#!/usr/bin/env node
/**
 * empty-state-gate.mjs — the browser-tier proof for D-21 (56-03): the
 * addressed-but-not-held page renders the same three labelled frames the
 * election-less page renders, and the retoned `.lifecycle-pill--indeterminate`
 * computes to a neutral tone rather than an alarm one.
 *
 * WHY THIS FILE EXISTS, on the identical precedent `render-fidelity-gate.mjs`
 * states for itself. Every rung below could be written as a source scan of
 * `ElectionShell.tsx` / `components.css`, and every one of those scans would
 * be worthless — this repository has shipped an unstyled screen and a
 * silently clipped code past green source-scan gates, because those gates
 * asserted PRESENCE (a class in the markup, a rule in a stylesheet) rather
 * than RENDERING. A laid-out box, a computed `color`, and the exact string an
 * element's text resolves to are the only evidence a reader would actually
 * experience what the source declares, and none of the three can be obtained
 * without a browser holding a real layout against the page's own resolved
 * design tokens.
 *
 * WHAT IT MEASURES, and against what. `test/browser/election-shell-gate.tsx`'s
 * `?fixture=not-held` branch seeds the SAME real browser-side database the
 * existing `?fixture=public-surface` branch seeds, then mounts the shell with
 * an election id that surface never seeded — a production-length id, so the
 * page under measurement carries the same length precondition a reader
 * following a real link would. The harness publishes its own facts (the
 * requested id, the seeded id, the ordered slot suffixes) on
 * `__UI_GATE__.notHeld`; this file hard-codes no expected label anywhere —
 * every expected slot label comes from `COPY`'s `public.election.slot.*`
 * keys, and every expected colour comes from the page's OWN resolved
 * `--text` / `--fail` custom properties, read back through
 * `getComputedStyle`, never from a literal this file invented.
 *
 * WHAT IS COPIED FROM `render-fidelity-gate.mjs` RATHER THAN INVENTED: the
 * Playwright import (the full package, never the core-only sibling), the
 * static server (`lib/serve-dist.mjs`), the dist walk that resolves the built
 * entry by SEARCH, the frozen rung-id registry, `record(id, passed, detail)`,
 * and `--prove-matchers`'s shape (run every comparator against a violating
 * input AND a healthy one, with no browser and no build).
 *
 * PORT POLICY. `5194`, distinct from every port the phase already binds
 * (`5180`/`5181` dev+preview, `5183` the dashboard gate, `5191` this app's own
 * gate run, `5193` `render-fidelity-gate.mjs`), so this gate can run
 * concurrently with every existing one.
 *
 * FLAGS:
 *   --skip-build                    Reuse an existing `dist-gate/` rather
 *                                    than rebuilding.
 *   --prove-matchers                Run every comparator against a violating
 *                                    input AND a healthy one, requiring the
 *                                    first to FAIL and the second to PASS.
 *                                    Needs no browser and no build.
 *   --prove-pill-retone-reverted    56-03 Task 3: the build-level negative
 *                                    control. Rebuilds with the retone
 *                                    reverted at BUILD time and requires
 *                                    exactly `indeterminate-pill-neutral` to
 *                                    invert while the other two rungs
 *                                    survive.
 *   --port <n>                      Override the bound port.
 * Any other argument exits 2 naming it — an unknown flag must never be
 * silently ignored into a green run.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { readMutationReport } from '@votetorrent/ui-web/mutations';
import { COPY } from '../../../../packages/ui-web/src/copy.js';
import {
	PHASE_IDS,
	phaseCopyKey,
	INDETERMINATE_COPY_KEY,
} from '../../../../packages/ui-web/src/lifecycle/phase-ids.js';
import { ELECTION_ID_PATTERN } from '../../src/election-address.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const GATE_DIST = path.join(APP_DIR, 'dist-gate');
const GATE_ENTRY = 'election-shell-gate.html';
const GATE_CONFIG = 'vite.gate.config.ts';
const NOT_HELD_QUERY = 'fixture=not-held';
const DEFAULT_PORT = 5194;
const LABEL = 'empty-state-gate';

/** The build-time mutation `--prove-pill-retone-reverted` drives, and its outDir. */
const RETONE_MUTATION = 'pill-retone-reverted';
const MUTANT_CONFIG = 'vite.mutant.config.ts';
const MUTANT_DIST = path.join(APP_DIR, `dist-mutant-${RETONE_MUTATION}`);
/** The one rung the retone-revert mutation must invert. Every other rung must survive it.
 * Named as a module constant, on the identical precedent `GAP_RUNG_ID` follows in
 * `render-fidelity-gate.mjs`, so the control cannot drift from the rung it claims to invert. */
