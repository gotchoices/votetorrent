#!/usr/bin/env node
/**
 * assert-placeholders-labelled.mjs — the RENDERING half of D-18.
 *
 * Why this exists (G-53-UAT-01, the phase-53 human UAT walk). Every D-18
 * check this phase shipped asserts the ABSENCE of motion: no @keyframes, no
 * animation, no transition, no linear-gradient — see
 * `test/node/election-shell.test.mjs` sections 7 and 8. The shipped page
 * satisfied all of them and still read as "content loading", because three
 * unlabelled full-width grey rounded bars ARE the universal loading-skeleton
 * idiom regardless of whether they move. Absence-of-motion is necessary and
 * was never sufficient.
 *
 * So this gate asserts the PRESENCE of the thing that makes a placeholder
 * read as deliberate: a visible slot label, exposed to assistive technology,
 * on a rendered page in a real browser. It is deliberately not a source scan
 * — a source scan is exactly the tier that was blind to this defect (the
 * `aria-label`s were present in source the whole time and reached nobody,
 * because `role="presentation"` kept every one of those divs out of the
 * accessibility tree).
 *
 * Not a rung in `packages/ui-web/scripts/run-ui-gates.mjs`: that runner's
 * RUNG_IDS registry is shared with the dashboard, which renders no
 * placeholders at all, and a rung that is vacuous for one of its two
 * consumers is a rung that teaches the wrong thing when it passes.
 *
 * The slot ids and their expected labels are DERIVED from the
 * `public.election.slot.*` keys in `@votetorrent/ui-web`'s COPY table, never
 * transcribed — a second list here could drift from the copy the app renders
 * and this gate would keep passing against the stale one.
 *
 * A second rendered property lives here too, for the same reason and on the
 * same page load: the top-level regions of `<main>` must not touch. The
 * advisory disclosure is mounted as a SIBLING of the election section (D-16
 * forbids it from ever becoming conditional, which nesting would invite), so
 * it inherits none of that section's own `gap`; it rendered flush against the
 * placeholder above and the toggle below, 0px on both sides, reading as one
 * more item in the placeholder stack. That is a geometry defect, invisible to
 * a stylesheet scan, and it is measured here rather than in a second script
 * because it needs the identical browser, build and page load.
 *
 * Requires a prior `yarn workspace votetorrent-public build`. Runs every
 * control BEFORE it touches the real page: a gate whose predicate has not
 * been seen refusing something is not evidence.
 */
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveDist } from '../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { COPY } from '../../../packages/ui-web/src/index.js';

const PREFIX = '[assert-placeholders-labelled]';
const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
/**
 * 56-12: this gate serves the PRODUCTION page, and the production page now
 * resolves its deployment's bootstrap config at boot (`PublicApp.tsx`). A
 * gate that served an unconfigured deployment would render the config-fault
 * box instead of the placeholder page it exists to measure -- it would be
 * measuring a fault page, not this one. Write a valid config into the served
 * root before serving, and remove it in the same teardown that closes the
 * server and the browser, whether or not the run succeeded, so a failed run
 * never leaves this repo's own `dist/` looking configured. Nothing dials
 * this address -- the `.invalid` host and the shape of the recipe are the
 * same one `56-06` handed `56-11` for the identical reason.
 * @type {string}
 */
const DIST_CONFIG_JSON = path.join(DIST, 'config.json');
const GATE_CONFIG_BODY = JSON.stringify({
	bootstrapNodes: ['/dns4/gateway.assert-placeholders-labelled.invalid/tcp/443/wss/p2p/12D3KooWAssertPlaceholdersLabelledGatePeerId1'],
});
const PORT = 5193;

/** The copy-key prefix that declares a placeholder slot. @type {string} */
const SLOT_KEY_PREFIX = 'public.election.slot.';

/**
 * Slot id -> the label that slot must render, derived from COPY. The slot id
 * is the key's last segment, which is also the `data-slot` attribute value
 * `ElectionShell.tsx` renders — that shared derivation is what keeps the two
 * from drifting.
 * @type {Readonly<Record<string, string>>}
 */
const EXPECTED_LABELS = Object.freeze(
	Object.fromEntries(
		Object.entries(COPY)
			.filter(([key]) => key.startsWith(SLOT_KEY_PREFIX))
			.map(([key, value]) => [key.slice(SLOT_KEY_PREFIX.length), value]),
	),
);

