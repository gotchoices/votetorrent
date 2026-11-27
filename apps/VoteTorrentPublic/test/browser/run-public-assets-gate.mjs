#!/usr/bin/env node
/**
 * run-public-assets-gate.mjs — the D-20 definition-of-done instrument (56-06),
 * and its build-level negative control.
 *
 * Usage, from `apps/VoteTorrentPublic`:
 *
 *   node test/browser/run-public-assets-gate.mjs
 *   node test/browser/run-public-assets-gate.mjs --prove-absent
 *
 * The first spawns a real `vite build` (the app's own production config,
 * `vite.config.ts`) and requires all five rungs below to pass against the
 * served `dist/`. The second spawns a real `vite build --config
 * vite.gate.config.ts` (whose `publicDir: false` Task 1 deliberately kept)
 * and requires the THREE ASSET rungs (1-3) to FAIL against the served
 * `dist-gate/`, while the two control rungs (4-5) still pass unchanged. A
 * green inner run under `--prove-absent` is a hard failure with an explicit
 * message — without it, "every icon answers 200" would pass even against a
 * build this app already knows ships none.
 *
 * `vite build` is SPAWNED, never imported, so each mode exercises a real
 * artefact of a real build — the same discipline `run-live-read-gate.mjs`
 * states for itself, and this file's own direct precedent.
 *
 * PORT POLICY (56-PLAN-OUTLINE.md Amendment 3, the phase's settled map):
 * 5180/5181 dev+preview; 5183 the dashboard gate; 5191 this app's shared-
 * runner gate; 5192 the live-read gate; 5193 the placeholder-label +
 * render-fidelity gates; 5194 the empty-state gate (56-03); **this gate
 * takes 5195**; 5196/5197/5198 are reserved for `56-14`/`56-11`/`56-12` and
 * must never be bound here.
 *
 * TWO TRAPS THAT WOULD MAKE THE NAIVE VERSION OF THIS GATE STRUCTURALLY
 * INCAPABLE OF FAILING (both handled below, both recorded as rungs of their
 * own rather than silently avoided):
 *
 *   1. `serveDist` answers `/favicon.ico` with a hard-coded 204, unconditionally
 *      — the literal path `56-CONTEXT.md` names as the shipped defect. A rung
 *      built on that path would be permanently green no matter what the build
 *      contains. No rung here asserts on `/favicon.ico`; R5 instead asserts
 *      the 204 as a measured, named fact, so a future author who reaches for
 *      the obvious path is told why not, rather than shipping a vacuous rung.
 *   2. Headless Chromium does not reliably auto-request declared favicons, so
 *      a passive network-log watch can observe nothing and pass vacuously.
 *      R2 DRIVES the four requests explicitly via an in-page `fetch()`, and
 *      carries an anti-vacuity floor (>= 4 responses observed) rather than
 *      trusting an absence of 404s alone.
 *
 * Every href this file measures is read FROM THE RENDERED DOM (R1), never
 * transcribed into a second list here — a transcribed list could drift from
 * what the page actually declares and this gate would keep passing against
 * the stale copy.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const PORT = 5195;

const PROVE_ABSENT = process.argv.includes('--prove-absent');

const MODE = PROVE_ABSENT
	? {
			label: 'PROVE-ABSENT (inverted, against dist-gate/)',
			buildConfig: 'vite.gate.config.ts',
			distDir: path.join(APP_ROOT, 'dist-gate'),
			entryName: 'election-shell-gate.html',
		}
	: {
			label: 'normal (against dist/)',
			buildConfig: null,
			distDir: path.join(APP_ROOT, 'dist'),
			entryName: 'index.html',
		};

/** Asset rungs that MUST fail under --prove-absent; the control rungs (4, 5) must not. @type {ReadonlyArray<number>} */
const ASSET_RUNGS_MUST_FAIL = Object.freeze([1, 2, 3]);

/** @returns {Promise<void>} */
function buildDist() {
	return new Promise((resolve, reject) => {
		const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
		const args = MODE.buildConfig ? ['build', '--config', MODE.buildConfig] : ['build'];
		const child = spawn(process.execPath, [viteBin, ...args], { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`vite build exited ${code}`))));
	});
}

/**
 * Walk `dir` for the one file named `name`, relative to `dir`. Zero or more
 * than one match is a hard failure — a driver that guessed which entry to
 * serve would be a driver whose log claims to have gated a page nobody
 * asked for.
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
	if (matches.length === 0) throw new Error(`the build emitted no "${name}" under ${dir}`);
	if (matches.length > 1) throw new Error(`the build emitted ${matches.length} files named "${name}": ${matches.join(', ')}`);
	return matches[0];
}

/**
 * @typedef {{ id: number, name: string, ok: boolean, detail?: string }} Rung
 */

/** @type {Rung[]} */
const rungs = [];
/** @param {number} id @param {string} name @param {boolean} ok @param {string} [detail] */
function record(id, name, ok, detail) {
	rungs.push({ id, name, ok, detail });
}

