/**
 * chart-geometry-fixtures.js — the single source of the production-length
 * fixtures `chart-geometry-gate.tsx` (the page) and `run-chart-geometry-gate.mjs`
 * (the Node driver) both import (60-07, D-24). Because both sides read the
 * SAME module, the page can never publish its own expectation for the driver
 * to trivially agree with — `checkVacuity` cross-checks `FIXTURE_META`
 * against this module's own exports before any rung runs.
 *
 * Plain ESM, no JSX, no TypeScript syntax — JSDoc types only, so this file
 * loads unchanged in the Vite-built browser page and under a bare `node
 * --test` run with no transform.
 *
 * `TOOLTIP_COPY_KEYS` names the two copy keys the page composes tooltip text
 * through (60-12) — this module holds only the key NAMES, never a rendered
 * sentence, so the page and the driver read the same key names from one
 * module and neither can drift into authoring its own English.
 *
 * FIXTURE DATA RULE (T-60-07-02, a security property, not a style note):
 * this module holds aggregate counts and schema enum names ONLY. No
 * registrant identifier, no person name, no district, no address, and none
 * of the schema's own private/payload/content-hash column names.
 * `chart-geometry-harness.test.mjs` enforces the exact banned-name list by
 * its own separate constant, with its own planted positive control — not
 * repeated here verbatim, so this header cannot itself trip that scan.
 *
 * Every planted zero is deliberate — it is the ANTI-VACUITY control each
 * geometry comparator in `run-chart-geometry-gate.mjs` requires be present,
 * named per-fixture below.
 */

/**
 * @typedef {{ key: string, label: string, value: number, tone?: 'series-1' | 'series-2' | 'ok' | 'warn' | 'fail', tooltip?: string }} ChartDatum
 * @typedef {{ seriesKey: string, value: number, tooltip?: string }} StackedSegment
 * @typedef {{ key: string, label: string, segments: StackedSegment[] }} StackedDatum
 * @typedef {{ key: string, label: string, tone: 'series-1' | 'series-2' | 'ok' | 'warn' | 'fail' }} ChartSeries
 * @typedef {{ id: string, value: number, total: number }} MeterFixture
 */

/**
 * C1 — the status bars. `RegistrantStatus` codes (`a`/`s`/`r`) reproduced
 * verbatim from `packages/vote-core/schema/votetorrent.qsql:1750-1753`. The
 * `r`/Revoked zero is C1's planted positive control: a proportionality
 * comparator that passes on all three bars regardless of value would be
 * vacuous, and it is also the D-16 "does a zero-count status still get a
 * bar" case. The two non-zero values are deliberately distinct and
 * four-digit-versus-three-digit so the thousands separator is exercised and
 * equal-height bars cannot pass a proportionality test by accident.
 * @type {ReadonlyArray<ChartDatum>}
 */
export const STATUS_FIXTURE = Object.freeze([
	Object.freeze({ key: 'a', label: 'Active', value: 1847, tone: 'ok' }),
	Object.freeze({ key: 's', label: 'Suspended', value: 612, tone: 'warn' }),
	Object.freeze({ key: 'r', label: 'Revoked', value: 0, tone: 'fail' }),
]);

/**
 * C2 — the stacked request bars. `RegistrationRequestStatus` codes (`p`/`a`/`r`)
 * reproduced verbatim from `packages/vote-core/schema/votetorrent.qsql:1438-1441`,
 * in the schema's own code order (the real read carries no `order by`). Each
 * category carries both `registrant` and `bridge` segments; Rejected's
 * `bridge` segment is C2's planted positive control — a zero-valued segment
 * that must measure zero height while its category's sum assertion still
 * holds.
 * @type {ReadonlyArray<StackedDatum>}
 */
export const REQUEST_FIXTURE = Object.freeze([
	Object.freeze({
		key: 'p',
		label: 'Pending',
		segments: [
			Object.freeze({ seriesKey: 'registrant', value: 1263 }),
			Object.freeze({ seriesKey: 'bridge', value: 418 }),
		],
	}),
	Object.freeze({
		key: 'a',
		label: 'Approved',
		segments: [
			Object.freeze({ seriesKey: 'registrant', value: 902 }),
			Object.freeze({ seriesKey: 'bridge', value: 77 }),
		],
	}),
	Object.freeze({
		key: 'r',
		label: 'Rejected',
		segments: [
			Object.freeze({ seriesKey: 'registrant', value: 145 }),
			Object.freeze({ seriesKey: 'bridge', value: 0 }),
		],
	}),
]);

/**
 * The two `ChartSeries` C2's stacked bars are keyed by.
 * @type {ReadonlyArray<ChartSeries>}
 */
export const REQUEST_SERIES = Object.freeze([
	Object.freeze({ key: 'registrant', label: 'Registrant', tone: 'series-1' }),
	Object.freeze({ key: 'bridge', label: 'Bridge', tone: 'series-2' }),
]);

