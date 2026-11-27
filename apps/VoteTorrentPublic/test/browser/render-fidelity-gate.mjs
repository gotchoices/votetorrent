#!/usr/bin/env node
/**
 * render-fidelity-gate.mjs — the browser-tier proof that the public election
 * page RENDERS what 54-06's reads return, against a database seeded with real
 * rows (54-16 Task 3; D-11, D-14, D-18, D-19).
 *
 * WHY THIS FILE EXISTS AT ALL, which is the thing a later reader will get
 * wrong first. Every rung below could be written as a source scan, and every
 * one of those scans would be worthless. This repository has shipped an
 * 84-character code that clipped silently and an entire screen with no styling
 * applied, both past green gates, because those gates asserted PRESENCE —
 * a class attribute is in the markup, a component is in the tree — rather than
 * RENDERING. Presence is not rendering. A computed `border-top-style`, a
 * measured `scrollWidth`, and the exact string sitting in a `td` are the only
 * evidence that a reader would actually experience what the CSS declares, and
 * none of the three can be obtained without a browser holding a real layout.
 *
 * WHAT IT MEASURES, and against what. The harness's
 * `?fixture=public-surface` branch seeds a real browser-side database and
 * mounts the shell with NO injected election, so the page under measurement is
 * produced by the genuine read path. The harness then publishes the FIXTURE's
 * own exported values on `__UI_GATE__.fixture`. Every data-derived expectation
 * below is read from that channel — this file hard-codes no registrant name,
 * no district, no marker and no release count. The three column headings are
 * the one exception and they are not fixture data: the UI spec records them as
 * the single place a raw schema identifier renders verbatim, so they are the
 * spec's literals, asserted here as literals.
 *
 * THE TWO CHART RUNGS (60-08's C6/C7) DEPEND ON THE SEEDED DISTRICT
 * DISTRIBUTION. The district-bars rung can only prove D-09's fold is
 * SELECTIVE, rather than merely present, when the seeded roll holds at least
 * two districts at or above the fold's own exported threshold and at least
 * two below it -- `registrant-roll-fixture.js` carries the matching header
 * rule naming this file's rung in turn, so a later reader changing either
 * side finds the other.
 *
 * THE DIVISION OF LABOUR WITH 54-18, recorded so that plan does not duplicate
 * this one. `--prove-matchers` proves every COMPARATOR in this file can
 * report failure, by running each against a synthetic input built to violate
 * it. It deliberately does NOT rebuild a mutated product: 53-D20's rule is
 * that a build-level negative control REBUILDS rather than injecting at
 * runtime, and that a dist-level control must mutate a symbol in an
 * object-literal property-key position because the minifier renames bare
 * local bindings. Those controls belong to `mutations.mjs`, which is 54-18's
 * file. This file proves the comparators can fail; 54-18 proves the built
 * product can fail them. 54-18 also owns rehoming these rungs into the shared
 * runner, `run-ui-gates.mjs` — until then this script is standalone and
 * self-running so it is verifiable now.
 *
 * WHAT IS COPIED FROM `run-ui-gates.mjs` RATHER THAN INVENTED: the Playwright
 * import (the full package, never the core-only sibling, never a named browser
 * channel, never a hardcoded system-Chrome path — that path does not exist on
 * the CI image), `chromium.launch({ headless: true })`, the static server
 * (`lib/serve-dist.mjs`, not a second one), the dist walk that resolves the
 * built entry by SEARCH rather than by predicting the bundler's output path
 * algebra, the frozen rung-id registry, and `record(id, passed, detail)`.
 * A rung id may never interpolate a value under test into its own name: a
 * check named after something computed is a check nobody else can invert.
 *
 * PORT POLICY. `5193`, distinct from every port the phase already binds
 * (`5180`/`5181` dev and preview, `5183` the dashboard gate, `5191` the public
 * app's own gate run). Distinct from `5191` specifically so this gate and
 * `test:browser` can run concurrently. A bound port fails the run loudly —
 * `serve-dist.mjs` propagates the listen error rather than picking another.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-gate/` rather than rebuilding.
 *   --prove-matchers   Run every comparator against a violating input AND
 *                      against a healthy one, and require the first to FAIL
 *                      and the second to PASS. Needs no browser and no build.
 *   --port <n>         Override the bound port.
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
// D-09's declared threshold, imported by name rather than restated as a
// literal -- a dependency-free module, safe to import from this node driver.
// This gate never calls `foldDistrictCounts` itself, so a defect in the fold
// cannot hide inside an expectation derived from the fold under test.
import { SMALL_DISTRICT_THRESHOLD } from '../../src/roll-disclosure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const GATE_DIST = path.join(APP_DIR, 'dist-gate');
const GATE_ENTRY = 'election-shell-gate.html';
const GATE_CONFIG = 'vite.gate.config.ts';
const FIXTURE_QUERY = 'fixture=public-surface';
const DEFAULT_PORT = 5193;
/** The build-time mutation `--prove-gap-cues-flattened` drives, and its outDir. */
const GAP_MUTATION = 'gap-cues-flattened';
const MUTANT_CONFIG = 'vite.mutant.config.ts';
const MUTANT_DIST = path.join(APP_DIR, `dist-mutant-${GAP_MUTATION}`);
/** The one rung the gap-cues mutation must invert. Every other rung must survive it. */
const GAP_RUNG_ID = 'gap-card-style-diverges';
const LABEL = 'render-fidelity-gate';

/** The narrow viewport the roll rungs measure at. Overflow is only observable
 * when the content genuinely exceeds its container. */
const NARROW_VIEWPORT = Object.freeze({ width: 380, height: 900 });

/**
 * The published column headings, in order. NOT fixture data: 54-UI-SPEC
 * records these as the one place a raw schema identifier renders verbatim
 * rather than through the copy table, so they are the spec's own literals.
 * @type {ReadonlyArray<string>}
 */
const EXPECTED_HEADERS = Object.freeze(['LastName', 'FirstName', 'District']);

/**
 * The key-release fact's own stable per-card identity, as 54-13 renders it.
 * Model vocabulary, not fixture data and not a measured value — the same
 * status as the headings above.
 * @type {string}
 */
const KEYRELEASE_FACT_ID = 'keyrelease';

/**
 * Frozen rung-id registry, module-level, single source of truth. `record()`
 * throws on any id outside this array — the structural enforcement of "never
 * interpolate a value under test into a check's name".
 * @type {ReadonlyArray<string>}
 */
export const RUNG_IDS = Object.freeze([
	'roll-fields-rendered',
	'roll-overflows-not-clips',
	'roll-hides-extrafields-and-superseded',
	'roll-escapes-authority-text',
	'keyrelease-renders-filled-with-nonzero-released',
	'gap-card-style-diverges',
	'keyrelease-meter-fill-matches-released-ratio',
	'roll-district-bars-proportional-and-folded',
	'roll-chart-axis-ticks-are-whole-numbers',
]);

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
// THE COMPARATORS.
//
// Every one is a PURE function over values already read out of the page, and
// that is not a style preference: it is what lets `--prove-matchers` exercise
// each of them against a violating input with no browser at all. A comparator
// that could only run inside `page.evaluate` could only ever be proven by
// breaking the product, which is a control nobody runs.
//
// Each returns `{ passed, detail }`, and every failing detail NAMES THE
// CONDITION that failed with the values it saw. "The roll looks wrong" is not
// a detail — a rung that cannot say what diverged cannot be acted on.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ passed: boolean, detail: string }} Verdict
 */

/**
 * The roll renders one table, the three published headings in order, one row
 * per seeded registrant, and no empty cell.
 *
 * @param {{ rollCount: number, headers: string[], rowCount: number, cellCount: number, emptyCellCount: number }} m
 * @param {number} expectedRowCount
 * @returns {Verdict}
 */