/**
 * @typedef {object} PlaceholderRecord
 * @property {string} slot            the element's data-slot value
 * @property {string} visibleText     innerText as the browser lays it out
 * @property {boolean} exposedToAT    does an accessibility-tree snapshot carry this label
 * @property {string} animationName
 * @property {string} animationDuration
 * @property {string} transitionDuration
 * @property {string} backgroundImage
 * @property {string} beforeAnimationName
 * @property {string} afterAnimationName
 * @property {string} beforeBackgroundImage
 * @property {string} afterBackgroundImage
 */

/**
 * The single predicate, exercised by the controls and by the real page alike.
 * Returns a list of human-readable problems; empty means the rendering is a
 * deliberate, labelled, still gap.
 *
 * @param {ReadonlyArray<PlaceholderRecord>} records
 * @param {Readonly<Record<string, string>>} expected
 * @param {number} keyframeCount total @keyframes rules in the page's stylesheets
 * @returns {string[]}
 */
export function findPlaceholderProblems(records, expected, keyframeCount) {
	/** @type {string[]} */
	const problems = [];
	const expectedSlots = Object.keys(expected);

	if (expectedSlots.length === 0) {
		problems.push('no placeholder slot labels are declared in COPY — this gate would otherwise pass vacuously');
		return problems;
	}
	if (records.length === 0) {
		problems.push('the page rendered no placeholder at all — this gate would otherwise pass vacuously');
		return problems;
	}
	if (keyframeCount !== 0) {
		problems.push(`${keyframeCount} @keyframes rule(s) reached the page's stylesheets — a label must not be bought back with a shimmer`);
	}

	const seen = new Set();
	for (const r of records) {
		seen.add(r.slot);
		const want = expected[r.slot];
		if (want === undefined) {
			problems.push(`slot "${r.slot}" renders a placeholder but declares no label in COPY`);
			continue;
		}
		const text = r.visibleText.trim();
		if (text === '') {
			problems.push(`slot "${r.slot}" renders no visible text — an unlabelled block reads as content in flight, not as a deliberate gap`);
		} else if (text !== want) {
			problems.push(`slot "${r.slot}" renders "${text}" but its declared label is "${want}"`);
		}
		if (!r.exposedToAT) {
			problems.push(`slot "${r.slot}" is absent from the accessibility tree — its label reaches no assistive technology`);
		}
		if (r.animationName !== 'none' || r.animationDuration !== '0s') {
			problems.push(`slot "${r.slot}" carries animation (${r.animationName} / ${r.animationDuration})`);
		}
		if (r.transitionDuration !== '0s') {
			problems.push(`slot "${r.slot}" carries a transition (${r.transitionDuration})`);
		}
		for (const [what, value] of [
			['background-image', r.backgroundImage],
			['::before background-image', r.beforeBackgroundImage],
			['::after background-image', r.afterBackgroundImage],
		]) {
			if (value !== 'none') problems.push(`slot "${r.slot}" carries a ${what} (${value}) — a moving gradient is what a shimmer is made of`);
		}
		for (const [what, value] of [
			['::before', r.beforeAnimationName],
			['::after', r.afterAnimationName],
		]) {
			if (value !== 'none') problems.push(`slot "${r.slot}" carries a ${what} animation (${value})`);
		}
	}

	for (const slot of expectedSlots) {
		if (!seen.has(slot)) problems.push(`slot "${slot}" declares a label in COPY but rendered no placeholder on the election-less page`);
	}

	return problems;
}

/**
 * @typedef {object} RegionRecord
 * @property {string} label  a human-readable identifier for the region
 * @property {number} top
 * @property {number} bottom
 */

/**
 * Consecutive top-level regions of `<main>` must be separated by at least
 * `minGapPx`. Measured on PAINTED GEOMETRY, never on a declared rule: the
 * defect this catches is a container that declares no gap while its children
 * declare no margin, which no single rule is wrong about.
 *
 * The threshold is a resolved design token rather than a magic number, so a
 * page that has lost its token layer entirely fails here loudly instead of
 * comparing against a silent 0.
 *
 * @param {ReadonlyArray<RegionRecord>} regions in document order
 * @param {number} minGapPx
 * @returns {string[]}
 */
export function findSeparationProblems(regions, minGapPx) {
	/** @type {string[]} */
	const problems = [];
	if (!Number.isFinite(minGapPx) || minGapPx <= 0) {
		problems.push(`the minimum-separation token did not resolve to a positive length (got ${minGapPx}) — the page has probably lost its token layer`);
		return problems;
	}
	if (regions.length < 2) {
		problems.push(`<main> rendered ${regions.length} top-level region(s) — fewer than two cannot be checked for separation, and this gate would otherwise pass vacuously`);
		return problems;
	}
	for (let i = 1; i < regions.length; i += 1) {
		const above = regions[i - 1];
		const below = regions[i];
		const gap = below.top - above.bottom;
		if (gap < minGapPx) {
			problems.push(`"${above.label}" and "${below.label}" are separated by ${gap}px, under the ${minGapPx}px minimum — regions that touch read as one crowded stack rather than as distinct statements`);
		}
	}
	return problems;
}

