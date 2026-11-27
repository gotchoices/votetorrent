#!/usr/bin/env node
/**
 * measure-bundle.mjs — the 56-02 gzip re-measure. MEASURES, NEVER GATES.
 *
 * THE ONE THING THIS SCRIPT MUST NOT DO: become a size budget. Bundle weight
 * is explicitly DEFERRED by owner decision (`56-CONTEXT.md` § Phase
 * Boundary; `.planning/STATE.md`, 2026-09-03 UAT walk: "page transfer
 * accepted at ~686 kB gzip ... and revisited in Phase 56 rather than gated
 * now"). This script contains NO threshold constant, NO comparison against
 * a prior figure, NO max/budget flag, and NO non-zero exit reachable from a
 * size value. A parse failure (the build itself failing, or Vite emitting no
 * `gzip:` line at all) is a real failure; a LARGE number is not. Nothing in
 * this file, and no Vite config in this app, may introduce
 * `build.chunkSizeWarningLimit` as a back-door budget.
 *
 * Takes the same `--build-config <path>` / `--dist <dirname>` flags as
 * `assert-no-node-polyfills.mjs` / `assert-single-quereus-instance.mjs`
 * (same contract, same default: no flags = production `dist/`).
 *
 * Standalone Node script, no new dependency.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const PREFIX = '[measure-bundle]';
const ROOT = process.cwd();

/** @param {string} name */
function getFlag(name) {
	const idx = process.argv.indexOf(name);
	return idx === -1 ? undefined : process.argv[idx + 1];
}
const BUILD_CONFIG = getFlag('--build-config');
const DIST_DIRNAME = getFlag('--dist') ?? 'dist';

/** @param {string} message */
function fail(message) {
	process.stderr.write(`${PREFIX} FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function info(message) {
	process.stdout.write(`${PREFIX} INFO: ${message}\n`);
}

/**
 * THE PARSE-AND-SUM FUNCTION. Vite's own build output prints one line per
 * emitted asset with a `gzip: N.NN kB` (or ` kB` variants) suffix; this
 * parses every such figure and sums it. Exported implicitly via module scope
 * so the self-control below exercises the SAME function the real measurement
 * uses, never a look-alike.
 *
 * Deliberately returns a plain number and NEVER throws or exits on a large
 * value — the only failure this function itself can produce is finding
 * literally nothing to parse, which the caller decides how to treat.
 *
 * @param {string} buildOutput
 * @returns {{ total: number, rows: Array<{ label: string, gzipKb: number }> }}
 */
export function parseGzipTotal(buildOutput) {
	// Vite's own asset line shape, e.g.:
	//   dist/assets/index-abc123.js   123.45 kB │ gzip: 45.67 kB
	// For large chunks Vite formats the RAW size column with a THOUSANDS
	// COMMA (e.g. "2,453.14 kB"), so the first size figure's pattern must
	// tolerate a comma — a plain `[\d.]+` silently fails to match the whole
	// line and drops the biggest asset from the sum, which is the exact
	// wrong-direction bug for a measurement instrument to carry. The `gzip:`
	// figure itself has never been observed with a comma in this repo's
	// build output, but `[\d,.]+` is used there too for the same reason.
	const lineRe = /^(.*?)\s+[\d,.]+\s*kB.*?gzip:\s*([\d,.]+)\s*kB/gm;
	/** @type {Array<{ label: string, gzipKb: number }>} */
	const rows = [];
	let total = 0;
	let match;
	while ((match = lineRe.exec(buildOutput)) !== null) {
		const label = match[1].trim();
		const gzipKb = Number.parseFloat(match[2].replace(/,/g, ''));
		if (Number.isNaN(gzipKb)) continue;
		rows.push({ label, gzipKb });
		total += gzipKb;
	}
	return { total, rows };
}

// ---------------------------------------------------------------------------
// Self-control, BEFORE the build. Feeds a synthetic build output whose
// `gzip:` figures total an absurd value (999999 kB) through the REAL
// parse-and-sum function, and asserts the function returns that total while
// this script's own exit path stays 0. This is the falsifiable form of
// "this cannot gate" — a comment saying so is not a control.
// ---------------------------------------------------------------------------
const SYNTHETIC_ABSURD_OUTPUT = [
	// Comma-formatted raw-size column, matching Vite's own thousands-comma
	// shape for large chunks — exercises the same tolerance the real
	// measurement needs (this app's own production JS chunk is already
	// large enough to trigger it: "2,453.14 kB").
	'dist/assets/index-aaaaaa.js    1,000,000.00 kB │ gzip: 500000.00 kB',
	'dist/assets/vendor-bbbbbb.js    999,999.00 kB │ gzip: 499999.00 kB',
].join('\n');
const selfControl = parseGzipTotal(SYNTHETIC_ABSURD_OUTPUT);
if (Math.abs(selfControl.total - 999999) > 0.01) {
	fail(
		`self-control: the synthetic absurd fixture (500000.00 + 499999.00 = 999999.00 kB) parsed as ${selfControl.total} kB — ` +
			'the parse-and-sum function is broken.',
	);
}
info(
	`self-control: parse-and-sum function correctly totalled a synthetic 999999 kB figure, and this script's exit path ` +
		'stays 0 regardless — proving this script is structurally incapable of gating on a size.',
);

// ---------------------------------------------------------------------------
// The real build + measurement.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const viteBuildArgs = [viteBin, 'build'];
if (BUILD_CONFIG) viteBuildArgs.push('--config', BUILD_CONFIG);
const build = spawnSync(process.execPath, viteBuildArgs, { encoding: 'utf8', cwd: ROOT });
const buildOutput = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;

if (build.status !== 0) {
	fail(`vite build exited ${build.status} — cannot measure a bundle that failed to build.\n--- captured output ---\n${buildOutput}`);
}

const { total, rows } = parseGzipTotal(buildOutput);
if (rows.length === 0) {
	fail(
		`no "gzip:" figure found anywhere in the vite build output for dist dirname "${DIST_DIRNAME}" — this is a ` +
			'PARSE failure (the measurement instrument is blind), not a size judgement.\n' +
			`--- captured output ---\n${buildOutput}`,
	);
}

process.stdout.write(`${PREFIX} per-asset gzip figures (dist: "${DIST_DIRNAME}", build config: ${BUILD_CONFIG ?? 'default (vite.config.ts)'}):\n`);
for (const row of rows) {
	process.stdout.write(`${PREFIX}   ${row.label}: ${row.gzipKb.toFixed(2)} kB gzip\n`);
}
info(`TOTAL gzip transfer for "${DIST_DIRNAME}": ${total.toFixed(2)} kB — measured only, no threshold, no comparison bar, no exit path reachable from this number.`);
process.exit(0);