const RETONE_RUNG_ID = 'indeterminate-pill-neutral';

/**
 * Frozen rung-id registry, module-level, single source of truth. `record()`
 * throws on any id outside this array — a rung id may never interpolate a
 * value under test into its own name.
 * @type {ReadonlyArray<string>}
 */
export const RUNG_IDS = Object.freeze(['notheld-frames-render', 'indeterminate-pill-neutral', 'pill-word-distinct-without-hue']);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/**
 * @param {string} id
 * @param {boolean} passed
 * @param {string} detail
 */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) {
		throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	}
	rungs.push({ id, passed, detail });
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// COPY-derived and model-derived expectations. Every value below is READ from
// the shared COPY table / lifecycle model, never a literal this file invents.
// ---------------------------------------------------------------------------

/** The copy-key prefix that declares a placeholder slot. @type {string} */
const SLOT_KEY_PREFIX = 'public.election.slot.';

/** The three slot suffixes, in COPY's own declaration order. @type {ReadonlyArray<string>} */
const EXPECTED_SLOT_ORDER = Object.freeze(
	Object.keys(COPY)
		.filter((key) => key.startsWith(SLOT_KEY_PREFIX))
		.map((key) => key.slice(SLOT_KEY_PREFIX.length)),
);

/** Slot suffix -> the label that slot must render. @type {Readonly<Record<string,string>>} */
const EXPECTED_SLOT_LABELS = Object.freeze(
	Object.fromEntries(
		Object.entries(COPY)
			.filter(([key]) => key.startsWith(SLOT_KEY_PREFIX))
			.map(([key, value]) => [key.slice(SLOT_KEY_PREFIX.length), value]),
	),
);

/** The not-held sentence's title, the ready predicate the harness itself waits on. @type {string} */
const NOT_HELD_TITLE = COPY['public.election.notHeld.title'];

/** The retoned pill's own word. @type {string} */
const INDETERMINATE_WORD = COPY[INDETERMINATE_COPY_KEY];

/** The other four lifecycle phases' words — what `INDETERMINATE_WORD` must never collide with. @type {ReadonlyArray<string>} */
const OTHER_PHASE_WORDS = Object.freeze(PHASE_IDS.map((id) => COPY[/** @type {string} */ (phaseCopyKey(id))]));

// ---------------------------------------------------------------------------
// THE COMPARATORS. Every one is a PURE function over values already read out
// of the page — the property that lets `--prove-matchers` exercise each
// against a violating input with no browser at all.
// ---------------------------------------------------------------------------

/** @typedef {{ passed: boolean, detail: string }} Verdict */

/**
 * All three labelled frames render, in the copy table's own order, each with
 * a laid-out box and the dashed `.skeleton` outline. PRESENCE of the class
 * attribute is not RENDERING — that distinction is why the box and the
 * border are measured and not just the node count.
 *
 * @param {{ slots: Array<{ slot: string, labelText: string, height: number, borderTopStyle: string }> }} m
 * @param {ReadonlyArray<string>} expectedOrder
 * @param {Readonly<Record<string,string>>} expectedLabels
 * @returns {Verdict}
 */
