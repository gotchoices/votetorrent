#!/usr/bin/env node
/**
 * run-offline-gate.mjs — the browser-tier proof that BOTH 56-12 surfaces
 * render correctly against COMPUTED style, on production-length fixtures,
 * against a real page (D-17's staleness banner, D-13's config-fault box).
 *
 * WHY THIS FILE EXISTS AT ALL. Every rung below could be written as a source
 * scan (`test/node/offline-surfaces.test.mjs` already covers the source
 * half). This repository has twice shipped a defect only a real browser
 * could catch — an 84-character code that clipped silently, and an entire
 * screen with no styling applied — both past every source-level gate,
 * because those gates asserted PRESENCE rather than RENDERING. A computed
 * `border-top-color`, a laid-out bounding box and the exact text a reader
 * would see are the only evidence that what CSS declares is what actually
 * paints.
 *
 * Modelled in shape on `test/browser/render-fidelity-gate.mjs`: the
 * Playwright import, `chromium.launch({ headless: true })`, `serveDist`,
 * the dist walk that resolves the built entry by SEARCH, the frozen
 * `RUNG_IDS` registry with `record(id, passed, detail)` throwing on any
 * unregistered id, pure exported comparators exercised by `--prove-matchers`
 * against both a violating and a healthy input, and a flag parser that
 * exits 2 on an unrecognised argument.
 *
 * PORT POLICY (56-PLAN-OUTLINE.md Amendment 3): this gate takes **5198** —
 * 5195 is 56-06's, and this plan `depends_on` 56-06, so re-binding it would
 * race that gate's own run. A bound port fails loudly; `serveDist` rejects
 * on `EADDRINUSE` rather than silently choosing another.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-offline/` rather than rebuilding.
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
import { existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { COPY, t } from '@votetorrent/ui-web';
import { formatReaderInstant } from '../../src/reader-instant.js';
import { UNHELD_ELECTION_ID } from '../fixtures/seed-public-surface.js';
import { ELECTION_ID_PATTERN } from '../../src/election-address.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-offline');
const GATE_ENTRY = 'offline-gate.html';
const GATE_CONFIG = 'vite.offline.config.ts';
const DEFAULT_PORT = 5198;
const LABEL = 'run-offline-gate';

const CONFIG_JSON_PATH = path.join(DIST, 'config.json');
const VALID_CONFIG_BODY = JSON.stringify({
	bootstrapNodes: ['/dns4/gateway.offline-gate.invalid/tcp/443/wss/p2p/12D3KooWOfflineGateFixturePinnedPeerId01'],
});

/** @type {ReadonlyArray<string>} */
export const RUNG_IDS = Object.freeze([
	'staleness-first-child',
	'staleness-tone-is-warn-not-fail',
	'staleness-redundant-word',
	'staleness-instant-is-absolute',
	'staleness-absent-when-not-ready',
	'config-fault-missing',
	'config-fault-malformed',
	'config-fault-clears',
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
// A frozen relative-time vocabulary, held as DATA and never restated in
// prose anywhere in this file — a checker whose own comment spells the
// pattern it hunts for is permanently green (this repo's own standing rule,
// manufactured several times already in this phase). The positive control
// below is built by CONCATENATING a member, never by writing one out.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const RELATIVE_TIME_VOCABULARY = Object.freeze([
	['ago'].join(''),
	['just', ' ', 'now'].join(''),
	['minute', 's'].join(''),
	['hour', 's'].join(''),
	['moment', 's'].join(''),
]);

/** @param {string} text @returns {string[]} every relative-time term found. */
function relativeTimeTermsIn(text) {
	const lowered = text.toLowerCase();
	return RELATIVE_TIME_VOCABULARY.filter((term) => lowered.includes(term));
}

// ---------------------------------------------------------------------------
// THE COMPARATORS — pure functions over values already read out of the
// page, so `--prove-matchers` can exercise each with no browser at all.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ passed: boolean, detail: string }} Verdict
 */

/**
 * @param {{ bannerCount: number, firstChildIsBanner: boolean, addressPresent: boolean, statusBannerPresent: boolean }} m
 * @returns {Verdict}
 */
