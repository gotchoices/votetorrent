#!/usr/bin/env node
/**
 * run-liveness-gate.mjs — the browser-tier proof of Surface 5 (56-14, D-16's
 * UI feedback half / D-19's UI half) against COMPUTED style, on a real page.
 *
 * Modelled in shape on `test/offline/run-offline-gate.mjs`: the Playwright
 * import, `chromium.launch({ headless: true })`, `serveDist`, the dist walk
 * that resolves the built entry by SEARCH, the frozen `RUNG_IDS` registry
 * with `record(id, passed, detail)` throwing on any unregistered id, pure
 * exported comparators exercised by `--prove-matchers` against both a
 * violating and a healthy input, and a flag parser that exits 2 on an
 * unrecognised argument.
 *
 * THE BOUNDARY THIS GATE DOES AND DOES NOT CARRY. Everything from the
 * external-write seam onward is production code -- the store write, the
 * effective-change derivation, `subscribe.js`'s projection, the hook, the
 * render and the CSS. The libp2p transport and the threshold-signature
 * verification IN FRONT OF that seam are `56-11`'s proof (`test:mesh-read`)
 * and are NOT re-proven here. A reader who quotes this gate as proof that a
 * MESH write lights the badge is double-counting `56-11`'s evidence.
 *
 * PORT POLICY (`56-PLAN-OUTLINE.md` Amendment 3): this gate takes **5196**.
 * A bound port fails loudly; `serveDist` rejects on `EADDRINUSE` rather than
 * silently choosing another.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-liveness/` rather than rebuilding.
 *   --prove-matchers   Run every comparator against a violating input AND a
 *                      healthy one, requiring the first to FAIL and the
 *                      second to PASS. Needs no browser and no build.
 *   --port <n>         Override the bound port.
 * Any other argument exits 2 naming it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { COPY } from '@votetorrent/ui-web';
import { UNHELD_ELECTION_ID, LIVENESS_ELECTION_ID } from '../fixtures/seed-public-surface.js';
import { ELECTION_ID_PATTERN } from '../../src/election-address.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-liveness');
const GATE_ENTRY = 'liveness-gate.html';
const GATE_CONFIG = 'vite.liveness.config.ts';
const DEFAULT_PORT = 5196;
const LABEL = 'run-liveness-gate';

/**
 * Two distinct, production-length replacement titles -- distinct from each
 * other and from the seeded fixture title, each at least 28 characters
 * (`project_ui_defects_invisible_to_every_tier` -- a short fixture cannot
 * fail).
 * @type {string}
 */
const REPLACEMENT_TITLE_PEER = 'Peer-Replicated Election Title Update';
/** @type {string} */
const REPLACEMENT_TITLE_LOCAL = 'Locally-Applied Election Title Change';

/** @type {ReadonlyArray<string>} */
export const RUNG_IDS = Object.freeze([
	'badge-absent-before-any-update',
	'badge-appears-on-peer-write',
	'badge-auto-clears-at-duration',
	'badge-silent-on-local-write',
	'badge-suppressed-when-connection-down',
	'badge-transition-gated-by-reduced-motion',
]);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/** @param {string} id @param {boolean} passed @param {string} detail */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	rungs.push({ id, passed, detail });
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// THE COMPARATORS — pure functions over values already read out of the
// page, so `--prove-matchers` can exercise each with no browser at all.
// ---------------------------------------------------------------------------

/** @typedef {{ passed: boolean, detail: string }} Verdict */

/**
 * @param {{ badgeCount: number, statusBannerPresent: boolean, statusBannerTonePresent: boolean }} m
 * @returns {Verdict}
 */
export function evaluateBadgeAbsentBeforeUpdate(m) {
	/** @type {string[]} */
	const failures = [];
	if (!m.statusBannerPresent) failures.push('.status-banner is absent — the claim would be vacuous');
	if (!m.statusBannerTonePresent) failures.push('.status-banner__tone is absent — the claim would be vacuous');
	if (m.badgeCount !== 0) failures.push(`${m.badgeCount} .live-update-badge element(s) present before any update`);
	return failures.length === 0
		? { passed: true, detail: 'zero .live-update-badge, with .status-banner and .status-banner__tone present' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ effectiveChangeCount: number, badgeCount: number, badgeText: string, badgeHeight: number, badgeColor: string, badgeBorderColor: string, badgeIsLastChild: boolean, headlineThenBadge: boolean, titleText: string }} m
 * @param {{ ok: string, fail: string }} tokens
 * @param {string} expectedText
 * @param {string} expectedTitle
 * @returns {Verdict}
 */
