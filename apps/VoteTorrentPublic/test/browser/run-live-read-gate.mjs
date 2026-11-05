#!/usr/bin/env node
/**
 * run-live-read-gate.mjs — the driver for D-27's live-read gate, and its
 * inversion control.
 *
 * Usage, from `apps/VoteTorrentPublic`:
 *
 *   node test/browser/run-live-read-gate.mjs
 *   node test/browser/run-live-read-gate.mjs --prove-frozen
 *
 * The first requires all nine rungs to pass. The second re-runs the IDENTICAL
 * build and the IDENTICAL page with `?control=nolisten`, which skips the
 * writing handle's `enableChangePropagation` call and nothing else, and
 * INVERTS the verdict: rungs 8 and 9 MUST fail. A green control is a hard
 * failure with an explicit message, because without it "the page updated"
 * passes vacuously — a gate that cannot tell a live seam from a frozen page
 * is measuring nothing.
 *
 * `vite build` is SPAWNED, never imported, so the gate exercises a real
 * artefact of a real build. `serveDist` serves that artefact; `vite dev` is
 * never a gate. The port is 5192, distinct from the 5191 the shell gate's
 * runner binds, so the two can run back to back without racing a bind.
 *
 * DELIBERATELY NOT WIRED into `package.json` or `web-gates.yml`: attaching
 * this gate to `run-ui-gates.mjs`, to a script and to CI is 54-18's. A script
 * added here would be this plan claiming a hand-off it did not make.
 *
 * Page `console` and `pageerror` events are forwarded into the run log. A
 * render throw must be visible as a throw, not as a mystery timeout.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const DIST_LIVE = path.join(APP_ROOT, 'dist-live');
const BUILD_CONFIG = 'vite.live.config.ts';
const ENTRY_NAME = 'live-read-gate.html';
const PORT = 5192;

/** The two rungs the inversion control requires to FAIL. @type {ReadonlyArray<number>} */
const FROZEN_MUST_FAIL = Object.freeze([8, 9]);

const PROVE_FROZEN = process.argv.includes('--prove-frozen');

/** @returns {Promise<void>} */
function buildGate() {
	return new Promise((resolve, reject) => {
		const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
		const child = spawn(process.execPath, [viteBin, 'build', '--config', BUILD_CONFIG], {
			cwd: APP_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve(undefined) : reject(new Error(`vite build --config ${BUILD_CONFIG} exited ${code}`)),
		);
	});
}

/**
 * Walk `dir` for the one file named `name` and return its path RELATIVE to
 * `dir`. Zero matches and more than one are both hard failures: a driver that
 * guessed which entry to serve would be a driver whose log claims to have
 * gated a page nobody asked for.
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function resolveEntry(dir, name) {
	/** @type {string[]} */
	const matches = [];
	/** @param {string} current */
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === name) matches.push(path.relative(dir, full));
		}
	};
	walk(dir);
	if (matches.length === 0) throw new Error(`the gate build emitted no "${name}" under ${dir}`);
	if (matches.length > 1) throw new Error(`the gate build emitted ${matches.length} files named "${name}": ${matches.join(', ')}`);
	return matches[0];
}

async function main() {
	console.log(`[live-read-gate] mode=${PROVE_FROZEN ? 'PROVE-FROZEN (inverted)' : 'normal'} config=${BUILD_CONFIG} out=dist-live port=${PORT}`);
	await buildGate();
	const entryRel = resolveEntry(DIST_LIVE, ENTRY_NAME);

	const server = await serveDist(DIST_LIVE, PORT);
	const browser = await chromium.launch();
	/** @type {any} */
	let readout = null;
	/** @type {string[]} */
	const lines = [];
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));

		const url = `${server.url}/${entryRel}${PROVE_FROZEN ? '?control=nolisten' : ''}`;
		console.log(`[live-read-gate] ${url}`);
		// ONE navigation, for the whole run. The write and the assertion happen
		// in this single page load; a second `goto` or a `location.reload()`
		// would prove nothing about the seam.
		await page.goto(url, { waitUntil: 'load' });
		await page
			.waitForFunction(() => /** @type {any} */ (window).__LIVE_READ_GATE_DONE__ === true, null, { timeout: 240_000 })
			.catch(() => {});
		readout = await page.evaluate(() => /** @type {any} */ (window).__LIVE_READ_GATE__ ?? null);
	} finally {
		await browser.close();
		await server.close();
	}

	console.log('\n===== page output =====');
	for (const line of lines) console.log(line);

	if (!readout) {
		console.error('[live-read-gate] NO READOUT — the page never published __LIVE_READ_GATE__');
		process.exit(1);
	}
	if (readout.crashed) {
		console.error('[live-read-gate] CRASHED:\n' + readout.crashed);
	}

	console.log('\n===== rungs =====');
	for (const rung of readout.rungs ?? []) {
		console.log(`  ${rung.ok ? 'ok  ' : 'FAIL'}  ${String(rung.id).padStart(2)} · ${rung.name}${rung.detail ? ` — ${rung.detail}` : ''}`);
	}
	console.log(`RUNGS: ${readout.passed}/${readout.total}`);
	console.log(`before: ${JSON.stringify(String(readout.beforeText ?? '').slice(0, 160))}`);
	console.log(`after:  ${JSON.stringify(String(readout.afterText ?? '').slice(0, 160))}`);
	console.log(`navigation entries: ${readout.navBefore} -> ${readout.navAfter}; load nonce ${readout.loadNonce}`);

	if (!PROVE_FROZEN) {
		if (readout.passed !== readout.total || readout.total !== 9) {
			console.error(`[live-read-gate] FAIL — expected 9/9, got ${readout.passed}/${readout.total}`);
			process.exit(1);
		}
		console.log('[live-read-gate] PASS — the page re-rendered on a second-handle write, in one page load');
		return;
	}

	// The inversion. Rungs 8 and 9 must have FAILED, and every other rung must
	// still have passed — a control that fails for an unrelated reason (a
	// broken seed, a moved parameter name) would look identical to a working
	// one, and would silently stop proving anything.
	/** @type {Map<number, any>} */
	const byId = new Map((readout.rungs ?? []).map((/** @type {any} */ r) => [r.id, r]));
	/** @type {string[]} */
	const problems = [];
	for (const id of FROZEN_MUST_FAIL) {
		const rung = byId.get(id);
		if (!rung) problems.push(`rung ${id} did not run at all`);
		else if (rung.ok) problems.push(`rung ${id} ("${rung.name}") PASSED with propagation disabled`);
	}
	for (const rung of readout.rungs ?? []) {
		if (!FROZEN_MUST_FAIL.includes(rung.id) && !rung.ok) {
			problems.push(`rung ${rung.id} ("${rung.name}") failed for an unrelated reason: ${rung.detail}`);
		}
	}

	if (problems.length > 0) {
		console.error(
			'\n[live-read-gate] INVERSION CONTROL FAILED — this gate cannot discriminate a live seam from a frozen page.\n' +
				'With change propagation switched OFF at the writing handle, rungs 8 and 9 must FAIL and the other seven must pass.\n' +
				problems.map((p) => `  - ${p}`).join('\n'),
		);
		process.exit(1);
	}
	console.log('[live-read-gate] PROVE-FROZEN PASS — with propagation disabled, rungs 8 and 9 failed and the other seven passed');
}

main().catch((err) => {
	console.error('[live-read-gate] driver error:', err);
	process.exit(1);
});
