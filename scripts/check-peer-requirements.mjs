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
const KNOWN_ALLOWED = new Set([
  '@optimystic/quereus-plugin-crypto@npm:0.16.3',
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
