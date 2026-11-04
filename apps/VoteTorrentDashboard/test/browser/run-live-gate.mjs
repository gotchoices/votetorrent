#!/usr/bin/env node
/**
 * run-live-gate.mjs -- the live dashboard's browser gate (UI-SPEC gates 1-8
 * and 10, plus D-10, D-13, D-14, D-15, D-19, D-20 and D-23), run in a real
 * headless Chromium against a PRODUCTION vite build of `live-gate.html`.
 *
 * WHAT IT PROVES. The page mounts the shipped shell, boot, strand reader,
 * replication bridge, IndexedDB live store, registry, status reducer, chip,
 * panels, change marks, pairing screen and scanner. Only the peer layer is
 * fake (see `live-gate.tsx`): four boot deps through the shell's `bootDeps`
 * and the pairing screen's `loadPairing`. Every rung measures computed
 * values, boxes and times, and every comparator below is a pure function
 * that `--prove-matchers` runs against a violating input (must FAIL) and a
 * healthy input (must PASS), the Phase 60 pattern.
 *
 * WHAT IT DOES NOT PROVE. No libp2p, no cadre-core, no relay, no cohort:
 * 66-26 runs real nodes, 66-27 the devices. The strand image is a fixture.
 *
 * BUILD. A programmatic `vite build` of `live-gate.html` merged over the
 * app's own `vite.config.ts`, into a fresh `mkdtemp` outDir with a fresh
 * scratch `cacheDir` every run (a reused cache false-negates controls), never
 * `dist/`. `vite dev` is never a gate. Served by `serveDist` on a FIXED port
 * (5187 unless `--port`); a bound port fails loudly.
 *
 * ISOLATION. Every context aborts any request that is not same-origin and
 * counts it; rung `iso-no-external-requests` needs zero aborted and at least
 * one origin request. Contexts run with `timezoneId: 'UTC'`, `locale: 'en-US'`.
 *
 * HYGIENE. Fixture codes are synthetic, yet this runner prints only their
 * length and a SHA-256 prefix. Rung details carry measurements and counts.
 * The banned copy words of gate 8 are assembled from fragments, so a scan of
 * this file never finds one whole.
 *
 * FLAGS:
 *   --prove-matchers        run every comparator's controls; no browser, no build
 *   --legs <a,b,...>        run only these legs (tokens and isolation always run)
 *   --skip-build --dist <d> serve an existing build (local iteration only)
 *   --port <n>              bind another port
 * Any other argument exits 2 naming it.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY, t } from '../../../../packages/ui-web/src/copy.js';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(APP_DIR, 'src');
const GATE_HTML = path.join(__dirname, 'live-gate.html');
const DEFAULT_PORT = 5187;
const LABEL = 'run-live-gate';

// --- Spec literals (UI-SPEC / CONTEXT), never imported product constants ---
export const MARK_LIFETIME_MS = 4000;
export const MARK_TOLERANCE_MS = 300;
export const OFFLINE_GRACE_MS = 10_000;
export const CHIP_DEBOUNCE_MS = 1000;
export const CHIP_HEIGHT_PX = 32;
export const BACKGROUND_RETRY_WINDOW_MS = 25_000;
export const CHIP_WIDTHS = Object.freeze([1280, 1024, 901, 800]);
export const CODE_WIDTHS = Object.freeze([
	{ width: 1280, height: 720, ctaRequired: true },
	{ width: 768, height: 1024, ctaRequired: false },
	{ width: 375, height: 667, ctaRequired: true },
]);
export const LONG_CODE_CHARS = 3000;
export const SLICE_CHARS = 40;
export const BODY_BACKGROUND = 'rgb(13, 15, 20)';
export const PRIMARY_RGB = 'rgb(59, 130, 246)';
const PX_TOL = 0.5;

// --- Rung registry -----------------------------------------------------------

const T1_RUNGS = [
	'g1-tokens-first',
	'iso-no-external-requests',
	'g2-composed-shell-non-blank',
	'd10-panel-bodies-no-write-affordance',
	'g3-chip-geometry',
	'g3-control-clip-detected',
	'g4-long-code-no-overflow',
	'g4-code-never-leaves-the-field',
	'g5-no-marks-first-render',
	'g5-one-mark-4s',
	'g5-reduced-motion-static-mark',
	'g6-catching-up-until-first-pass',
	'g10-scanner-close-ends-tracks',
	'g10-scanner-esc-ends-tracks',
	'g8-copy-mounted-keys',
];

/** @type {ReadonlyArray<string>} */
export const RUNG_IDS = Object.freeze([...T1_RUNGS]);

/** Leg -> the rungs it records. `tokens` and isolation are recorded by every run. */
export const LEG_RUNGS = Object.freeze({
	tokens: Object.freeze(['g1-tokens-first', 'iso-no-external-requests']),
	shell: Object.freeze(['g2-composed-shell-non-blank', 'd10-panel-bodies-no-write-affordance']),
	chip: Object.freeze(['g3-chip-geometry', 'g3-control-clip-detected']),
	pairing: Object.freeze(['g4-long-code-no-overflow', 'g4-code-never-leaves-the-field']),
	marks: Object.freeze(['g5-no-marks-first-render', 'g5-one-mark-4s', 'g5-reduced-motion-static-mark']),
	truth: Object.freeze(['g6-catching-up-until-first-pass']),
	scanner: Object.freeze(['g10-scanner-close-ends-tracks', 'g10-scanner-esc-ends-tracks']),
	copy: Object.freeze(['g8-copy-mounted-keys']),
});
const LEG_ORDER = Object.freeze(['shell', 'chip', 'pairing', 'marks', 'truth', 'scanner', 'copy']);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/** @param {string} id @param {boolean} passed @param {string} detail */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	rungs.push({ id, passed, detail });
	process.stdout.write(`[${LABEL}] ${passed ? 'PASS' : 'FAIL'} ${id}: ${detail}\n`);
}

