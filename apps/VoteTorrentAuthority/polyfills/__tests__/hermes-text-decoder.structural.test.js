/**
 * hermes-text-decoder.structural.test.js — 58-03 (D-04) structural guard.
 *
 * Certifies that the ASCII fast path in BOTH apps' `hermes-text-decoder.js`
 * emits whole runs of ASCII bytes through a single, bounded
 * `String.fromCharCode.apply(...)` call site, and that the per-byte
 * `s += String.fromCharCode(b)` form the 57-11 Hermes profile identified as
 * the #1 hot frame is gone from `decode()` — while the multi-byte branches
 * (continuation-byte, overlong, surrogate, out-of-range, fatal, BOM) stay
 * byte-for-byte untouched, per D-04.
 *
 * WRITTEN BEFORE THE REWRITE (task 1) and proven RED against the pre-rewrite
 * source, per 58-VALIDATION.md Known Blind Spot 4 — "every gate added here
 * must be shown RED against the unfixed code" before it is ever trusted
 * green. The verbatim RED capture lives at
 * .planning/phases/58-.../58-03-structural-red-evidence.txt.
 *
 * SELF-TRIP DISPOSITION. This repo has three recorded incidents of a checker
 * whose own comment quoted the pattern it hunted, leaving it permanently
 * green. That hazard does not apply the same way here: this guard reads
 * exactly two explicitly named files (`AUTHORITY_PATH`, `VOTER_PATH`) via
 * `fs.readFileSync` — never a directory glob, and never its own source
 * (`__filename`) — so the "checker scans a directory containing itself"
 * class is structurally impossible. `SG1` below asserts that fact rather
 * than assuming it. The hazard that DOES apply here runs the other
 * direction: a comment or string literal inside a SCANNED file could satisfy
 * or defeat a match on its own. `stripCommentsAndStrings` removes block
 * comments, then line comments, then string literals — in that order,
 * because stripping line comments first would corrupt a block comment that
 * itself contains a `//` sequence — before any structural assertion runs,
 * and `SG2` (an inertness control borrowed from
 * `scripts/check-screen-scroll-containers.mjs` and
 * `packages/web-data/test/classification-drift.test.mjs`) proves that
 * stripping is actually live rather than merely claimed.
 *
 * The assertion regexes themselves are written as inline regex literals
 * passed directly to `.match(...)` / `toMatch(...)` — never restated in a
 * comment — so there is no textual copy of the hunted pattern anywhere in
 * this file's prose for a future scan to trip on.
 */

const fs = require('fs');
const path = require('path');

const AUTHORITY_PATH = path.resolve(__dirname, '../hermes-text-decoder.js');
const VOTER_PATH = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills/hermes-text-decoder.js');

/**
 * Removes block comments, then line comments, then single-quoted,
 * double-quoted and template string literals — in that order. Order is
 * load-bearing: stripping line comments before block comments would corrupt
 * a block comment that itself contains a `//` sequence.
 *
 * ACCEPTED LIMITATION (stated, not hidden): this pass is not quote-state-aware
 * while stripping line comments, so a `//` appearing INSIDE a string literal
 * would be mistaken for a comment opener. Neither `hermes-text-decoder.js`
 * (in either app) nor any fixture in this file places `//` inside a string
 * literal, so the limitation is never exercised here.
 *
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  // 1. Block comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. Line comments — whole-line or trailing.
  out = out
    .split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  // 3. String literals — single-quoted, double-quoted, template. Each whole
  //    literal collapses to a single space so a literal that straddled a
  //    token boundary cannot accidentally re-join two adjacent tokens into a
  //    false structural match.
  out = out
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
  return out;
}

/**
 * Extracts the integer bound to `ASCII_CHUNK =` from an already-stripped
 * source. Returns null when no such declaration exists (expected pre-rewrite
 * — the constant does not exist yet, and that absence is exactly what S4
 * fails RED on).
 *
 * @param {string} strippedSrc
 * @returns {number | null}
 */