export function evaluateStalenessFirstChild(m) {
	/** @type {string[]} */
	const failures = [];
	if (!m.addressPresent) failures.push('.election-address is absent — the ordering claim would be vacuous');
	if (!m.statusBannerPresent) failures.push('.status-banner is absent — the ordering claim would be vacuous');
	if (m.bannerCount !== 1) failures.push(`${m.bannerCount} .staleness-banner element(s) inside #root (want exactly 1)`);
	if (!m.firstChildIsBanner) failures.push('.staleness-banner is not the firstElementChild of .election');
	return failures.length === 0
		? { passed: true, detail: 'exactly 1 .staleness-banner, first child of .election, ahead of a present .election-address and .status-banner' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ blockBorderColor: string, badgeColor: string, badgeBorderColor: string, blockBackground: string }} m
 * @param {{ warn: string, fail: string, surface2: string }} tokens
 * @returns {Verdict}
 */
export function evaluateStalenessTone(m, tokens) {
	/** @type {string[]} */
	const failures = [];
	if (m.blockBorderColor !== tokens.warn) failures.push(`block border-top-color "${m.blockBorderColor}" (want --warn "${tokens.warn}")`);
	if (m.badgeColor !== tokens.warn) failures.push(`badge color "${m.badgeColor}" (want --warn "${tokens.warn}")`);
	if (m.badgeBorderColor !== tokens.warn) failures.push(`badge border-top-color "${m.badgeBorderColor}" (want --warn "${tokens.warn}")`);
	for (const [label, value] of [
		['block border', m.blockBorderColor],
		['badge color', m.badgeColor],
		['badge border', m.badgeBorderColor],
	]) {
		if (value === tokens.fail) failures.push(`${label} equals --fail ("${tokens.fail}") — an absence of connection is not an error`);
	}
	if (m.blockBackground !== tokens.surface2) failures.push(`block background "${m.blockBackground}" (want --surface2 "${tokens.surface2}")`);
	return failures.length === 0
		? { passed: true, detail: `border/colour resolve to --warn ("${tokens.warn}"), background to --surface2 ("${tokens.surface2}"), none equals --fail ("${tokens.fail}")` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ badgeText: string, badgeHeight: number, textPresent: boolean }} m
 * @param {string} expectedBadgeText
 * @returns {Verdict}
 */
export function evaluateStalenessRedundantWord(m, expectedBadgeText) {
	/** @type {string[]} */
	const failures = [];
	if (!m.textPresent) failures.push('the sentence child is absent — the badge would be rendering alone');
	if (m.badgeText !== expectedBadgeText) failures.push(`badge text "${m.badgeText}" (want "${expectedBadgeText}")`);
	if (!(m.badgeHeight > 0)) failures.push(`badge laid-out height is ${m.badgeHeight} — presence of a class attribute is not rendering`);
	return failures.length === 0
		? { passed: true, detail: `badge text "${m.badgeText}", height ${m.badgeHeight}px, sentence present` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ renderedText: string }} m
 * @param {{ expectedText: string, justNowText: string, zoneLabel: string }} expected
 * @returns {Verdict}
 */
export function evaluateStalenessInstantAbsolute(m, expected) {
	/** @type {string[]} */
	const failures = [];
	if (m.renderedText !== expected.expectedText) failures.push(`rendered text does not match the runner-recomputed sentence: "${m.renderedText}" vs "${expected.expectedText}"`);
	if (m.renderedText === expected.justNowText) failures.push('rendered text is identical to a just-now-composed sentence — the instant is not discriminably absolute');
	if (!m.renderedText.includes(expected.zoneLabel)) failures.push(`rendered text does not contain the zone label "${expected.zoneLabel}"`);
	const relativeHits = relativeTimeTermsIn(m.renderedText);
	if (relativeHits.length > 0) failures.push(`rendered text contains relative-time term(s): ${relativeHits.join(', ')}`);
	return failures.length === 0
		? { passed: true, detail: `rendered text matches the recomputed absolute sentence, differs from a just-now sentence, contains the zone label, no relative-time term` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ bannerCount: number, notHeldTextPresent: boolean }} m
 * @returns {Verdict}
 */