export function evaluateBadgeAppearsOnPeerWrite(m, tokens, expectedText, expectedTitle) {
	/** @type {string[]} */
	const failures = [];
	if (!(m.effectiveChangeCount > 0)) failures.push('applyPeerBatch reported zero effective changes — the write was a no-op');
	if (m.badgeCount !== 1) failures.push(`${m.badgeCount} .live-update-badge element(s) (want exactly 1)`);
	if (m.badgeText !== expectedText) failures.push(`badge text "${m.badgeText}" (want "${expectedText}")`);
	if (!(m.badgeHeight > 0)) failures.push(`badge laid-out height is ${m.badgeHeight} — a class attribute is not rendering`);
	if (m.badgeColor !== tokens.ok) failures.push(`badge color "${m.badgeColor}" (want --ok "${tokens.ok}")`);
	if (m.badgeBorderColor !== tokens.ok) failures.push(`badge border-top-color "${m.badgeBorderColor}" (want --ok "${tokens.ok}")`);
	if (m.badgeColor === tokens.fail || m.badgeBorderColor === tokens.fail) failures.push('badge colour equals --fail');
	if (!m.badgeIsLastChild) failures.push('badge is not the last element child of .status-banner');
	if (!m.headlineThenBadge) failures.push('badge does not follow .status-banner__headline in document position');
	if (m.titleText !== expectedTitle) failures.push(`rendered .election-title "${m.titleText}" (want "${expectedTitle}")`);
	return failures.length === 0
		? { passed: true, detail: `badge text "${m.badgeText}", colour resolves to --ok, last child after the headline, title shows "${m.titleText}"` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ half: { badgeCount: number, statusBannerPresent: boolean, titleText: string }, after: { badgeCount: number, statusBannerPresent: boolean, titleText: string } }} m
 * @param {string} expectedTitle
 * @returns {Verdict}
 */
export function evaluateBadgeAutoClears(m, expectedTitle) {
	/** @type {string[]} */
	const failures = [];
	if (m.half.badgeCount !== 1) failures.push(`at the half-duration check, ${m.half.badgeCount} badge(s) present (want 1)`);
	if (!m.half.statusBannerPresent) failures.push('at the half-duration check, .status-banner is absent');
	if (m.half.titleText !== expectedTitle) failures.push(`at the half-duration check, title is "${m.half.titleText}" (want "${expectedTitle}")`);
	if (m.after.badgeCount !== 0) failures.push(`after the full duration, ${m.after.badgeCount} badge(s) still present (want 0)`);
	if (!m.after.statusBannerPresent) failures.push('after the full duration, .status-banner is absent — the clearance is not isolated to the badge');
	if (m.after.titleText !== expectedTitle) failures.push(`after the full duration, title is "${m.after.titleText}" (want "${expectedTitle}") — the clearance is not isolated to the badge`);
	return failures.length === 0
		? { passed: true, detail: 'badge present at the half-duration check, absent after the full duration, page otherwise unchanged both times' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ titleChanged: boolean, badgeSeenDuringWindow: boolean }} m
 * @returns {Verdict}
 */
export function evaluateBadgeSilentOnLocalWrite(m) {
	/** @type {string[]} */
	const failures = [];
	if (!m.titleChanged) failures.push('the rendered .election-title never changed — the notice channel did not demonstrably fire, so this rung proves nothing');
	if (m.badgeSeenDuringWindow) failures.push('.live-update-badge appeared during the observation window following a LOCAL write');
	return failures.length === 0
		? { passed: true, detail: 'the title changed (the read demonstrably re-ran) and zero .live-update-badge appeared during the observation window' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ stalenessBannerPresent: boolean, badgeSeenDuringWindow: boolean }} m
 * @returns {Verdict}
 */
