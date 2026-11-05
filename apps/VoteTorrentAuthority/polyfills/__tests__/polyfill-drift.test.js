/**
 * polyfill-drift.test.js — 58-01 (D-05/D-13/D-14) drift + reachability guard
 * for the extracted Hermes UTF-8 TextDecoder.
 *
 * Lives in the Authority app ONLY. It also reads the Voter app's two files
 * (resolved relative to this file, one directory tree up and back down into
 * ../../../VoteTorrentVoter/…) so a Voter-only regression is caught without a
 * second copy of this guard — a second copy would itself need a drift guard,
 * which is the exact problem this file exists to close.
 *
 * SELF-TRIP DISPOSITION (per group, stated once here rather than assumed):
 *
 *   Group A (byte identity) — makes NO content assertion. It compares two
 *   OTHER files to each other byte-for-byte. The self-tripping-checker class
 *   this repo has recorded three times (a checker whose own comment quotes
 *   the pattern it hunts) does not apply to a pure equality comparison, so
 *   there is nothing to guard against here.
 *
 *   Group B (bootstrap wiring) IS a content assertion, but it scans two
 *   OTHER files (both apps' polyfills.bootstrap.js) and never its own
 *   source, so it does not self-trip either. Its residual risk runs the
 *   OTHER direction: a comment inside a SCANNED file could satisfy or
 *   defeat a match. That is why the comment stripper below exists, and why
 *   the inertness control proves the stripper is actually live rather than
 *   claimed.
 *
 *   Group C (reachability smoke) is purely behavioural — it requires the
 *   module and calls it. Nothing here is a text-pattern match.
 *
 *   Consequently: this file does NOT assemble any hunted literal from
 *   fragments (that discipline is for checkers that scan themselves — see
 *   packages/web-data/test/classification-drift.test.mjs's SECOND_LIST_IDENTIFIERS),
 *   and it does NOT add any assertion that reads its own source.
 *
 * NO TIMING ASSERTION of any kind lives in this file. Per 58-VALIDATION.md
 * Known Blind Spot 2, wall-clock checks are flaky under jest's parallel
 * workers; the only proof of "materially reduced" work is D-07's on-device
 * profile, which is 58-08's job, not this file's.
 *
 * CONFORMANCE DISCLAIMER (Group C): the reachability smoke below exercises
 * four data points (typeof, .default, ascii round-trip via a fixed input)
 * to prove the class is *reachable and not obviously broken* from jest. It
 * is NOT the WHATWG conformance suite — that is 58-02's job, and 58-02's
 * entire evidentiary value depends on being the FIRST behavioural coverage
 * this class has ever had. Do not add conformance cases here.
 *
 * RESIDUAL (recorded per 58-VALIDATION.md Known Blind Spot 4's discipline of
 * naming what a guard does NOT cover): a Voter-only edit verified with only
 * the Voter app's OWN jest suite would not trip this guard, because this
 * guard lives in the Authority suite. The nets that close that gap are the
 * root `yarn test` (which runs both workspaces) and 58-02's both-copies
 * conformance suite — neither is this file's job.
 */

const fs = require('fs');
const path = require('path');

const AUTHORITY_DECODER_PATH = path.resolve(__dirname, '../hermes-text-decoder.js');
const VOTER_DECODER_PATH = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills/hermes-text-decoder.js');
const AUTHORITY_BOOTSTRAP_PATH = path.resolve(__dirname, '../../polyfills.bootstrap.js');
const VOTER_BOOTSTRAP_PATH = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills.bootstrap.js');

/**
 * Strip block comments, THEN whole-line `//` comments, in that order — block
 * comments first, so a `//` sequence inside a block comment is never mistaken
 * for a line-comment opener once the block comment is already gone. Mirrors
 * the discipline in scripts/check-screen-scroll-containers.mjs and the exact
 * pipeline this plan's own Task 2 verify script used (a Perl block-comment
 * strip, then a whole-line `//` filter).
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlockComments
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('polyfill-drift (58-01: D-05 byte identity, D-13 wiring, D-14 reachability)', () => {
  describe('Group A — byte identity (D-05)', () => {
    it('both apps hermes-text-decoder.js are byte-identical', () => {
      const authoritySource = fs.readFileSync(AUTHORITY_DECODER_PATH, 'utf8');
      const voterSource = fs.readFileSync(VOTER_DECODER_PATH, 'utf8');
      expect(voterSource).toBe(authoritySource);
    });

    it('neither copy is vacuously short (guards against two simultaneously-truncated files)', () => {
      const authoritySource = fs.readFileSync(AUTHORITY_DECODER_PATH, 'utf8');
      const voterSource = fs.readFileSync(VOTER_DECODER_PATH, 'utf8');
      expect(authoritySource.length).toBeGreaterThan(0);
      expect(voterSource.length).toBeGreaterThan(0);
      expect(authoritySource.length).toBeGreaterThan(1500);
      expect(voterSource.length).toBeGreaterThan(1500);
    });
  });

  describe('Group B — bootstrap wiring (D-05 / D-13)', () => {
    const cases = [
      ['Authority', AUTHORITY_BOOTSTRAP_PATH],
      ['Voter', VOTER_BOOTSTRAP_PATH],
    ];

    it.each(cases)('%s polyfills.bootstrap.js requires the extracted module under the unchanged guard', (_label, bootstrapPath) => {
      const stripped = stripComments(fs.readFileSync(bootstrapPath, 'utf8'));

      expect(stripped).toContain("require('./polyfills/hermes-text-decoder')");
      expect(stripped).toContain("if (typeof globalThis.TextDecoder === 'undefined') {");
      // Comment-stripped source must no longer inline-assign the class —
      // this is the assertion that catches a regression back to the
      // pre-58-01 shape.
      expect(stripped).not.toMatch(/globalThis\.TextDecoder\s*=\s*class/);
    });

    it('inertness control: a synthetic source with the inline-class pattern only inside a comment does not match after stripping', () => {
      const fixture = [
        "// globalThis.TextDecoder = class { /* old shape, should never match */ }",
        "/* globalThis.TextDecoder = class { also inside a block comment } */",
        "if (typeof globalThis.TextDecoder === 'undefined') {",
        "  globalThis.TextDecoder = require('./polyfills/hermes-text-decoder');",
        "}",
      ].join('\n');
      const stripped = stripComments(fixture);

      expect(stripped).not.toMatch(/globalThis\.TextDecoder\s*=\s*class/);
      // And the stripper does not over-strip: the real (non-comment) require
      // line must still be visible after stripping.
      expect(stripped).toContain("require('./polyfills/hermes-text-decoder')");
    });
  });

  describe('Group C — reachability smoke (D-14, closes RESEARCH A-3)', () => {
    // Reachability only — NOT WHATWG conformance. See file header.
    it('the extracted class is require()-able from jest, is CommonJS (no .default), and decodes ASCII', () => {
      const Decoder = require('../hermes-text-decoder');

      expect(typeof Decoder).toBe('function');
      expect(Decoder.default).toBeUndefined();

      const decoded = new Decoder().decode(Uint8Array.from([0x68, 0x69]));
      expect(decoded).toBe('hi');
    });
  });
});