/** @param {string} text */
function sha256Prefix(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** @param {string} message */
function say(message) {
	process.stdout.write(`[${LABEL}] ${message}\n`);
}

/** @param {string} message @returns {never} */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// THE COMPARATORS -- pure functions over measured values.
// ---------------------------------------------------------------------------

/** @typedef {{ passed: boolean, detail: string }} Verdict */
/** @typedef {{ left: number, top: number, right: number, bottom: number, width: number, height: number }} Box */

/** @param {string[]} failures @param {string} ok @returns {Verdict} */
function verdict(failures, ok) {
	return failures.length === 0 ? { passed: true, detail: ok } : { passed: false, detail: failures.join('; ') };
}

/** @param {Box} a @param {Box} b */
function intersects(a, b) {
	const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return w > PX_TOL && h > PX_TOL;
}

/** @param {Box} inner @param {Box} outer */
function inside(inner, outer) {
	return (
		inner.left >= outer.left - PX_TOL &&
		inner.top >= outer.top - PX_TOL &&
		inner.right <= outer.right + PX_TOL &&
		inner.bottom <= outer.bottom + PX_TOL
	);
}

/** @param {string} s */
function norm(s) {
	return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Gate 1: the body background and `--primary` are measured before anything else.
 * @param {{ background: string, primary: string }} m
 * @returns {Verdict}
 */
export function evaluateTokens(m) {
	/** @type {string[]} */
	const f = [];
	if (m.background !== BODY_BACKGROUND) f.push(`body background "${m.background}" is not ${BODY_BACKGROUND}`);
	if (typeof m.primary !== 'string' || m.primary.trim() === '') f.push('--primary is empty');
	return verdict(f, `body background ${m.background}, --primary "${String(m.primary).trim()}"`);
}

/**
 * Gate 2: at least one panel with a visible, non-empty text node of non-zero box.
 * @param {{ panelCount: number, textPanels: number, deniedCount: number }} m
 * @returns {Verdict}
 */
export function evaluateNonBlankShell(m) {
	/** @type {string[]} */
	const f = [];
	if (!(m.panelCount >= 1)) f.push(`panels measured: ${m.panelCount}`);
	if (!(m.textPanels >= 1)) f.push(`panels with a visible text node: ${m.textPanels}`);
	return verdict(f, `panels ${m.panelCount} (denied ${m.deniedCount}), with visible text ${m.textPanels}`);
}

/**
 * D-10: no panel body holds a control or a pointer cursor; zero bodies fails.
 * @param {{ bodies: Array<{ index: number, controls: number, pointers: number }> }} m
 * @returns {Verdict}
 */
export function evaluatePanelBodies(m) {
	/** @type {string[]} */
	const f = [];
	if (m.bodies.length === 0) f.push('zero panel bodies measured');
	for (const body of m.bodies) {
		if (body.controls > 0) f.push(`panel body ${body.index} holds ${body.controls} control(s)`);
		if (body.pointers > 0) f.push(`panel body ${body.index} has ${body.pointers} pointer-cursor element(s)`);
	}
	return verdict(f, `${m.bodies.length} panel bodies, no control, no pointer cursor`);
}

/**
 * Gate 3 / D-13: one measured chip state at one width.
 * @param {{
 *   state: string, width: number, statusCount: number, text: string, expectedText: string, expectReconnect: boolean,
 *   chip: (Box & { scrollWidth: number, clientWidth: number }) | null,
 *   reconnect: (Box & { scrollWidth: number, clientWidth: number }) | null,
 *   topbar: (Box & { scrollWidth: number, clientWidth: number }) | null,
 *   neighbours: Array<{ name: string, box: Box }>,
 *   name: { scrollWidth: number, clientWidth: number, textOverflow: string, width: number } | null,
 *   viewport: { w: number, h: number },
 * }} m
 * @returns {Verdict}
 */
export function evaluateChipGeometry(m) {
	/** @type {string[]} */
	const f = [];
	const at = `${m.state}@${m.width}`;
	if (m.statusCount !== 1) f.push(`${at}: ${m.statusCount} [role=status] elements (want 1)`);
	if (!m.chip) return verdict([...f, `${at}: no chip`], '');
	if (!m.topbar) return verdict([...f, `${at}: no top bar`], '');
	if (m.neighbours.length < 3) f.push(`${at}: only ${m.neighbours.length} neighbour(s) measured (want >= 3)`);
	if (!inside(m.chip, m.topbar)) f.push(`${at}: the chip box is outside the top bar`);
	for (const n of m.neighbours) {
		if (intersects(m.chip, n.box)) f.push(`${at}: the chip intersects ${n.name}`);
		if (m.reconnect && intersects(m.reconnect, n.box)) f.push(`${at}: Reconnect intersects ${n.name}`);
		if (n.box.left < -PX_TOL || n.box.right > m.viewport.w + PX_TOL) f.push(`${at}: ${n.name} leaves the viewport`);
	}
	if (m.chip.scrollWidth > m.chip.clientWidth) f.push(`${at}: chip clipped, scrollWidth ${m.chip.scrollWidth} > clientWidth ${m.chip.clientWidth}`);
	if (m.topbar.scrollWidth > m.topbar.clientWidth) f.push(`${at}: top bar overflows, ${m.topbar.scrollWidth} > ${m.topbar.clientWidth}`);
	if (m.expectReconnect !== (m.reconnect !== null)) f.push(`${at}: Reconnect ${m.reconnect ? 'present' : 'absent'} (want ${m.expectReconnect ? 'present' : 'absent'})`);
	if (m.reconnect) {
		if (m.reconnect.scrollWidth > m.reconnect.clientWidth) f.push(`${at}: Reconnect clipped, ${m.reconnect.scrollWidth} > ${m.reconnect.clientWidth}`);
		if (!inside(m.reconnect, m.topbar)) f.push(`${at}: Reconnect is outside the top bar`);
		if (Math.abs(m.reconnect.height - CHIP_HEIGHT_PX) > PX_TOL) f.push(`${at}: Reconnect is ${m.reconnect.height}px tall (want ${CHIP_HEIGHT_PX})`);
		if (m.reconnect.left < -PX_TOL || m.reconnect.right > m.viewport.w + PX_TOL || m.reconnect.top < -PX_TOL || m.reconnect.bottom > m.viewport.h + PX_TOL) {
			f.push(`${at}: Reconnect is not fully inside the viewport`);
		}
	}
	if (m.width >= 901) {
		if (Math.abs(m.chip.height - CHIP_HEIGHT_PX) > PX_TOL) f.push(`${at}: chip is ${m.chip.height}px tall, not one ${CHIP_HEIGHT_PX}px line`);
		if (m.reconnect && Math.abs(m.reconnect.top - m.chip.top) > 1) f.push(`${at}: Reconnect is not on the chip's row`);
	}
	if (!m.name) f.push(`${at}: no authority name`);
	else {
		if (m.name.scrollWidth > m.name.clientWidth && m.name.textOverflow !== 'ellipsis') f.push(`${at}: the authority name overflows without an ellipsis`);
		if (m.name.width < 120) f.push(`${at}: the authority name is only ${m.name.width}px wide`);
	}
	if (norm(m.text) !== norm(m.expectedText)) f.push(`${at}: chip text differs from the copy value for the state`);
	return verdict(
		f,
		`${at}: chip ${m.chip.width.toFixed(1)}x${m.chip.height.toFixed(1)} (${m.chip.scrollWidth}/${m.chip.clientWidth})` +
			(m.reconnect ? `, Reconnect ${m.reconnect.width.toFixed(1)}x${m.reconnect.height.toFixed(1)}` : '') +
			`, ${m.neighbours.length} neighbours clear`,
	);
}

/**
 * Gate 4: a 3000-character code causes no horizontal overflow; the CTA is reachable.
 * @param {{ width: number, height: number, valueLength: number, ctaRequired: boolean,
 *   card: { scrollWidth: number, clientWidth: number } | null,
 *   textarea: { scrollWidth: number, clientWidth: number } | null,
 *   page: { scrollWidth: number, innerWidth: number },
 *   cta: { box: Box, enabled: boolean } | null, scrollY: number }} m
 * @returns {Verdict}
 */
export function evaluateLongCode(m) {
	/** @type {string[]} */
	const f = [];
	const at = `${m.width}x${m.height}`;
	if (m.valueLength !== LONG_CODE_CHARS) f.push(`${at}: field holds ${m.valueLength} characters (want ${LONG_CODE_CHARS})`);
	if (!m.card) f.push(`${at}: no card`);
	else if (m.card.scrollWidth > m.card.clientWidth) f.push(`${at}: card overflows ${m.card.scrollWidth} > ${m.card.clientWidth}`);
	if (!m.textarea) f.push(`${at}: no textarea`);
	else if (m.textarea.scrollWidth > m.textarea.clientWidth) f.push(`${at}: textarea overflows ${m.textarea.scrollWidth} > ${m.textarea.clientWidth}`);
	if (m.page.scrollWidth > m.page.innerWidth) f.push(`${at}: page overflows ${m.page.scrollWidth} > ${m.page.innerWidth}`);
	if (m.ctaRequired) {
		if (!m.cta) f.push(`${at}: no CTA`);
		else {
			if (!m.cta.enabled) f.push(`${at}: CTA disabled`);
			const b = m.cta.box;
			if (b.left < -PX_TOL || b.top < -PX_TOL || b.right > m.width + PX_TOL || b.bottom > m.height + PX_TOL) f.push(`${at}: CTA not fully inside the viewport (bottom ${b.bottom.toFixed(1)})`);
		}
		if (m.scrollY !== 0) f.push(`${at}: page scrolled to ${m.scrollY}`);
	}
	return verdict(f, `${at}: card/textarea/page within width, length ${m.valueLength}${m.ctaRequired ? ', CTA in view' : ''}`);
}

/**
 * Gate 4 containment: no 40-character slice of the code in any place it must not reach.
 * @param {{ code: string, haystacks: Array<{ where: string, text: string }>, consumedFieldValue: string | null }} m
 * @returns {Verdict}
 */
export function evaluateCodeContainment(m) {
	/** @type {string[]} */
	const f = [];
	if (m.code.length < SLICE_CHARS) f.push('the code is shorter than one slice');
	const slices = new Set();
	for (let i = 0; i + SLICE_CHARS <= m.code.length; i += 1) slices.add(m.code.slice(i, i + SLICE_CHARS));
	/** @type {Set<string>} */
	const leaked = new Set();
	for (const { where, text } of m.haystacks) {
		const s = String(text ?? '');
		for (let i = 0; i + SLICE_CHARS <= s.length; i += 1) {
			if (slices.has(s.slice(i, i + SLICE_CHARS))) {
				leaked.add(where);
				break;
			}
		}
	}
	for (const where of leaked) f.push(`a code slice reached ${where}`);
	if (m.haystacks.length === 0) f.push('zero places searched');
	if (m.consumedFieldValue !== '') f.push(`the field still holds ${m.consumedFieldValue === null ? 'no measurable value' : m.consumedFieldValue.length + ' characters'} after a consuming failure`);
	return verdict(f, `${m.haystacks.length} places searched, no slice found; field empty after a consuming failure`);
}

/**
 * Gate 5. `expect: 'none'` (first render) wants zero marks; `expect: 'one'` wants exactly one
 * mark with the word, a tint, the primary inset bar and a 4000 +/- 300 ms lifetime; under
 * reduced motion every transition duration measured is 0s.
 * @param {{ expect: 'none' | 'one', reducedMotion?: boolean, statusCount?: number, liveRegionAnnounced?: boolean,
 *   marks: Array<{ addT: number, removeT: number | null, background: string, boxShadow: string, transitionAtAdd: string, transitionAtFade: string | null, hasWord: boolean }> }} m
 * @returns {Verdict}
 */
export function evaluateMarkTrace(m) {
	/** @type {string[]} */
	const f = [];
	if (m.expect === 'none') {
		if (m.marks.length !== 0) f.push(`${m.marks.length} mark(s) on the first render (want 0)`);
		return verdict(f, 'zero marks on the first render');
	}
	if (m.marks.length !== 1) return verdict([`${m.marks.length} marked element(s) (want exactly 1)`], '');
	const mark = m.marks[0];
	if (!mark.hasWord) f.push('the mark carries no "updated" word');
	if (!mark.background || mark.background === 'rgba(0, 0, 0, 0)' || mark.background === 'transparent') f.push(`no tint (background ${mark.background})`);
	if (!String(mark.boxShadow).includes(PRIMARY_RGB)) f.push('no primary inset bar');
	if (mark.removeT === null) f.push('the mark never cleared');
	else {
		const life = mark.removeT - mark.addT;
		if (Math.abs(life - MARK_LIFETIME_MS) > MARK_TOLERANCE_MS) f.push(`lifetime ${life.toFixed(0)} ms (want ${MARK_LIFETIME_MS} +/- ${MARK_TOLERANCE_MS})`);
	}
	if (m.reducedMotion) {
		for (const value of [mark.transitionAtAdd, mark.transitionAtFade]) {
			if (value === null) continue;
			if (String(value).split(',').some((v) => v.trim() !== '0s')) f.push(`transition-duration "${value}" under reduced motion`);
		}
	}
	if (m.statusCount !== undefined && m.statusCount !== 1) f.push(`${m.statusCount} [role=status] elements (want 1, the chip)`);
	if (m.liveRegionAnnounced === false) f.push('the polite live region gained no text');
	const life = mark.removeT === null ? NaN : mark.removeT - mark.addT;
	return verdict(f, `one mark, word present, lifetime ${life.toFixed(0)} ms${m.reducedMotion ? ', transitions 0s' : ''}`);
}

/**
 * The chip kinds in force over [from, to], from a change-only trace.
 * @param {Array<{ t: number, kind: string | null }>} samples @param {number} from @param {number} to
 */
function kindsInForce(samples, from, to) {
	const kinds = new Set();
	let before = null;
	for (const s of samples) {
		if (s.t <= from) before = s.kind;
		else if (s.t <= to) kinds.add(s.kind);
	}
	if (before !== null) kinds.add(before);
	return kinds;
}

/**
 * Gate 6 / D-13: while the first pass is held, the chip is Catching up and never Live; the
 * first Live follows the first pass-complete within debounce + slack.
 * @param {{ samples: Array<{ t: number, kind: string | null }>, heldFrom: number, heldTo: number, passCompleteT: number | null, slackMs: number }} m
 * @returns {Verdict}
 */
export function evaluateStatusTruth(m) {
	/** @type {string[]} */
	const f = [];
	const held = kindsInForce(m.samples, m.heldFrom, m.heldTo);
	if (!held.has('catching-up')) f.push(`no catching-up while held (kinds: ${[...held].join(',') || 'none'})`);
	if (held.has('live')) f.push('Live shown while the first pass was held');
	if (m.passCompleteT === null) return verdict([...f, 'no pass-complete after release'], '');
	const firstLive = m.samples.find((s) => s.kind === 'live' && s.t > m.heldFrom);
	if (!firstLive) f.push('never Live after release');
	else {
		if (firstLive.t <= m.passCompleteT) f.push(`Live at ${firstLive.t.toFixed(0)} before pass-complete at ${m.passCompleteT.toFixed(0)}`);
		if (firstLive.t > m.passCompleteT + CHIP_DEBOUNCE_MS + m.slackMs) f.push(`Live ${(firstLive.t - m.passCompleteT).toFixed(0)} ms after pass-complete`);
	}
	return verdict(f, `held kinds {${[...held].join(',')}}, Live ${firstLive ? (firstLive.t - m.passCompleteT).toFixed(0) : '?'} ms after pass-complete`);
}

/** @param {string[]} parts */
const word = (...parts) => parts.join('');
/** Gate 8's banned patterns, assembled from fragments (a scan of this file finds none whole). */
const BANNED = Object.freeze([
	{ name: word('snap', 'shot'), re: new RegExp(`\\b${word('snap', 'shot')}`, 'i') },
	{ name: word('as', ' of'), re: new RegExp(`\\b${word('as', ' of')}\\b`, 'i') },
	{ name: word('re', 'fresh'), re: new RegExp(`\\b${word('re', 'fresh')}`, 'i') },
	{ name: word('re', 'store'), re: new RegExp(`\\b${word('re', 'store')}`, 'i') },
	{ name: word('Pha', 'se'), re: new RegExp(`\\b${word('Pha', 'se')}\\b`) },
	{ name: word('D', '-NN'), re: new RegExp(`\\b${word('D', '-')}\\d+`) },
	{ name: word('era', 'se'), re: new RegExp(`\\b${word('era', 'se')}`, 'i') },
	{ name: 'erasure promise 1', re: new RegExp(word('permanently ', 'deleted from the network'), 'i') },
	{ name: 'erasure promise 2', re: new RegExp(word('no longer has ', 'access to the data'), 'i') },
]);

/**
 * Gate 8 (66-05 ruling 8): rendered texts and the copy values the dashboard source references.
 * Exact matches of the out-of-scope values are reported, not failed; texts equal to fixture
 * data are not copy and are exempt (counted).
 * @param {{ texts: string[], referencedValues: Array<{ key: string, value: string }>, outOfScope: string[], fixtureStrings: string[], minTexts?: number, minKeys?: number }} m
 * @returns {Verdict & { outOfScopeHits: string[], fixtureExempt: number }}
 */
export function evaluateCopy(m) {
	/** @type {string[]} */
	const f = [];
	const minTexts = m.minTexts ?? 20;
	const minKeys = m.minKeys ?? 50;
	const outOfScope = new Set(m.outOfScope);
	const fixture = new Set(m.fixtureStrings);
	/** @type {string[]} */
	const hits = [];
	let fixtureExempt = 0;
	/** @param {string} where @param {string} text */
	const scan = (where, text) => {
		if (outOfScope.has(text)) {
			hits.push(where);
			return;
		}
		for (const b of BANNED) if (b.re.test(text)) f.push(`${where} contains "${b.name}"`);
	};
	m.texts.forEach((text, i) => {
		if (fixture.has(text)) {
			fixtureExempt += 1;
			return;
		}
		scan(`rendered text #${i}`, text);
	});
	for (const { key, value } of m.referencedValues) scan(`copy key ${key}`, value);
	if (m.texts.length < minTexts) f.push(`only ${m.texts.length} rendered texts (vacuous below ${minTexts})`);
	if (m.referencedValues.length < minKeys) f.push(`only ${m.referencedValues.length} referenced keys (vacuous below ${minKeys})`);
	const v = verdict(f, `${m.texts.length} rendered texts (${fixtureExempt} fixture data), ${m.referencedValues.length} referenced keys, ${hits.length} known out-of-scope hit(s)`);
	return { ...v, outOfScopeHits: hits, fixtureExempt };
}

/**
 * Gate 10: every recorded camera track ended; zero tracks fails.
 * @param {{ streams: Array<{ tracks: Array<{ readyState: string }> }> }} m
 * @returns {Verdict}
 */
export function evaluateTracksEnded(m) {
	const tracks = m.streams.flatMap((s) => s.tracks);
	/** @type {string[]} */
	const f = [];
	if (tracks.length === 0) f.push('zero camera tracks recorded');
	const open = tracks.filter((tr) => tr.readyState !== 'ended');
	if (open.length > 0) f.push(`${open.length} of ${tracks.length} track(s) not ended`);
	return verdict(f, `${m.streams.length} stream(s), ${tracks.length} track(s), all ended`);
}

// ---------------------------------------------------------------------------
// --prove-matchers
// ---------------------------------------------------------------------------

/** @param {number} left @param {number} top @param {number} width @param {number} height @returns {Box} */
function box(left, top, width, height) {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

function healthyChip(width = 1280, overrides = {}) {
	return {
		state: 'offline',
		width,
		statusCount: 1,
		text: 'Offline · last update 12:00',
		expectedText: 'Offline · last update 12:00',
		expectReconnect: true,
		chip: { ...box(600, 10, 180, 32), scrollWidth: 178, clientWidth: 178 },
		reconnect: { ...box(790, 10, 76, 32), scrollWidth: 74, clientWidth: 74 },
		topbar: { ...box(0, 0, width, 120), scrollWidth: width, clientWidth: width },
		neighbours: [
			{ name: 'identity', box: box(0, 0, 400, 40) },
			{ name: 'switcher', box: box(410, 10, 180, 32) },
			{ name: 'kebab', box: box(width - 80, 10, 32, 32) },
		],
		name: { scrollWidth: 380, clientWidth: 380, textOverflow: 'ellipsis', width: 380 },
		viewport: { w: width, h: 720 },
		...overrides,
	};
}

function healthyMark(overrides = {}) {
	return {
		addT: 1000,
		removeT: 5000,
		background: 'color(srgb 0.23 0.51 0.96 / 0.15)',
		boxShadow: `${PRIMARY_RGB} 2px 0px 0px 0px inset`,
		transitionAtAdd: '0s',
		transitionAtFade: '2.5s',
		hasWord: true,
		...overrides,
	};
}

function matcherControls() {
	const code = 'vtpair1.' + 'Q'.repeat(LONG_CODE_CHARS - 8);
	const healthyCode = {
		width: 1280,
		height: 720,
		valueLength: LONG_CODE_CHARS,
		ctaRequired: true,
		card: { scrollWidth: 560, clientWidth: 560 },
		textarea: { scrollWidth: 520, clientWidth: 520 },
		page: { scrollWidth: 1280, innerWidth: 1280 },
		cta: { box: box(400, 500, 200, 40), enabled: true },
		scrollY: 0,
	};
	const healthyTexts = Array.from({ length: 25 }, (_, i) => `Panel heading ${i}`);
	const healthyKeys = Array.from({ length: 60 }, (_, i) => ({ key: `k.${i}`, value: `Value ${i}` }));
	const copyBase = { texts: healthyTexts, referencedValues: healthyKeys, outOfScope: ['Phase unknown'], fixtureStrings: [] };
	const truthSamples = [
		{ t: 0, kind: 'catching-up' },
		{ t: 5600, kind: 'live' },
	];

	/** @type {Array<{ label: string, violating: Verdict, healthy: Verdict }>} */
	const c = [];
	/** @param {string} label @param {Verdict} violating @param {Verdict} healthy */
	const add = (label, violating, healthy) => c.push({ label, violating, healthy });
	const okTokens = evaluateTokens({ background: BODY_BACKGROUND, primary: ' #3b82f6' });

	add('tokens: transparent body', evaluateTokens({ background: 'rgba(0, 0, 0, 0)', primary: '#3b82f6' }), okTokens);
	add('tokens: empty --primary', evaluateTokens({ background: BODY_BACKGROUND, primary: '' }), okTokens);
	add('shell: zero panels', evaluateNonBlankShell({ panelCount: 0, textPanels: 0, deniedCount: 0 }), evaluateNonBlankShell({ panelCount: 9, textPanels: 9, deniedCount: 0 }));
	add('shell: panels without text', evaluateNonBlankShell({ panelCount: 9, textPanels: 0, deniedCount: 0 }), evaluateNonBlankShell({ panelCount: 9, textPanels: 1, deniedCount: 0 }));
	add('bodies: one button', evaluatePanelBodies({ bodies: [{ index: 0, controls: 1, pointers: 0 }] }), evaluatePanelBodies({ bodies: [{ index: 0, controls: 0, pointers: 0 }] }));
	add('bodies: one pointer cursor', evaluatePanelBodies({ bodies: [{ index: 0, controls: 0, pointers: 1 }] }), evaluatePanelBodies({ bodies: [{ index: 0, controls: 0, pointers: 0 }] }));
	add('bodies: zero bodies', evaluatePanelBodies({ bodies: [] }), evaluatePanelBodies({ bodies: [{ index: 0, controls: 0, pointers: 0 }] }));
	const okChip = evaluateChipGeometry(healthyChip());
	add('chip: 1px outside the top bar', evaluateChipGeometry(healthyChip(1280, { topbar: { ...box(0, 11, 1280, 120), scrollWidth: 1280, clientWidth: 1280 } })), okChip);
	add('chip: 1px intersection', evaluateChipGeometry(healthyChip(1280, { neighbours: [...healthyChip().neighbours.slice(0, 2), { name: 'kebab', box: box(779, 10, 8, 32) }] })), okChip);
	add('chip: scrollWidth one over', evaluateChipGeometry(healthyChip(1280, { chip: { ...box(600, 10, 180, 32), scrollWidth: 179, clientWidth: 178 } })), okChip);
	add('chip: 33px tall at 1024', evaluateChipGeometry(healthyChip(1024, { chip: { ...box(600, 10, 180, 33), scrollWidth: 178, clientWidth: 178 }, reconnect: { ...box(790, 10, 76, 32), scrollWidth: 74, clientWidth: 74 } })), evaluateChipGeometry(healthyChip(1024)));
	add('chip: two [role=status]', evaluateChipGeometry(healthyChip(1280, { statusCount: 2 })), okChip);
	add('chip: zero neighbours', evaluateChipGeometry(healthyChip(1280, { neighbours: [] })), okChip);
	add('chip: Reconnect missing in Offline', evaluateChipGeometry(healthyChip(1280, { reconnect: null })), okChip);
	add('chip: Reconnect below the fold at 800', evaluateChipGeometry(healthyChip(800, { reconnect: { ...box(10, 700, 76, 32), scrollWidth: 74, clientWidth: 74 }, topbar: { ...box(0, 0, 800, 760), scrollWidth: 800, clientWidth: 800 } })), evaluateChipGeometry(healthyChip(800, { chip: { ...box(10, 60, 180, 40), scrollWidth: 178, clientWidth: 178 }, reconnect: { ...box(200, 64, 76, 32), scrollWidth: 74, clientWidth: 74 }, neighbours: [{ name: 'identity', box: box(0, 0, 400, 40) }, { name: 'switcher', box: box(410, 5, 180, 32) }, { name: 'kebab', box: box(760, 5, 32, 32) }] })));
	add('chip: wrong text', evaluateChipGeometry(healthyChip(1280, { text: 'Live' })), okChip);
	add('chip: bar overflow', evaluateChipGeometry(healthyChip(1280, { topbar: { ...box(0, 0, 1280, 120), scrollWidth: 3400, clientWidth: 1280 } })), okChip);
	const okCode = evaluateLongCode(healthyCode);
	add('code: page scrollWidth one over', evaluateLongCode({ ...healthyCode, page: { scrollWidth: 1281, innerWidth: 1280 } }), okCode);
	add('code: CTA 1px below the fold', evaluateLongCode({ ...healthyCode, cta: { box: box(400, 681, 200, 40), enabled: true } }), okCode);
	add('code: card overflow', evaluateLongCode({ ...healthyCode, card: { scrollWidth: 3000, clientWidth: 560 } }), okCode);
	add('code: vacuous field', evaluateLongCode({ ...healthyCode, valueLength: 0 }), okCode);
	const okContain = evaluateCodeContainment({ code, haystacks: [{ where: 'localStorage', text: '{"a":1}' }], consumedFieldValue: '' });
	add('containment: slice in localStorage', evaluateCodeContainment({ code, haystacks: [{ where: 'localStorage', text: `x${code.slice(100, 140)}y` }], consumedFieldValue: '' }), okContain);
	add('containment: field not cleared', evaluateCodeContainment({ code, haystacks: [{ where: 'title', text: 'Pair' }], consumedFieldValue: code }), okContain);
	const okOne = evaluateMarkTrace({ expect: 'one', marks: [healthyMark()] });
	add('marks: lifetime 3690', evaluateMarkTrace({ expect: 'one', marks: [healthyMark({ removeT: 4690 })] }), okOne);
	add('marks: lifetime 4310', evaluateMarkTrace({ expect: 'one', marks: [healthyMark({ removeT: 5310 })] }), evaluateMarkTrace({ expect: 'one', marks: [healthyMark({ removeT: 5250 })] }));
	add('marks: two marks', evaluateMarkTrace({ expect: 'one', marks: [healthyMark(), healthyMark()] }), okOne);
	add('marks: zero marks', evaluateMarkTrace({ expect: 'one', marks: [] }), okOne);
	add('marks: missing word', evaluateMarkTrace({ expect: 'one', marks: [healthyMark({ hasWord: false })] }), okOne);
	add('marks: no primary bar (tokens missing)', evaluateMarkTrace({ expect: 'one', marks: [healthyMark({ boxShadow: 'none', background: 'rgba(0, 0, 0, 0)' })] }), okOne);
	add('marks: transition under reduced motion', evaluateMarkTrace({ expect: 'one', reducedMotion: true, marks: [healthyMark({ transitionAtFade: '2.5s' })] }), evaluateMarkTrace({ expect: 'one', reducedMotion: true, marks: [healthyMark({ transitionAtFade: '0s' })] }));
	add('marks: a mark on the first render', evaluateMarkTrace({ expect: 'none', marks: [healthyMark()] }), evaluateMarkTrace({ expect: 'none', marks: [] }));
	add('marks: a second role=status', evaluateMarkTrace({ expect: 'one', statusCount: 2, marks: [healthyMark()] }), evaluateMarkTrace({ expect: 'one', statusCount: 1, marks: [healthyMark()] }));
	const okTruth = evaluateStatusTruth({ samples: truthSamples, heldFrom: 0, heldTo: 3000, passCompleteT: 5000, slackMs: 2000 });
	add('truth: Live 1ms before pass-complete', evaluateStatusTruth({ samples: [{ t: 0, kind: 'catching-up' }, { t: 4999, kind: 'live' }], heldFrom: 0, heldTo: 3000, passCompleteT: 5000, slackMs: 2000 }), okTruth);
	add('truth: Live while held', evaluateStatusTruth({ samples: [{ t: 0, kind: 'catching-up' }, { t: 1000, kind: 'live' }], heldFrom: 0, heldTo: 3000, passCompleteT: 5000, slackMs: 2000 }), okTruth);
	add('truth: Live too late', evaluateStatusTruth({ samples: [{ t: 0, kind: 'catching-up' }, { t: 9000, kind: 'live' }], heldFrom: 0, heldTo: 3000, passCompleteT: 5000, slackMs: 2000 }), okTruth);
	const okCopy = evaluateCopy(copyBase);
	for (const b of BANNED) {
		const sample = b.name.startsWith('erasure') ? (b.name.endsWith('1') ? word('It is permanently ', 'deleted from the network') : word('It no longer has ', 'access to the data')) : b.name === word('D', '-NN') ? word('see D', '-12') : `x ${b.name} y`;
		add(`copy: "${b.name}"`, evaluateCopy({ ...copyBase, texts: [...healthyTexts, sample] }), okCopy);
	}
	add('copy: "Phase unknown." is not the exact out-of-scope value', evaluateCopy({ ...copyBase, texts: [...healthyTexts, word('Pha', 'se unknown.')] }), evaluateCopy({ ...copyBase, texts: [...healthyTexts, word('Pha', 'se unknown')] }));
	add('copy: vacuous text set', evaluateCopy({ ...copyBase, texts: healthyTexts.slice(0, 5) }), okCopy);
	add('copy: vacuous key set', evaluateCopy({ ...copyBase, referencedValues: healthyKeys.slice(0, 10) }), okCopy);
	const okTracks = evaluateTracksEnded({ streams: [{ tracks: [{ readyState: 'ended' }] }] });
	add('tracks: one live track', evaluateTracksEnded({ streams: [{ tracks: [{ readyState: 'live' }] }] }), okTracks);
	add('tracks: zero tracks', evaluateTracksEnded({ streams: [] }), okTracks);
	return c;
}

function runProveMatchers() {
	const controls = matcherControls();
	let inert = 0;
	let indiscriminate = 0;
	for (const control of controls) {
		if (control.violating.passed) {
			inert += 1;
			process.stderr.write(`[${LABEL}] matcher is inert: "${control.label}" did not fail its violating input.\n`);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(`[${LABEL}] matcher is indiscriminate: "${control.label}" also failed its healthy input: ${control.healthy.detail}\n`);
		}
	}
	if (inert > 0 || indiscriminate > 0) {
		process.stdout.write(`PROVE-MATCHERS: FAIL (${inert} inert, ${indiscriminate} indiscriminate of ${controls.length})\n`);
		process.exit(1);
	}
	process.stdout.write(`PROVE-MATCHERS: PASS (${controls.length}/${controls.length})\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Gate 8: the copy keys the dashboard source references
// ---------------------------------------------------------------------------

/** @param {string} dir @returns {string[]} */
function walkSource(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walkSource(full));
		else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full);
	}
	return out;
}

/** Every COPY key the comment-stripped dashboard source names, plus every key under a `t(` template prefix. */
export function referencedCopyKeys() {
	const keys = new Set(Object.keys(COPY));
	/** @type {Set<string>} */
	const found = new Set();
	for (const file of walkSource(SRC_DIR)) {
		const src = stripComments(readFileSync(file, 'utf8'));
		for (const m of src.matchAll(/'([^'\\\n]+)'|"([^"\\\n]+)"/g)) {
			const value = m[1] ?? m[2];
			if (keys.has(value)) found.add(value);
		}
		for (const m of src.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) {
			const prefix = m[1];
			for (const key of keys) if (prefix.length > 0 && key.startsWith(prefix)) found.add(key);
		}
	}
	return [...found].sort();
}

// ---------------------------------------------------------------------------
// Build / serve / drive
// ---------------------------------------------------------------------------

/** @param {string} dir @param {string} name @returns {string | null} */
function findFile(dir, name) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			const hit = findFile(full, name);
			if (hit) return hit;
		} else if (entry === name) return full;
	}
	return null;
}

/** A programmatic production build of live-gate.html into a fresh scratch dir. */
async function buildGate() {
	const scratch = mkdtempSync(path.join(os.tmpdir(), 'vt-live-gate-'));
	const outDir = path.join(scratch, 'dist');
	const cacheDir = path.join(scratch, 'vite-cache');
	const vite = await import('vite');
	const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(APP_DIR, 'vite.config.ts'), APP_DIR);
	if (!loaded) fail('vite.config.ts did not load');
	const config = vite.mergeConfig(loaded.config, {
		root: APP_DIR,
		configFile: false,
		publicDir: false,
		cacheDir,
		logLevel: 'warn',
		build: { outDir, emptyOutDir: true, rollupOptions: { input: GATE_HTML } },
	});
	const started = Date.now();
	await vite.build({ ...config, configFile: false });
	say(`built live-gate.html in ${((Date.now() - started) / 1000).toFixed(1)} s into ${outDir}`);
	return outDir;
}

/** @param {import('playwright').Browser} browser @param {string} origin @param {{ aborted: number, seen: number }} iso */
async function newGateContext(browser, origin, iso) {
	const ctx = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 720 } });
	await ctx.route('**/*', (route) => {
		let same = false;
		try {
			same = new URL(route.request().url()).origin === origin;
		} catch {
			same = false;
		}
		if (same) {
			iso.seen += 1;
			return route.continue();
		}
		iso.aborted += 1;
		return route.abort();
	});
	return ctx;
}

/** @type {Array<{ page: string, verdict: Verdict }>} */
const tokenReadings = [];
/** Gate 8's rendered texts, unioned over every page. */
const renderedTexts = new Set();
/** @type {Set<string>} */
const fixtureStrings = new Set();
/** Console text of every page (gate 4 containment). @type {string[]} */
const consoleTexts = [];

/**
 * Open a gate page, wait for the driver, then measure the tokens FIRST.
 * @param {import('playwright').BrowserContext} ctx @param {string} url @param {string} query @param {string} label
 */
async function openGatePage(ctx, url, query, label) {
	const page = await ctx.newPage();
	page.on('console', (m) => consoleTexts.push(m.text()));
	page.on('pageerror', (e) => consoleTexts.push(`[pageerror] ${e.name}`));
	await page.goto(`${url}?${query}`, { waitUntil: 'load' });
	await page.waitForFunction(() => /** @type {any} */ (window).__LIVE_GATE__?.ready === true, null, { timeout: 60_000 });
	const tokens = await page.evaluate(() => ({
		background: getComputedStyle(document.body).backgroundColor,
		primary: getComputedStyle(document.documentElement).getPropertyValue('--primary'),
	}));
	const v = evaluateTokens(tokens);
	tokenReadings.push({ page: label, verdict: v });
	say(`${label}: body background ${tokens.background} (first measurement)`);
	const failed = await page.evaluate(() => /** @type {any} */ (window).__LIVE_GATE__.failed);
	if (failed.length > 0) throw new Error(`${label}: driver failed (${failed.map((/** @type {any} */ x) => x.name).join(', ')})`);
	return page;
}

/**
 * @param {import('playwright').Page} page @param {string} name @param {...any} args
 * @returns {Promise<any>}
 */
function ctl(page, name, ...args) {
	return page.evaluate(([n, a]) => /** @type {any} */ (window).__LIVE_GATE_CTL__[/** @type {string} */ (n)](.../** @type {any[]} */ (a)), /** @type {[string, any[]]} */ ([name, args]));
}

/** @param {import('playwright').Page} page */
async function collect(page) {
	const texts = await ctl(page, 'texts');
	for (const text of texts) renderedTexts.add(text);
	for (const s of await ctl(page, 'fixtureStrings')) fixtureStrings.add(s);
}

/** @param {import('playwright').Page} page */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));

/** @param {import('playwright').Page} page @param {string} kind @param {number} [timeout] */
function waitChip(page, kind, timeout = 30_000) {
	return page.waitForFunction((k) => document.querySelector('.sh-status-chip')?.getAttribute('data-kind') === k, kind, { timeout });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} at */
const hhmmUtc = (at) => new Date(at).toISOString().slice(11, 16);

/** @param {import('playwright').Page} page @param {string} hash */
async function lastPassAt(page, hash) {
	const events = await ctl(page, 'events');
	const done = events.filter((/** @type {any} */ e) => e.hash === hash && e.ev === 'pass-complete');
	return done.length > 0 ? done[done.length - 1].at : null;
}

/** @param {import('playwright').Page} page @returns {Promise<any>} */
function measureChip(page) {
	return page.evaluate(() => {
		/** @param {Element | null} el */
		const rect = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		/** @param {Element | null} el */
		const sized = (el) => (el ? { ...rect(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null);
		const chip = document.querySelector('.sh-status-chip');
		const nameEl = document.querySelector('.sh-authority-name');
		const neighbours = [
			['identity', '.sh-identity'],
			['switcher', '.sh-switcher-button'],
			['preview', '.pv-control'],
			['kebab', '.sh-kebab-button'],
		]
			.map(([name, sel]) => ({ name, box: rect(document.querySelector(sel)) }))
			.filter((n) => n.box !== null);
		return {
			statusCount: document.querySelectorAll('[role="status"]').length,
			text: chip?.textContent ?? '',
			kind: chip?.getAttribute('data-kind') ?? null,
			chip: sized(chip),
			reconnect: sized(document.querySelector('.sh-reconnect')),
			topbar: sized(document.querySelector('.sh-topbar')),
			neighbours,
			name: nameEl
				? { scrollWidth: nameEl.scrollWidth, clientWidth: nameEl.clientWidth, textOverflow: getComputedStyle(nameEl).textOverflow, width: nameEl.getBoundingClientRect().width }
				: null,
			viewport: { w: innerWidth, h: innerHeight },
		};
	});
}

/** @param {import('playwright').Page} page @param {string} state @param {string} expectedText @param {Array<any>} sink */
async function measureChipAtWidths(page, state, expectedText, sink) {
	for (const width of CHIP_WIDTHS) {
		await page.setViewportSize({ width, height: 720 });
		await frames(page);
		const m = await measureChip(page);
		const v = evaluateChipGeometry({ ...m, state, width, expectedText, expectReconnect: state === 'offline' || state === 'offline-no-update' });
		say(`chip ${v.passed ? 'ok  ' : 'FAIL'} ${v.detail}`);
		sink.push(v);
	}
	await page.setViewportSize({ width: 1280, height: 720 });
	await frames(page);
}

/** @param {import('playwright').Page} page */
function measurePanels(page) {
	return page.evaluate(() => {
		const panels = [...document.querySelectorAll('section.panel')];
		const denied = panels.filter((p) => p.classList.contains('panel--denied')).length;
		let textPanels = 0;
		for (const panel of panels) {
			const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if ((n.textContent ?? '').trim() === '' || !n.parentElement) continue;
				const r = n.parentElement.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) {
					textPanels += 1;
					break;
				}
			}
		}
		const CONTROL = 'button, input, select, textarea, a[href], [onclick], [role=button], [role=link]';
		const bodies = [...document.querySelectorAll('section.panel .panel-body')].map((body, index) => ({
			index,
			controls: body.querySelectorAll(CONTROL).length,
			pointers: [body, ...body.querySelectorAll('*')].filter((el) => getComputedStyle(el).cursor === 'pointer').length,
		}));
		const bodyTexts = [...document.querySelectorAll('section.panel .panel-body')].map((b) => (b.textContent ?? '').trim()).filter((s) => s.length > 0);
		return { panelCount: panels.length - denied, deniedCount: denied, textPanels, bodies, bodyTexts };
	});
}

// --- Legs ---------------------------------------------------------------------

/** @typedef {{ browser: import('playwright').Browser, url: string, origin: string, iso: { aborted: number, seen: number } }} Env */

/** @param {Env} env */
async function legShell(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	try {
		const page = await openGatePage(ctx, env.url, 'leg=shell&clear=1&seed=A&mode=A:auto', 'shell');
		const hash = await ctl(page, 'hashOf', 'A');
		await page.waitForFunction((h) => /** @type {any} */ (window).__LIVE_GATE_CTL__.counts()[h]?.passesComplete >= 1, hash, { timeout: 60_000 });
		await page.waitForFunction(() => document.querySelectorAll('section.panel').length > 0, null, { timeout: 30_000 });
		await waitChip(page, 'live');
		await frames(page);
		const m = await measurePanels(page);
		record('g2-composed-shell-non-blank', evaluateNonBlankShell(m).passed, evaluateNonBlankShell(m).detail);
		const bodies = evaluatePanelBodies(m);
		record('d10-panel-bodies-no-write-affordance', bodies.passed, bodies.detail);
		await collect(page);
	} finally {
		await ctx.close();
	}
}

/** @param {Env} env */
async function legChip(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	/** @type {Verdict[]} */
	const results = [];
	try {
		const page = await openGatePage(ctx, env.url, 'leg=chip&clear=1&seed=A,C&mode=A:auto,C:never', 'chip');
		const A = await ctl(page, 'hashOf', 'A');
		const C = await ctl(page, 'hashOf', 'C');
		await waitChip(page, 'live', 60_000);
		await measureChipAtWidths(page, 'live', t('status.chip.live'), results);
		await collect(page);

		// Offline: disconnect with the next passes held, past the grace and the debounce.
		await ctl(page, 'holdFirstPass', A);
		await ctl(page, 'disconnect', A);
		await sleep(OFFLINE_GRACE_MS + CHIP_DEBOUNCE_MS + 1500);
		await waitChip(page, 'offline', 15_000);
		// Read after the wait: a pass that started connected and ended after the
		// disconnect still sets the reducer's last update.
		const at = await lastPassAt(page, A);
		const offlineText = t('status.chip.offline', { time: at === null ? '' : hhmmUtc(at) });
		await measureChipAtWidths(page, 'offline', offlineText, results);
		await collect(page);

		// Live control: a 40px region cap must be caught by the same comparator.
		const style = await page.addStyleTag({ content: '.sh-status-region{max-width:40px !important}' });
		await frames(page);
		const capped = evaluateChipGeometry({ ...(await measureChip(page)), state: 'offline', width: 1280, expectedText: offlineText, expectReconnect: true });
		record('g3-control-clip-detected', !capped.passed, capped.passed ? 'the 40px cap was NOT detected (inert)' : `detected: ${capped.detail}`);
		await style.evaluate((el) => /** @type {any} */ (el).remove());
		await frames(page);

		// Catching up: connected again, the pass still held.
		await ctl(page, 'connect', A);
		await waitChip(page, 'catching-up', 15_000);
		await measureChipAtWidths(page, 'catching-up', t('status.chip.catching-up'), results);
		await ctl(page, 'releasePass', A);
		await waitChip(page, 'live', 30_000);

		// Not live: a second page in the same context while this page leads A.
		const follower = await openGatePage(ctx, env.url, 'leg=chip-follower&mode=A:auto', 'chip-follower');
		await waitChip(follower, 'not-live', 10_000);
		await measureChipAtWidths(follower, 'not-live', t('status.chip.not-live'), results);
		await collect(follower);
		await follower.close();

		// Offline, no update: switch to C (never reachable, no lastPassAt).
		await page.click('.sh-switcher-button');
		await page.click(`.sh-switcher-row:has-text("${GATE_C_NAME}")`);
		await sleep(OFFLINE_GRACE_MS + CHIP_DEBOUNCE_MS + 1500);
		await waitChip(page, 'offline', 15_000);
		await measureChipAtWidths(page, 'offline-no-update', t('status.chip.offline-no-update'), results);
		await collect(page);
		void C;
	} finally {
		await ctx.close();
	}
	const failed = results.filter((r) => !r.passed);
	record(
		'g3-chip-geometry',
		results.length === 20 && failed.length === 0,
		`${results.length} measurements (want 20), ${failed.length} failing${failed.length ? ': ' + failed.map((r) => r.detail).join(' | ') : ''}`,
	);
}
const GATE_C_NAME = 'Gate Township Registrar';

/** @param {Env} env */
async function legPairing(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	let code = 'vtpair1.';
	for (let i = 0; code.length < LONG_CODE_CHARS; i += 1) code += B64[(i * 37 + Math.floor(i / 64) * 11) % 64];
	say(`long code: ${code.length} characters, sha256 ${sha256Prefix(code)}`);
	/** @type {Verdict[]} */
	const geometry = [];
	let consumed = /** @type {string | null} */ (null);
	/** @type {Array<{ where: string, text: string }>} */
	const haystacks = [];
	try {
		const page = await openGatePage(ctx, env.url, 'leg=pairing&clear=1', 'pairing');
		const consoleStart = consoleTexts.length;
		await page.waitForSelector('.pr-code');
		await page.fill('.pr-code', code);
		for (const spec of CODE_WIDTHS) {
			await page.setViewportSize({ width: spec.width, height: spec.height });
			await frames(page);
			const m = await page.evaluate(() => {
				const card = document.querySelector('.pr-card');
				const ta = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('.pr-code'));
				const cta = /** @type {HTMLButtonElement | null} */ (document.querySelector('.pr-cta'));
				const r = cta?.getBoundingClientRect();
				return {
					valueLength: ta?.value.length ?? 0,
					card: card ? { scrollWidth: card.scrollWidth, clientWidth: card.clientWidth } : null,
					textarea: ta ? { scrollWidth: ta.scrollWidth, clientWidth: ta.clientWidth } : null,
					page: { scrollWidth: document.documentElement.scrollWidth, innerWidth: innerWidth },
					cta: cta && r ? { box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, enabled: !cta.disabled } : null,
					scrollY,
				};
			});
			const v = evaluateLongCode({ ...m, width: spec.width, height: spec.height, ctaRequired: spec.ctaRequired });
			say(`code ${v.passed ? 'ok  ' : 'FAIL'} ${v.detail}`);
			geometry.push(v);
		}
		await page.setViewportSize({ width: 1280, height: 720 });
		const places = await page.evaluate(() => {
			/** @type {Array<{ where: string, text: string }>} */
			const out = [{ where: 'location.href', text: location.href }, { where: 'document.title', text: document.title }];
			for (let i = 0; i < localStorage.length; i += 1) {
				const k = localStorage.key(i) ?? '';
				out.push({ where: `localStorage[${i}]`, text: `${k}=${localStorage.getItem(k) ?? ''}` });
			}
			for (let i = 0; i < sessionStorage.length; i += 1) {
				const k = sessionStorage.key(i) ?? '';
				out.push({ where: `sessionStorage[${i}]`, text: `${k}=${sessionStorage.getItem(k) ?? ''}` });
			}
			document.querySelectorAll('[title],[aria-label]').forEach((el, i) => {
				out.push({ where: `attribute #${i}`, text: `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}` });
			});
			return out;
		});
		haystacks.push(...places);

		// A consuming failure: `expired` (keepsCode false) clears the field.
		await page.evaluate(() => /** @type {any} */ (window).__LIVE_GATE_CTL__.pairing.pushFail('expired'));
		await page.click('.pr-cta');
		await page.waitForSelector('.pr-alert', { timeout: 10_000 });
		await collect(page);
		// null when the field is absent: an absent field must not pass as an empty one.
		consumed = await page.evaluate(() => /** @type {HTMLTextAreaElement | null} */ (document.querySelector('.pr-code'))?.value ?? null);
		haystacks.push(...consoleTexts.slice(consoleStart).map((text, i) => ({ where: `console #${i}`, text })));

		// Every failure view, the held verifying/joining sequence and the three notices, for gate 8.
		const reasons = ['malformed', 'old-style', 'expired', 'spent', 'unreachable', 'digest-mismatch', 'officer-not-valid', 'no-storage', 'unsupported'];
		for (const reason of reasons) {
			await ctl(page, 'remount');
			await page.waitForSelector('.pr-code');
			await page.fill('.pr-code', 'vtpair1.' + 'B'.repeat(60));
			await page.evaluate((r) => /** @type {any} */ (window).__LIVE_GATE_CTL__.pairing.pushFail(r), reason);
			await page.click('.pr-cta');
			await page.waitForSelector('.pr-alert', { timeout: 10_000 });
			await collect(page);
		}
		await ctl(page, 'remount');
		await page.waitForSelector('.pr-code');
		await page.fill('.pr-code', 'vtpair1.' + 'C'.repeat(60));
		await page.evaluate(() => /** @type {any} */ (window).__LIVE_GATE_CTL__.pairing.pushHold());
		await page.click('.pr-cta');
		await page.waitForSelector('.pr-status', { timeout: 10_000 });
		await collect(page);
		await page.evaluate(() => /** @type {any} */ (window).__LIVE_GATE_CTL__.pairing.release());
		for (const reason of ['revoked', 'removed', 'key-invalid']) {
			await ctl(page, 'showNotice', reason);
			await page.waitForSelector('.pr-notice', { timeout: 5_000 });
			await collect(page);
		}
		say(`pairing: ${reasons.length} failure views, the held sequence and 3 notices driven; ${renderedTexts.size} distinct texts so far`);
	} finally {
		await ctx.close();
	}
	const gf = geometry.filter((v) => !v.passed);
	record('g4-long-code-no-overflow', geometry.length === 3 && gf.length === 0, geometry.map((v) => v.detail).join(' | '));
	const c = evaluateCodeContainment({ code, haystacks, consumedFieldValue: consumed });
	record('g4-code-never-leaves-the-field', c.passed, c.detail);
}