/**
 * The copy keys `chart-geometry-gate.tsx` composes C1/C2 tooltip text
 * through, via `t()` — mirroring `RegistrationsPanel.tsx`'s `toStatusData`/
 * `toRequestData` exactly (60-12). Naming them here, once, means the page and
 * `run-chart-geometry-gate.mjs`'s comparators can never disagree about which
 * key was rendered. Tooltip text is COMPOSED by the page through `t()` and is
 * never stored in this module.
 * @type {{ statusChart: string, requestChart: string }}
 */
export const TOOLTIP_COPY_KEYS = Object.freeze({
	statusChart: 'panels.registrations.statusChart.tooltip',
	requestChart: 'panels.registrations.requestChart.tooltip',
});

/**
 * C3 — the intake time series. Ten consecutive-hour buckets, each `label`
 * the full 19-character `strftime('%Y-%m-%dT%H:00:00', …)` boundary Quereus
 * returns — no trailing `Z`, because that expression yields a 19-character
 * value without one. Counts at index 2 (`10:00:00`) and index 8
 * (`16:00:00`) are zero — deliberately INTERIOR empty buckets, C3's planted
 * positive control: a gap-rendering implementation (one that filters zero
 * rows, or sets `connectNulls`) cannot pass a mark-count-equals-bucket-count
 * rung against this fixture.
 * @type {ReadonlyArray<ChartDatum>}
 */
export const INTAKE_FIXTURE = Object.freeze(
	/** @type {ReadonlyArray<ChartDatum>} */ (
		[
			['2026-09-15T08:00:00', 37],
			['2026-09-15T09:00:00', 52],
			['2026-09-15T10:00:00', 0],
			['2026-09-15T11:00:00', 64],
			['2026-09-15T12:00:00', 91],
			['2026-09-15T13:00:00', 128],
			['2026-09-15T14:00:00', 73],
			['2026-09-15T15:00:00', 46],
			['2026-09-15T16:00:00', 0],
			['2026-09-15T17:00:00', 19],
		].map(([bucketStart, count]) => Object.freeze({ key: String(bucketStart), label: String(bucketStart), value: Number(count) }))
	),
);

/**
 * C5 — the keyholders meters. Three entries covering both extremes (60-VALIDATION's
 * own naming) plus an interior point: `zero` (0/12), `partial` (7/12, interior),
 * `full` (12/12). The harness builds each `valueLabel` as `${value} / ${total}`
 * — the slash form `60-04` settled on, not the UI-SPEC's "N of M" wording,
 * because "of" would be authored prose with no copy key.
 * @type {ReadonlyArray<MeterFixture>}
 */
export const METER_FIXTURES = Object.freeze([
	Object.freeze({ id: 'zero', value: 0, total: 12 }),
	Object.freeze({ id: 'partial', value: 7, total: 12 }),
	Object.freeze({ id: 'full', value: 12, total: 12 }),
]);

/**
 * SMALL_COUNT_FIXTURE — 60-13. Whole purpose: keep the tick-VALUE rung
 * (`numeric-axis-ticks-are-whole-numbers`) non-vacuous. A maximum of 3 or
 * less is the condition under which Recharts' nice-number tick algorithm
 * reaches for a fractional subdivision — the three fixtures above count in
 * the hundreds/thousands and could never reach that condition, exactly why
 * 60-UAT test 11 was invisible on the officer dashboard. Covers the three
 * officer-side numeric axes Task 1's public-side fix (BarSeries's horizontal
 * XAxis) does not exercise: BarSeries's vertical YAxis, StackedBarSeries's
 * YAxis and TimeSeries's YAxis.
 *
 * Names and labels are schema enum names and bucket boundaries ONLY, per this
 * module's own FIXTURE DATA RULE (T-60-07-02) — `chart-geometry-harness.test.mjs`
 * rung (6) scans this module against `BANNED_FIELD_RE`.
 */

/**
 * The vertical bar probe. `RegistrantStatus` codes, reused from
 * `STATUS_FIXTURE` above at counts small enough to be non-vacuous: 3/1/0.
 * The zero keeps this module's own "absent vs zero" discipline (a real bar
 * fixture always plants a zero-valued category).
 * @type {ReadonlyArray<ChartDatum>}
 */
export const SMALL_COUNT_BAR_FIXTURE = Object.freeze([
	Object.freeze({ key: 'a', label: 'Active', value: 3, tone: 'ok' }),
	Object.freeze({ key: 's', label: 'Suspended', value: 1, tone: 'warn' }),
	Object.freeze({ key: 'r', label: 'Revoked', value: 0, tone: 'fail' }),
]);

/**
 * The stacked-bar probe. Two `RegistrationRequestStatus` categories, each
 * carrying both `REQUEST_SERIES` segments, whose largest COLUMN TOTAL is 3
 * (2 + 1) — small enough to reach a fractional tick, non-zero on both
 * segments across the two categories.
 * @type {ReadonlyArray<StackedDatum>}
 */