function parseAsciiChunk(strippedSrc) {
  const m = strippedSrc.match(/ASCII_CHUNK\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const FILES = [
  ['authority', AUTHORITY_PATH],
  ['voter', VOTER_PATH],
];

describe.each(FILES)('structural guard (D-04) — %s', (_label, filePath) => {
  const rawSource = fs.readFileSync(filePath, 'utf8');
  const stripped = stripCommentsAndStrings(rawSource);

  test('S1: exactly one chunked String.fromCharCode.apply(...) call site, using bytes.subarray(...)', () => {
    const applyMatches = stripped.match(/String\.fromCharCode\.apply\(/g) || [];
    expect(applyMatches.length).toBe(1);

    const subarrayMatches = stripped.match(/bytes\.subarray\(/g) || [];
    expect(subarrayMatches.length).toBeGreaterThanOrEqual(1);
  });

  test('S2: the old per-byte ASCII emit form is absent', () => {
    const perByteMatches = stripped.match(/s\s*\+=\s*String\.fromCharCode\(\s*b\s*\)/g) || [];
    expect(perByteMatches.length).toBe(0);
  });

  test('S3: exactly two non-apply String.fromCharCode( sites remain, both in the multi-byte emit path', () => {
    // `String.fromCharCode.apply(` never matches this pattern: the character
    // immediately after `fromCharCode` there is `.`, not `(`.
    const nonApplyMatches = stripped.match(/String\.fromCharCode\(/g) || [];
    expect(nonApplyMatches.length).toBe(2);

    expect(stripped).toMatch(/String\.fromCharCode\(0xd800\s*\+/);
    expect(stripped).toMatch(/String\.fromCharCode\(cp\)/);
  });

  test('S4: ASCII_CHUNK is declared and stays within the conservative [256, 8192] band', () => {
    const chunk = parseAsciiChunk(stripped);
    expect(chunk).not.toBeNull();
    expect(chunk).toBeGreaterThanOrEqual(256);
    expect(chunk).toBeLessThanOrEqual(8192);
  });
});

test('S4 (cross-file): both files declare the same ASCII_CHUNK value', () => {
  const authorityChunk = parseAsciiChunk(stripCommentsAndStrings(fs.readFileSync(AUTHORITY_PATH, 'utf8')));
  const voterChunk = parseAsciiChunk(stripCommentsAndStrings(fs.readFileSync(VOTER_PATH, 'utf8')));
  expect(voterChunk).toBe(authorityChunk);
});

describe('self-trip guards', () => {
  test('SG1: the guard never reads its own source, and neither scanned path lives inside this test directory', () => {
    const scannedPaths = [AUTHORITY_PATH, VOTER_PATH];
    expect(scannedPaths).not.toContain(__filename);
    for (const scannedPath of scannedPaths) {
      expect(scannedPath.startsWith(__dirname + path.sep)).toBe(false);
    }
  });

  /* ───────────────────────────────────────────────────────────────────────
   * BEGIN CONTROL FIXTURES
   * The only place in this file where the hunted patterns appear
   * deliberately outside of real assertions — each occurrence below sits
   * ONLY inside a line comment, a block comment or a string literal.
   * ─────────────────────────────────────────────────────────────────────── */
  const INERTNESS_FIXTURE = [
    '// String.fromCharCode.apply(null, bytes.subarray(a, b)); s += String.fromCharCode(b);',
    '/* String.fromCharCode.apply(null, bytes.subarray(a, b)); s += String.fromCharCode(b); */',
    'const label = "String.fromCharCode.apply(null, bytes.subarray(a, b)); s += String.fromCharCode(b);";',
    'export function noop() { return 0; }',
  ].join('\n');
  /* END CONTROL FIXTURES
   * ─────────────────────────────────────────────────────────────────────── */

  test('SG2 (inertness control): the target forms hidden only in comments/strings do not satisfy S1 or S2 after stripping', () => {
    const strippedFixture = stripCommentsAndStrings(INERTNESS_FIXTURE);

    const applyMatches = strippedFixture.match(/String\.fromCharCode\.apply\(/g) || [];
    expect(applyMatches.length).toBe(0);

    const perByteMatches = strippedFixture.match(/s\s*\+=\s*String\.fromCharCode\(\s*b\s*\)/g) || [];
    expect(perByteMatches.length).toBe(0);
  });
});

describe('chunk-boundary decoding (D-04)', () => {
  // Exercises the real class directly — never through polyfills.bootstrap.js
  // (jest's Node environment supplies a native TextDecoder, so that guard is
  // permanently false under jest; see the same discipline in
  // hermes-text-decoder.conformance.test.js).
  const Decoder = require('../hermes-text-decoder');

  // Derived from the source rather than hard-coded twice. Pre-rewrite,
  // ASCII_CHUNK does not exist yet (parseAsciiChunk returns null) — these
  // cases fall back to 4096 so they exercise a real boundary and stay GREEN
  // against the pre-rewrite per-byte decoder, which round-trips any ASCII
  // run length exactly regardless of chunking. Post-rewrite this resolves to
  // the real declared constant.
  const authorityStripped = stripCommentsAndStrings(fs.readFileSync(AUTHORITY_PATH, 'utf8'));
  const ASCII_CHUNK = parseAsciiChunk(authorityStripped) ?? 4096;

  test('a 10000-byte all-ASCII buffer round-trips to an exactly equal string', () => {
    const input = new Uint8Array(10000);
    for (let i = 0; i < 10000; i++) input[i] = 0x20 + (i % 95); // printable ASCII range
    let expected = '';
    for (let i = 0; i < input.length; i++) expected += String.fromCharCode(input[i]);

    const out = new Decoder().decode(input);
    expect(out).toBe(expected);
    expect(out.length).toBe(10000);
  });

  test.each([
    ['ASCII_CHUNK', ASCII_CHUNK],
    ['ASCII_CHUNK - 1', ASCII_CHUNK - 1],
    ['ASCII_CHUNK + 1', ASCII_CHUNK + 1],
    ['2 * ASCII_CHUNK', 2 * ASCII_CHUNK],
  ])('a run of %s (%i) ASCII bytes round-trips exactly', (_label, n) => {
    const input = new Uint8Array(n).fill(0x41);
    const out = new Decoder().decode(input);
    expect(out.length).toBe(n);
    expect(out).toBe('A'.repeat(n));
  });

  test('an ASCII run ending one byte before a chunk boundary, followed by U+20AC, followed by more ASCII, decodes exactly', () => {
    const preLen = ASCII_CHUNK - 1;
    const tailLen = 5;
    const input = new Uint8Array(preLen + 3 + tailLen);
    input.fill(0x41, 0, preLen);
    input[preLen] = 0xe2;
    input[preLen + 1] = 0x82;
    input[preLen + 2] = 0xac;
    input.fill(0x42, preLen + 3, preLen + 3 + tailLen);

    const expected = 'A'.repeat(preLen) + '€' + 'B'.repeat(tailLen);
    const out = new Decoder().decode(input);
    expect(out).toBe(expected);
  });

  test('an ASCII run ending exactly at a chunk boundary followed by an invalid leading byte: one U+FFFD (fatal:false), throws (fatal:true)', () => {
    const n = ASCII_CHUNK;
    const input = new Uint8Array(n + 1);
    input.fill(0x41, 0, n);
    input[n] = 0xff; // never a valid UTF-8 leading byte

    const outNonFatal = new Decoder('utf-8', { fatal: false }).decode(input);
    expect(outNonFatal).toBe('A'.repeat(n) + '�');
    const replacementCount = (outNonFatal.match(/�/g) || []).length;
    expect(replacementCount).toBe(1);

    expect(() => new Decoder('utf-8', { fatal: true }).decode(input)).toThrow(TypeError);
  });
});