/**
 * R1 — derive and classify the icon <link> tags from the rendered DOM. No
 * href is ever transcribed as a literal in this file.
 * @param {ReadonlyArray<{ rel: string, type: string, sizes: string, href: string }>} links
 * @returns {{ problems: string[], hrefs: string[], typeByHref: Record<string, string> }}
 */
function classifyLinks(links) {
	/** @type {string[]} */
	const problems = [];
	if (links.length !== 4) {
		problems.push(`expected exactly 4 icon <link> tags (rel="icon" or rel="apple-touch-icon"), found ${links.length}`);
	}
	const svgLinks = links.filter((l) => l.rel === 'icon' && l.type === 'image/svg+xml');
	const pngLinks = links.filter((l) => l.rel === 'icon' && l.type === 'image/png');
	const appleLinks = links.filter((l) => l.rel === 'apple-touch-icon');
	if (svgLinks.length !== 1) problems.push(`expected exactly 1 rel="icon" type="image/svg+xml" link, found ${svgLinks.length}`);
	if (pngLinks.length !== 2) problems.push(`expected exactly 2 rel="icon" type="image/png" links, found ${pngLinks.length}`);
	if (appleLinks.length !== 1) problems.push(`expected exactly 1 rel="apple-touch-icon" link, found ${appleLinks.length}`);
	const distinctPngSizes = new Set(pngLinks.map((l) => l.sizes));
	if (distinctPngSizes.size !== 2) problems.push(`expected 2 distinct "sizes" values among the png icon links, found: ${[...distinctPngSizes].join(', ')}`);

	const hrefs = links.map((l) => l.href);
	if (new Set(hrefs).size !== hrefs.length) problems.push('two or more icon <link> tags declare the same href');
	for (const href of hrefs) {
		if (!href || !href.startsWith('/')) problems.push(`href ${JSON.stringify(href)} does not start with "/"`);
		if (href === '/favicon.ico') problems.push('an icon <link> points at /favicon.ico — the one path that can never 404 on this server (see R5); no rung may be built on it');
	}

	/** @type {Record<string, string>} */
	const typeByHref = {};
	for (const l of links) typeByHref[l.href] = l.type || 'apple-touch-icon';

	return { problems, hrefs: hrefs.filter(Boolean), typeByHref };
}