export function evaluateBadgeSuppressedWhenDown(m) {
	/** @type {string[]} */
	const failures = [];
	if (!m.stalenessBannerPresent) failures.push('.staleness-banner is absent — the connection is not genuinely down, so this rung proves nothing');
	if (m.badgeSeenDuringWindow) failures.push('.live-update-badge appeared during the observation window while the connection was down');
	return failures.length === 0
		? { passed: true, detail: '.staleness-banner present (connection genuinely down) and zero .live-update-badge appeared after a peer write' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ noPreference: { duration: string, property: string, shorthand: string }, reduce: { duration: string, property: string, shorthand: string } }} m
 * @returns {Verdict}
 */
export function evaluateTransitionGatedByReducedMotion(m) {
	/** @type {string[]} */
	const failures = [];
	if (m.noPreference.duration !== '0.2s') failures.push(`no-preference transition-duration "${m.noPreference.duration}" (want "0.2s")`);
	if (m.noPreference.property !== 'opacity') failures.push(`no-preference transition-property "${m.noPreference.property}" (want "opacity")`);
	if (m.reduce.duration !== '0s') failures.push(`reduce transition-duration "${m.reduce.duration}" (want "0s")`);
	if (m.reduce.property === 'opacity') failures.push('reduce transition-property is "opacity" — the media gate did not engage');
	if (m.noPreference.shorthand === m.reduce.shorthand) {
		failures.push(
			`the two computed transition shorthand strings are IDENTICAL ("${m.noPreference.shorthand}") — getComputedStyle().transition is never the ` +
				'empty string (it resolves to the UA default when nothing applies), so an "absent" check written as falsy/empty-string would pass even if the media query were deleted',
		);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `no-preference: duration ${m.noPreference.duration}, property ${m.noPreference.property}; reduce: duration ${m.reduce.duration}, property ${m.reduce.property}; the two computed shorthand strings differ`,
			}
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — matcher positive controls (`--prove-matchers`).
// ---------------------------------------------------------------------------

const HEALTHY_TOKENS = Object.freeze({ ok: 'rgb(34, 197, 94)', fail: 'rgb(239, 68, 68)' });

/** @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>} */
function matcherControls() {
	return Object.freeze([
		{
			label: 'badge-absent-before-any-update vs. a page with a badge already present',
			violating: evaluateBadgeAbsentBeforeUpdate({ badgeCount: 1, statusBannerPresent: true, statusBannerTonePresent: true }),
			healthy: evaluateBadgeAbsentBeforeUpdate({ badgeCount: 0, statusBannerPresent: true, statusBannerTonePresent: true }),
		},
		{
			label: 'badge-appears-on-peer-write vs. a badge coloured --fail with a stale title',
			violating: evaluateBadgeAppearsOnPeerWrite(
				{
					effectiveChangeCount: 1,
					badgeCount: 1,
					badgeText: 'UPDATED',
					badgeHeight: 18,
					badgeColor: HEALTHY_TOKENS.fail,
					badgeBorderColor: HEALTHY_TOKENS.fail,
					badgeIsLastChild: true,
					headlineThenBadge: true,
					titleText: 'stale title',
				},
				HEALTHY_TOKENS,
				'UPDATED',
				'new title',
			),
			healthy: evaluateBadgeAppearsOnPeerWrite(
				{
					effectiveChangeCount: 1,
					badgeCount: 1,
					badgeText: 'UPDATED',
					badgeHeight: 18,
					badgeColor: HEALTHY_TOKENS.ok,
					badgeBorderColor: HEALTHY_TOKENS.ok,
					badgeIsLastChild: true,
					headlineThenBadge: true,
					titleText: 'new title',
				},
				HEALTHY_TOKENS,
				'UPDATED',
				'new title',
			),
		},
		{
			label: 'badge-auto-clears-at-duration vs. a badge that never clears',
			violating: evaluateBadgeAutoClears(
				{ half: { badgeCount: 1, statusBannerPresent: true, titleText: 'T' }, after: { badgeCount: 1, statusBannerPresent: true, titleText: 'T' } },
				'T',
			),
			healthy: evaluateBadgeAutoClears(
				{ half: { badgeCount: 1, statusBannerPresent: true, titleText: 'T' }, after: { badgeCount: 0, statusBannerPresent: true, titleText: 'T' } },
				'T',
			),
		},
		{
			label: 'badge-silent-on-local-write vs. a badge that appears anyway',
			violating: evaluateBadgeSilentOnLocalWrite({ titleChanged: true, badgeSeenDuringWindow: true }),
			healthy: evaluateBadgeSilentOnLocalWrite({ titleChanged: true, badgeSeenDuringWindow: false }),
		},
		{
			label: 'badge-suppressed-when-connection-down vs. a badge lit while genuinely down',
			violating: evaluateBadgeSuppressedWhenDown({ stalenessBannerPresent: true, badgeSeenDuringWindow: true }),
			healthy: evaluateBadgeSuppressedWhenDown({ stalenessBannerPresent: true, badgeSeenDuringWindow: false }),
		},
		{
			label: 'badge-transition-gated-by-reduced-motion vs. a media query that never engaged (identical computed values)',
			violating: evaluateTransitionGatedByReducedMotion({
				noPreference: { duration: '0s', property: 'all', shorthand: 'all 0s ease 0s' },
				reduce: { duration: '0s', property: 'all', shorthand: 'all 0s ease 0s' },
			}),
			healthy: evaluateTransitionGatedByReducedMotion({
				noPreference: { duration: '0.2s', property: 'opacity', shorthand: 'opacity 0.2s ease-out 0s' },
				reduce: { duration: '0s', property: 'all', shorthand: 'all 0s ease 0s' },
			}),
		},
	]);
}

function runProveMatchers() {
	const controls = matcherControls();
	let inert = 0;
	let indiscriminate = 0;
	for (const control of controls) {
		if (control.violating.passed) {
			inert += 1;
			process.stderr.write(`[${LABEL}] matcher is inert — "${control.label}" did not fail its violating input.\n`);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(`[${LABEL}] matcher is indiscriminate — "${control.label}" ALSO failed its healthy input: ${control.healthy.detail}\n`);
		}
	}
	if (inert > 0 || indiscriminate > 0) fail(`${inert} comparator(s) inert, ${indiscriminate} indiscriminate, out of ${controls.length}.`);
	process.stdout.write(`[${LABEL}] OK: all ${controls.length} comparators FAIL on a violating input and PASS on a healthy one.\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Build / serve / drive plumbing.
// ---------------------------------------------------------------------------

/** @returns {Promise<void>} */
function buildGate() {
	return new Promise((resolvePromise, rejectPromise) => {
		const viteBin = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
		if (!existsSync(viteBin)) fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
		const child = spawn(process.execPath, [viteBin, 'build', '--config', GATE_CONFIG], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => (code === 0 ? resolvePromise(undefined) : rejectPromise(new Error(`vite build --config ${GATE_CONFIG} exited ${code}`))));
	});
}

/** @returns {string} */
function resolveGateEntry() {
	if (!existsSync(DIST)) fail(`gate dist "${DIST}" does not exist — run \`yarn build:liveness\` or drop --skip-build.`);
	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walk(full));
			else if (entry.name === GATE_ENTRY) out.push(full);
		}
		return out;
	}
	const matches = walk(DIST);
	if (matches.length !== 1) fail(`expected exactly one "${GATE_ENTRY}" under "${DIST}", found ${matches.length}.`);
	return path.relative(DIST, matches[0]).split(path.sep).join('/');
}