/** @param {Partial<PlaceholderRecord>} over @returns {PlaceholderRecord} */
function inertRecord(over) {
	return {
		slot: 'title',
		visibleText: EXPECTED_LABELS.title ?? 'Election title',
		exposedToAT: true,
		animationName: 'none',
		animationDuration: '0s',
		transitionDuration: '0s',
		backgroundImage: 'none',
		beforeAnimationName: 'none',
		afterAnimationName: 'none',
		beforeBackgroundImage: 'none',
		afterBackgroundImage: 'none',
		...over,
	};
}

/** Controls run before anything real. @returns {void} */
function runControls() {
	const oneSlot = Object.freeze({ title: EXPECTED_LABELS.title ?? 'Election title' });
	/** @type {Array<{ name: string, problems: string[], mustFire: boolean }>} */
	const controls = [];

	// The exact shipped defect: a placeholder that renders nothing visible.
	controls.push({
		name: 'positive: an unlabelled placeholder',
		problems: findPlaceholderProblems([inertRecord({ visibleText: '' })], oneSlot, 0),
		mustFire: true,
	});
	// The second half of the shipped defect: labelled in source, invisible to AT.
	controls.push({
		name: 'positive: a placeholder absent from the accessibility tree',
		problems: findPlaceholderProblems([inertRecord({ exposedToAT: false })], oneSlot, 0),
		mustFire: true,
	});
	// A label must not be bought back with motion.
	controls.push({
		name: 'positive: a labelled placeholder that shimmers',
		problems: findPlaceholderProblems(
			[inertRecord({ animationName: 'shimmer', animationDuration: '1.2s' })],
			oneSlot,
			1,
		),
		mustFire: true,
	});
	// A predicate that fires on everything discriminates nothing.
	controls.push({
		name: 'benign: a labelled, exposed, still placeholder',
		problems: findPlaceholderProblems([inertRecord({})], oneSlot, 0),
		mustFire: false,
	});

	// The separation predicate, same discipline: seen refusing the exact
	// shipped geometry (0px on both sides of the advisory) before it is
	// trusted, and seen NOT firing on a well-spaced page.
	controls.push({
		name: 'positive: two top-level regions that touch',
		problems: findSeparationProblems(
			[
				{ label: 'election', top: 120, bottom: 238 },
				{ label: 'advisory', top: 238, bottom: 255 },
			],
			8,
		),
		mustFire: true,
	});
	controls.push({
		name: 'positive: a page whose spacing token did not resolve',
		problems: findSeparationProblems(
			[
				{ label: 'election', top: 120, bottom: 238 },
				{ label: 'advisory', top: 254, bottom: 271 },
			],
			Number.NaN,
		),
		mustFire: true,
	});
	controls.push({
		name: 'benign: two well-separated top-level regions',
		problems: findSeparationProblems(
			[
				{ label: 'election', top: 120, bottom: 238 },
				{ label: 'advisory', top: 254, bottom: 271 },
			],
			8,
		),
		mustFire: false,
	});

	let bad = 0;
	for (const c of controls) {
		const fired = c.problems.length > 0;
		const ok = fired === c.mustFire;
		if (!ok) bad += 1;
		console.log(`${PREFIX}   ${ok ? 'ok  ' : 'FAIL'} control ${c.name} — ${fired ? `fired: ${c.problems[0]}` : 'did not fire'}`);
	}
	if (bad > 0) {
		console.error(`${PREFIX} ${bad} control(s) behaved wrongly — the predicate proves nothing. Not scanning the real page.`);
		process.exit(1);
	}
}