export function evaluateRollFields(m, expectedRowCount) {
	/** @type {string[]} */
	const failures = [];
	if (m.rollCount !== 1) failures.push(`wrapper count ${m.rollCount} (want 1)`);
	if (m.headers.length !== EXPECTED_HEADERS.length || m.headers.some((h, i) => h !== EXPECTED_HEADERS[i])) {
		failures.push(`headings ${JSON.stringify(m.headers)} (want ${JSON.stringify(EXPECTED_HEADERS)}, in order)`);
	}
	if (m.rowCount !== expectedRowCount) failures.push(`body rows ${m.rowCount} (want ${expectedRowCount})`);
	if (m.emptyCellCount !== 0) failures.push(`${m.emptyCellCount} of ${m.cellCount} cells have empty text`);
	return failures.length === 0
		? { passed: true, detail: `1 wrapper, headings in order, ${m.rowCount} rows, ${m.cellCount} non-empty cells` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * The roll SCROLLS rather than clipping, and the full production-length value
 * reached the DOM.
 *
 * Four conditions, and the fourth is the decisive one. A wrapper can report
 * `overflow-x: auto` and still be showing a truncated string if something
 * upstream shortened it, so the rung also requires the LONGEST seeded district
 * to be some cell's text as an EXACT match. Not `includes` — a truncation is a
 * substring of the original, so a containment test would pass on exactly the
 * defect this rung exists to catch.
 *
 * @param {{ overflowX: string, scrollWidth: number, clientWidth: number, cells: Array<{ text: string, textOverflow: string, overflow: string }> }} m
 * @param {string} longestDistrict
 * @returns {Verdict}
 */
export function evaluateRollOverflow(m, longestDistrict) {
	/** @type {string[]} */
	const failures = [];
	if (m.overflowX !== 'auto') failures.push(`computed overflow-x is "${m.overflowX}" (want "auto")`);
	if (!(m.scrollWidth > m.clientWidth)) {
		failures.push(`scrollWidth ${m.scrollWidth} is not greater than clientWidth ${m.clientWidth} — nothing overflows, so scrolling is unproven`);
	}
	const clipped = m.cells.filter((c) => c.textOverflow === 'ellipsis' || c.overflow !== 'visible');
	if (clipped.length > 0) {
		const first = clipped[0];
		failures.push(`${clipped.length} cell(s) clip: first has text-overflow "${first.textOverflow}", overflow "${first.overflow}"`);
	}
	if (!m.cells.some((c) => c.text === longestDistrict)) {
		failures.push(`no cell's text is EXACTLY the longest seeded district (${longestDistrict.length} chars) — it was truncated or never rendered`);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `overflow-x auto, scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}, ${m.cells.length} cells unclipped, longest district (${longestDistrict.length} chars) present verbatim`,
			}
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Neither of the two strings that must never reach a reader appears anywhere
 * in the rendered page.
 *
 * Both are seeded NON-NULL on purpose upstream — an absent column and an
 * unreissued registrant could never fail this, so the assertion would be
 * green and worthless. The count is reported even on success, so a reader can
 * see the scan actually ran over a non-empty document.
 *
 * @param {string} html
 * @param {Array<{ label: string, needle: string }>} needles
 * @returns {Verdict}
 */
export function evaluateHiddenStrings(html, needles) {
	/** @type {string[]} */
	const failures = [];
	for (const { label, needle } of needles) {
		if (typeof needle !== 'string' || needle === '') {
			failures.push(`${label}: the needle itself is absent from the readout — this scan would be inert`);
			continue;
		}
		const occurrences = html.split(needle).length - 1;
		if (occurrences !== 0) failures.push(`${label} appears ${occurrences} time(s) in the rendered page`);
	}
	return failures.length === 0
		? { passed: true, detail: `${needles.length} forbidden string(s) absent from ${html.length} chars of rendered markup` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Authority-supplied text carrying a markup element reaches the DOM as TEXT
 * and never as an element.
 *
 * Both halves are needed. Zero elements alone would pass on a page that simply
 * dropped the value; the value present as a cell's exact text alone would pass
 * on a page that also injected it. Together they are the observable form of
 * "the framework's text-node escaping is doing its job".
 *
 * @param {{ injectedElementCount: number, cellTexts: string[] }} m
 * @param {string} hostileValue
 * @returns {Verdict}
 */
export function evaluateEscaping(m, hostileValue) {
	/** @type {string[]} */
	const failures = [];
	if (typeof hostileValue !== 'string' || hostileValue === '') {
		failures.push('the hostile value is absent from the readout — this check would be inert');
	}
	if (m.injectedElementCount !== 0) {
		failures.push(`${m.injectedElementCount} injected element(s) exist under the roll — the value was parsed as markup`);
	}
	if (hostileValue && !m.cellTexts.includes(hostileValue)) {
		failures.push('the hostile value is not any cell\'s exact text — it was dropped or altered rather than escaped');
	}
	return failures.length === 0
		? { passed: true, detail: `0 injected elements under the roll; the ${hostileValue.length}-char hostile value present as cell text` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Does `text` carry both numbers as STANDALONE numbers?
 *
 * Word-boundary matched, so `5` does not match inside `15` or `25`. That is
 * not a refinement — the seeded counts are small integers and a substring
 * scan would match almost any page.
 *
 * @param {string} text
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function matchesNumberPair(text, a, b) {
	if (typeof text !== 'string') return false;
	/** @param {number} n */
	const standalone = (n) => new RegExp(`\\b${String(n)}\\b`).test(text);
	return standalone(a) && standalone(b);
}

/**
 * D-14's structural claim: the key-release fact is a FILLED card carrying a
 * non-zero released count, and never a gap card.
 *
 * The second half is the half that would be forgotten. A page that rendered
 * the key-release sentence inside a de-emphasised gap card would satisfy every
 * "the numbers are on the page" check and would still be telling a reader that
 * a fact the system genuinely holds is a fact it does not.
 *
 * 54-13 DID ship a per-fact hook attribute, so this rung scopes tighter than
 * the number-pair match alone: the ONE filled card carrying the pair must also
 * BE the key-release fact. That can only tighten the rung — a page that put
 * the counts on some other card would now fail rather than pass on a
 * coincidence.
 *
 * @param {{ filledMatches: string[], gapMatches: string[], filledTotal: number, gapTotal: number }} m
 * @param {{ released: number, total: number }} counts
 * @param {string} expectedFactId
 * @returns {Verdict}
 */
export function evaluateKeyReleaseCard(m, counts, expectedFactId) {
	/** @type {string[]} */
	const failures = [];
	if (!(counts.released > 0)) failures.push(`seeded released is ${counts.released} — a zero would make this rung vacuous`);
	if (!(counts.released < counts.total)) failures.push(`seeded released ${counts.released} is not strictly below total ${counts.total}`);
	if (m.filledMatches.length !== 1) {
		failures.push(`${m.filledMatches.length} of ${m.filledTotal} filled card(s) carry the pair ${counts.released}/${counts.total} (want exactly 1): ${JSON.stringify(m.filledMatches)}`);
	} else if (m.filledMatches[0] !== expectedFactId) {
		failures.push(`the one filled card carrying the pair is "${m.filledMatches[0]}", not the key-release fact ("${expectedFactId}")`);
	}
	if (m.gapMatches.length !== 0) {
		failures.push(`${m.gapMatches.length} of ${m.gapTotal} gap card(s) carry the pair: ${JSON.stringify(m.gapMatches)}`);
	}
	return failures.length === 0
		? { passed: true, detail: `exactly 1 of ${m.filledTotal} filled cards carries ${counts.released}/${counts.total} and it is "${m.filledMatches[0]}"; 0 of ${m.gapTotal} gap cards do` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-11: the gap card is de-emphasised by ALL THREE cues together.
 *
 * No single cue is sufficient and the rung must fail if any one of the three
 * matches — a card that merely looks slightly different still reads as a fact.
 * The two elements compared are structurally identical apart from the class,
 * the branch attribute and one copy key, so a divergence here isolates
 * STYLING rather than structure.
 *
 * @param {{ borderTopStyle: string, color: string, fontSize: string }} gap
 * @param {{ borderTopStyle: string, color: string, fontSize: string }} plain
 * @returns {Verdict}
 */
export function evaluateGapStyleDivergence(gap, plain) {
	/** @type {string[]} */
	const failures = [];
	if (gap.borderTopStyle !== 'dashed') failures.push(`gap border-top-style is "${gap.borderTopStyle}" (want "dashed")`);
	if (plain.borderTopStyle !== 'solid') failures.push(`plain border-top-style is "${plain.borderTopStyle}" (want "solid")`);
	if (gap.borderTopStyle === plain.borderTopStyle) failures.push(`border-top-style does not diverge (both "${gap.borderTopStyle}")`);
	if (gap.color === plain.color) failures.push(`color does not diverge (both "${gap.color}")`);
	const gapSize = Number.parseFloat(gap.fontSize);
	const plainSize = Number.parseFloat(plain.fontSize);
	if (!Number.isFinite(gapSize) || !Number.isFinite(plainSize)) {
		failures.push(`font-size unreadable (gap "${gap.fontSize}", plain "${plain.fontSize}")`);
	} else if (!(gapSize < plainSize)) {
		failures.push(`font-size is not strictly smaller on the gap card (gap ${gapSize}px, plain ${plainSize}px)`);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `border-top-style ${gap.borderTopStyle} vs ${plain.borderTopStyle}; color ${gap.color} vs ${plain.color}; font-size ${gapSize}px vs ${plainSize}px`,
			}
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// D-24 / C6 / C7 / D-09 — the two chart-geometry comparators `60-08` adds.
//
// Same discipline as every comparator above: pure functions over values
// already read out of the page (or, for `deriveDistrictExpectation`, over the
// harness's `districts` array), exercised by `--prove-matchers` with no
// browser and no build. Module constants below are the ONLY tolerances these
// two comparators carry, and each is justified at its own declaration rather
// than left as a bare number.
// ---------------------------------------------------------------------------

/** C6: below this measured track width, a one-pixel rounding is a large
 * fraction of the ratio and the tolerance below cannot be trusted. @type {number} */
const MIN_TRACK_PX = 40;

/** C6: how far a measured fill/track ratio may diverge from the seeded
 * released/keyholder ratio and still count as "matches". Chosen so a wrong
 * denominator (the roll row count in place of the keyholder count) — which
 * moves the seeded ratio by well over three points — is caught, while a
 * border or a sub-pixel layout rounding is not. @type {number} */
const METER_RATIO_TOLERANCE = 0.03;

/** C7: how far a label's measured vertical centre may sit outside a bar's own
 * `[top, bottom]` span and still count as "on that bar's row". @type {number} */
const ROW_MATCH_TOLERANCE_PX = 2;

/** C7: how far a bar's measured width/max-width ratio may diverge from its
 * count/max-count ratio. Chosen to absorb a rounded data-end cap and
 * sub-pixel scaling without absorbing a one-unit count error at this
 * fixture's counts. @type {number} */
const BAR_RATIO_TOLERANCE = 0.04;

/** C7: how far a label's measured box may extend past the chart's own
 * measured box and still count as unclipped — a sub-pixel layout rounding
 * allowance, not a licence to hide a genuinely clipped label. @type {number} */
const CLIP_TOLERANCE_PX = 0.5;

/**
 * @typedef {{ name: string, count: number }} DistrictExpectationEntry
 * @typedef {{
 *   unfolded: ReadonlyArray<Readonly<DistrictExpectationEntry>>,
 *   foldedNames: ReadonlyArray<string>,
 *   foldedTotal: number,
 *   distinctCount: number,
 *   rowTotal: number,
 * }} DistrictExpectation
 */

/**
 * A pure tally/partition over the harness channel's `districts` array (one
 * entry per seeded row, duplicates included) against D-09's threshold.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, because an expectation derived from the
 * implementation under test proves nothing: it never calls
 * `foldDistrictCounts`, never orders the `unfolded` list (a comparator that
 * needs an order must sort it itself), and never models the
 * complementary-disclosure guard (`roll-disclosure.js`'s "if exactly one
 * group would fold, fold one more" rule). It reproduces only the POLICY — a
 * count below the threshold is withheld — never the ALGORITHM.
 *
 * @param {unknown} districts
 * @param {number} threshold
 * @returns {Readonly<DistrictExpectation>}
 */
export function deriveDistrictExpectation(districts, threshold) {
	const rows = Array.isArray(districts) ? districts : [];

	/** @type {Record<string, number>} */
	const tally = Object.create(null);
	for (const value of rows) {
		if (typeof value === 'string' && value !== '') {
			tally[value] = (tally[value] ?? 0) + 1;
		}
	}

	/** @type {DistrictExpectationEntry[]} */
	const unfolded = [];
	/** @type {string[]} */
	const foldedNames = [];
	let foldedTotal = 0;
	const names = Object.keys(tally);
	for (const name of names) {
		const count = tally[name];
		if (count >= threshold) unfolded.push(Object.freeze({ name, count }));
		else {
			foldedNames.push(name);
			foldedTotal += count;
		}
	}

	return Object.freeze({
		unfolded: Object.freeze(unfolded),
		foldedNames: Object.freeze(foldedNames),
		foldedTotal,
		distinctCount: names.length,
		rowTotal: rows.length,
	});
}

/**
 * C6: the key-release meter's measured fill width divided by its measured
 * track width equals the seeded released/keyholder ratio, within
 * `METER_RATIO_TOLERANCE`.
 *
 * TWO BLIND SPOTS THIS COMPARATOR CANNOT CLOSE, both stated rather than
 * hidden (60-08's own objective records the same two):
 *  - The DENOMINATOR. `60-06` mounts the meter with
 *    `total={keyRelease.keyholderCount}`, never `keyRelease.total` — but the
 *    shipped keyrelease fixture seeds both as the SAME number, so no
 *    measurement here can tell a correct denominator from a wrong one. That
 *    claim is owned at the source tier by `60-06`'s own grep-for-`.total`
 *    check.
 *  - The EXTREMES. The seeded page publishes one ratio (roughly 3 of 5), never
 *    `value === 0` or `value === total`. Those two extremes are covered by
 *    this comparator's OWN `--prove-matchers` controls below, not by the
 *    browser leg.
 *
 * Collects every failure rather than short-circuiting, and reports both
 * measured widths and both ratios on success so a reader can see the rung
 * actually measured something.
 *
 * @param {{ meterCount: number, trackCount: number, fillCount: number, trackWidth: number, fillWidth: number }} m
 * @param {{ value: number, total: number }} counts
 * @returns {Verdict}
 */
export function evaluateMeterGeometry(m, counts) {
	/** @type {string[]} */
	const failures = [];
	if (m.meterCount !== 1) failures.push(`meter count ${m.meterCount} (want 1) -- the key-release card renders no meter, or more than one`);
	if (m.trackCount !== 1) failures.push(`track count ${m.trackCount} (want 1)`);
	if (m.fillCount !== 1) failures.push(`fill count ${m.fillCount} (want 1)`);
	if (!(counts.value > 0 && counts.value < counts.total)) {
		failures.push(
			`seeded ratio ${counts.value}/${counts.total} is an extreme -- an always-empty and an always-full meter both ` +
				'satisfy an extreme, so this rung would be vacuous against it',
		);
	}
	if (m.trackWidth < MIN_TRACK_PX) failures.push(`track width ${m.trackWidth}px is below the ${MIN_TRACK_PX}px measurement floor`);
	if (!(m.fillWidth > 0)) failures.push(`fill width ${m.fillWidth}px is not positive -- renders empty regardless of data`);
	if (!(m.fillWidth < m.trackWidth)) failures.push(`fill width ${m.fillWidth}px is not below track width ${m.trackWidth}px -- renders full regardless of data`);
	const measuredRatio = m.trackWidth !== 0 ? m.fillWidth / m.trackWidth : Number.NaN;
	const expectedRatio = counts.total !== 0 ? counts.value / counts.total : Number.NaN;
	if (!Number.isFinite(measuredRatio) || !Number.isFinite(expectedRatio) || Math.abs(measuredRatio - expectedRatio) > METER_RATIO_TOLERANCE) {
		failures.push(
			`measured ratio ${Number.isFinite(measuredRatio) ? measuredRatio.toFixed(3) : measuredRatio} diverges from expected ` +
				`${Number.isFinite(expectedRatio) ? expectedRatio.toFixed(3) : expectedRatio} by more than ${METER_RATIO_TOLERANCE}`,
		);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `track ${m.trackWidth}px, fill ${m.fillWidth}px, measured ratio ${measuredRatio.toFixed(3)} vs expected ${expectedRatio.toFixed(3)}`,
			}
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C7 / D-09: one bar renders per surviving district bucket, every bar is
 * non-zero-width and proportional to its own count, the fold's selectivity is
 * observable, no withheld name leaks into the chart, and no label is clipped.
 *
 * Every condition is COLLECTED, never short-circuited — including the
 * anti-vacuity check on `expected` itself, so a single run can report every
 * way this rung is currently unable to prove anything, not just the first.
 *
 * PAIRING IS BY MEASURED GEOMETRY, NEVER BY INDEX: for each surviving
 * district this function finds the one text matching its name EXACTLY (never
 * `includes` — a truncation is a substring of the original), locates the one
 * bar whose row that label's vertical centre falls inside, and finds the one
 * other text on that same row that parses as the district's count. Nothing
 * here assumes the product's rendering order.
 *
 * @param {{
 *   chartCount: number,
 *   bars: ReadonlyArray<{ width: number, top: number, bottom: number }>,
 *   texts: ReadonlyArray<{ text: string, left: number, right: number, top: number, bottom: number, width: number }>,
 *   chartBox: { left: number, right: number, top: number, bottom: number } | null,
 *   markupElementCount: number,
 * }} m
 * @param {Readonly<DistrictExpectation>} expected
 * @returns {Verdict}
 */
export function evaluateDistrictBars(m, expected) {
	/** @type {string[]} */
	const failures = [];
	if (m.chartCount !== 1) failures.push(`chart count ${m.chartCount} (want 1) -- the roll card renders no district chart, or more than one`);

	// Anti-vacuity on the EXPECTATION itself, before anything about the page:
	// this is the condition that makes the rung a real privacy control rather
	// than a bar counter, and it is why Task 1 rebalanced the fixture.
	if (expected.unfolded.length < 2 || expected.foldedNames.length < 2) {
		failures.push(
			`the fixture no longer holds two districts at or above the fold threshold and two below it ` +
				`(unfolded=${expected.unfolded.length}, folded=${expected.foldedNames.length}) -- this rung can no longer ` +
				'distinguish a selective fold from a total one',
		);
	}

	const bars = Array.isArray(m.bars) ? m.bars : [];
	const texts = Array.isArray(m.texts) ? m.texts : [];

	if (bars.length !== expected.unfolded.length + 1) {
		failures.push(`${bars.length} bar(s) rendered, want ${expected.unfolded.length + 1} (one per surviving district plus "other")`);
	}
	if (bars.length >= expected.distinctCount) {
		failures.push(`${bars.length} bar(s) rendered is not fewer than the ${expected.distinctCount} distinct seeded district(s) -- the fold did not fire`);
	}
	if (bars.length < 2) {
		failures.push(`only ${bars.length} bar(s) rendered -- the fold swallowed everything, indistinguishable from a broken mount`);
	}
	const zeroWidthBars = bars.filter((b) => !(b.width > 0));
	if (zeroWidthBars.length > 0) failures.push(`${zeroWidthBars.length} of ${bars.length} bar(s) measure zero or negative width`);

	/** @param {number} top @param {number} bottom @returns {number} */
	const rowCenter = (top, bottom) => (top + bottom) / 2;
	/** @param {number} center @param {{ top: number, bottom: number }} bar @returns {boolean} */
	const onRow = (center, bar) => center >= bar.top - ROW_MATCH_TOLERANCE_PX && center <= bar.bottom + ROW_MATCH_TOLERANCE_PX;
	/** @param {string} text @returns {boolean} */
	const isPureInteger = (text) => /^-?\d+$/.test(text);

	const usedBarIdx = new Set();
	const usedTextIdx = new Set();
	/** @type {Array<{ entry: DistrictExpectationEntry, bar: { width: number, top: number, bottom: number }, barIdx: number, nameText: (typeof texts)[number], countText: (typeof texts)[number] }>} */
	const pairs = [];

	for (const entry of expected.unfolded) {
		const nameMatches = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.text === entry.name);
		if (nameMatches.length !== 1) {
			failures.push(`district "${entry.name}": ${nameMatches.length} text(s) match its name exactly (want 1)`);
			continue;
		}
		const { t: nameText, i: nameIdx } = nameMatches[0];
		const nameCenter = rowCenter(nameText.top, nameText.bottom);
		const hostBars = bars.map((b, i) => ({ b, i })).filter(({ b }) => onRow(nameCenter, b));
		if (hostBars.length !== 1) {
			failures.push(`district "${entry.name}": its label's vertical centre falls inside ${hostBars.length} bar row(s) (want 1)`);
			continue;
		}
		const { b: bar, i: barIdx } = hostBars[0];
		const countMatches = texts
			.map((t, i) => ({ t, i }))
			.filter(({ i }) => i !== nameIdx)
			.filter(({ t }) => isPureInteger(t.text) && Number.parseInt(t.text, 10) === entry.count)
			.filter(({ t }) => onRow(rowCenter(t.top, t.bottom), bar));
		if (countMatches.length !== 1) {
			failures.push(`district "${entry.name}": ${countMatches.length} count text(s) on its bar row read as ${entry.count} (want exactly 1)`);
			continue;
		}
		usedBarIdx.add(barIdx);
		usedTextIdx.add(nameIdx);
		usedTextIdx.add(countMatches[0].i);
		pairs.push({ entry, bar, barIdx, nameText, countText: countMatches[0].t });
	}

	// The "other" bar: exactly one bar left unpaired, and the count text on
	// its row must equal `expected.foldedTotal` -- the bucket is asserted by
	// its ARITHMETIC, never by its caller-supplied label wording.
	const unpairedBarIdx = bars.map((_, i) => i).filter((i) => !usedBarIdx.has(i));
	if (unpairedBarIdx.length !== 1) {
		failures.push(`${unpairedBarIdx.length} bar(s) remain unpaired after matching every surviving district (want exactly 1, the "other" bucket)`);
	} else {
		const otherBar = bars[unpairedBarIdx[0]];
		const otherCountMatches = texts
			.map((t, i) => ({ t, i }))
			.filter(({ i }) => !usedTextIdx.has(i))
			.filter(({ t }) => isPureInteger(t.text))
			.filter(({ t }) => onRow(rowCenter(t.top, t.bottom), otherBar));
		if (otherCountMatches.length !== 1 || Number.parseInt(otherCountMatches[0].t.text, 10) !== expected.foldedTotal) {
			failures.push(
				`"other" bucket: ${otherCountMatches.length} count text(s) on its row (want exactly 1) reading its expected total ${expected.foldedTotal}`,
			);
		}
	}

	// Proportionality, computed only over the matched (unfolded) pairs.
	if (pairs.length > 0) {
		const maxPair = pairs.reduce((a, b) => (b.entry.count > a.entry.count ? b : a));
		const maxCount = maxPair.entry.count;
		const maxWidth = maxPair.bar.width;
		if (!(maxWidth > 0)) {
			failures.push(`the max-count district's bar measures ${maxWidth}px width -- proportionality cannot be assessed`);
		} else {
			for (const p of pairs) {
				const expectedRatio = p.entry.count / maxCount;
				const measuredRatio = p.bar.width / maxWidth;
				if (Math.abs(measuredRatio - expectedRatio) > BAR_RATIO_TOLERANCE) {
					failures.push(
						`district "${p.entry.name}": bar width ${p.bar.width}px is not proportional to its count ${p.entry.count} ` +
							`(measured ratio ${measuredRatio.toFixed(3)} vs expected ${expectedRatio.toFixed(3)})`,
					);
				}
			}
		}
	}

	// Disclosure: every withheld name absent from the chart's text as a
	// SUBSTRING -- the stricter direction, because a partial leak is still a
	// leak. Scope matters: this readout must already be scoped to the chart
	// subtree, since these names legitimately appear in the roll table above
	// it -- widening the readout would turn this condition into a permanent
	// failure, not a reason to delete it.
	const chartText = texts.map((t) => t.text).join(' ');
	for (const name of expected.foldedNames) {
		if (chartText.includes(name)) failures.push(`withheld district "${name}" appears as a substring in the chart's own text`);
	}

	// Unclipped labels: every text paired above must measure a positive width
	// and lie inside the chart's own measured box, expanded by
	// `CLIP_TOLERANCE_PX`. A box extending past the chart's own box is the
	// observable form of an SVG-clipped label.
	const clipCandidates = pairs.flatMap((p) => [p.nameText, p.countText]);
	if (clipCandidates.length > 0) {
		if (!m.chartBox) {
			failures.push(`no chart box measured -- cannot confirm ${clipCandidates.length} paired label(s) are unclipped`);
		} else {
			const box = m.chartBox;
			for (const t of clipCandidates) {
				if (!(t.width > 0)) {
					failures.push(`label "${t.text}" measures zero width`);
					continue;
				}
				if (t.left < box.left - CLIP_TOLERANCE_PX || t.right > box.right + CLIP_TOLERANCE_PX || t.top < box.top - CLIP_TOLERANCE_PX || t.bottom > box.bottom + CLIP_TOLERANCE_PX) {
					failures.push(`label "${t.text}" box (${t.left},${t.top})-(${t.right},${t.bottom}) extends past the chart's own box (${box.left},${box.top})-(${box.right},${box.bottom}) -- clipped`);
				}
			}
		}
	}

	if (m.markupElementCount !== 0) {
		failures.push(`${m.markupElementCount} markup element(s) (b, i, script, img) reached the chart -- authority-supplied text was parsed as markup instead of text`);
	}

	return failures.length === 0
		? {
				passed: true,
				detail: `${bars.length} bar(s) (${expected.unfolded.length} named + "other"), proportional within ${BAR_RATIO_TOLERANCE}, ${expected.foldedNames.length} withheld name(s) absent, 0 markup element(s)`,
			}
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-16/60-13: every numeric-axis tick label parses as a whole number, and the
 * largest tick never runs past the fixture's own real maximum.
 *
 * ANTI-VACUITY FIRST, and the third clause is the one that makes this rung
 * honest rather than merely correct: a fractional tick is only REACHABLE when
 * the axis's own data maximum is small (Recharts' nice-number algorithm has
 * no reason to subdivide below 1 once the domain runs into the hundreds), so
 * `expected.maxValue > 3` must itself be a FAIL — a rung fed a large-count
 * fixture would otherwise pass on every build, healthy or not.
 *
 * @param {ReadonlyArray<string>} ticks
 * @param {{ maxValue: number, axisName: string }} expected
 * @returns {Verdict}
 */
export function evaluateIntegerTicks(ticks, expected) {
	/** @type {string[]} */
	const failures = [];
	const list = Array.isArray(ticks) ? ticks : [];
	const axisName = expected && typeof expected.axisName === 'string' && expected.axisName !== '' ? expected.axisName : '(unnamed axis)';
	const maxValue = expected ? expected.maxValue : Number.NaN;

	if (list.length < 2) {
		failures.push(
			`${axisName}: only ${list.length} tick(s) rendered -- an axis with fewer than 2 ticks cannot show a fractional subdivision, so this rung would be vacuous`,
		);
	}
	const emptyCount = list.filter((t) => typeof t !== 'string' || t.trim() === '').length;
	if (emptyCount > 0) failures.push(`${axisName}: ${emptyCount} of ${list.length} tick(s) have empty text`);
	if (!Number.isFinite(maxValue) || maxValue > 3) {
		failures.push(
			`${axisName}: the fixture's maximum (${maxValue}) is too large for a fractional tick to be reachable; this rung would be vacuous`,
		);
	}

	/** @type {number[]} */
	const parsed = [];
	for (const raw of list) {
		if (typeof raw !== 'string' || raw.trim() === '') continue;
		const stripped = raw.replace(/,/g, '');
		if (!/^-?\d+$/.test(stripped)) {
			failures.push(`${axisName}: tick "${raw}" is not a whole number`);
			continue;
		}
		parsed.push(Number.parseInt(stripped, 10));
	}

	if (parsed.length > 0 && Number.isFinite(maxValue)) {
		const largest = Math.max(...parsed);
		if (largest > maxValue) failures.push(`${axisName}: largest tick ${largest} exceeds the fixture's real maximum ${maxValue}`);
	}

	return failures.length === 0
		? { passed: true, detail: `${axisName}: ${list.length} tick(s) [${list.join(', ')}], all whole numbers, within the fixture's real maximum ${maxValue}` }
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — the matcher positive controls (`--prove-matchers`).
//
// Every comparator above is run TWICE: once against an input built to violate
// it, which must report FAIL, and once against a healthy input, which must
// report PASS. Only the first is what 54-VALIDATION's self-tripping-checker
// rule 2 demands, but a comparator that fails on EVERYTHING is as useless as
// one that fails on nothing, and only the second control can tell them apart.
// ---------------------------------------------------------------------------

const HEALTHY_CELLS = [
	{ text: 'A production-length district value (48 chars long!!)', textOverflow: 'clip', overflow: 'visible' },
	{ text: 'Someothercell', textOverflow: 'clip', overflow: 'visible' },
];
const HEALTHY_LONGEST = HEALTHY_CELLS[0].text;
const CONTROL_MARKER = ['EXTRA', 'FIELDS', 'MUST', 'NOT', 'RENDER'].join('-');
const CONTROL_HOSTILE = `<${'script'}>controlXss()</${'script'}>`;

// C6/C7 controls' own literals -- assembled at runtime, never a bare literal
// this file's own `Gate-source integrity` bans could match, and long enough
// (>= 20 chars, per D-19's production-length rule) to genuinely exercise the
// clipping condition rather than standing in for it.
const CTRL_DISTRICT_A = ['Meridian Hollow Ward Twelve', '(control-fixture)'].join(' ');
const CTRL_DISTRICT_B = ['Cinder Bluff Precinct Nine', '(control-fixture)'].join(' ');
const CTRL_DISTRICT_C = ['Larkspur Fen Precinct Three', '(control-fixture)'].join(' ');
const CTRL_DISTRICT_D = ['Foxglove Reach Precinct Five', '(control-fixture)'].join(' ');
const CTRL_OTHER_LABEL = ['Other', 'district(s)', '(control-fixture)'].join(' ');
/** Threshold used by every C7 control below -- deliberately not D-09's real
 * exported constant, so these controls stay independent of any future change
 * to `SMALL_DISTRICT_THRESHOLD`. @type {number} */
const CTRL_BARS_THRESHOLD = 2;
/** A=3 (unfolded), B=2 (unfolded), C=1 and D=1 (both folded) -- two above the
 * threshold and two below it, matching the shape Task 1 gave the real fixture. */
const CTRL_BARS_DISTRICTS = Object.freeze([
	CTRL_DISTRICT_A,
	CTRL_DISTRICT_A,
	CTRL_DISTRICT_A,
	CTRL_DISTRICT_B,
	CTRL_DISTRICT_B,
	CTRL_DISTRICT_C,
	CTRL_DISTRICT_D,
]);
const CTRL_BARS_EXPECTED = deriveDistrictExpectation(CTRL_BARS_DISTRICTS, CTRL_BARS_THRESHOLD);
/** The healthy C7 readout: one bar per surviving district (A, B) plus a
 * folded "other" bucket whose count equals C + D. @type {{ chartCount: number, bars: Array<{width:number,top:number,bottom:number}>, texts: Array<{text:string,left:number,right:number,top:number,bottom:number,width:number}>, chartBox: {left:number,right:number,top:number,bottom:number}, markupElementCount: number }} */
const CTRL_BARS_HEALTHY_READOUT = {
	chartCount: 1,
	bars: [
		{ width: 180, top: 0, bottom: 20 },
		{ width: 120, top: 24, bottom: 44 },
		{ width: 40, top: 48, bottom: 68 },
	],
	texts: [
		{ text: CTRL_DISTRICT_A, left: 0, right: 180, top: 0, bottom: 20, width: 180 },
		{ text: '3', left: 182, right: 190, top: 5, bottom: 15, width: 8 },
		{ text: CTRL_DISTRICT_B, left: 0, right: 120, top: 24, bottom: 44, width: 120 },
		{ text: '2', left: 122, right: 130, top: 29, bottom: 39, width: 8 },
		{ text: CTRL_OTHER_LABEL, left: 0, right: 40, top: 48, bottom: 68, width: 40 },
		{ text: '2', left: 42, right: 50, top: 53, bottom: 63, width: 8 },
	],
	chartBox: { left: 0, right: 200, top: 0, bottom: 100 },
	markupElementCount: 0,
};

/**
 * @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>}
 */
function matcherControls() {
	return Object.freeze([
		{
			label: 'roll-fields comparator vs. a table with two headings and three rows',
			violating: evaluateRollFields({ rollCount: 1, headers: ['LastName', 'District'], rowCount: 3, cellCount: 6, emptyCellCount: 1 }, 4),
			healthy: evaluateRollFields({ rollCount: 1, headers: [...EXPECTED_HEADERS], rowCount: 4, cellCount: 12, emptyCellCount: 0 }, 4),
		},
		{
			label: 'overflow comparator vs. a wrapper that clips (overflow-x hidden, scrollWidth === clientWidth, cell ellipsised)',
			violating: evaluateRollOverflow(
				{
					overflowX: 'hidden',
					scrollWidth: 282,
					clientWidth: 282,
					cells: [{ text: HEALTHY_LONGEST.slice(0, 20), textOverflow: 'ellipsis', overflow: 'hidden' }],
				},
				HEALTHY_LONGEST,
			),
			healthy: evaluateRollOverflow({ overflowX: 'auto', scrollWidth: 384, clientWidth: 282, cells: HEALTHY_CELLS }, HEALTHY_LONGEST),
		},
		{
			label: 'forbidden-string scan vs. markup that really contains the withheld-field marker',
			violating: evaluateHiddenStrings(`<td>a cell</td><span>${CONTROL_MARKER}</span>`, [{ label: 'control marker', needle: CONTROL_MARKER }]),
			healthy: evaluateHiddenStrings('<td>a cell</td><span>nothing to see</span>', [{ label: 'control marker', needle: CONTROL_MARKER }]),
		},
		{
			label: 'escaping check vs. a fragment that really contains an injected element',
			violating: evaluateEscaping({ injectedElementCount: 1, cellTexts: [] }, CONTROL_HOSTILE),
			healthy: evaluateEscaping({ injectedElementCount: 0, cellTexts: [CONTROL_HOSTILE] }, CONTROL_HOSTILE),
		},
		{
			label: 'number-pair matcher vs. a card carrying 15 and 25 (the word boundaries must hold)',
			// The counts are 2 and 5, both of which appear in the control text as
			// SUBSTRINGS of 15 and 25 and neither of which appears standalone.
			// They also satisfy `0 < released < total`, so the ONLY thing left
			// to fail is the word boundary — which is the property this control
			// exists to prove, rather than an incidental count mismatch.
			violating: evaluateKeyReleaseCard(
				{
					filledMatches: matchesNumberPair('15 of 25 keyholders have released their keys.', 2, 5) ? ['control'] : [],
					gapMatches: [],
					filledTotal: 1,
					gapTotal: 0,
				},
				{ released: 2, total: 5 },
				KEYRELEASE_FACT_ID,
			),
			healthy: evaluateKeyReleaseCard(
				{
					filledMatches: matchesNumberPair('3 of 5 keyholders have released their keys.', 3, 5) ? [KEYRELEASE_FACT_ID] : [],
					gapMatches: [],
					filledTotal: 1,
					gapTotal: 0,
				},
				{ released: 3, total: 5 },
				KEYRELEASE_FACT_ID,
			),
		},
		{
			label: 'style comparator vs. two elements with IDENTICAL computed styles',
			violating: evaluateGapStyleDivergence(
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
			),
			healthy: evaluateGapStyleDivergence(
				{ borderTopStyle: 'dashed', color: 'rgb(141, 151, 168)', fontSize: '12px' },
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
			),
		},
		{
			label: 'C6 meter-geometry comparator vs. a fill measuring ~90% of its track while the counts say 60%',
			violating: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 180 }, { value: 3, total: 5 }),
			healthy: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 120 }, { value: 3, total: 5 }),
		},
		{
			label: 'C6 meter-geometry comparator vs. a saturated input (value === total) whose fill genuinely fills the track',
			// The arithmetic "matches" -- fillWidth/trackWidth really is 1.0, the
			// same as released/total -- and the comparator must still refuse it:
			// an always-full meter is indistinguishable from a correct one at
			// this one extreme, so the rung would be vacuous against it.
			violating: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 200 }, { value: 5, total: 5 }),
			healthy: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 120 }, { value: 3, total: 5 }),
		},
		{
			label: 'C6 meter-geometry comparator vs. a zero input (value === 0) whose fill genuinely renders empty',
			violating: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 0 }, { value: 0, total: 5 }),
			healthy: evaluateMeterGeometry({ meterCount: 1, trackCount: 1, fillCount: 1, trackWidth: 200, fillWidth: 120 }, { value: 3, total: 5 }),
		},
		{
			label: 'C7 district-bars comparator vs. a fold that did not fire (one bar per distinct district, no "other" bucket)',
			violating: evaluateDistrictBars(
				{
					chartCount: 1,
					bars: [
						{ width: 180, top: 0, bottom: 20 },
						{ width: 120, top: 24, bottom: 44 },
						{ width: 60, top: 48, bottom: 68 },
						{ width: 60, top: 72, bottom: 92 },
					],
					texts: [
						{ text: CTRL_DISTRICT_A, left: 0, right: 180, top: 0, bottom: 20, width: 180 },
						{ text: '3', left: 182, right: 190, top: 5, bottom: 15, width: 8 },
						{ text: CTRL_DISTRICT_B, left: 0, right: 120, top: 24, bottom: 44, width: 120 },
						{ text: '2', left: 122, right: 130, top: 29, bottom: 39, width: 8 },
						{ text: CTRL_DISTRICT_C, left: 0, right: 60, top: 48, bottom: 68, width: 60 },
						{ text: '1', left: 62, right: 70, top: 53, bottom: 63, width: 8 },
						{ text: CTRL_DISTRICT_D, left: 0, right: 60, top: 72, bottom: 92, width: 60 },
						{ text: '1', left: 62, right: 70, top: 77, bottom: 87, width: 8 },
					],
					chartBox: { left: 0, right: 200, top: 0, bottom: 100 },
					markupElementCount: 0,
				},
				CTRL_BARS_EXPECTED,
			),
			healthy: evaluateDistrictBars(CTRL_BARS_HEALTHY_READOUT, CTRL_BARS_EXPECTED),
		},
		{
			label: 'C7 district-bars comparator vs. a readout whose chart text leaks a withheld (folded) district name',
			violating: evaluateDistrictBars(
				{
					...CTRL_BARS_HEALTHY_READOUT,
					texts: [
						...CTRL_BARS_HEALTHY_READOUT.texts,
						// A stray text node under the chart subtree carrying a name that
						// should have been folded away -- the leak this control proves
						// the comparator can catch.
						{ text: CTRL_DISTRICT_C, left: 5, right: 60, top: 200, bottom: 220, width: 55 },
					],
				},
				CTRL_BARS_EXPECTED,
			),
			healthy: evaluateDistrictBars(CTRL_BARS_HEALTHY_READOUT, CTRL_BARS_EXPECTED),
		},
		{
			label: 'integer-tick comparator vs. the live defect\'s fractional, over-domain ticks (0/0.4/0.8/1.2/1.6/2 against a max of 2)',
			violating: evaluateIntegerTicks(['0', '0.4', '0.8', '1.2', '1.6', '2'], { maxValue: 2, axisName: 'district chart numeric axis' }),
			healthy: evaluateIntegerTicks(['0', '1', '2'], { maxValue: 2, axisName: 'district chart numeric axis' }),
		},
		{
			label: 'integer-tick comparator vs. the narrow-width form (0/0.7/1.4/2.1) -- fractional AND over-domain',
			violating: evaluateIntegerTicks(['0', '0.7', '1.4', '2.1'], { maxValue: 2, axisName: 'district chart numeric axis' }),
			healthy: evaluateIntegerTicks(['0', '1', '2'], { maxValue: 2, axisName: 'district chart numeric axis' }),
		},
		{
			label: 'integer-tick comparator vs. a single-tick axis (planted anti-vacuity control missing)',
			violating: evaluateIntegerTicks(['0'], { maxValue: 2, axisName: 'district chart numeric axis' }),
			healthy: evaluateIntegerTicks(['0', '1', '2'], { maxValue: 2, axisName: 'district chart numeric axis' }),
		},
		{
			label: 'integer-tick comparator vs. a healthy integer tick list whose expected maximum is 1847 (would be vacuous against a large-count fixture)',
			violating: evaluateIntegerTicks(['0', '500', '1000', '1500'], { maxValue: 1847, axisName: 'district chart numeric axis' }),
			healthy: evaluateIntegerTicks(['0', '1', '2'], { maxValue: 2, axisName: 'district chart numeric axis' }),
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
// The build / serve / launch plumbing, copied in shape from `run-ui-gates.mjs`.
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
 * Resolve the built entry by SEARCHING `dist-gate` for exactly one file of
 * that name, rather than predicting the bundler's output path for a non-root
 * HTML input. Two matches is as much a setup error as none.
 * @returns {string}
 */
function resolveGateEntry(distAbs = GATE_DIST) {
	const GATE_DIST = distAbs;
	if (!existsSync(GATE_DIST)) fail(`gate dist "${GATE_DIST}" does not exist — run \`yarn build:gate\` or drop --skip-build.`);
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
	const matches = walk(GATE_DIST);
	if (matches.length !== 1) fail(`expected exactly one "${GATE_ENTRY}" under "${GATE_DIST}", found ${matches.length}.`);
	return path.relative(GATE_DIST, matches[0]).split(path.sep).join('/');
}

/**
 * Everything the rungs need, read out of the live page in ONE evaluate so the
 * whole readout describes a single layout rather than several.
 * @param {import('playwright').Page} page
 */
function readPage(page) {
	return page.evaluate(() => {
		/** @param {Element} el */
		const styleOf = (el) => {
			const cs = getComputedStyle(el);
			return { borderTopStyle: cs.borderTopStyle, color: cs.color, fontSize: cs.fontSize };
		};
		// The harness's ONE readout channel, read through an untyped view of the
		// global object -- this file is checked as JS, and the harness's own
		// `declare global` lives in a `.tsx` the checker does not apply here.
		const gateReadout = /** @type {any} */ (globalThis).__UI_GATE__ ?? null;
		const rolls = [...document.querySelectorAll('#root .registrant-roll')];
		const roll = rolls[0] ?? null;
		const rollStyle = roll ? getComputedStyle(roll) : null;
		const cellEls = roll ? [...roll.querySelectorAll('tbody td')] : [];
		const outcome = document.querySelector('#root [data-fact-group="outcome"]');
		// The pair D-11 is measured on, and neither half is arbitrary. BOTH come
		// from the outcome section, which is the only section rendering a gap
		// card and a filled card together — that is what makes the comparison a
		// comparison of STYLING rather than of two different page regions. The
		// filled half is pinned to the key-release card specifically because
		// 54-13 renders its two branches identically apart from the class, the
		// branch attribute and one copy key, so this pair differs in styling
		// and in nothing else. A missing half fails the rung by name rather
		// than silently substituting some other card.
		const gapCard = outcome ? outcome.querySelector('.fact-card--gap') : null;
		const plainCard = outcome ? outcome.querySelector('.fact-card:not(.fact-card--gap)[data-fact-id="keyrelease"]') : null;
		// A card's text as a READER experiences it, NOT as `textContent`
		// returns it. `textContent` concatenates adjacent block elements with
		// no separator at all, so a heading ending in a letter fuses with a
		// body starting with a digit — the key-release card really does
		// serialise as "...key release3 of 5 keyholders...", which defeats a
		// word-boundary match on the numerator for a reason that has nothing
		// to do with what is on screen. Joining the descendant TEXT NODES with
		// a single space reproduces the visual separation the two block
		// elements already have. This is a fix to the MEASUREMENT, not a
		// loosening of the assertion: the numbers must still be standalone
		// within their own sentence.
		/** @param {Element} el */
		const readerText = (el) => {
			/** @type {string[]} */
			const parts = [];
			/** @param {Node} node */
			const walk = (node) => {
				for (const child of node.childNodes) {
					if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue ?? '');
					else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
				}
			};
			walk(el);
			return parts.join(' ');
		};
		// D-24/C6/C7 -- Recharts may split a single tick into several `tspan`
		// children, and `textContent` concatenates them with no separator.
		// Collapsing whitespace is a fix to the MEASUREMENT, not a loosening of
		// the assertion: the exact-match requirement on a district's full name
		// stays exact.
		/** @param {string} s */
		const normalizeWhitespace = (s) => s.replace(/\s+/g, ' ').trim();
		// A multi-line SVG `<text>` wraps by splitting the original string on
		// spaces into sibling `<tspan>`s, each its own visual line -- the space
		// that decided the wrap point is DISCARDED, not kept as a text node, so
		// `el.textContent` alone reproduces "Ward</b>5 Precinct" (fused) rather
		// than "Ward</b> 5 Precinct". Joining the `<tspan>` children with a
		// single space reconstructs the space the line-wrap removed. Same
		// discipline as `readerText` above: a fix to the MEASUREMENT, not a
		// loosening of the exact-match requirement.
		/** @param {Element} el */
		const svgTextOf = (el) => {
			const tspans = [...el.querySelectorAll('tspan')];
			return tspans.length > 0 ? tspans.map((t) => t.textContent ?? '').join(' ') : (el.textContent ?? '');
		};
		/** @param {Element} el */
		// A card with no per-fact identity is reported as such rather than as
		// `null` — it would be a real defect (54-13 tags every card), and a
		// nameless entry in a failure detail helps nobody.
		const cardText = (el) => ({
			id: el.getAttribute('data-fact-id') ?? '(untagged card)',
			kind: el.getAttribute('data-fact-kind') ?? '(untagged kind)',
			text: readerText(el),
		});
		// C6 -- measured with `getBoundingClientRect()` directly on the SVG
		// elements, scoped to the key-release card by the interface contract's
		// selector table. Reported even when a half is missing (0 rather than a
		// thrown error): the COMPARATOR decides what a missing half means, not
		// this readout.
		const keyreleaseCard = document.querySelector('#root [data-fact-id="keyrelease"]');
		const meterEls = keyreleaseCard ? [...keyreleaseCard.querySelectorAll('.vt-chart__meter')] : [];
		const trackEls = keyreleaseCard ? [...keyreleaseCard.querySelectorAll('.vt-chart__meter-track')] : [];
		const fillEls = keyreleaseCard ? [...keyreleaseCard.querySelectorAll('.vt-chart__meter-fill')] : [];
		// C7 -- scoped to the roll card's `.vt-chart--bar` root, per the
		// interface contract. If the chart element is present but
		// `.vt-chart__bar--series-1` matches zero elements, the zero is reported
		// rather than falling back to another selector -- a readout that
		// quietly retries a looser selector is how a rung starts passing on a
		// chart that is not the one under test.
		const rollCard = document.querySelector('#root [data-fact-id="registrantRoll"]');
		const districtChartEls = rollCard ? [...rollCard.querySelectorAll('.vt-chart--bar')] : [];
		const districtChart = districtChartEls[0] ?? null;
		const districtChartRect = districtChart ? districtChart.getBoundingClientRect() : null;
		const barEls = districtChart ? [...districtChart.querySelectorAll('.vt-chart__bar--series-1')] : [];
		const districtTextEls = districtChart ? [...districtChart.querySelectorAll('text')] : [];
		const markupEls = districtChart ? [...districtChart.querySelectorAll('b, i, script, img')] : [];
		// D-16/60-13 -- the horizontal C7 form's numeric axis is XAxis, so the
		// tick text lives under `.recharts-xAxis-tick-labels`, scoped to this
		// same chart root per the interface contract's selector table.
		const numericTickEls = districtChart ? [...districtChart.querySelectorAll('.recharts-xAxis-tick-labels .vt-chart__axis')] : [];
		return {
			gate: gateReadout ? { error: gateReadout.error, fixture: gateReadout.fixture } : null,
			roll: {
				rollCount: rolls.length,
				headers: roll ? [...roll.querySelectorAll('thead th')].map((th) => th.textContent ?? '') : [],
				rowCount: roll ? roll.querySelectorAll('tbody tr').length : 0,
				cellCount: cellEls.length,
				emptyCellCount: cellEls.filter((td) => (td.textContent ?? '').trim() === '').length,
				overflowX: rollStyle ? rollStyle.overflowX : '(no roll)',
				scrollWidth: roll ? roll.scrollWidth : 0,
				clientWidth: roll ? roll.clientWidth : 0,
				cells: cellEls.map((td) => {
					const cs = getComputedStyle(td);
					return { text: td.textContent ?? '', textOverflow: cs.textOverflow, overflow: cs.overflow };
				}),
				injectedElementCount: roll ? roll.querySelectorAll('script').length : 0,
			},
			html: document.body.innerHTML,
			filledCards: [...document.querySelectorAll('#root .fact-card:not(.fact-card--gap)')].map(cardText),
			gapCards: [...document.querySelectorAll('#root .fact-card--gap')].map(cardText),
			gapStyle: gapCard ? { id: gapCard.getAttribute('data-fact-id') ?? '(untagged card)', ...styleOf(gapCard) } : null,
			plainStyle: plainCard ? { id: plainCard.getAttribute('data-fact-id') ?? '(untagged card)', ...styleOf(plainCard) } : null,
			meter: {
				meterCount: meterEls.length,
				trackCount: trackEls.length,
				fillCount: fillEls.length,
				trackWidth: trackEls[0] ? trackEls[0].getBoundingClientRect().width : 0,
				fillWidth: fillEls[0] ? fillEls[0].getBoundingClientRect().width : 0,
			},
			districtChart: {
				chartCount: districtChartEls.length,
				bars: barEls.map((el) => {
					const r = el.getBoundingClientRect();
					return { width: r.width, top: r.top, bottom: r.bottom };
				}),
				texts: districtTextEls.map((el) => {
					const r = el.getBoundingClientRect();
					return { text: normalizeWhitespace(svgTextOf(el)), left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
				}),
				chartBox: districtChartRect
					? { left: districtChartRect.left, right: districtChartRect.right, top: districtChartRect.top, bottom: districtChartRect.bottom }
					: null,
				markupElementCount: markupEls.length,
				numericTicks: numericTickEls.map((el) => (el.textContent ?? '').trim()),
			},
		};
	});
}

/**
 * `--prove-gap-cues-flattened` — the BUILD-LEVEL half of this gate's negative
 * control, and the half `--prove-matchers` structurally cannot supply.
 *
 * `--prove-matchers` runs every comparator against synthetic inputs, so it
 * proves the comparators fire. It cannot see a SHIPPED STYLESHEET that
 * stopped carrying the gap cues, because it never builds or loads one. This
 * mode closes exactly that gap: it rebuilds a real mutant artefact with the
 * gap-card rule's declaration body flattened and re-runs the SAME rungs
 * against it, requiring `gap-card-style-diverges` — and only it — to fail.
 *
 * Four verdicts are kept distinct on purpose, because collapsing any two of
 * them is how a control becomes decorative:
 *   - CONTROL COULD NOT RUN: the healthy leg did not fully pass, or the
 *     mutant build failed. Nothing can be attributed to the mutation.
 *   - MUTATION IS A NO-OP: the mutant build exited 0 but the plugin flattened
 *     nothing. Distinct from an inert gate: the gate was never tested.
 *   - WRONG FAILURE SHAPE: the mutant page crashed, went vacuous, or took
 *     down rungs other than the target. A blank page failing everything is
 *     not evidence the style rung works.
 *   - IS INERT: the mutant leg still PASSED the target rung. This prints the
 *     literal sentinel `web-gates.yml` greps across every control in this
 *     repo, so it is readable by the mechanism already in place.
 *
 * @param {number} port
 * @param {boolean} skipBuild
 */
async function runProveGapCuesFlattened(port, skipBuild) {
	const PREFIX = `[${LABEL}] --prove-gap-cues-flattened: control could not run —`;

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
	process.stdout.write(`[${LABEL}] building the ${GAP_MUTATION} mutant via ${MUTANT_CONFIG}\n`);
	const code = await buildGate(MUTANT_CONFIG, { UI_GATE_MUTATION: GAP_MUTATION }, true);
	if (code !== 0) {
		process.stderr.write(`\n${PREFIX} the ${GAP_MUTATION} mutant build exited ${code}\n`);
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
	if (report.mutation !== GAP_MUTATION || !Number.isInteger(report.removals) || report.removals < 1) {
		process.stderr.write(
			`\n[${LABEL}] MUTATION IS A NO-OP — the mutant build exited 0 but flattened no declaration body.\n` +
				`  report=${JSON.stringify(report)}\n` +
				'  This is NOT the same verdict as an inert gate: the gate was never put to the test at all.\n',
		);
		process.exit(1);
	}

	const mutant = await driveRungs(MUTANT_DIST, port);
	if (!mutant.ok) {
		process.stderr.write(
			`\n[${LABEL}] WRONG FAILURE SHAPE — the mutant page did not render at all: ${mutant.vacuity}\n` +
				'  A crashed or blank page failing every rung is not evidence the style rung discriminates.\n',
		);
		process.exit(1);
	}
	for (const r of mutant.results) {
		process.stdout.write(`  mutant  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}\n            -> ${r.detail}\n`);
	}

	const target = mutant.results.find((r) => r.id === GAP_RUNG_ID);
	const collateral = mutant.results.filter((r) => r.id !== GAP_RUNG_ID && !r.passed);

	if (!target) {
		process.stderr.write(`\n[${LABEL}] WRONG FAILURE SHAPE — the rung "${GAP_RUNG_ID}" did not run on the mutant leg.\n`);
		process.exit(1);
	}
	if (target.passed) {
		process.stderr.write(
			`\n[${LABEL}] --prove-gap-cues-flattened: the style-divergence rung is inert — a rebuild with the gap-card ` +
				`cue declarations flattened still PASSED "${GAP_RUNG_ID}".\n  detail: ${target.detail}\n`,
		);
		process.exit(1);
	}
	if (collateral.length > 0) {
		process.stderr.write(
			`\n[${LABEL}] WRONG FAILURE SHAPE — the mutation took down rungs it has no business touching: ` +
				`${collateral.map((r) => r.id).join(', ')}\n` +
				collateral.map((r) => `  ${r.id}: ${r.detail}\n`).join(''),
		);
		process.exit(1);
	}

	process.stdout.write(
		`\n[${LABEL}] --prove-gap-cues-flattened PASS — a rebuilt product with the gap-card cue declarations flattened ` +
			`genuinely FAILED "${GAP_RUNG_ID}" while all ${RUNG_IDS.length - 1} other rungs still passed.\n` +
			`  flattened ${report.removals} rule(s): ${JSON.stringify(report.selectors)}\n` +
			`  failure detail: ${target.detail}\n`,
	);
	process.exit(0);
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let proveGapCues = false;
	let port = Number(process.env.RENDER_FIDELITY_PORT ?? DEFAULT_PORT);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') runProveMatchers();
		else if (arg === '--prove-gap-cues-flattened') proveGapCues = true;
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	if (proveGapCues) {
		await runProveGapCuesFlattened(port, skipBuild);
		return;
	}
	if (!skipBuild) await buildGate();
	await driveAndReport(GATE_DIST, port);
}

/**
 * Build/serve/drive one dist and record every rung against it, WITHOUT
 * exiting. Returns a structured outcome so a control can distinguish
 * `vacuous` (the readout never published, the harness recorded an error, the
 * fixture channel is null — i.e. the page did not render at all) from a run
 * that genuinely produced rung verdicts. That distinction is the whole
 * difference between "the mutant leg failed the target rung" and "the mutant
 * leg crashed", and a control that cannot tell them apart reports a pass on
 * a blank page.
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
		const page = await browser.newPage({ viewport: { ...NARROW_VIEWPORT } });
		/** @type {string[]} */
		const console_lines = [];
		page.on('console', (m) => console_lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => console_lines.push(`[pageerror] ${e.message}`));

		const url = `${server.url}/${entryRel}?${FIXTURE_QUERY}`;
		process.stdout.write(`[${LABEL}] viewport ${NARROW_VIEWPORT.width}x${NARROW_VIEWPORT.height}, GET ${url}\n`);
		await page.goto(url, { waitUntil: 'load' });
		await page
			.waitForFunction(() => /** @type {any} */ (globalThis).__UI_GATE_DONE__ === true, null, { timeout: 180_000 })
			.catch(() => {});

		const m = await readPage(page);
		// The store plugin logs one upgrade-blocked warning per table while it
		// declares the schema; they resolve on their own and drowning the rung
		// lines in ~60 of them hides anything that matters. Errors are printed
		// in full; the rest are counted, never silently dropped.
		const loud = console_lines.filter((line) => !line.startsWith('[warning]'));
		for (const line of loud) process.stdout.write(`  ${line}\n`);
		process.stdout.write(`  (${console_lines.length - loud.length} store-upgrade warning(s) suppressed, ${loud.length} other console line(s) shown)\n`);

		// Anti-vacuity, BEFORE any rung. A readout that never published, a
		// harness that recorded a render error, or a fixture channel that is
		// null (the default branch) would make every rung below meaningless
		// rather than failing — so each is a hard stop with its own message.
		const gate = m.gate;
		if (gate === null) bail('the harness never published its readout — the page did not finish, so no rung ran.');
		else if (gate.error !== null) bail(`the harness recorded a render/seed error: ${gate.error}`);
		else {
			const fx = gate.fixture;
			if (fx === null || fx === undefined) bail('the readout carries no fixture channel — the page was not built with the fixture parameter.');
			else if (!Array.isArray(fx.districts) || fx.districts.length === 0) bail('the fixture channel publishes no districts — every data-derived rung would be inert.');
			else if (!Number.isInteger(fx.rollRowCount) || fx.rollRowCount <= 0) bail('the fixture channel publishes no roll row count.');
			else {
				const longestDistrict = [...fx.districts].sort((a, b) => b.length - a.length)[0];

				const fields = evaluateRollFields(m.roll, fx.rollRowCount);
				record('roll-fields-rendered', fields.passed, fields.detail);

				const overflow = evaluateRollOverflow(m.roll, longestDistrict);
				record('roll-overflows-not-clips', overflow.passed, overflow.detail);

				const hidden = evaluateHiddenStrings(m.html, [
					{ label: 'the withheld authority-field marker', needle: fx.extraFieldsMarker },
					{ label: 'the superseded surname', needle: fx.supersededLastName },
					{ label: 'the superseded district', needle: fx.supersededDistrict },
				]);
				record('roll-hides-extrafields-and-superseded', hidden.passed, hidden.detail);

				const escaping = evaluateEscaping(
					{ injectedElementCount: m.roll.injectedElementCount, cellTexts: m.roll.cells.map((c) => c.text) },
					fx.xssLastName,
				);
				record('roll-escapes-authority-text', escaping.passed, escaping.detail);

				// 54-13 DID ship a per-fact hook attribute, so both halves are reported
				// by fact id rather than by ordinal — that can only tighten this rung.
				const keyrelease = evaluateKeyReleaseCard(
					{
						filledMatches: m.filledCards.filter((c) => matchesNumberPair(c.text, fx.released, fx.total)).map((c) => c.id),
						gapMatches: m.gapCards.filter((c) => matchesNumberPair(c.text, fx.released, fx.total)).map((c) => c.id),
						filledTotal: m.filledCards.length,
						gapTotal: m.gapCards.length,
					},
					{ released: fx.released, total: fx.total },
					KEYRELEASE_FACT_ID,
				);
				record('keyrelease-renders-filled-with-nonzero-released', keyrelease.passed, keyrelease.detail);

				// C6/D-24. Denominator is `fx.keyholders`, never `fx.total` -- 60-06
				// mounts the meter with `total={keyRelease.keyholderCount}`. This gate
				// CANNOT discriminate the two while the shipped keyrelease fixture
				// seeds them equal (`EXPECTED_TOTAL === EXPECTED_KEYHOLDERS`); that
				// claim is owned at the source tier by 60-06's own grep-for-`.total`
				// check, not here.
				const meterGeometry = evaluateMeterGeometry(m.meter, { value: fx.released, total: fx.keyholders });
				record('keyrelease-meter-fill-matches-released-ratio', meterGeometry.passed, meterGeometry.detail);

				// C7/D-09. The expectation is built from the harness's OWN `districts`
				// array, never by calling `foldDistrictCounts` -- a defect in the fold
				// cannot hide inside an expectation derived from the fold itself.
				const districtExpectation = deriveDistrictExpectation(fx.districts, SMALL_DISTRICT_THRESHOLD);
				const districtBars = evaluateDistrictBars(m.districtChart, districtExpectation);
				record('roll-district-bars-proportional-and-folded', districtBars.passed, districtBars.detail);

				// D-16/60-13. `maxValue` is derived from the SAME expectation the
				// bars rung above just built -- the largest surviving district
				// count or the folded "other" total, whichever is greater -- never
				// a literal, so a rebalanced fixture moves this expectation with it.
				const numericMax = Math.max(
					districtExpectation.unfolded.reduce((max, e) => Math.max(max, e.count), 0),
					districtExpectation.foldedTotal,
				);
				const integerTicks = evaluateIntegerTicks(m.districtChart.numericTicks, { maxValue: numericMax, axisName: 'district chart numeric axis' });
				record('roll-chart-axis-ticks-are-whole-numbers', integerTicks.passed, integerTicks.detail);

				// Both cards are taken from the SAME rendered section, so the pair
				// differs only in the class, the branch attribute and one copy key —
				// which is what makes the comparison isolate styling from structure.
				if (m.gapStyle === null || m.plainStyle === null) {
					record('gap-card-style-diverges', false, `the outcome section did not render both a gap card and a filled card (gap=${JSON.stringify(m.gapStyle)}, filled=${JSON.stringify(m.plainStyle)})`);
				} else {
					const style = evaluateGapStyleDivergence(m.gapStyle, m.plainStyle);
					record('gap-card-style-diverges', style.passed, `${m.gapStyle.id} vs ${m.plainStyle.id}: ${style.detail}`);
				}
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
 * process exit code. A vacuity bail is a hard failure here, exactly as it was
 * before this function existed.
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
	process.stdout.write(`\nRENDER FIDELITY: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

await main();