/**
 * Read every rung's raw material off the live page in one evaluate.
 * @param {import('playwright').Page} page
 */
function readPage(page) {
	return page.evaluate(() => {
		/** @param {string} name @returns {string} */
		const tokenOf = (name) => {
			const probe = document.createElement('div');
			probe.style.display = 'none';
			probe.style.color = `var(${name})`;
			document.body.appendChild(probe);
			const resolved = getComputedStyle(probe).color;
			probe.remove();
			return resolved.trim();
		};
		const root = document.getElementById('root');
		const readout = /** @type {any} */ (globalThis).__LIVENESS_GATE__ ?? null;

		const statusBanner = root ? root.querySelector('.status-banner') : null;
		const statusBannerTone = statusBanner ? statusBanner.querySelector('.status-banner__tone') : null;
		const headline = statusBanner ? statusBanner.querySelector('.status-banner__headline') : null;
		const badges = root ? [...root.querySelectorAll('.live-update-badge')] : [];
		const badge = badges[0] ?? null;
		const badgeStyle = badge ? getComputedStyle(badge) : null;
		const stalenessBanner = root ? root.querySelector('.staleness-banner') : null;
		const titleEl = root ? root.querySelector('.election-title') : null;

		return {
			readout,
			tokens: { ok: tokenOf('--ok'), fail: tokenOf('--fail'), warn: tokenOf('--warn'), text: tokenOf('--text') },
			statusBannerPresent: statusBanner !== null,
			statusBannerTonePresent: statusBannerTone !== null,
			stalenessBannerPresent: stalenessBanner !== null,
			badgeCount: badges.length,
			badgeText: badge ? (badge.textContent ?? '') : '',
			badgeHeight: badge ? badge.getBoundingClientRect().height : 0,
			badgeColor: badgeStyle ? badgeStyle.color : '',
			badgeBorderColor: badgeStyle ? badgeStyle.borderTopColor : '',
			badgeIsLastChild: statusBanner !== null && badge !== null && statusBanner.lastElementChild === badge,
			headlineThenBadge: !!(headline && badge && headline.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING),
			titleText: titleEl ? (titleEl.textContent ?? '') : '',
		};
	});
}