export const SMALL_COUNT_STACKED_FIXTURE = Object.freeze([
	Object.freeze({
		key: 'p',
		label: 'Pending',
		segments: [
			Object.freeze({ seriesKey: 'registrant', value: 2 }),
			Object.freeze({ seriesKey: 'bridge', value: 1 }),
		],
	}),
	Object.freeze({
		key: 'a',
		label: 'Approved',
		segments: [
			Object.freeze({ seriesKey: 'registrant', value: 0 }),
			Object.freeze({ seriesKey: 'bridge', value: 1 }),
		],
	}),
]);

/**
 * The time-series probe. Four consecutive-hour buckets, same 19-character
 * boundary shape `INTAKE_FIXTURE` uses, maximum 2 with one INTERIOR zero
 * (index 1) — mirroring `INTAKE_FIXTURE`'s own planted-zero discipline at a
 * small enough scale to reach a fractional tick.
 * @type {ReadonlyArray<ChartDatum>}
 */
export const SMALL_COUNT_TIME_FIXTURE = Object.freeze(
	/** @type {ReadonlyArray<ChartDatum>} */ (
		[
			['2026-09-15T08:00:00', 1],
			['2026-09-15T09:00:00', 0],
			['2026-09-15T10:00:00', 2],
			['2026-09-15T11:00:00', 1],
		].map(([bucketStart, count]) => Object.freeze({ key: String(bucketStart), label: String(bucketStart), value: Number(count) }))
	),
);

/**
 * Each small-count probe's OWN real maximum, computed FROM its fixture array
 * rather than hand-written, so a per-probe bound can never silently drift out
 * of sync if a fixture's values change (60-REVIEW-2 CR-01). A single SHARED
 * bound across all three probes is what let a tick of 3 on the time-series
 * probe (real max 2) pass `evaluateIntegerTicks`'s `largest > maxValue` check
 * one unit too loosely — this module now names each probe's bound
 * separately.
 * @type {number}
 */
export const SMALL_COUNT_BAR_MAX = Math.max(...SMALL_COUNT_BAR_FIXTURE.map((d) => d.value));

/** @type {number} */
export const SMALL_COUNT_STACKED_MAX = Math.max(
	...SMALL_COUNT_STACKED_FIXTURE.map((d) => d.segments.reduce((sum, seg) => sum + seg.value, 0)),
);

/** @type {number} */
export const SMALL_COUNT_TIME_MAX = Math.max(...SMALL_COUNT_TIME_FIXTURE.map((d) => d.value));

/**
 * The largest value across all three SMALL_COUNT_FIXTURE arrays -- retained
 * for callers that need ONE shared figure (e.g. the matcher control that
 * proves a shared bound would be vacuous against a large-count fixture).
 * NEVER the per-probe bound `evaluateNumericAxisTicksAcrossProbes` enforces
 * -- that per-probe distinction is exactly what CR-01 fixed.
 * @type {number}
 */
export const SMALL_COUNT_MAX = Math.max(SMALL_COUNT_BAR_MAX, SMALL_COUNT_STACKED_MAX, SMALL_COUNT_TIME_MAX);

/**
 * The `data-chart-geometry` attribute values the three probe charts mount
 * under, in the order the driver reads them.
 * @type {ReadonlyArray<string>}
 */
export const SMALL_COUNT_PROBE_IDS = Object.freeze(['ticks-vertical-bar', 'ticks-stacked-bar', 'ticks-time-series']);

/**
 * Echoed by the page's readout so the driver can prove it is asserting
 * against the SAME fixture revision it renders — never a copy that has
 * silently drifted. `panelColumnWidthPx` is 420: above `NARROW_CONTAINER_PX`
 * (400), so the six-tick branch applies. The 280px narrow branch is a
 * judgement call and is 60-09's screenshot review, not a rung here.
 * @type {{ version: number, panelColumnWidthPx: number, statusCount: number, requestCategoryCount: number, intakeBucketCount: number, meterCount: number, registrationsCapabilityId: string, keyholdersCapabilityId: string, smallCountMax: number, smallCountBarMax: number, smallCountStackedMax: number, smallCountTimeMax: number, smallCountProbeIds: ReadonlyArray<string> }}
 */
export const FIXTURE_META = Object.freeze({
	version: 4,
	panelColumnWidthPx: 420,
	statusCount: STATUS_FIXTURE.length,
	requestCategoryCount: REQUEST_FIXTURE.length,
	intakeBucketCount: INTAKE_FIXTURE.length,
	meterCount: METER_FIXTURES.length,
	registrationsCapabilityId: 'registrations',
	keyholdersCapabilityId: 'keyholders',
	smallCountMax: SMALL_COUNT_MAX,
	smallCountBarMax: SMALL_COUNT_BAR_MAX,
	smallCountStackedMax: SMALL_COUNT_STACKED_MAX,
	smallCountTimeMax: SMALL_COUNT_TIME_MAX,
	smallCountProbeIds: SMALL_COUNT_PROBE_IDS,
});