/** @param {Env} env */
async function legMarks(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	try {
		const page = await openGatePage(ctx, env.url, 'leg=marks&clear=1&seed=A&mode=A:auto', 'marks');
		const A = await ctl(page, 'hashOf', 'A');
		await waitChip(page, 'live', 60_000);
		await sleep(1500);
		const t0 = await page.evaluate(() => performance.now());
		await sleep(1000);
		const first = await ctl(page, 'markTrace');
		const none = evaluateMarkTrace({ expect: 'none', marks: first });
		record('g5-no-marks-first-render', none.passed, `${none.detail} (sampled 1 s from ${t0.toFixed(0)} ms)`);

		/** @param {boolean} reduced */
		const oneChange = async (reduced) => {
			const before = (await ctl(page, 'markTrace')).length;
			const from = await page.evaluate(() => performance.now());
			const target = await ctl(page, 'bumpMarkTarget', A);
			const woke = await ctl(page, 'wake', A, target.table);
			say(`mark target ${target.table}.${target.column} (key ${target.markKeyPrefix}<Id>), bump ${target.bump}, woke ${woke}`);
			await page.waitForFunction((n) => /** @type {any} */ (window).__LIVE_GATE_CTL__.markTrace().length > n, before, { timeout: 30_000 });
			const announced = await page
				.waitForFunction(() => (document.querySelector('.change-mark-live-region')?.textContent ?? '').trim().length > 0, null, { timeout: 3_000 })
				.then(() => true, () => false);
			await sleep(MARK_LIFETIME_MS + MARK_TOLERANCE_MS + 800);
			const marks = (await ctl(page, 'markTrace')).filter((/** @type {any} */ m) => m.addT >= from);
			const statusCount = await page.evaluate(() => document.querySelectorAll('[role="status"]').length);
			for (const m of marks) say(`mark lifetime ${m.removeT === null ? 'open' : (m.removeT - m.addT).toFixed(0)} ms, transition ${m.transitionAtAdd}/${m.transitionAtFade}`);
			return evaluateMarkTrace({ expect: 'one', reducedMotion: reduced, marks, statusCount, liveRegionAnnounced: announced });
		};
		const one = await oneChange(false);
		record('g5-one-mark-4s', one.passed, one.detail);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const reduced = await oneChange(true);
		record('g5-reduced-motion-static-mark', reduced.passed, reduced.detail);
		await collect(page);
	} finally {
		await ctx.close();
	}
}