/**
 * Anti-vacuity, before any rung runs. Each check is its own named hard stop.
 * @param {any} m the readPage() result
 * @returns {string | null} a bail message, or null if clear.
 */
function checkVacuity(m) {
	if (m.readout === null) return 'the harness never published its readout — the page did not finish.';
	if (m.readout.error !== null) return `the harness recorded a seed/render/feed-parameter error: ${m.readout.error}`;
	if (!m.readout.handleRecorded) return 'no handle was recorded by the harness source seam.';
	const id = m.readout.requestedElectionId;
	if (typeof id !== 'string' || id.length === 0) return `the requested election id is absent: ${JSON.stringify(id)}`;
	if (id === UNHELD_ELECTION_ID) return 'the requested election id equals UNHELD_ELECTION_ID -- this navigation did not test what it claims to.';
	if (id.length < 43) return `the requested election id is shorter than 43 characters (${id.length}): "${id}"`;
	if (!ELECTION_ID_PATTERN.test(id)) return `the requested election id fails ELECTION_ID_PATTERN: "${id}"`;
	if (id !== LIVENESS_ELECTION_ID) return `the requested election id "${id}" is not this gate's own LIVENESS_ELECTION_ID`;
	const ms = m.readout.liveUpdateBadgeMs;
	if (typeof ms !== 'number' || ms < 1000) return `the readout's LIVE_UPDATE_BADGE_MS is absent, not a number, or under 1000ms: ${JSON.stringify(ms)}`;
	for (const [name, value] of Object.entries(m.tokens)) {
		if (!value) return `design token --${name} did not resolve to a computed colour — the page has likely lost its stylesheet.`;
	}
	if (m.tokens.ok === m.tokens.fail) return `--ok and --fail resolve to the same colour (${m.tokens.ok}) — the token layer is not distinguishing them.`;
	return null;
}

/**
 * Navigate `page` to `url` and wait (bounded) for the harness's own readout
 * to publish.
 * @param {import('playwright').Page} page
 * @param {string} url
 * @returns {Promise<void>}
 */
async function gotoAndWait(page, url) {
	await page.goto(url, { waitUntil: 'load' });
	await page.waitForFunction(() => /** @type {any} */ (globalThis).__UI_GATE_DONE__ === true, null, { timeout: 60_000 }).catch(() => {});
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ badgeCount: number }>}
 */
function readBadgeOnly(page) {
	return page.evaluate(() => {
		const root = document.getElementById('root');
		return { badgeCount: root ? root.querySelectorAll('.live-update-badge').length : 0 };
	});
}

