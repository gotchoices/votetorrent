/**
 * check-peer-requirements.mjs
 *
 * Guard script for the broad YN0086 logFilters discard in .yarnrc.yml.
 *
 * Context: yarn berry 4 under nodeLinker:node-modules emits YN0086 (a project-wide
 * "Some peer dependencies are incorrectly met" summary) for ALL unmet peer deps — not
 * just the @optimystic/quereus-plugin-* ones. .yarnrc.yml discards YN0086 globally so
 * that the known-allowed @optimystic crypto-plugin mismatch stays silent. Because that
 * discard is broad, this guard restores the signal for the only surface it could mask:
 * @optimystic/quereus-plugin-* consumer mismatches.
 *
 * What this script does:
 *   1. Runs `yarn explain peer-requirements` and parses its stdout.
 *   2. Selects only ✘ lines mentioning an @optimystic/quereus-plugin-* consumer.
 *   3. Extracts the unique consumer descriptors from those lines.
 *   4. Compares that set against KNOWN_ALLOWED.
 *   5. Exits non-zero if any UNEXPECTED descriptor is found; exits 0 on the happy path.
 *
 * To update the allow-list (e.g. when upstream @optimystic releases a clean version):
 *   - Remove the resolved entry from KNOWN_ALLOWED (D-02 removal trigger).
 *   - Also remove the `logFilters: code: YN0086` entry from .yarnrc.yml.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// KNOWN_ALLOWED: the exact set of @optimystic/quereus-plugin-* consumer
// descriptors that are currently expected to appear as ✘ in
// `yarn explain peer-requirements`.
//
// Empirically, on the reconciled tree (quereus 3.3.0, @optimystic family
// 0.13.5), only one explicit consumer descriptor is printed:
//   @optimystic/quereus-plugin-crypto@npm:0.13.5
// (quereus-plugin-optimystic's mismatch is folded into cadre-core's
// "… and 1 other dependency" summary rather than listed as its own line.)
//
// Update this list — and remove the YN0086 logFilters from .yarnrc.yml —
// when a clean upstream @optimystic release peers on @quereus/quereus 3.x.
// ---------------------------------------------------------------------------
const KNOWN_ALLOWED = new Set([
  '@optimystic/quereus-plugin-crypto@npm:0.13.5',
]);

// Regex to match the ✘ marker (U+2718)
const FAIL_MARKER = '✘';

// Regex to extract @optimystic/quereus-plugin-<name>@npm:<version> descriptors
const CONSUMER_RE = /@optimystic\/quereus-plugin-[a-z]+@npm:[0-9][0-9.]*/g;

async function main() {
  let stdout;
  try {
    // yarn explain peer-requirements exits 0 even when ✘ lines are present.
    // Do NOT rely on its exit code — parse the output instead.
    ({ stdout } = await execAsync('yarn explain peer-requirements', {
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    // exec rejects on non-zero exit; but yarn explain peer-requirements should
    // always exit 0. Surface any unexpected error.
    stderr(`yarn explain peer-requirements failed: ${err.message}`);
    process.exit(2);
  }

  const lines = stdout.split('\n');

  // Select lines that have BOTH a ✘ marker AND an @optimystic/quereus-plugin-* mention
  const mismatchLines = lines.filter(
    (l) => l.includes(FAIL_MARKER) && l.includes('@optimystic/quereus-plugin-'),
  );

  // Extract the unique consumer descriptors from those lines
  const observed = new Set();
  for (const line of mismatchLines) {
    const matches = line.match(CONSUMER_RE);
    if (matches) {
      for (const m of matches) {
        observed.add(m);
      }
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
