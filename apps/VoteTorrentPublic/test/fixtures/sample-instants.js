/**
 * sample-instants.js — TEST-ONLY. D-25's derived-instant machinery: a
 * fixture-construction helper that computes its sample set ARITHMETICALLY
 * from the timeline it is handed, never as a hand-picked literal. Plain JS,
 * dependency-free, frozen exports, zero imports from `src/` — same charter
 * as `election-fixture.js`. Imports NOTHING: no `@votetorrent/ui-web`, no
 * `@votetorrent/vote-engine`, no `node:` module.
 *
 * THE MOST IMPORTANT RULE IN THIS FILE: `expectedPhase` is computed here by
 * this module's OWN interval-membership arithmetic, and MUST NEVER be
 * obtained by calling `derivePhase`. A fixture that asks the code under
 * test what the right answer is proves nothing — the whole value of this
 * helper is that it is an INDEPENDENT oracle.
 *
 * Contrast with `derivePhase`'s never-throw discipline, deliberately:
 * `derivePhase` is a renderer facing hostile authority data and must always
 * produce something honest for it. This module is a fixture-construction
 * TOOL facing test authors, and a silently-degraded sample set is exactly
 * the failure D-25 exists to prevent — so this module THROWS, loudly and by
 * name, on any input it cannot use, rather than degrading.
 */

/**
 * The smallest step that survives canonicalisation: VoteTorrent's canonical
 * datetime is 19 characters with one-second resolution, so a finer step
 * would produce two instants that serialise to the SAME string, and the
 * "one step either side" sample would silently collapse onto the boundary.
 * @type {number}
 */
export const STEP_MS = 1000;

/**
 * The three internal boundaries `deriveSampleInstants` samples around, in
 * chronological order — the three openers the four-phase walk consults; the
 * other four `ELECTION_EVENT_ORDER` members are stage markers, not phase
 * boundaries.
 * @type {ReadonlyArray<string>}
 */
const BOUNDARY_KEYS = Object.freeze(['votingStarts', 'tallyingStarts', 'closed']);

/** T-only, no-`Z`, 19-character canonical form. */
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * Parse a canonical 19-character, no-`Z` datetime as UTC EXPLICITLY,
 * mirroring 086's `normalizeInstant` — never a bare `new Date(value)`, which
 * would parse the un-anchored string in the runner's own local zone.
 * Throws, naming both `label` and the offending value, rather than
 * degrading.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function parseCanonicalUtc(value, label) {
	if (typeof value !== 'string' || !CANONICAL_RE.test(value)) {
		throw new Error(
			`deriveSampleInstants: "${label}" must be a canonical 19-character datetime with no "Z" suffix, ` +
				`got ${JSON.stringify(value)} (${typeof value})`,
		);
	}
	const ms = Date.parse(`${value}Z`);
	if (!Number.isFinite(ms)) {
		throw new Error(`deriveSampleInstants: "${label}" (${value}) did not parse to a usable instant`);
	}
	return ms;
}

/**
 * Serialise epoch-ms back to the canonical 19-character, no-`Z` form.
 * @param {number} ms
 * @returns {string}
 */