async function main() {
	console.log(`${PREFIX} controls first:`);
	runControls();

	if (!existsSync(DIST)) {
		console.error(`${PREFIX} ${DIST} does not exist — run \`yarn workspace votetorrent-public build\` first.`);
		process.exit(1);
	}

	// 56-12: configure the deployment this gate is about to serve — see the
	// module-level comment beside DIST_CONFIG_JSON for why. Written BEFORE
	// serveDist and removed in the finally below, whether or not the run
	// succeeded.
	await writeFile(DIST_CONFIG_JSON, GATE_CONFIG_BODY);

	const server = await serveDist(DIST, PORT);
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
		/** @type {string[]} */
		const pageErrors = [];
		page.on('pageerror', (e) => pageErrors.push(String(e)));
		// The election-less root URL: the state every real visitor lands on
		// first, and the only one that renders all three placeholders.
		await page.goto(server.url, { waitUntil: 'networkidle' });
		await page.waitForFunction(() => document.querySelectorAll('.skeleton').length > 0 || document.body.innerText.length > 0);

		const ariaSnapshot = await page.locator('body').ariaSnapshot();

		const raw = await page.evaluate(() => {
			const keyframeCount = (() => {
				let n = 0;
				for (const sheet of document.styleSheets) {
					let rules;
					try {
						rules = sheet.cssRules;
					} catch {
						continue;
					}
					for (const r of rules) if (r.type === CSSRule.KEYFRAMES_RULE) n += 1;
				}
				return n;
			})();
			const root = document.documentElement;
			const minGapRaw = getComputedStyle(root).getPropertyValue('--space-sm').trim();
			const minGapPx = Number.parseFloat(minGapRaw);
			const main = document.querySelector('.public-app__main');
			const regions = main
				? [...main.children].map((el) => {
						const r = el.getBoundingClientRect();
						const cls = el.getAttribute('class');
						return {
							label: cls ? `.${cls.split(/\s+/).join('.')}` : el.tagName.toLowerCase(),
							top: Math.round(r.top),
							bottom: Math.round(r.bottom),
						};
					})
				: [];
			const records = [...document.querySelectorAll('[data-slot]')].map((el) => {
				const cs = getComputedStyle(el);
				const before = getComputedStyle(el, '::before');
				const after = getComputedStyle(el, '::after');
				return {
					slot: el.getAttribute('data-slot') ?? '',
					visibleText: /** @type {HTMLElement} */ (el).innerText ?? '',
					animationName: cs.animationName,
					animationDuration: cs.animationDuration,
					transitionDuration: cs.transitionDuration,
					backgroundImage: cs.backgroundImage,
					beforeAnimationName: before.animationName,
					afterAnimationName: after.animationName,
					beforeBackgroundImage: before.backgroundImage,
					afterBackgroundImage: after.backgroundImage,
				};
			});
			return { keyframeCount, records, regions, minGapPx, minGapRaw };
		});

		if (pageErrors.length > 0) {
			console.error(`${PREFIX} the page threw before it could be measured: ${pageErrors.join(' | ')}`);
			process.exit(1);
		}

		// Accessibility-tree exposure is measured OUT of page, from the
		// snapshot Playwright builds off Chromium's own accessibility tree —
		// an in-page `aria-label` read would have reported the shipped defect
		// as fine, which is precisely how it survived.
		const records = raw.records.map((r) => ({
			...r,
			exposedToAT: EXPECTED_LABELS[r.slot] !== undefined && ariaSnapshot.includes(EXPECTED_LABELS[r.slot]),
		}));

		const problems = [
			...findPlaceholderProblems(records, EXPECTED_LABELS, raw.keyframeCount),
			...findSeparationProblems(raw.regions, raw.minGapPx),
		];

		console.log(`${PREFIX} slots declared in COPY: ${Object.keys(EXPECTED_LABELS).join(', ')}`);
		console.log(`${PREFIX} placeholders rendered:   ${records.map((r) => `${r.slot}="${r.visibleText.trim()}" at=${r.exposedToAT}`).join('  ') || '(none)'}`);
		console.log(`${PREFIX} @keyframes in page:      ${raw.keyframeCount}`);
		console.log(`${PREFIX} <main> regions:          ${raw.regions.map((r) => `${r.label}[${r.top}-${r.bottom}]`).join('  ') || '(none)'}`);
		console.log(`${PREFIX} minimum separation:      ${raw.minGapPx}px (--space-sm: "${raw.minGapRaw}")`);

		if (problems.length > 0) {
			console.error(`\n${PREFIX} FAIL — ${problems.length} problem(s):`);
			for (const p of problems) console.error(`  - ${p}`);
			console.error('\nARIA SNAPSHOT of the rendered page (what assistive technology is actually offered):');
			console.error(ariaSnapshot);
			process.exit(1);
		}

		const gaps = raw.regions.slice(1).map((r, i) => r.top - raw.regions[i].bottom);
		console.log(`\n${PREFIX} PASS — ${records.length}/${Object.keys(EXPECTED_LABELS).length} placeholders render their declared label, are exposed to assistive technology, and carry no motion; ${raw.regions.length} top-level regions separated by ${gaps.join('/')}px (minimum ${raw.minGapPx}px).`);
	} finally {
		await browser.close();
		await server.close();
		await rm(DIST_CONFIG_JSON, { force: true });
	}
}

await main();
