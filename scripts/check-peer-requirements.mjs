/**
 * check-peer-requirements.mjs
 *
 * Guard script for the broad YN0086 logFilters discard in .yarnrc.yml.
 *
 * Context: yarn berry 4 under nodeLinker:node-modules emits YN0086 (a project-wide
 * "Some peer dependencies are incorrectly met" summary) for ALL unmet peer deps — not
 * just the @optimystic/quereus-plugin-* ones. .yarnrc.yml discards YN0086 globally so
 * that the known-allowed @optimystic crypto/optimystic plugin mismatches stay silent.
 * Because that discard is broad, this guard restores the signal for the only surface it
 * could mask: @optimystic/quereus-plugin-* consumer mismatches.
 *
 * What this script does:
 *   1. Runs `yarn explain peer-requirements` (no args) and parses its stdout.
 *   2. Selects the ✘ summary lines mentioning an @optimystic/quereus-plugin-* consumer,
 *      capturing each line's leading p-hash.
 *   3. For each selected line, drills into `yarn explain peer-requirements <p-hash>` —
 *      the DETAIL tree enumerates EVERY consumer explicitly, including ones the folded
 *      "… and N other dependency" summary hides. It unions all observed
 *      @optimystic/quereus-plugin-<name>@npm:<version> descriptors from those detail trees.
 *      Note: patch-installed packages appear as @patch:... in detail trees; CONSUMER_ANY_RE
 *      is used for the presence check, CONSUMER_RE for KNOWN_ALLOWED comparisons.
 *   4. Compares that expanded observed set against KNOWN_ALLOWED.
 *   5. Exits non-zero if any UNEXPECTED descriptor is found, OR if a folded summary line's
 *      detail drill-down cannot be enumerated (fail closed). Exits 0 on the happy path.
 *
 * Why the detail drill-down (CR-02): `yarn explain peer-requirements` folds multiple
 * consumers of the same provided-peer into one ✘ summary line (e.g. cadre-core's
 * "… and 1 other dependency"), naming only quereus-plugin-crypto and hiding
 * quereus-plugin-optimystic. The summary text alone is therefore blind to folded
 * mismatches. The per-requirement detail tree (`yarn explain peer-requirements <p-hash>`)
 * lists each consumer as its own branch, so the guard sees the full surface.
 * (`--json` is NOT supported by this yarn 4.7.0 subcommand.)
 *
 * Phase 29 (SIGN-05): packages/vote-engine bumped quereus-plugin-crypto to ^0.14.0
 * (resolves to 0.14.1). Other workspace consumers (cadre-core, quereus-plugin-sereus
 * portals) still depend on 0.13.5 transitively. On the 3.3.0 tree the full surface was:
 *   @optimystic/quereus-plugin-crypto@npm:0.13.5  — portal workspaces (unchanged)
 *   @optimystic/quereus-plugin-crypto@npm:0.14.1  — vote-engine (upgraded)
 *   @optimystic/quereus-plugin-optimystic@npm:0.13.5
 * (the optimystic plugin was previously folded into cadre-core's summary and invisible;
 * the detail drill-down now surfaces it).
 *
 * Phase 33 (UPG-03): quereus bumped to 4.2.1 (64e8a4bca7 patch). The optimystic plugin
 * mismatch DISAPPEARED on the 4.x tree (its peer range is satisfied by the 4.2.1 copy).
 * KNOWN_ALLOWED updated empirically to reflect the two remaining crypto mismatches.
 *
 * To update the allow-list (e.g. when upstream @optimystic releases a clean version that
 * peers on @quereus/quereus 3.x — D-02 removal trigger):
 *   - Remove the resolved entry/entries from KNOWN_ALLOWED.
 *   - Also remove the `logFilters: code: YN0086` entry from .yarnrc.yml.
 *
 * This guard runs automatically on every `yarn install` (root package.json `postinstall`)
 * and before the workspace lints (root `lint`), so the broad YN0086 discard is operationally
 * enforced, not merely available as `yarn lint:peers` (WR-04).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// KNOWN_ALLOWED: the exact set of @optimystic/quereus-plugin-* consumer
// descriptors that are currently expected to appear as ✘ in
// `yarn explain peer-requirements` (across the EXPANDED detail trees).
//
// Phase 29 (SIGN-05): @optimystic/quereus-plugin-crypto bumped in
// packages/vote-engine from 0.13.5 → ^0.14.0 (resolves to 0.14.1 on npm).
// Other workspace consumers (@serfab/cadre-core, @serfab/quereus-plugin-sereus
// portals) still depend on 0.13.5 transitively and produce their own ✘ lines.
//
// Phase 33 (UPG-03): quereus bumped from 3.3.0 → 4.2.1 (64e8a4bca7 patch).
// After the 4.x bump, @optimystic/quereus-plugin-optimystic@npm:0.13.5
// DISAPPEARED from the observed mismatch set (its peer range is now satisfied
// by the resolved 4.2.1 copy). Only the two crypto mismatches remained:
//   @optimystic/quereus-plugin-crypto@npm:0.13.5  — cadre-core / quereus-plugin-sereus portals
//   @optimystic/quereus-plugin-crypto@npm:0.14.1  — vote-engine (upgraded)
//
// Phase 36 (CID-01, D-01): the two vendored @serfab/* portals
// (cadre-core, quereus-plugin-sereus) had their @optimystic/quereus-plugin-crypto
// range widened from ^0.13.5 → ^0.14.0, so ALL consumers now resolve the single
// 0.14.1 copy. The @npm:0.13.5 crypto mismatch DISAPPEARED entirely (confirmed:
// `grep -c '@optimystic/quereus-plugin-crypto@npm:0.13' yarn.lock` == 0,
// `yarn why` shows one resolved 0.14.1 copy across all consumer paths). The
// dual-copy exception is retired; only the single crypto mismatch remains:
//   @optimystic/quereus-plugin-crypto@npm:0.14.1  — all consumers (the pre-existing
//     ^0.16.2 peer wart against crypto-plugin's OWN internal quereus-version scheme,
//     unrelated to @quereus/quereus 4.2.1 — see .yarnrc.yml)
// (Observed empirically via `yarn explain peer-requirements` after the 0.14 repin.)
// ---------------------------------------------------------------------------
// v4.4 bump (2026-07-28): @optimystic/* family bumped 0.14.1 → 0.16.3 (all aligned)
// alongside cadre-core 0.9.0 + quereus 4.4.1. The crypto-plugin peer wart is the SAME
// known-suppressed `^0.16.2` mismatch against the plugin's own internal quereus-version
// scheme (unrelated to @quereus/quereus 4.4.1) — only the resolved version moved.
// db-p2p 0.18.0 bump (2026-08-03): @optimystic/* family bumped 0.16.3 → 0.18.0 (all
// aligned) to pick up the reworked db-p2p membership admission gate. The mismatch is
// unchanged in SHAPE — `packages/attestation-native` consumes
// @optimystic/quereus-plugin-crypto but does not itself declare @quereus/quereus, so it
// cannot provide that peer (every other consumer — vote-engine, cadre-core,
// quereus-plugin-sereus, both apps — provides the resolved 4.4.1 patch copy and reports ✓).
// Only the resolved version moved. Note the crypto plugin's peer range is now
// `@quereus/quereus: ^4.3.0`, satisfied by 4.4.1; the residual ✘ is the missing
// declaration in attestation-native, not a version conflict.
// Spike 064 (four-family bump): @optimystic 0.22.0 -> 0.24.0. The mismatch is the
// SAME single one, re-keyed to the new provider version. Two OTHER mismatches
// DISAPPEARED on this bump -- `yarn explain peer-requirements` now shows
// `@serfab/cadre-core@npm:0.11.0 provides @quereus/quereus@npm:4.14.0 to
// @optimystic/quereus-plugin-crypto@npm:0.24.0` (and the same for
// quereus-plugin-sereus), so the long-standing ^0.16.2 peer wart against the
// crypto plugin's own internal quereus-version scheme is FIXED upstream.
// What remains is VT-side: packages/attestation-native depends on
// quereus-plugin-crypto without declaring @quereus/quereus itself.
//
// Phase 50-04: the root `resolutions` entry for @optimystic/quereus-plugin-crypto
// is a floating `^0.24.0` range, and upstream published a 0.24.2 patch release
// sometime before this plan ran. `yarn.lock` at this plan's starting commit had
// ALREADY re-resolved every consumer to the single unified 0.24.2 copy (verified:
// `git show HEAD:yarn.lock` contains zero `0.24.0` entries and one `0.24.2` entry)
// -- this KNOWN_ALLOWED value was already stale before apps/VoteTorrentDashboard
// existed. Re-keyed 0.24.0 -> 0.24.2 to match the actual (still single-copy, still
// benign) resolved state; `yarn why @optimystic/quereus-plugin-crypto` confirms
// every consumer (cadre-core, quereus-plugin-sereus, attestation-native,
// vote-engine, and now votetorrent-dashboard) resolves the SAME 0.24.2 descriptor.
//
// @optimystic 0.25.1 -> 0.27.0 bump (2026-09-03): the mismatch is again the SAME
// single one, re-keyed to the new provider version. `yarn why
// @optimystic/quereus-plugin-crypto` resolves every consumer (cadre-core,
// quereus-plugin-sereus, attestation-native, vote-engine, votetorrent-dashboard,
// votetorrent-public) to one 0.27.0 copy, and @serfab/cadre-core@0.11.0's own
// `^0.24.0` @optimystic range is flattened onto 0.27.0 by the root `resolutions`
// -- so no second, unfixed db-p2p is nested behind cadre-core. The residual cause
// is unchanged and still VT-side: packages/attestation-native depends on
// quereus-plugin-crypto without declaring @quereus/quereus itself, so it cannot
// provide that peer.
//
// @optimystic 0.29.0 -> 1.0.0-beta.2 bump (2026-09-11, commit eb5302af): same single
// mismatch, re-keyed again. This value went stale the moment that bump landed and
// stayed stale because nothing re-runs this guard on a dependency change -- the
// checker reported the descriptor as `disappeared` (the allowlisted 0.29.0 entry no
// longer exists) AND as `unexpected` (the real 1.0.0-beta.2 one is not allowlisted),
// which is exactly what a version-keyed allowlist looks like when it is left behind.
// NOTE the 0.29.0 line itself was never committed: it sat uncommitted in the working
// tree from 2026-09-10, so the tracked value was still 0.27.0 two bumps later.
//
// @optimystic 1.0.0-beta.2 -> 1.0.0-beta.3 bump (2026-09-14): same single mismatch,
// re-keyed once more. Re-verified rather than assumed: `yarn why
// @optimystic/quereus-plugin-crypto` resolves every workspace consumer to one
// 1.0.0-beta.3 copy, and the cause is still the VT-side one described above
// (packages/attestation-native depends on quereus-plugin-crypto without declaring
// @quereus/quereus, so it cannot provide that peer). Unlike the two bumps before it,
// this line was updated in the same commit as the bump.
//
// @optimystic 1.0.0-beta.3 -> 1.1.0 bump (2026-09-21): same single mismatch, re-keyed
// again. Re-verified rather than assumed: yarn.lock holds exactly ONE resolved
// @optimystic/quereus-plugin-crypto version (1.1.0), and the cause is unchanged —
// packages/attestation-native depends on quereus-plugin-crypto without declaring
// @quereus/quereus, so it cannot provide that peer. NOTE what did NOT change here:
// optimystic 1.1.0 raised both plugins' @quereus/quereus peer RANGE from ^4.3.0 to
// ^4.19.4, but this mismatch was never a range problem — it is a MISSING peer, so
// narrowing the range neither caused nor cured it. The real fix is to add
// @quereus/quereus to packages/attestation-native, not to widen this allowlist;
// until then the entry stays and must be re-keyed on every optimystic bump.
//
// @optimystic 1.1.0 -> 1.2.0 bump (2026-09-22): same single mismatch, re-keyed again and
// re-verified the same way — yarn.lock holds exactly ONE resolved
// @optimystic/quereus-plugin-crypto version (1.2.0), and the cause is still the missing
// @quereus/quereus dependency in packages/attestation-native, not a peer RANGE (1.2.0
// leaves that range at ^4.19.4, unchanged from 1.1.0).
//
// @optimystic 1.2.0 -> 1.3.0 bump (2026-09-22): same single mismatch, re-keyed once more.
// Re-verified: yarn.lock holds exactly ONE resolved @optimystic/quereus-plugin-crypto
// version (1.3.0), the peer range is still ^4.19.4, and the cause is still the missing
// @quereus/quereus declaration in packages/attestation-native. NOTE the @serfab family did
// NOT move on this hop (cadre-core / quereus-plugin-sereus stay 1.2.0), so this is the first
// bump where the two families are deliberately on different minors.
//
// @optimystic 1.3.0 -> 1.5.0 bump (2026-09-24): same single mismatch, re-keyed once more
// (1.4.0 skipped). Re-verified: yarn.lock holds exactly ONE resolved
// @optimystic/quereus-plugin-crypto version (1.5.0), the peer range is still ^4.19.4, and the
// cause is still the missing @quereus/quereus declaration in packages/attestation-native.
// The @serfab family again did NOT move (cadre-core / quereus-plugin-sereus stay 1.2.0).
//
// @optimystic 1.5.0 -> 1.7.0 bump (2026-09-28): same single mismatch, re-keyed once more
// (1.6.0 skipped). Re-verified: yarn.lock holds exactly ONE resolved
// @optimystic/quereus-plugin-crypto version (1.7.0). Its peer range moved to ^4.20.0, which
// dragged @quereus/quereus 4.19.4 -> 4.20.0 in the same commit, but the cause is still the
// missing @quereus/quereus declaration in packages/attestation-native (YN0002 names it).
// The @serfab family moved in the same commit (cadre-core / quereus-plugin-sereus 1.2.0 -> 1.6.0,
// strand-proto still 0.11.0); it does not touch this mismatch.
//
// @optimystic 1.8.1 -> 1.9.0 bump (2026-10-02): same single mismatch, re-keyed. The 1.7.0 ->
// 1.8.1 bump never re-keyed this entry, so the guard had been reporting 1.7.0 as `disappeared`
// and 1.8.1 as `unexpected` since then. Re-verified: yarn.lock holds exactly ONE resolved
// @optimystic/quereus-plugin-crypto version (1.9.0), and YN0002 still names
// packages/attestation-native as the workspace that does not provide @quereus/quereus.
//
// @optimystic 1.9.0 -> 1.10.1 + @serfab 1.9.0 -> 1.12.0 bump (2026-10-05): same single mismatch,
// re-keyed. yarn.lock holds exactly ONE resolved @optimystic/quereus-plugin-crypto version
// (1.10.1); its peer range is still ^4.20.0 (satisfied by the single patched 4.20.0 copy) and the
// cause is still the missing @quereus/quereus declaration in packages/attestation-native.
//
// @optimystic 1.10.1 -> 1.11.0 + @serfab 1.12.0 -> 1.13.0 bump (2026-10-06): same single
// mismatch, re-keyed. The peer range moved to ^4.20.1, which dragged @quereus/quereus 4.20.0 ->
// 4.20.1; YN0002 still names packages/attestation-native as the workspace that does not provide it.
//
// @optimystic 1.11.0 -> 1.12.1 bump (2026-10-08, @serfab stays 1.13.0, already latest): same single
// mismatch, re-keyed. The peer range is still ^4.20.1; the cause is unchanged.
//
// @serfab 1.13.0 -> 1.14.0 bump (2026-10-09, @optimystic stays 1.12.1): no change to this set —
// cadre-core 1.14 requires ^1.12.0, which the single 1.12.1 copy already satisfies.
//
// @serfab 1.14.0 -> 1.15.0 + @optimystic 1.12.1 -> 1.13.0 + @quereus 4.20.1 -> 4.20.2 bump
// (2026-10-13): same single mismatch, re-keyed. The peer range is still ^4.20.1 (satisfied by the
// single patched 4.20.2 copy); YN0002 still names packages/attestation-native.
//
// @optimystic 1.13.0 -> 1.14.0 bump (2026-10-14, @serfab stays 1.15.0, quereus 4.20.2): same single
// mismatch, re-keyed. The peer range is still ^4.20.1.
//
// @serfab 1.15.0 -> 1.16.0 + @optimystic 1.14.0 -> 1.15.0 bump (2026-10-16, quereus 4.20.2): same
// single mismatch, re-keyed. The peer range is still ^4.20.1.
//
// @serfab 1.16.0 -> 1.18.0 + @optimystic 1.15.0 -> 1.19.0 bump (2026-10-26, quereus 4.20.2 -> 4.20.3):
// same single mismatch, re-keyed. The peer range moved to ^4.20.3, which dragged quereus to 4.20.3;
// YN0002 still names packages/attestation-native as the workspace that does not provide it.
//
// @serfab 1.19.0 -> 1.19.1 + @optimystic 1.19.0 -> 1.20.1 bump (2026-10-30, quereus 4.20.3 -> 4.21.1):
// same single mismatch, re-keyed. The peer range moved to ^4.21.0; YN0002 still names
// packages/attestation-native.
//
// @serfab 1.19.1 -> 1.20.0 + @optimystic 1.20.1 -> 1.24.0 bump (2026-11-02, quereus 4.21.1 -> 4.24.0):
// same single mismatch expected, re-keyed (the peer range moved to ^4.24.0). Re-confirm after install.
//
// @serfab 1.20.0 -> 1.21.0 + @optimystic 1.24.0 -> 1.25.0 bump (2026-11-05, quereus 4.24.0 -> 4.26.0):
// same single mismatch, re-keyed. The peer range moved to ^4.25.0; YN0002 still names
// packages/attestation-native.
const KNOWN_ALLOWED = new Set([
  '@optimystic/quereus-plugin-crypto@npm:1.25.0',
]);

// The ✘ marker (U+2718)
const FAIL_MARKER = '✘';

// Match @optimystic/quereus-plugin-<name>@npm:<version> descriptors. Name allows
// hyphenated/multi-segment names ([a-z0-9-]+); version allows the full npm version
// charset (digits, letters, dot, hyphen) so prerelease/build versions are captured
// verbatim rather than truncated (closes the WR-01/WR-02 fail-open holes).
const CONSUMER_RE = /@optimystic\/quereus-plugin-[a-z0-9-]+@npm:[0-9A-Za-z.-]+/g;

// Broader match for any @optimystic/quereus-plugin-* consumer descriptor, regardless
// of protocol (@npm:, @patch:, @portal:, etc.). Used only for the fail-close presence
// check in folded detail trees — CONSUMER_RE (npm-only) is still used for KNOWN_ALLOWED
// comparisons. Needed because @optimystic/quereus-plugin-optimystic is installed via a
// yarn patch (descriptor form: @patch:@optimystic/quereus-plugin-optimystic@npm%3A0.13.5#...)
// rather than bare @npm:, so CONSUMER_RE alone misses it in detail trees (D-26-fix-01).
const CONSUMER_ANY_RE = /@optimystic\/quereus-plugin-[a-z0-9-]+@/g;

// Detect a folded summary line ("… and N other dependency/dependencies").
const FOLD_RE = /and\s+\d+\s+other\s+dependenc(?:y|ies)/i;

// Capture the leading p-hash of a no-arg listing line: "p0bd4b → ✘ …"
const PHASH_RE = /^\s*(\S+)\s*→/;

async function runYarnExplain(args) {
  // `yarn explain peer-requirements` (and its detail form) exit 0 even when ✘
  // lines are present — parse the output, never rely on the exit code.
  const { stdout } = await execAsync(`yarn explain peer-requirements ${args}`.trim(), {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  let stdout;
  try {
    stdout = await runYarnExplain('');
  } catch (err) {
    // CR-01: surface the REAL yarn error (err.message) — do not call an undefined
    // symbol. Fail closed (non-zero) so a broken guard never silently passes.
    process.stderr.write(
      `[lint:peers] yarn explain peer-requirements failed: ${err.message}\n`,
    );
    process.exit(2);
  }

  const lines = stdout.split('\n');

  // Select the ✘ summary lines that mention an @optimystic/quereus-plugin-* consumer.
  const mismatchLines = lines.filter(
    (l) => l.includes(FAIL_MARKER) && l.includes('@optimystic/quereus-plugin-'),
  );

  // Build the observed set from the EXPANDED detail trees, not the folded summary text.
  const observed = new Set();
  for (const line of mismatchLines) {
    const phashMatch = line.match(PHASH_RE);
    const phash = phashMatch ? phashMatch[1] : null;
    const isFolded = FOLD_RE.test(line);

    let detail = null;
    if (phash) {
      try {
        detail = await runYarnExplain(phash);
      } catch (err) {
        detail = null;
        process.stderr.write(
          `[lint:peers] detail drill-down failed for ${phash}: ${err.message}\n`,
        );
      }
    }

    if (detail) {
      const matches = detail.match(CONSUMER_RE);
      if (matches) {
        for (const m of matches) observed.add(m);
      }
    }

    // Fail-closed fallback: a folded summary line whose detail tree could not be
    // enumerated by name must NOT slip through — a folded @optimystic/quereus-plugin-*
    // mismatch could be hiding there.
    // Use CONSUMER_ANY_RE (protocol-agnostic) for the presence check so that patch-
    // installed packages (whose descriptor is @patch:... not @npm:...) are still seen.
    if (isFolded) {
      const detailMatches = detail ? detail.match(CONSUMER_ANY_RE) : null;
      if (!detailMatches || detailMatches.length === 0) {
        process.stderr.write(
          `[lint:peers] ERROR: a folded @optimystic/quereus-plugin-* peer mismatch ` +
            `could not be verified by name.\n` +
            `\n` +
            `The summary line "${line.trim()}" folds extra consumers into "and N other\n` +
            `dependency", and its detail view (yarn explain peer-requirements ${phash ?? '<p-hash>'})\n` +
            `did not enumerate the @optimystic/quereus-plugin-* consumers. The YN0086 install\n` +
            `summary is discarded in .yarnrc.yml, so this guard is the only thing catching such\n` +
            `mismatches — failing closed rather than passing blind.\n`,
        );
        process.exit(1);
      }
    }

    // Also fold the explicitly-named consumer from the summary line itself, as a
    // belt-and-suspenders measure for non-folded lines.
    const summaryMatches = line.match(CONSUMER_RE);
    if (summaryMatches) {
      for (const m of summaryMatches) observed.add(m);
    }
  }

  // Compute UNEXPECTED = observed - KNOWN_ALLOWED
  const unexpected = [...observed].filter((d) => !KNOWN_ALLOWED.has(d));

  // Compute DISAPPEARED = KNOWN_ALLOWED - observed (informational only — good news)
  const disappeared = [...KNOWN_ALLOWED].filter((d) => !observed.has(d));

  if (disappeared.length > 0) {
    console.log(
      `[lint:peers] INFO: the following known-allowed mismatches no longer appear ` +
        `(upstream may have fixed the peer range — consider removing the YN0086 ` +
        `logFilters entry from .yarnrc.yml and updating KNOWN_ALLOWED here):`,
    );
    for (const d of disappeared) {
      console.log(`  disappeared: ${d}`);
    }
  }

  if (unexpected.length > 0) {
    process.stderr.write(
      `[lint:peers] ERROR: ${unexpected.length} UNEXPECTED @optimystic/quereus-plugin-* ` +
        `peer mismatch(es) detected.\n` +
        `\n` +
        `The YN0086 install summary is discarded in .yarnrc.yml, so this guard is the\n` +
        `only thing catching new mismatches. Either fix the mismatch upstream or update\n` +
        `KNOWN_ALLOWED in scripts/check-peer-requirements.mjs if the new mismatch is\n` +
        `intentional.\n` +
        `\n`,
    );
    for (const d of unexpected) {
      process.stderr.write(`  unexpected: ${d}\n`);
    }
    process.exit(1);
  }

  // Happy path
  const allowedList = [...KNOWN_ALLOWED].join(', ');
  console.log(
    `[lint:peers] OK — @optimystic/quereus-plugin-* peer mismatches match the ` +
      `known-allowed set: ${allowedList}`,
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[lint:peers] Unexpected error: ${err.message}\n`);
  process.exit(2);
});