/**
 * Poll `readBadgeOnly` for `durationMs`, returning `true` iff a badge was
 * ever observed. Bounded by a fixed step count, never a busy loop.
 * @param {import('playwright').Page} page
 * @param {number} durationMs
 * @returns {Promise<boolean>}
 */
async function badgeSeenDuring(page, durationMs) {
	const stepMs = 200;
	const steps = Math.max(1, Math.ceil(durationMs / stepMs));
	let seen = false;
	for (let i = 0; i < steps; i += 1) {
		const m = await readBadgeOnly(page);
		if (m.badgeCount > 0) seen = true;
		await page.waitForTimeout(stepMs);
	}
	return seen;
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let port = DEFAULT_PORT;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') return runProveMatchers();
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	if (!skipBuild) await buildGate();
	const entryRel = resolveGateEntry();

	/** @type {Awaited<ReturnType<typeof serveDist>> | undefined} */
	let server;
	/** @type {import('playwright').Browser | undefined} */
	let browser;
	try {
		server = await serveDist(DIST, port);
		browser = await chromium.launch({ headless: true });

		// -- Rungs 1-3: one page, feed=running -------------------------------
		{
			const page = await browser.newPage();
			await gotoAndWait(page, `${server.url}/${entryRel}?feed=running`);
			let m = await readPage(page);
			let vacuity = checkVacuity(m);
			if (vacuity) fail(`rungs 1-3 (feed=running, before any update): ${vacuity}`);

			{
				const v = evaluateBadgeAbsentBeforeUpdate(m);
				record('badge-absent-before-any-update', v.passed, v.detail);
			}

			const effectiveChangeCount = await page.evaluate(
				(/** @type {string} */ title) => /** @type {any} */ (globalThis).__LIVENESS_GATE__.applyPeerBatch(title),
				REPLACEMENT_TITLE_PEER,
			);
			// Wait for the re-render, bounded, before reading computed style.
			await page
				.waitForFunction(
					(/** @type {string} */ expected) => document.querySelector('#root .election-title')?.textContent === expected,
					REPLACEMENT_TITLE_PEER,
					{ timeout: 10_000 },
				)
				.catch(() => {});
			m = await readPage(page);
			vacuity = checkVacuity(m);
			if (vacuity) fail(`rung 2 (badge-appears-on-peer-write): ${vacuity}`);
			{
				const v = evaluateBadgeAppearsOnPeerWrite(
					{ ...m, effectiveChangeCount },
					{ ok: m.tokens.ok, fail: m.tokens.fail },
					COPY['public.liveUpdate.badge'],
					REPLACEMENT_TITLE_PEER,
				);
				record('badge-appears-on-peer-write', v.passed, v.detail);
			}

			const badgeMs = m.readout.liveUpdateBadgeMs;
			await page.waitForTimeout(Math.round(badgeMs / 2));
			const half = await readPage(page);
			await page.waitForTimeout(badgeMs / 2 + 1000);
			const after = await readPage(page);
			{
				const v = evaluateBadgeAutoClears(
					{
						half: { badgeCount: half.badgeCount, statusBannerPresent: half.statusBannerPresent, titleText: half.titleText },
						after: { badgeCount: after.badgeCount, statusBannerPresent: after.statusBannerPresent, titleText: after.titleText },
					},
					REPLACEMENT_TITLE_PEER,
				);
				record('badge-auto-clears-at-duration', v.passed, v.detail);
			}
			await page.close();
		}

		// -- Rung 4: fresh reload, feed=running, the discrimination path -----
		{
			const page = await browser.newPage();
			await gotoAndWait(page, `${server.url}/${entryRel}?feed=running`);
			let m = await readPage(page);
			let vacuity = checkVacuity(m);
			if (vacuity) fail(`rung 4 (before applyLocalWrite): ${vacuity}`);
			const titleBefore = m.readout.requestedElectionId; // sanity anchor, not asserted on

			await page.evaluate((/** @type {string} */ title) => /** @type {any} */ (globalThis).__LIVENESS_GATE__.applyLocalWrite(title), REPLACEMENT_TITLE_LOCAL);
			await page
				.waitForFunction(
					(/** @type {string} */ expected) => document.querySelector('#root .election-title')?.textContent === expected,
					REPLACEMENT_TITLE_LOCAL,
					{ timeout: 10_000 },
				)
				.catch(() => {});
			m = await readPage(page);
			const titleChanged = m.titleText === REPLACEMENT_TITLE_LOCAL;
			const badgeSeenDuringWindow = titleChanged ? await badgeSeenDuring(page, m.readout.liveUpdateBadgeMs + 500) : false;
			void titleBefore;
			{
				const v = evaluateBadgeSilentOnLocalWrite({ titleChanged, badgeSeenDuringWindow });
				record('badge-silent-on-local-write', v.passed, v.detail);
			}
			await page.close();
		}

		// -- Rung 5: fresh reload, feed=stopped -------------------------------
		{
			const page = await browser.newPage();
			await gotoAndWait(page, `${server.url}/${entryRel}?feed=stopped`);
			const m0 = await readPage(page);
			const vacuity = checkVacuity(m0);
			if (vacuity) fail(`rung 5 (feed=stopped, before applyPeerBatch): ${vacuity}`);
			const stalenessBannerPresent = m0.stalenessBannerPresent;

			await page.evaluate((/** @type {string} */ title) => /** @type {any} */ (globalThis).__LIVENESS_GATE__.applyPeerBatch(title), REPLACEMENT_TITLE_PEER);
			const badgeSeenDuringWindow = await badgeSeenDuring(page, m0.readout.liveUpdateBadgeMs + 500);
			{
				const v = evaluateBadgeSuppressedWhenDown({ stalenessBannerPresent, badgeSeenDuringWindow });
				record('badge-suppressed-when-connection-down', v.passed, v.detail);
			}
			await page.close();
		}

		// -- Rung 6: motion, two fresh navigations, differing only in emulateMedia --
		{
			const activeBrowser = browser;
			const activeServer = server;
			if (!activeBrowser || !activeServer) fail('rung 6: browser/server not initialised — unreachable by construction.');

			/**
			 * @param {'no-preference' | 'reduce'} reducedMotion
			 * @returns {Promise<{ duration: string, property: string, shorthand: string }>}
			 */
			const measureOnce = async (reducedMotion) => {
				const page = await /** @type {import('playwright').Browser} */ (activeBrowser).newPage();
				await page.emulateMedia({ reducedMotion });
				await gotoAndWait(page, `${/** @type {{ url: string }} */ (activeServer).url}/${entryRel}?feed=running`);
				const before = await readPage(page);
				const vacuity = checkVacuity(before);
				if (vacuity) fail(`rung 6 (${reducedMotion}, before applyPeerBatch): ${vacuity}`);
				await page.evaluate((/** @type {string} */ title) => /** @type {any} */ (globalThis).__LIVENESS_GATE__.applyPeerBatch(title), REPLACEMENT_TITLE_PEER);
				await page
					.waitForFunction(() => document.querySelectorAll('#root .live-update-badge').length === 1, null, { timeout: 10_000 })
					.catch(() => {});
				const computed = await page.evaluate(() => {
					const badge = document.querySelector('#root .live-update-badge');
					if (!badge) return { duration: '', property: '', shorthand: '' };
					const style = getComputedStyle(badge);
					return { duration: style.transitionDuration, property: style.transitionProperty, shorthand: style.transition };
				});
				await page.close();
				return computed;
			};

			const noPreference = await measureOnce('no-preference');
			const reduce = await measureOnce('reduce');
			const v = evaluateTransitionGatedByReducedMotion({ noPreference, reduce });
			record('badge-transition-gated-by-reduced-motion', v.passed, v.detail);
		}
	} finally {
		await browser?.close();
		await server?.close();
	}

	let failed = 0;
	for (const id of RUNG_IDS) {
		const rung = rungs.find((r) => r.id === id);
		if (!rung) {
			failed += 1;
			process.stdout.write(`FAIL  ${id}\n      -> never ran\n`);
			continue;
		}
		if (!rung.passed) failed += 1;
		process.stdout.write(`${rung.passed ? 'PASS' : 'FAIL'}  ${rung.id}\n      -> ${rung.detail}\n`);
	}
	process.stdout.write(`\nLIVENESS GATE: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

await main();