export function evaluateStalenessAbsentWhenNotReady(m) {
	/** @type {string[]} */
	const failures = [];
	if (!m.notHeldTextPresent) failures.push('the not-held sentence is absent — this navigation did not reach the state this rung means to discriminate');
	if (m.bannerCount !== 0) failures.push(`${m.bannerCount} .staleness-banner element(s) present on a page that never became ready`);
	return failures.length === 0
		? { passed: true, detail: 'zero .staleness-banner while the not-held sentence is present' }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ unreadableCount: number, electionCount: number, headingText: string, bodyText: string, otherVariantAbsent: boolean, backgroundColor: string, borderColor: string }} m
 * @param {{ expectedHeading: string, expectedBody: string, surface: string, border: string }} expected
 * @returns {Verdict}
 */
export function evaluateConfigFaultState(m, expected) {
	/** @type {string[]} */
	const failures = [];
	if (m.unreadableCount !== 1) failures.push(`${m.unreadableCount} .election-unreadable section(s) (want exactly 1)`);
	if (m.electionCount !== 0) failures.push(`${m.electionCount} .election section(s) present (want 0 — the fault box replaces the normal shell content)`);
	if (m.headingText !== expected.expectedHeading) failures.push(`heading "${m.headingText}" (want "${expected.expectedHeading}")`);
	if (m.bodyText !== expected.expectedBody) failures.push(`body "${m.bodyText}" (want "${expected.expectedBody}")`);
	if (!m.otherVariantAbsent) failures.push('the other fault variant\'s string is also present — the two must be distinguished by copy alone');
	if (m.backgroundColor !== expected.surface) failures.push(`background "${m.backgroundColor}" (want --surface "${expected.surface}")`);
	if (m.borderColor !== expected.border) failures.push(`border-top-color "${m.borderColor}" (want --border "${expected.border}")`);
	return failures.length === 0
		? { passed: true, detail: `heading/body match, other variant absent, box colours match --surface/--border` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * @param {{ unreadableCount: number, electionCount: number, electionIdText: string | null }} m
 * @param {string} expectedElectionId
 * @returns {Verdict}
 */
export function evaluateConfigFaultClears(m, expectedElectionId) {
	/** @type {string[]} */
	const failures = [];
	if (m.unreadableCount !== 0) failures.push(`${m.unreadableCount} .election-unreadable section(s) present (want 0 — a valid config must clear the fault)`);
	if (m.electionCount !== 1) failures.push(`${m.electionCount} .election section(s) (want exactly 1)`);
	if (m.electionIdText !== expectedElectionId) failures.push(`URL election id rendered as "${m.electionIdText}" (want "${expectedElectionId}")`);
	return failures.length === 0
		? { passed: true, detail: `0 fault boxes, 1 .election section, URL election id "${m.electionIdText}" rendered` }
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — matcher positive controls (`--prove-matchers`).
// ---------------------------------------------------------------------------

const HEALTHY_TOKENS = Object.freeze({ warn: 'rgb(245, 158, 11)', fail: 'rgb(239, 68, 68)', surface2: 'rgb(27, 32, 43)' });
const HEALTHY_CONFIG_TOKENS = Object.freeze({ surface: 'rgb(21, 25, 34)', border: 'rgb(42, 48, 64)' });

/** @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>} */
function matcherControls() {
	return Object.freeze([
		{
			label: 'staleness-first-child vs. a page with two banners and no address line',
			violating: evaluateStalenessFirstChild({ bannerCount: 2, firstChildIsBanner: true, addressPresent: false, statusBannerPresent: true }),
			healthy: evaluateStalenessFirstChild({ bannerCount: 1, firstChildIsBanner: true, addressPresent: true, statusBannerPresent: true }),
		},
		{
			label: 'staleness-tone vs. a banner coloured --fail',
			violating: evaluateStalenessTone(
				{ blockBorderColor: HEALTHY_TOKENS.fail, badgeColor: HEALTHY_TOKENS.fail, badgeBorderColor: HEALTHY_TOKENS.fail, blockBackground: HEALTHY_TOKENS.surface2 },
				HEALTHY_TOKENS,
			),
			healthy: evaluateStalenessTone(
				{ blockBorderColor: HEALTHY_TOKENS.warn, badgeColor: HEALTHY_TOKENS.warn, badgeBorderColor: HEALTHY_TOKENS.warn, blockBackground: HEALTHY_TOKENS.surface2 },
				HEALTHY_TOKENS,
			),
		},
		{
			label: 'staleness-redundant-word vs. a chipless badge (zero height) with the sentence missing',
			violating: evaluateStalenessRedundantWord({ badgeText: 'NOT CONNECTED', badgeHeight: 0, textPresent: false }, 'NOT CONNECTED'),
			healthy: evaluateStalenessRedundantWord({ badgeText: 'NOT CONNECTED', badgeHeight: 18, textPresent: true }, 'NOT CONNECTED'),
		},
		{
			label: 'staleness-instant-is-absolute vs. a relative-time sentence identical to a just-now composition',
			violating: evaluateStalenessInstantAbsolute(
				{ renderedText: 'Updated 5 minutes ago.' },
				{ expectedText: 'This is the last version…', justNowText: 'Updated 5 minutes ago.', zoneLabel: '(UTC)' },
			),
			healthy: evaluateStalenessInstantAbsolute(
				{ renderedText: 'As of Sep 4, 2026, 3:45 PM (UTC), it isn\'t connected.' },
				{ expectedText: 'As of Sep 4, 2026, 3:45 PM (UTC), it isn\'t connected.', justNowText: 'As of just now, it isn\'t connected.', zoneLabel: '(UTC)' },
			),
		},
		{
			label: 'staleness-absent-when-not-ready vs. a banner rendered unconditionally alongside the not-held sentence',
			violating: evaluateStalenessAbsentWhenNotReady({ bannerCount: 1, notHeldTextPresent: true }),
			healthy: evaluateStalenessAbsentWhenNotReady({ bannerCount: 0, notHeldTextPresent: true }),
		},
		{
			label: 'config-fault-state vs. a box carrying the OTHER variant\'s string too',
			violating: evaluateConfigFaultState(
				{ unreadableCount: 1, electionCount: 0, headingText: 'A', bodyText: 'B', otherVariantAbsent: false, backgroundColor: HEALTHY_CONFIG_TOKENS.surface, borderColor: HEALTHY_CONFIG_TOKENS.border },
				{ expectedHeading: 'A', expectedBody: 'B', ...HEALTHY_CONFIG_TOKENS },
			),
			healthy: evaluateConfigFaultState(
				{ unreadableCount: 1, electionCount: 0, headingText: 'A', bodyText: 'B', otherVariantAbsent: true, backgroundColor: HEALTHY_CONFIG_TOKENS.surface, borderColor: HEALTHY_CONFIG_TOKENS.border },
				{ expectedHeading: 'A', expectedBody: 'B', ...HEALTHY_CONFIG_TOKENS },
			),
		},
		{
			label: 'config-fault-clears vs. a page that still shows a fault box after a valid config was served',
			violating: evaluateConfigFaultClears({ unreadableCount: 1, electionCount: 0, electionIdText: null }, 'e-fixture'),
			healthy: evaluateConfigFaultClears({ unreadableCount: 0, electionCount: 1, electionIdText: 'e-fixture' }, 'e-fixture'),
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
	if (!existsSync(DIST)) fail(`gate dist "${DIST}" does not exist — run \`yarn build:offline\` or drop --skip-build.`);
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
 * Read every rung's raw material off the live page in one evaluate. `branch`
 * selects which half of the readout is meaningful; the other half's fields
 * are still read (cheaply) but ignored by the caller.
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
		const readout = /** @type {any} */ (globalThis).__OFFLINE_GATE__ ?? null;

		// -- staleness readout --
		const banners = root ? [...root.querySelectorAll('.staleness-banner')] : [];
		const banner = banners[0] ?? null;
		const electionSection = root ? root.querySelector('.election') : null;
		const bannerStyle = banner ? getComputedStyle(banner) : null;
		const badge = banner ? banner.querySelector('.staleness-banner__badge') : null;
		const badgeStyle = badge ? getComputedStyle(badge) : null;
		const textEl = banner ? banner.querySelector('.staleness-banner__text') : null;
		const notHeldEls = root ? [...root.querySelectorAll('h2, p')] : [];

		// -- config-fault readout --
		const unreadableSections = root ? [...root.querySelectorAll('.election-unreadable')] : [];
		const unreadable = unreadableSections[0] ?? null;
		const unreadableStyle = unreadable ? getComputedStyle(unreadable) : null;
		const heading = unreadable ? unreadable.querySelector('h2') : null;
		const body = unreadable ? unreadable.querySelector('p') : null;
		const electionSections = root ? [...root.querySelectorAll('.election')] : [];
		const addressCode = root ? root.querySelector('.election-address code') : null;
		const bodyTextAll = root ? (root.textContent ?? '') : '';

		return {
			readout,
			tokens: { warn: tokenOf('--warn'), fail: tokenOf('--fail'), text: tokenOf('--text'), surface2: tokenOf('--surface2'), surface: tokenOf('--surface'), border: tokenOf('--border') },
			staleness: {
				bannerCount: banners.length,
				firstChildIsBanner: electionSection !== null && electionSection.firstElementChild === banner,
				addressPresent: root ? root.querySelector('.election-address') !== null : false,
				statusBannerPresent: root ? root.querySelector('.status-banner') !== null : false,
				blockBorderColor: bannerStyle ? bannerStyle.borderTopColor : '',
				blockBackground: bannerStyle ? bannerStyle.backgroundColor : '',
				badgeColor: badgeStyle ? badgeStyle.color : '',
				badgeBorderColor: badgeStyle ? badgeStyle.borderTopColor : '',
				badgeText: badge ? (badge.textContent ?? '') : '',
				badgeHeight: badge ? badge.getBoundingClientRect().height : 0,
				textPresent: textEl !== null,
				renderedText: textEl ? (textEl.textContent ?? '') : '',
				notHeldTextPresent: notHeldEls.some((el) => el.textContent === /** @type {any} */ (globalThis).__EXPECTED_NOT_HELD_TITLE__),
			},
			configFault: {
				unreadableCount: unreadableSections.length,
				electionCount: electionSections.length,
				headingText: heading ? (heading.textContent ?? '') : '',
				bodyText: body ? (body.textContent ?? '') : '',
				backgroundColor: unreadableStyle ? unreadableStyle.backgroundColor : '',
				borderColor: unreadableStyle ? unreadableStyle.borderTopColor : '',
				electionIdText: addressCode ? addressCode.textContent : null,
				fullText: bodyTextAll,
			},
		};
	});
}

/**
 * Anti-vacuity, before any rung runs. Each check is its own named hard stop.
 * @param {any} m the readPage() result
 * @param {{ requireInstant: boolean }} opts
 * @returns {string | null} a bail message, or null if clear.
 */
function checkVacuity(m, { requireInstant }) {
	if (m.readout === null) return 'the harness never published its readout — the page did not finish.';
	if (m.readout.error !== null) return `the harness recorded a seed/render error: ${m.readout.error}`;
	if (requireInstant) {
		const instant = m.readout.injectedInstant;
		if (typeof instant !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(instant)) {
			return `the injected canonical instant is absent or malformed: ${JSON.stringify(instant)}`;
		}
		const ageMs = Date.now() - Date.parse(`${instant}Z`);
		if (!(ageMs >= 60 * 60 * 1000)) return `the injected instant is not at least one hour before the run's own clock (age ${ageMs}ms)`;
	}
	for (const [name, value] of Object.entries(m.tokens)) {
		if (!value) return `design token --${name} did not resolve to a computed colour — the page has likely lost its stylesheet.`;
	}
	if (m.tokens.warn === m.tokens.fail) return `--warn and --fail resolve to the same colour (${m.tokens.warn}) — the token layer is not distinguishing them.`;
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

	let server;
	let browser;
	try {
		server = await serveDist(DIST, port);
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await page.addInitScript((title) => {
			/** @type {any} */ (window).__EXPECTED_NOT_HELD_TITLE__ = title;
		}, t('public.election.notHeld.title'));

		// ---- STALE branch: happy path (RUNG_IDS 1-4) ----------------------
		await gotoAndWait(page, `${server.url}/${entryRel}?fixture=stale`);
		let m = await readPage(page);
		let vacuity = checkVacuity(m, { requireInstant: true });
		if (vacuity) fail(`stale (happy path): ${vacuity}`);

		{
			const v = evaluateStalenessFirstChild(m.staleness);
			record('staleness-first-child', v.passed, v.detail);
		}
		{
			const v = evaluateStalenessTone(m.staleness, { warn: m.tokens.warn, fail: m.tokens.fail, surface2: m.tokens.surface2 });
			record('staleness-tone-is-warn-not-fail', v.passed, v.detail);
		}
		{
			const v = evaluateStalenessRedundantWord(m.staleness, COPY['public.staleness.badge']);
			record('staleness-redundant-word', v.passed, v.detail);
		}
		{
			const injected = m.readout.injectedInstant;
			const formatted = formatReaderInstant(injected);
			const zoneLabel = formatted ? `(${formatted.zone})` : '(?)';
			const expectedText = formatted ? t('public.staleness.body', { asOf: `${formatted.text} ${zoneLabel}` }) : '';
			const justNowInstant = new Date().toISOString().slice(0, 19);
			const justNowFormatted = formatReaderInstant(justNowInstant);
			const justNowText = justNowFormatted ? t('public.staleness.body', { asOf: `${justNowFormatted.text} (${justNowFormatted.zone})` }) : '';
			const v = evaluateStalenessInstantAbsolute(m.staleness, { expectedText, justNowText, zoneLabel });
			record('staleness-instant-is-absolute', v.passed, v.detail);
		}

		// ---- STALE branch: discrimination (RUNG_ID 5) ----------------------
		await gotoAndWait(page, `${server.url}/${entryRel}?fixture=stale&election=${UNHELD_ELECTION_ID}`);
		m = await readPage(page);
		vacuity = checkVacuity(m, { requireInstant: false });
		if (vacuity) fail(`stale (discrimination): ${vacuity}`);
		if (m.readout.requestedElectionId !== UNHELD_ELECTION_ID || !ELECTION_ID_PATTERN.test(m.readout.requestedElectionId)) {
			fail(`stale (discrimination): the requested election id "${m.readout.requestedElectionId}" is not UNHELD_ELECTION_ID or fails ELECTION_ID_PATTERN — this navigation did not test what it claims to.`);
		}
		{
			const v = evaluateStalenessAbsentWhenNotReady(m.staleness);
			record('staleness-absent-when-not-ready', v.passed, v.detail);
		}

		// ---- CONFIG branch: three states of the SAME served root ----------
		const configTokens = { surface: m.tokens.surface, border: m.tokens.border };
		const configUrl = `${server.url}/${entryRel}?fixture=config&network=vtxfixture54&election=${UNHELD_ELECTION_ID}`;

		rmSync(CONFIG_JSON_PATH, { force: true });
		await gotoAndWait(page, configUrl);
		m = await readPage(page);
		vacuity = checkVacuity(m, { requireInstant: false });
		if (vacuity) fail(`config (missing): ${vacuity}`);
		{
			const otherAbsent = !m.configFault.fullText.includes(t('public.config.malformed.title'));
			const v = evaluateConfigFaultState(
				{ ...m.configFault, otherVariantAbsent: otherAbsent },
				{ expectedHeading: t('public.config.missing.title'), expectedBody: t('public.config.missing.body'), ...configTokens },
			);
			record('config-fault-missing', v.passed, v.detail);
		}

		writeFileSync(CONFIG_JSON_PATH, '{not valid json');
		await gotoAndWait(page, configUrl);
		m = await readPage(page);
		vacuity = checkVacuity(m, { requireInstant: false });
		if (vacuity) fail(`config (malformed): ${vacuity}`);
		{
			const otherAbsent = !m.configFault.fullText.includes(t('public.config.missing.title'));
			const v = evaluateConfigFaultState(
				{ ...m.configFault, otherVariantAbsent: otherAbsent },
				{ expectedHeading: t('public.config.malformed.title'), expectedBody: t('public.config.malformed.body'), ...configTokens },
			);
			record('config-fault-malformed', v.passed, v.detail);
		}

		writeFileSync(CONFIG_JSON_PATH, VALID_CONFIG_BODY);
		await gotoAndWait(page, configUrl);
		m = await readPage(page);
		vacuity = checkVacuity(m, { requireInstant: false });
		if (vacuity) fail(`config (clears): ${vacuity}`);
		{
			const v = evaluateConfigFaultClears(m.configFault, UNHELD_ELECTION_ID);
			record('config-fault-clears', v.passed, v.detail);
		}
	} finally {
		rmSync(CONFIG_JSON_PATH, { force: true });
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
	process.stdout.write(`\nOFFLINE GATE: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

await main();