export function evaluateFramesRender(m, expectedOrder, expectedLabels) {
	/** @type {string[]} */
	const failures = [];
	if (m.slots.length !== expectedOrder.length) {
		failures.push(`${m.slots.length} .skeleton element(s) rendered (want ${expectedOrder.length}: ${expectedOrder.join(', ')})`);
	}
	const gotOrder = m.slots.map((s) => s.slot);
	const orderMatches = expectedOrder.every((slot, i) => gotOrder[i] === slot);
	if (!orderMatches) failures.push(`data-slot order is ${JSON.stringify(gotOrder)} (want ${JSON.stringify(expectedOrder)})`);
	for (const s of m.slots) {
		const want = expectedLabels[s.slot];
		if (want === undefined) {
			failures.push(`slot "${s.slot}" renders but declares no expected label`);
			continue;
		}
		if (s.labelText !== want) failures.push(`slot "${s.slot}" label is "${s.labelText}" (want "${want}")`);
		if (!(s.height > 0)) failures.push(`slot "${s.slot}" has no laid-out box (height ${s.height})`);
		if (s.borderTopStyle !== 'dashed') failures.push(`slot "${s.slot}" border-top-style is "${s.borderTopStyle}" (want "dashed")`);
	}
	return failures.length === 0
		? { passed: true, detail: `${m.slots.length} skeleton frame(s) in order ${gotOrder.join(', ')}, each labelled, laid out, dashed` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * The retoned pill computes to the `--text` token at `opacity: 0.85`, and
 * measurably NOT to `--fail`. Both expected colours are resolved from the
 * page's own tokens by the caller — this comparator never carries a literal.
 *
 * @param {{ count: number, color: string, opacity: string }} m
 * @param {string} textToken
 * @param {string} failToken
 * @returns {Verdict}
 */
export function evaluateIndeterminatePillNeutral(m, textToken, failToken) {
	/** @type {string[]} */
	const failures = [];
	if (typeof textToken !== 'string' || textToken === '') failures.push('the --text token did not resolve — this comparator would be vacuous');
	if (typeof failToken !== 'string' || failToken === '') failures.push('the --fail token did not resolve — this comparator would be vacuous');
	if (textToken && failToken && textToken === failToken) failures.push('the --text and --fail tokens resolved to the SAME colour — this comparator could not discriminate');
	if (m.count !== 1) failures.push(`${m.count} .lifecycle-pill--indeterminate element(s) found (want 1)`);
	if (m.color !== textToken) failures.push(`computed color is "${m.color}" (want the --text token, "${textToken}")`);
	if (m.opacity !== '0.85') failures.push(`computed opacity is "${m.opacity}" (want "0.85")`);
	if (m.color === failToken) failures.push(`computed color equals the --fail token ("${failToken}") — the pill still reads as an alarm`);
	return failures.length === 0
		? { passed: true, detail: `1 pill, color ${m.color} (== --text ${textToken}, != --fail ${failToken}), opacity ${m.opacity}` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * The retoned state still carries its own redundant word, distinct from every
 * other lifecycle phase's word — proof hue is not the sole differentiator.
 * Does NOT re-render the other four states; it only proves the word itself
 * collides with none of them.
 *
 * @param {{ pillText: string }} m
 * @param {string} expectedWord
 * @param {ReadonlyArray<string>} otherWords
 * @returns {Verdict}
 */
export function evaluatePillWordDistinct(m, expectedWord, otherWords) {
	/** @type {string[]} */
	const failures = [];
	if (typeof expectedWord !== 'string' || expectedWord === '') failures.push('the expected indeterminate-phase word is absent — this comparator would be vacuous');
	if (m.pillText !== expectedWord) failures.push(`pill text is "${m.pillText}" (want "${expectedWord}")`);
	if (otherWords.includes(m.pillText)) failures.push(`pill text "${m.pillText}" collides with another lifecycle phase's word: ${JSON.stringify(otherWords)}`);
	return failures.length === 0
		? { passed: true, detail: `pill text "${m.pillText}", distinct from ${JSON.stringify(otherWords)}` }
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — the matcher positive controls (`--prove-matchers`). Every
// comparator above is run TWICE: once against an input built to violate it,
// which must report FAIL, and once against a healthy input, which must
// report PASS.
// ---------------------------------------------------------------------------

const CONTROL_TEXT_RGB = 'rgb(233, 236, 242)';
const CONTROL_FAIL_RGB = 'rgb(239, 68, 68)';

/**
 * @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>}
 */
function matcherControls() {
	return Object.freeze([
		{
			label: 'frames-render comparator vs. a page missing the timeline frame',
			violating: evaluateFramesRender(
				{
					slots: [
						{ slot: 'title', labelText: EXPECTED_SLOT_LABELS.title, height: 32, borderTopStyle: 'dashed' },
						{ slot: 'lifecycle', labelText: EXPECTED_SLOT_LABELS.lifecycle, height: 32, borderTopStyle: 'dashed' },
					],
				},
				EXPECTED_SLOT_ORDER,
				EXPECTED_SLOT_LABELS,
			),
			healthy: evaluateFramesRender(
				{
					slots: EXPECTED_SLOT_ORDER.map((slot) => ({
						slot,
						labelText: EXPECTED_SLOT_LABELS[slot],
						height: 32,
						borderTopStyle: 'dashed',
					})),
				},
				EXPECTED_SLOT_ORDER,
				EXPECTED_SLOT_LABELS,
			),
		},
		{
			label: 'frames-render comparator vs. a title frame with zero height (present in source, never laid out)',
			violating: evaluateFramesRender(
				{
					slots: EXPECTED_SLOT_ORDER.map((slot) => ({
						slot,
						labelText: EXPECTED_SLOT_LABELS[slot],
						height: slot === 'title' ? 0 : 32,
						borderTopStyle: 'dashed',
					})),
				},
				EXPECTED_SLOT_ORDER,
				EXPECTED_SLOT_LABELS,
			),
			healthy: evaluateFramesRender(
				{
					slots: EXPECTED_SLOT_ORDER.map((slot) => ({
						slot,
						labelText: EXPECTED_SLOT_LABELS[slot],
						height: 32,
						borderTopStyle: 'dashed',
					})),
				},
				EXPECTED_SLOT_ORDER,
				EXPECTED_SLOT_LABELS,
			),
		},
		{
			label: 'indeterminate-pill-neutral comparator vs. a pill still resolving to --fail at full opacity',
			violating: evaluateIndeterminatePillNeutral({ count: 1, color: CONTROL_FAIL_RGB, opacity: '1' }, CONTROL_TEXT_RGB, CONTROL_FAIL_RGB),
			healthy: evaluateIndeterminatePillNeutral({ count: 1, color: CONTROL_TEXT_RGB, opacity: '0.85' }, CONTROL_TEXT_RGB, CONTROL_FAIL_RGB),
		},
		{
			label: 'indeterminate-pill-neutral comparator vs. two pills where one should be exactly one',
			violating: evaluateIndeterminatePillNeutral({ count: 2, color: CONTROL_TEXT_RGB, opacity: '0.85' }, CONTROL_TEXT_RGB, CONTROL_FAIL_RGB),
			healthy: evaluateIndeterminatePillNeutral({ count: 1, color: CONTROL_TEXT_RGB, opacity: '0.85' }, CONTROL_TEXT_RGB, CONTROL_FAIL_RGB),
		},
		{
			label: 'pill-word-distinct comparator vs. a pill whose word collides with another phase',
			violating: evaluatePillWordDistinct({ pillText: OTHER_PHASE_WORDS[0] }, INDETERMINATE_WORD, OTHER_PHASE_WORDS),
			healthy: evaluatePillWordDistinct({ pillText: INDETERMINATE_WORD }, INDETERMINATE_WORD, OTHER_PHASE_WORDS),
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
			process.stderr.write(
				`[${LABEL}] matcher is inert — the "${control.label}" positive-control input did not fail. ` +
					'This gate cannot detect a real regression until the comparator is fixed.\n',
			);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(
				`[${LABEL}] matcher is indiscriminate — the "${control.label}" comparator ALSO failed its healthy input: ${control.healthy.detail}\n`,
			);
		}
	}
	if (inert > 0 || indiscriminate > 0) {
		fail(`${inert} comparator(s) inert, ${indiscriminate} indiscriminate, out of ${controls.length}.`);
	}
	process.stdout.write(
		`[${LABEL}] OK: all ${controls.length} comparators reported FAIL on a violating input and PASS on a healthy one — live and discriminating.\n`,
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// The build / serve / launch plumbing, copied in shape from
// `render-fidelity-gate.mjs`.
// ---------------------------------------------------------------------------

/**
 * @param {string} [configRel] which vite config to build with (defaults to the healthy gate config)
 * @param {Record<string,string>} [env] extra environment for the spawned build
 * @param {boolean} [lenient] resolve with the exit code instead of throwing, for the control's mutant leg
 */
async function buildGate(configRel = GATE_CONFIG, env = {}, lenient = false) {
	const viteBin = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
	if (!existsSync(viteBin)) fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
	return await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [viteBin, 'build', '--config', configRel], {
			cwd: APP_DIR,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => {
			if (lenient) resolvePromise(code ?? 1);
			else if (code === 0) resolvePromise(0);
			else rejectPromise(new Error(`vite build --config ${configRel} exited ${code}`));
		});
	});
}

/**
 * Resolve the built entry by SEARCHING the dist dir for exactly one file of
 * that name, rather than predicting the bundler's output path.
 * @param {string} [distAbs]
 * @returns {string}
 */
function resolveGateEntry(distAbs = GATE_DIST) {
	if (!existsSync(distAbs)) fail(`gate dist "${distAbs}" does not exist — run \`yarn build:gate\` or drop --skip-build.`);
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
	const matches = walk(distAbs);
	if (matches.length !== 1) fail(`expected exactly one "${GATE_ENTRY}" under "${distAbs}", found ${matches.length}.`);
	return path.relative(distAbs, matches[0]).split(path.sep).join('/');
}

/**
 * Everything the rungs need, read out of the live page in ONE evaluate so the
 * whole readout describes a single layout rather than several.
 * @param {import('playwright').Page} page
 */
function readPage(page) {
	return page.evaluate((p) => {
		/** @param {string} raw */
		const normalizeColor = (raw) => {
			const probe = document.createElement('span');
			probe.style.color = raw;
			document.body.appendChild(probe);
			const normalized = getComputedStyle(probe).color;
			probe.remove();
			return normalized;
		};
		const rootStyle = getComputedStyle(document.documentElement);
		const rawText = rootStyle.getPropertyValue('--text').trim();
		const rawFail = rootStyle.getPropertyValue('--fail').trim();
		const tokenText = rawText ? normalizeColor(rawText) : '';
		const tokenFail = rawFail ? normalizeColor(rawFail) : '';

		const gateReadout = /** @type {any} */ (globalThis).__UI_GATE__ ?? null;

		const root = document.getElementById('root');
		const notHeldTitleEl = root ? [...root.querySelectorAll('h2, p')].find((el) => el.textContent === p.notHeldTitle) ?? null : null;
		const rollEl = root ? root.querySelector('.registrant-roll') : null;
		const bannerEl = root ? root.querySelector('.status-banner') : null;

		const slotEls = root ? [...root.querySelectorAll('.skeleton')] : [];
		const slots = slotEls.map((el) => {
			const cs = getComputedStyle(el);
			const label = el.querySelector('.skeleton-label');
			const rect = el.getBoundingClientRect();
			return {
				slot: el.getAttribute('data-slot') ?? '',
				labelText: label ? (label.textContent ?? '') : '',
				height: rect.height,
				borderTopStyle: cs.borderTopStyle,
			};
		});

		const pillEls = root ? [...root.querySelectorAll('.lifecycle-pill--indeterminate')] : [];
		const firstPill = pillEls[0] ?? null;
		const pillCs = firstPill ? getComputedStyle(firstPill) : null;

		return {
			gate: gateReadout ? { error: gateReadout.error, notHeld: gateReadout.notHeld } : null,
			tokenText,
			tokenFail,
			notHeldTitlePresent: notHeldTitleEl !== null,
			rollPresent: rollEl !== null,
			bannerPresent: bannerEl !== null,
			slots,
			pill: {
				count: pillEls.length,
				color: pillCs ? pillCs.color : '',
				opacity: pillCs ? pillCs.opacity : '',
				text: firstPill ? (firstPill.textContent ?? '') : '',
			},
		};
	}, { notHeldTitle: NOT_HELD_TITLE });
}

/**
 * Build/serve/drive one dist and record every rung against it, WITHOUT
 * exiting. Returns a structured outcome so a control can distinguish
 * `vacuous` (the readout never published, the harness recorded an error, the
 * notHeld channel is null, a precondition failed) from a run that genuinely
 * produced rung verdicts.
 *
 * @param {string} distAbs
 * @param {number} port
 * @returns {Promise<{ ok: boolean, vacuity: string | null, results: Array<{id:string,passed:boolean,detail:string}> }>}
 */
async function driveRungs(distAbs, port) {
	rungs.length = 0;
	/** @type {string | null} */
	let vacuity = null;
	/** @param {string} m */
	const bail = (m) => {
		vacuity = m;
	};
	const entryRel = resolveGateEntry(distAbs);
	let server;
	let browser;
	try {
		server = await serveDist(distAbs, port);
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		/** @type {string[]} */
		const console_lines = [];
		page.on('console', (m) => console_lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => console_lines.push(`[pageerror] ${e.message}`));

		const url = `${server.url}/${entryRel}?${NOT_HELD_QUERY}`;
		process.stdout.write(`[${LABEL}] GET ${url}\n`);
		await page.goto(url, { waitUntil: 'load' });
		await page
			.waitForFunction(() => /** @type {any} */ (globalThis).__UI_GATE_DONE__ === true, null, { timeout: 180_000 })
			.catch(() => {});

		const m = await readPage(page);
		const loud = console_lines.filter((line) => !line.startsWith('[warning]'));
		for (const line of loud) process.stdout.write(`  ${line}\n`);
		process.stdout.write(`  (${console_lines.length - loud.length} store-upgrade warning(s) suppressed, ${loud.length} other console line(s) shown)\n`);

		// Anti-vacuity, all of it BEFORE any rung runs, each its own named hard
		// stop — a bail() outcome, never a pass.
		const gate = m.gate;
		if (gate === null) bail('the harness never published its readout — the page did not finish, so no rung ran.');
		else if (gate.error !== null) bail(`the harness recorded a render/seed error: ${gate.error}`);
		else {
			const nh = gate.notHeld;
			if (nh === null || nh === undefined) bail('the readout carries no notHeld channel — the page was not built with the fixture=not-held parameter.');
			else if (typeof nh.requestedElectionId !== 'string' || nh.requestedElectionId === nh.seededElectionId) {
				bail(`the requested election id ("${nh.requestedElectionId}") equals the seeded one ("${nh.seededElectionId}") — this run cannot distinguish a not-held page from a genuinely held one.`);
			} else if (nh.requestedElectionId.length < 43) {
				bail(`the requested election id is ${nh.requestedElectionId.length} characters — shorter than the 43-character production-length precondition.`);
			} else if (!ELECTION_ID_PATTERN.test(nh.requestedElectionId)) {
				bail(`the requested election id fails ELECTION_ID_PATTERN: "${nh.requestedElectionId}"`);
			} else if (!m.notHeldTitlePresent) {
				bail('no element inside #root carries text equal to the notHeld title copy — the page is not in the state under test.');
			} else if (m.rollPresent) {
				bail('#root contains a .registrant-roll — the page is in a different state than the one claimed.');
			} else if (m.bannerPresent) {
				bail('#root contains a .status-banner — the page is in a different state than the one claimed.');
			} else if (!m.tokenText || !m.tokenFail) {
				bail(`the design tokens did not resolve (--text="${m.tokenText}", --fail="${m.tokenFail}") — every var(--…) would resolve empty and a colour rung would pass against any colour.`);
			} else if (m.tokenText === m.tokenFail) {
				bail(`--text and --fail resolved to the SAME colour ("${m.tokenText}") — the retone rung could not discriminate.`);
			} else {
				const frames = evaluateFramesRender({ slots: m.slots }, EXPECTED_SLOT_ORDER, EXPECTED_SLOT_LABELS);
				record('notheld-frames-render', frames.passed, frames.detail);

				const pillNeutral = evaluateIndeterminatePillNeutral(
					{ count: m.pill.count, color: m.pill.color, opacity: m.pill.opacity },
					m.tokenText,
					m.tokenFail,
				);
				record('indeterminate-pill-neutral', pillNeutral.passed, pillNeutral.detail);

				const wordDistinct = evaluatePillWordDistinct({ pillText: m.pill.text }, INDETERMINATE_WORD, OTHER_PHASE_WORDS);
				record('pill-word-distinct-without-hue', wordDistinct.passed, wordDistinct.detail);
			}
		}
	} finally {
		await browser?.close();
		await server?.close();
	}
	return { ok: vacuity === null, vacuity, results: rungs.map((r) => ({ ...r })) };
}

/**
 * The normal, non-inverted run: drive `distAbs`, print every rung, set the
 * process exit code. A vacuity bail is a hard failure here.
 * @param {string} distAbs
 * @param {number} port
 */
async function driveAndReport(distAbs, port) {
	const outcome = await driveRungs(distAbs, port);
	if (!outcome.ok) fail(String(outcome.vacuity));

	let failed = 0;
	for (const id of RUNG_IDS) {
		const rung = outcome.results.find((r) => r.id === id);
		if (!rung) {
			failed += 1;
			process.stdout.write(`FAIL  ${id}\n      -> never ran\n`);
			continue;
		}
		if (!rung.passed) failed += 1;
		process.stdout.write(`${rung.passed ? 'PASS' : 'FAIL'}  ${rung.id}\n      -> ${rung.detail}\n`);
	}
	process.stdout.write(`\nEMPTY STATE: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

/**
 * `--prove-pill-retone-reverted` — the BUILD-LEVEL half of the retone's
 * negative control (56-03 Task 3), on the identical shape
 * `render-fidelity-gate.mjs`'s `--prove-gap-cues-flattened` uses. See that
 * function's own header for why the four verdicts (control-could-not-run /
 * no-op / wrong-failure-shape / inert) are kept distinct.
 *
 * @param {number} port
 * @param {boolean} skipBuild
 */
async function runProvePillRetoneReverted(port, skipBuild) {
	const PREFIX = `[${LABEL}] --prove-pill-retone-reverted: control could not run —`;

	// Leg 1, the healthy baseline. It must pass EVERY rung, the target rung
	// included: a control cannot invert a rung that was never passing.
	if (!skipBuild) await buildGate();
	const healthy = await driveRungs(GATE_DIST, port);
	if (!healthy.ok) {
		process.stderr.write(`\n${PREFIX} the healthy leg did not render: ${healthy.vacuity}\n`);
		process.exit(1);
	}
	const healthyFailed = healthy.results.filter((r) => !r.passed);
	if (healthyFailed.length > 0 || healthy.results.length !== RUNG_IDS.length) {
		process.stderr.write(
			`\n${PREFIX} the healthy leg did not pass every rung, so nothing here can be attributed to the mutation.\n` +
				`  ran ${healthy.results.length}/${RUNG_IDS.length}, failed: ${healthyFailed.map((r) => r.id).join(', ') || 'none'}\n`,
		);
		process.exit(1);
	}
	process.stdout.write(`[${LABEL}] healthy leg: ${healthy.results.length}/${RUNG_IDS.length} rungs passed (full pass)\n`);

	// Leg 2, the mutant build. Source is mutated by a Vite plugin before a
	// real `vite build`; dist is never edited and nothing is injected at
	// runtime.
	process.stdout.write(`[${LABEL}] building the ${RETONE_MUTATION} mutant via ${MUTANT_CONFIG}\n`);
	const code = await buildGate(MUTANT_CONFIG, { UI_GATE_MUTATION: RETONE_MUTATION }, true);
	if (code !== 0) {
		process.stderr.write(`\n${PREFIX} the ${RETONE_MUTATION} mutant build exited ${code}\n`);
		process.exit(1);
	}

	// Machine-readable proof the mutation fired. Never a log scrape.
	let report;
	try {
		report = readMutationReport(MUTANT_DIST);
	} catch (err) {
		process.stderr.write(`\n${PREFIX} ${/** @type {any} */ (err)?.message ?? err}\n`);
		process.exit(1);
	}
	process.stdout.write(`[${LABEL}] mutation report: ${JSON.stringify(report)}\n`);
	if (report.mutation !== RETONE_MUTATION || !Number.isInteger(report.replacements) || report.replacements < 1) {
		process.stderr.write(
			`\n[${LABEL}] MUTATION IS A NO-OP — the mutant build exited 0 but reverted no declaration body.\n` +
				`  report=${JSON.stringify(report)}\n` +
				'  This is NOT the same verdict as an inert gate: the gate was never put to the test at all.\n',
		);
		process.exit(1);
	}

	const mutant = await driveRungs(MUTANT_DIST, port);
	if (!mutant.ok) {
		process.stderr.write(
			`\n[${LABEL}] WRONG FAILURE SHAPE — the mutant page did not render at all: ${mutant.vacuity}\n` +
				'  A crashed or blank page failing every rung is not evidence the retone rung discriminates.\n',
		);
		process.exit(1);
	}
	for (const r of mutant.results) {
		process.stdout.write(`  mutant  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}\n            -> ${r.detail}\n`);
	}

	const target = mutant.results.find((r) => r.id === RETONE_RUNG_ID);
	const collateral = mutant.results.filter((r) => r.id !== RETONE_RUNG_ID && !r.passed);

	if (!target) {
		process.stderr.write(`\n[${LABEL}] WRONG FAILURE SHAPE — the rung "${RETONE_RUNG_ID}" did not run on the mutant leg.\n`);
		process.exit(1);
	}
	if (target.passed) {
		process.stderr.write(
			`\n[${LABEL}] --prove-pill-retone-reverted: the retone rung is inert — a rebuild with the retone reverted still ` +
				`PASSED "${RETONE_RUNG_ID}".\n  detail: ${target.detail}\n`,
		);
		process.exit(1);
	}
	if (collateral.length > 0) {
		process.stderr.write(
			`\n[${LABEL}] WRONG FAILURE SHAPE — the mutation took down rungs it has no business touching: ${collateral.map((r) => r.id).join(', ')}\n` +
				collateral.map((r) => `  ${r.id}: ${r.detail}\n`).join(''),
		);
		process.exit(1);
	}

	process.stdout.write(
		`\n[${LABEL}] --prove-pill-retone-reverted PASS — a rebuilt product with the retone reverted genuinely FAILED "${RETONE_RUNG_ID}" ` +
			`while all ${RUNG_IDS.length - 1} other rungs still passed.\n` +
			`  reverted ${report.replacements} rule(s): ${JSON.stringify(report.selectors)}\n` +
			`  failure detail: ${target.detail}\n`,
	);
	process.exit(0);
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let proveRetoneReverted = false;
	let port = Number(process.env.EMPTY_STATE_PORT ?? DEFAULT_PORT);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') runProveMatchers();
		else if (arg === '--prove-pill-retone-reverted') proveRetoneReverted = true;
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	if (proveRetoneReverted) {
		await runProvePillRetoneReverted(port, skipBuild);
		return;
	}
	if (!skipBuild) await buildGate();
	await driveAndReport(GATE_DIST, port);
}

await main();