async function main() {
	console.log(`[public-assets-gate] mode=${MODE.label} port=${PORT}`);
	await buildDist();

	if (!existsSync(MODE.distDir)) {
		console.error(`[public-assets-gate] ${MODE.distDir} does not exist after build — cannot proceed.`);
		process.exit(1);
	}
	const entryRel = resolveEntry(MODE.distDir, MODE.entryName);

	const server = await serveDist(MODE.distDir, PORT);
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		/** @type {string[]} */
		const consoleLines = [];
		page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

		const url = `${server.url}/${entryRel}`;
		console.log(`[public-assets-gate] navigating to ${url}`);
		await page.goto(url, { waitUntil: 'load' });

		// -------------------------------------------------------------
		// R1 — declaration, read from the rendered DOM.
		// -------------------------------------------------------------
		const rawLinks = await page.evaluate(() => {
			const nodes = Array.from(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]'));
			return nodes.map((el) => ({
				rel: el.getAttribute('rel') ?? '',
				type: el.getAttribute('type') ?? '',
				sizes: el.getAttribute('sizes') ?? '',
				href: el.getAttribute('href') ?? '',
			}));
		});
		const { problems: r1Problems, hrefs, typeByHref } = classifyLinks(rawLinks);
		record(1, 'declaration: exactly four icon <link> tags, correct rel/type/sizes shape, none naming favicon.ico', r1Problems.length === 0, r1Problems.join('; '));

		// -------------------------------------------------------------
		// R2/R3 — drive real requests for every href R1 found (never a
		// passive network-log watch — Chromium does not reliably
		// auto-request favicons), and inspect the real bytes.
		// -------------------------------------------------------------
		/** @type {Array<{ href: string, status: number, ok: boolean, contentType: string | null, length: number, error?: string }>} */
		const fetched = await page.evaluate(async (hrefsToFetch) => {
			/** @type {any[]} */
			const out = [];
			for (const href of hrefsToFetch) {
				try {
					const res = await fetch(href, { cache: 'no-store' });
					const buf = await res.arrayBuffer();
					out.push({ href, status: res.status, ok: res.ok, contentType: res.headers.get('content-type'), length: buf.byteLength });
				} catch (err) {
					out.push({ href, status: 0, ok: false, contentType: null, length: 0, error: String(err) });
				}
			}
			return out;
		}, hrefs);

		const nonOkResponses = fetched.filter((f) => !f.ok);
		const r2Problems = [];
		if (fetched.length < 4) r2Problems.push(`anti-vacuity floor not met: only ${fetched.length} response(s) observed (need >= 4) — R1 may have found too few hrefs to drive`);
		if (nonOkResponses.length > 0) r2Problems.push(`${nonOkResponses.length} favicon-shaped request(s) answered non-2xx: ${nonOkResponses.map((f) => `${f.href}=${f.status}`).join(', ')}`);
		record(2, `network-log: >= 4 driven requests observed, zero non-2xx among them (observed ${fetched.length})`, r2Problems.length === 0, r2Problems.join('; '));

		const r3Problems = [];
		if (fetched.length === 0) {
			// Anti-vacuity: zero responses to check must not read as "every
			// response passed" — that is exactly how this rung would fail to
			// discriminate against a build (like dist-gate/) whose page
			// declares no icon links at all, so R1/R2 drove nothing.
			r3Problems.push('no responses were available to check — R1/R2 found nothing to fetch, so this rung cannot be trusted');
		}
		for (const f of fetched) {
			if (f.length === 0) r3Problems.push(`${f.href} answered with a zero-length body`);
			const expectedType = typeByHref[f.href] === 'image/svg+xml' ? 'image/svg+xml' : 'image/png';
			if (f.contentType !== expectedType) r3Problems.push(`${f.href} content-type was "${f.contentType}", expected "${expectedType}"`);
		}
		record(3, 'bytes are real: every response has a non-zero body and the correct content-type', r3Problems.length === 0, r3Problems.join('; '));

		// -------------------------------------------------------------
		// R4 — the instrument can produce a 404 for this shape of path.
		// -------------------------------------------------------------
		const controlAbsent = await page.evaluate(async () => {
			try {
				const res = await fetch('/favicon-absent-control.png', { cache: 'no-store' });
				return { status: res.status };
			} catch (err) {
				return { status: 0, error: String(err) };
			}
		});
		record(4, 'anti-vacuity: a request for a favicon-shaped path that does not exist answers 404', controlAbsent.status === 404, `status=${controlAbsent.status}`);

		// -------------------------------------------------------------
		// R5 — the /favicon.ico trap, recorded rather than built upon.
		// -------------------------------------------------------------
		const faviconIco = await page.evaluate(async () => {
			try {
				const res = await fetch('/favicon.ico', { cache: 'no-store' });
				return { status: res.status };
			} catch (err) {
				return { status: 0, error: String(err) };
			}
		});
		record(
			5,
			'trap, recorded: serveDist answers /favicon.ico with a hard-coded 204 regardless of build content — this is why no rung above is built on that path',
			faviconIco.status === 204,
			`status=${faviconIco.status}`,
		);

		console.log('\n===== page console =====');
		for (const line of consoleLines) console.log(line);

		console.log('\n===== rungs =====');
		for (const rung of rungs) {
			console.log(`  ${rung.ok ? 'ok  ' : 'FAIL'}  R${rung.id} · ${rung.name}${rung.detail ? ` — ${rung.detail}` : ''}`);
		}

		if (!PROVE_ABSENT) {
			const failed = rungs.filter((r) => !r.ok);
			if (failed.length > 0) {
				console.error(`\n[public-assets-gate] FAIL — ${failed.length}/${rungs.length} rung(s) failed`);
				process.exit(1);
			}
			console.log(`\n[public-assets-gate] PASS — all ${rungs.length} rungs passed against ${path.relative(APP_ROOT, MODE.distDir)}/`);
			return;
		}

		// The inversion: the three ASSET rungs must have FAILED; the two
		// control rungs must still have PASSED. A control that fails for an
		// unrelated reason would look identical to a working one and would
		// silently stop proving anything.
		/** @type {Map<number, Rung>} */
		const byId = new Map(rungs.map((r) => [r.id, r]));
		/** @type {string[]} */
		const inversionProblems = [];
		for (const id of ASSET_RUNGS_MUST_FAIL) {
			const rung = byId.get(id);
			if (!rung) inversionProblems.push(`rung ${id} did not run at all`);
			else if (rung.ok) inversionProblems.push(`rung ${id} ("${rung.name}") PASSED against dist-gate/ — the control did NOT fire`);
		}
		for (const rung of rungs) {
			if (!ASSET_RUNGS_MUST_FAIL.includes(rung.id) && !rung.ok) {
				inversionProblems.push(`rung ${rung.id} ("${rung.name}") failed for an unrelated reason: ${rung.detail}`);
			}
		}

		if (inversionProblems.length > 0) {
			console.error(
				'\n[public-assets-gate] --prove-absent CONTROL FAILED — could not prove this gate can go red.\n' +
					`Against a build with publicDir: false (${path.relative(APP_ROOT, MODE.distDir)}/), rungs ${ASSET_RUNGS_MUST_FAIL.join(', ')} must FAIL and the other two must still PASS.\n` +
					inversionProblems.map((p) => `  - ${p}`).join('\n'),
			);
			process.exit(1);
		}
		console.log(
			`\n[public-assets-gate] PROVE-ABSENT PASS — against ${path.relative(APP_ROOT, MODE.distDir)}/, rungs ${ASSET_RUNGS_MUST_FAIL.join(', ')} correctly failed and the two control rungs still passed`,
		);
	} finally {
		await browser.close();
		await server.close();
	}
}

main().catch((err) => {
	console.error('[public-assets-gate] driver error:', err);
	process.exit(1);
});