/** @param {Env} env */
async function legTruth(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	try {
		const page = await openGatePage(ctx, env.url, 'leg=truth&clear=1&seed=B&mode=B:auto&hold=B', 'truth');
		const B = await ctl(page, 'hashOf', 'B');
		await page.waitForFunction((h) => /** @type {any} */ (window).__LIVE_GATE_CTL__.events().some((/** @type {any} */ e) => e.hash === h && e.ev === 'connected'), B, { timeout: 30_000 });
		const heldFrom = await page.evaluate(() => performance.now());
		await sleep(3000);
		const heldTo = await page.evaluate(() => performance.now());
		await ctl(page, 'releasePass', B);
		await waitChip(page, 'live', 30_000);
		const events = await ctl(page, 'events');
		const pc = events.find((/** @type {any} */ e) => e.hash === B && e.ev === 'pass-complete' && e.t > heldTo);
		const v = evaluateStatusTruth({ samples: await ctl(page, 'chipTrace'), heldFrom, heldTo, passCompleteT: pc ? pc.t : null, slackMs: 2000 });
		record('g6-catching-up-until-first-pass', v.passed, v.detail);
		await collect(page);
	} finally {
		await ctx.close();
	}
}

/** @param {Env} env */
async function legScanner(env) {
	const ctx = await newGateContext(env.browser, env.origin, env.iso);
	try {
		const page = await openGatePage(ctx, env.url, 'leg=scanner&clear=1', 'scanner');
		/** @param {'close' | 'esc'} how */
		const once = async (how) => {
			const before = (await ctl(page, 'streams')).length;
			await page.click(`.pr-button:has-text("${t('pairing.scanCta')}")`);
			await page.waitForFunction(
				(n) => /** @type {any} */ (window).__LIVE_GATE_CTL__.streams().slice(n).some((/** @type {any} */ s) => s.tracks.some((/** @type {any} */ tr) => tr.readyState === 'live')),
				before,
				{ timeout: 15_000 },
			);
			await collect(page);
			if (how === 'close') await page.click('.pr-scanner-close');
			else await page.keyboard.press('Escape');
			await sleep(2000);
			return evaluateTracksEnded({ streams: (await ctl(page, 'streams')).slice(before) });
		};
		const closed = await once('close');
		record('g10-scanner-close-ends-tracks', closed.passed, closed.detail);
		const esc = await once('esc');
		record('g10-scanner-esc-ends-tracks', esc.passed, esc.detail);
	} finally {
		await ctx.close();
	}
}