function toCanonical(ms) {
	return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Derive D-25's sample set from `timeline`: 4 interval midpoints plus each
 * of the 3 internal boundaries sampled at (boundary − STEP_MS, boundary,
 * boundary + STEP_MS) = 4 + 3*3 = 13 entries, arithmetically DERIVED, never
 * a hand-written literal. Returns a frozen, chronologically ordered array of
 * frozen `{ label, at, kind, expectedPhase }` entries.
 *
 * Accepts ONLY an already-parsed timeline object — unlike `derivePhase`,
 * which must tolerate whatever the column holds, a fixture-construction
 * tool handed the wrong shape should say so rather than guess (see the
 * throw list below, and the object-only contract this enforces).
 *
 * @param {unknown} timeline
 * @returns {ReadonlyArray<Readonly<{ label: string, at: string, kind: string, expectedPhase: string }>>}
 */
export function deriveSampleInstants(timeline) {
	if (timeline === null || typeof timeline !== 'object' || Array.isArray(timeline)) {
		throw new Error(
			`deriveSampleInstants: "timeline" must be an already-parsed object, got ${typeof timeline}` +
				(typeof timeline === 'string' ? ' (a JSON string is not accepted here -- parse it first)' : ''),
		);
	}
	const record = /** @type {Record<string, unknown>} */ (timeline);

	const [votingStarts, tallyingStarts, closed] = BOUNDARY_KEYS.map((key) => parseCanonicalUtc(record[key], key));

	if (!(votingStarts < tallyingStarts && tallyingStarts < closed)) {
		throw new Error(
			`deriveSampleInstants: the three boundaries must be strictly increasing ` +
				`(votingStarts=${toCanonical(votingStarts)}, tallyingStarts=${toCanonical(tallyingStarts)}, closed=${toCanonical(closed)})`,
		);
	}

	// The last guard is what prevents a midpoint colliding with a
	// boundary±step sample and silently shrinking the set.
	const votingSpan = tallyingStarts - votingStarts;
	const settlingSpan = closed - tallyingStarts;
	if (votingSpan < 4 * STEP_MS) {
		throw new Error(
			`deriveSampleInstants: the voting interval [votingStarts, tallyingStarts) is narrower than ${4 * STEP_MS}ms (got ${votingSpan}ms)`,
		);
	}
	if (settlingSpan < 4 * STEP_MS) {
		throw new Error(
			`deriveSampleInstants: the settling interval [tallyingStarts, closed) is narrower than ${4 * STEP_MS}ms (got ${settlingSpan}ms)`,
		);
	}

	/**
	 * Computed by THIS module's own interval-membership arithmetic -- never
	 * by calling `derivePhase`. See this file's header for why.
	 * @param {number} ms
	 * @returns {string}
	 */
	function expectedPhaseAt(ms) {
		if (ms < votingStarts) return 'pre';
		if (ms < tallyingStarts) return 'voting';
		if (ms < closed) return 'settling';
		return 'closed';
	}

	/** @type {Array<{ label: string, at: number, kind: string }>} */
	const raw = [];

	// Interval midpoints (4). `voting`/`settling` are bounded, so their
	// midpoints are the arithmetic mean of their two edges, floored to a
	// whole second. `pre`/`closed` are unbounded on one side and have no
	// literal midpoint; their synthetic edge is derived from the timeline's
	// own known extent (`span = closed - votingStarts`) -- the ONE place a
	// choice is made, and it is still DERIVED: no literal instant is ever
	// written down.
	const span = closed - votingStarts;
	raw.push({ label: 'midpoint:pre', at: Math.floor(votingStarts - span / 2), kind: 'midpoint' });
	raw.push({ label: 'midpoint:voting', at: Math.floor((votingStarts + tallyingStarts) / 2), kind: 'midpoint' });
	raw.push({ label: 'midpoint:settling', at: Math.floor((tallyingStarts + closed) / 2), kind: 'midpoint' });
	raw.push({ label: 'midpoint:closed', at: Math.floor(closed + span / 2), kind: 'midpoint' });

	// Boundary neighbourhoods (9). The boundary instant ITSELF is the
	// load-bearing member of this group: the derivation rule is
	// `now >= boundary`, so the boundary is the exact off-by-one this
	// sample exists to catch -- nobody should later "simplify" it away.
	/** @type {ReadonlyArray<readonly [string, number]>} */
	const boundaries = [
		['votingStarts', votingStarts],
		['tallyingStarts', tallyingStarts],
		['closed', closed],
	];
	for (const [key, boundaryMs] of boundaries) {
		raw.push({ label: `boundary-minus-step:${key}`, at: boundaryMs - STEP_MS, kind: 'boundary-minus-step' });
		raw.push({ label: `boundary:${key}`, at: boundaryMs, kind: 'boundary' });
		raw.push({ label: `boundary-plus-step:${key}`, at: boundaryMs + STEP_MS, kind: 'boundary-plus-step' });
	}

	raw.sort((a, b) => a.at - b.at);

	return Object.freeze(
		raw.map((entry) =>
			Object.freeze({
				label: entry.label,
				at: toCanonical(entry.at),
				kind: entry.kind,
				expectedPhase: expectedPhaseAt(entry.at),
			}),
		),
	);
}