function legCopy() {
	const keys = referencedCopyKeys();
	const referencedValues = keys.map((key) => ({ key, value: String(COPY[key]) }));
	const v = evaluateCopy({
		texts: [...renderedTexts],
		referencedValues,
		outOfScope: [String(COPY['public.staleness.body']), String(COPY['lifecycle.indeterminate'])],
		fixtureStrings: [...fixtureStrings],
	});
	say(`gate 8: rendered texts ${renderedTexts.size}, referenced keys ${keys.length}, known out-of-scope hits ${v.outOfScopeHits.length} [${v.outOfScopeHits.join(', ')}]`);
	record('g8-copy-mounted-keys', v.passed, v.detail);
}

// ---------------------------------------------------------------------------

async function main() {
	const argv = process.argv.slice(2);
	let port = DEFAULT_PORT;
	let skipBuild = false;
	/** @type {string | null} */
	let distDir = null;
	/** @type {string[] | null} */
	let legs = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--prove-matchers') return runProveMatchers();
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--dist') distDir = argv[++i] ?? null;
		else if (arg === '--port') port = Number(argv[++i]);
		else if (arg === '--legs') legs = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
		else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}": refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}"`);
	if (skipBuild && !distDir) fail('--skip-build needs --dist <dir>');
	const selected = (legs ?? [...LEG_ORDER]).filter((l) => l !== 'tokens');
	for (const leg of selected) if (!(leg in LEG_RUNGS)) fail(`unknown leg "${leg}"`);
	const ordered = LEG_ORDER.filter((l) => selected.includes(l));
	const expected = new Set([...LEG_RUNGS.tokens, ...ordered.flatMap((l) => LEG_RUNGS[/** @type {keyof typeof LEG_RUNGS} */ (l)])]);

	const dist = skipBuild ? /** @type {string} */ (distDir) : await buildGate();
	const html = findFile(dist, 'live-gate.html');
	if (!html) fail('the build holds no live-gate.html');
	const entryRel = path.relative(dist, html).split(path.sep).join('/');

	const server = await serveDist(dist, port);
	const origin = new URL(server.url).origin;
	const env = { browser: /** @type {any} */ (null), url: `${server.url}/${entryRel}`, origin, iso: { aborted: 0, seen: 0 } };
	const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
	env.browser = browser;
	const started = Date.now();
	try {
		// The tokens comparator's live control: a blank page must fail it.
		const blank = await browser.newPage();
		await blank.goto('about:blank');
		const blankTokens = await blank.evaluate(() => ({
			background: getComputedStyle(document.body).backgroundColor,
			primary: getComputedStyle(document.documentElement).getPropertyValue('--primary'),
		}));
		await blank.close();
		const blankVerdict = evaluateTokens(blankTokens);

		/** @type {Record<string, (env: any) => Promise<void> | void>} */
		const runners = {
			shell: legShell,
			chip: legChip,
			pairing: legPairing,
			marks: legMarks,
			truth: legTruth,
			scanner: legScanner,
			copy: () => legCopy(),
		};
		for (const leg of ordered) {
			const legStart = Date.now();
			say(`--- leg ${leg} ---`);
			try {
				await runners[leg](env);
			} catch (err) {
				const name = err instanceof Error ? err.name : 'Error';
				const message = err instanceof Error ? err.message.split('\n')[0].slice(0, 240) : '';
				say(`leg ${leg} threw ${name}: ${message}`);
			}
			say(`leg ${leg}: ${((Date.now() - legStart) / 1000).toFixed(1)} s`);
		}

		const tokenFails = tokenReadings.filter((r) => !r.verdict.passed);
		record(
			'g1-tokens-first',
			tokenReadings.length > 0 && tokenFails.length === 0 && !blankVerdict.passed,
			`${tokenReadings.length} page(s) measured first, ${tokenFails.length} failing; blank-page control ${blankVerdict.passed ? 'PASSED (inert)' : 'failed as it must'}`,
		);
		say(`aborted external requests: ${env.iso.aborted}, origin requests: ${env.iso.seen}`);
		record('iso-no-external-requests', env.iso.aborted === 0 && env.iso.seen > 0, `aborted ${env.iso.aborted}, origin requests ${env.iso.seen}`);
	} finally {
		await browser.close();
		await server.close();
	}

	let failed = 0;
	for (const id of expected) {
		const hits = rungs.filter((r) => r.id === id);
		if (hits.length === 0) {
			failed += 1;
			process.stdout.write(`FAIL  ${id}\n      -> missing rung ${id}\n`);
			continue;
		}
		const ok = hits.every((h) => h.passed);
		if (!ok) failed += 1;
		process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${id}\n      -> ${hits.map((h) => h.detail).join(' | ')}\n`);
	}
	say(`total ${((Date.now() - started) / 1000).toFixed(1)} s`);
	const n = expected.size;
	process.stdout.write(failed === 0 ? `LIVE GATE: PASS (${n}/${n} rungs)\n` : `LIVE GATE: FAIL (${n - failed}/${n} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
