/**
 * facts.js -- the fact/gap model for the public no-login election view
 * (Phase 54: D-11, D-12, D-14, D-16, D-17, D-35).
 *
 * Five things a later reader cannot infer:
 *
 * 1. Lifted from spike 088's `facts.js`, and deliberately NOT verbatim: 088's
 *    own `ALLOWED_TABLES`/`FORBIDDEN_TABLES` arrays are dropped entirely.
 *    54-ISSUES I-04 / 54-RESEARCH Pitfall 7: 088's list still forbids
 *    `RegistrantPublic` and omits `Task` / `ReleaseKeyTaskExtension`, which
 *    contradicts D-15's and D-18's corrections. Two disagreeing allowlists is
 *    exactly the drift D-15's "carve-outs decay" rationale rejects. The
 *    single source of truth for table classification is 54-06's
 *    `classification.js` in `packages/web-data`. Do not reintroduce a table
 *    list here.
 * 2. This module imports NOTHING -- no `react`, no
 *    `@votetorrent/vote-engine/browser`, not even the sibling
 *    `phase-ids.js`. Same invariant `phase-ids.js` declares for itself, and
 *    for the same reason: it must be safe for any consumer to import without
 *    paying for a database engine (measured 0.30-0.44s vs 0.02s bare). The
 *    phase-id literals below are kept in lockstep with `PHASE_IDS` by
 *    `test/facts.test.mjs`, not by an import.
 * 3. The phase ids are `pre`/`voting`/`settling`/`closed` -- spike 086's
 *    `PHASES` (`086-election-phase-derivation/phase.js:51-54`), landed by
 *    54-02 as the one shared implementation under D-06. D-07 drops
 *    `threeBucket()`, which was the only layer mapping these ids onto the
 *    retired `organizing`/`running`/`released` names, so there is exactly
 *    one vocabulary and no mapping table. The correctness reason a later
 *    reader cannot infer: the old `released` opened at `tallyingStarts`,
 *    while the four-phase terminal phase opens at the `closed` event --
 *    reusing that id for a different interval would render "Results
 *    released" while D-13 guarantees no `Tally`/`Certification`/`Validation`
 *    table exists. The `phases` arrays below are therefore carried verbatim
 *    from 088, unremapped, and the `public.headline.*` copy key names use
 *    the same four words.
 * 4. Gap letters `A`-`G` are internal spike vocabulary and must never appear
 *    in a user-facing string (D-12, and the repo's standing rule against
 *    internal identifiers in UI copy). The `gap`, `filledGap` and `source`
 *    fields are provenance for a code reader; the ONLY renderable fields are
 *    `labelKey`, `sentenceKey`, `detailKey` and `emptyKey`.
 * 5. Seven gaps, not eight (D-16). Runoff is an unmodelled concept, not an
 *    unstored fact; it has no entry here and no letter in `GAP_IDS`.
 */

/** @typedef {'electionAndRules' | 'ballot' | 'electorate' | 'outcome'} FactGroup */
/** @typedef {'go' | 'wait' | 'done' | 'bad'} Tone */
/** @typedef {'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'} GapId */
/** @typedef {'pre' | 'voting' | 'settling' | 'closed'} HeadlinePhaseId */

/**
 * The four fact-group headings, UI-SPEC top-to-bottom order. An entry whose
 * `group` is not one of these fails the group-exhaustiveness test rather
 * than defaulting (D-35).
 * @type {ReadonlyArray<FactGroup>}
 */
export const FACT_GROUPS = Object.freeze(['electionAndRules', 'ballot', 'electorate', 'outcome']);

/** The four status tones `headline()` can return. @type {ReadonlyArray<Tone>} */
export const TONES = Object.freeze(['go', 'wait', 'done', 'bad']);

/**
 * 087's enumeration of gaps -- seven, `A` through `G`. No `H` (D-16): runoff
 * is an unmodelled concept, not merely an unstored fact.
 * @type {ReadonlyArray<GapId>}
 */
export const GAP_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

/**
 * The four renderable phase ids `headlineKey` handles explicitly, in
 * `PHASE_IDS` order, excluding the `indeterminate` sentinel. Kept in
 * lockstep with `phase-ids.js`'s `PHASE_IDS` by `test/facts.test.mjs` rung
 * 8 -- not by an import (see header note 2 above).
 * @type {ReadonlyArray<HeadlinePhaseId>}
 */
export const HEADLINE_PHASE_IDS = Object.freeze(['pre', 'voting', 'settling', 'closed']);

/**
 * All four phases, reused by construction (not a second literal) as the
 * `phases` array for every "always present" entry below.
 * @type {ReadonlyArray<HeadlinePhaseId>}
 */
const ALL_PHASES = HEADLINE_PHASE_IDS;

/**
 * Mirrors `phase-ids.js`'s `phaseCopyKey` null-on-unknown shape.
 * @param {string} group
 * @returns {string | null}
 */
export function groupCopyKey(group) {
	return /** @type {ReadonlyArray<string>} */ (FACT_GROUPS).includes(group) ? `public.group.${group}` : null;
}

/**
 * Mirrors `phase-ids.js`'s `phaseCopyKey` null-on-unknown shape.
 * @param {string} tone
 * @returns {string | null}
 */
export function toneCopyKey(tone) {
	return /** @type {ReadonlyArray<string>} */ (TONES).includes(tone) ? `public.tone.${tone}` : null;
}

/**
 * @typedef {Object} FactEntry
 * @property {string} id
 * @property {FactGroup} group
 * @property {ReadonlyArray<HeadlinePhaseId>} phases
 * @property {string} labelKey
 * @property {string | null} sentenceKey
 * @property {string | null} detailKey
 * @property {string | null} emptyKey
 * @property {ReadonlyArray<string> | null} interpolates
 * @property {GapId | null} gap
 * @property {GapId | null} filledGap
 * @property {string | null} source
 */

/**
 * Freezes an entry and its array-typed fields. Every field must be supplied
 * explicitly by the caller (no defaults) so a missing field is a typo a
 * reviewer or `checkJs` catches, never a silently-applied default.
 * @param {FactEntry} entry
 * @returns {Readonly<FactEntry>}
 */
function fact(entry) {
	/** @type {FactEntry} */
	const shaped = {
		...entry,
		phases: Object.freeze([...entry.phases]),
		interpolates: entry.interpolates === null ? null : Object.freeze([...entry.interpolates]),
	};
	return Object.freeze(shaped);
}

/**
 * The fact/gap model, 088's declaration order preserved (D-11), with
 * `registrantRoll` inserted directly after `electorate` (it answers the
 * same "who is eligible" question at higher fidelity, per the UI-SPEC's own
 * rationale). Every field is explicit -- `null` where not applicable.
 * @type {ReadonlyArray<Readonly<FactEntry>>}
 */
export const FACTS = Object.freeze([
	// -- Always present: identity and the verifiable governance trail. --------
	fact({
		id: 'identity',
		group: 'electionAndRules',
		phases: ALL_PHASES,
		labelKey: 'public.fact.identity.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'Election + ElectionRevision + Authority',
	}),
	fact({
		id: 'authority',
		group: 'electionAndRules',
		phases: ALL_PHASES,
		labelKey: 'public.fact.authority.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'Authority + Officer',
	}),
	fact({
		id: 'governance',
		group: 'electionAndRules',
		phases: ALL_PHASES,
		labelKey: 'public.fact.governance.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'AdminSigning + AdminSignature',
	}),
	fact({
		id: 'rules',
		group: 'electionAndRules',
		phases: ALL_PHASES,
		labelKey: 'public.fact.rules.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'ElectionAttestationPolicy + ElectionRecordValidityPolicy + ElectionDisclosurePolicy',
	}),
	fact({
		id: 'timeline',
		group: 'electionAndRules',
		phases: ALL_PHASES,
		labelKey: 'public.fact.timeline.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'ElectionRevision.Timeline (UNCONSTRAINED -- see conflicts)',
	}),

	// -- Phase-specific and genuinely actionable. ------------------------------
	fact({
		id: 'registration',
		group: 'electorate',
		phases: ['pre'],
		labelKey: 'public.fact.registration.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'ElectionRegistrationField + ElectionAttestationPolicy',
	}),
	fact({
		id: 'ballot',
		group: 'ballot',
		phases: ALL_PHASES,
		labelKey: 'public.fact.ballot.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'Ballot + Question + Option',
	}),
	fact({
		id: 'polls',
		group: 'ballot',
		phases: ['voting'],
		labelKey: 'public.fact.polls.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'derived from Timeline (votingStarts -> tallyingStarts)',
	}),
	fact({
		id: 'electorate',
		group: 'electorate',
		phases: ALL_PHASES,
		labelKey: 'public.fact.electorate.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'count(ElectionRegistrant) -- AGGREGATE only',
	}),
	// D-18: the named-fields roll, at higher fidelity than the `electorate`
	// aggregate above. A DECLARATION only -- no query, no field-selection
	// logic (both belong to 54-06's read and 54-14's render). `ExtraFields`
	// is never read and never rendered (D-19); `RegistrantSelective` is out
	// of scope (D-22) -- neither identifier appears anywhere in this module.
	fact({
		id: 'registrantRoll',
		group: 'electorate',
		phases: ALL_PHASES,
		labelKey: 'public.registrantRoll.heading',
		sentenceKey: 'public.registrantRoll.body',
		detailKey: 'public.registrantRoll.disclaimer',
		emptyKey: 'public.registrantRoll.empty',
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'RegistrantPublic (LastName, FirstName, District only)',
	}),
	fact({
		id: 'keyholders',
		group: 'outcome',
		phases: ALL_PHASES,
		labelKey: 'public.fact.keyholders.label',
		sentenceKey: null,
		detailKey: null,
		emptyKey: null,
		interpolates: null,
		gap: null,
		filledGap: null,
		source: 'Keyholder + ElectionRevision.KeyholderThreshold',
	}),

	// -- The gaps. Each cites spike 087's enumeration; NONE of these has a
	// table. 088's literal "why" prose is moved into a comment here -- it is
	// the provenance a code reader wants and exactly the renderable English
	// this module must not carry (only `sentenceKey`/`detailKey` render).
	// Gap A (087): no Vote or VoteEntry table exists -- vote and voter
	// entries live in negotiated blocks the schema does not model.
	fact({
		id: 'turnout',
		group: 'outcome',
		phases: ['voting', 'settling', 'closed'],
		labelKey: 'public.fact.turnout.label',
		sentenceKey: 'public.gap.turnout.sentence',
		detailKey: 'public.gap.turnout.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'A',
		filledGap: null,
		source: null,
	}),
	// Gap B (087): the vote nonce is held privately by the voter; there is
	// nothing on the network to check it against.
	fact({
		id: 'receipt',
		group: 'outcome',
		phases: ['settling', 'closed'],
		labelKey: 'public.fact.receipt.label',
		sentenceKey: 'public.gap.receipt.sentence',
		detailKey: 'public.gap.receipt.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'B',
		filledGap: null,
		source: null,
	}),
	// Gap C (087): no Block or MerkleNode table exists; doc/election.md
	// still asks "Where is this stored and cached?".
	fact({
		id: 'merkle',
		group: 'outcome',
		phases: ['settling', 'closed'],
		labelKey: 'public.fact.merkle.label',
		sentenceKey: 'public.gap.merkle.sentence',
		detailKey: 'public.gap.merkle.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'C',
		filledGap: null,
		source: null,
	}),
	// Gap D (087), FILLED not gapped (D-14): Keyholder records WHO holds a
	// key; only ReleaseKeyTaskExtension traces WHETHER it was released, and
	// Task.IsCompleted (per D-15/I-07) is what is counted. The
	// `released`/`total` values are supplied by the shell from the
	// `@votetorrent/web-data/public` read (54-06) and interpolated at render
	// time via `t()`'s `{{name}}` mechanism -- this module never acquires a
	// read dependency of its own.
	fact({
		id: 'keyrelease',
		group: 'outcome',
		phases: ['settling'],
		labelKey: 'public.fact.keyrelease.label',
		sentenceKey: 'public.fact.keyrelease.sentence',
		detailKey: 'public.fact.keyrelease.detail',
		emptyKey: null,
		interpolates: ['released', 'total'],
		gap: null,
		filledGap: 'D',
		source: 'Task ⋈ ReleaseKeyTaskExtension (IsCompleted counts only, D-14/D-15, I-07)',
	}),
	// Gap E (087): no Tally table exists; doc/election.md still asks "How is
	// this coordinated?".
	fact({
		id: 'results',
		group: 'outcome',
		phases: ['settling', 'closed'],
		labelKey: 'public.fact.results.label',
		sentenceKey: 'public.gap.results.sentence',
		detailKey: 'public.gap.results.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'E',
		filledGap: null,
		source: null,
	}),
	// Gap F (087): no Validation table, and no error-margin statistic
	// anywhere.
	fact({
		id: 'validation',
		group: 'outcome',
		phases: ['settling', 'closed'],
		labelKey: 'public.fact.validation.label',
		sentenceKey: 'public.gap.validation.sentence',
		detailKey: 'public.gap.validation.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'F',
		filledGap: null,
		source: null,
	}),
	// Gap G (087): no Certification table exists; each ballot authority is
	// meant to publish a signed outcome certification, but nothing stores
	// it.
	fact({
		id: 'certification',
		group: 'outcome',
		phases: ['closed'],
		labelKey: 'public.fact.certification.label',
		sentenceKey: 'public.gap.certification.sentence',
		detailKey: 'public.gap.certification.detail',
		emptyKey: null,
		interpolates: null,
		gap: 'G',
		filledGap: null,
		source: null,
	}),
]);

/**
 * Facts visible in a phase, in `FACTS` declaration order (D-11) -- gap cards
 * stay beside the facts they belong to. Never throws; an unrecognised phase
 * yields an empty array.
 * @param {string} phase
 * @returns {ReadonlyArray<Readonly<FactEntry>>}
 */
export function factsFor(phase) {
	return FACTS.filter((f) => /** @type {ReadonlyArray<string>} */ (f.phases).includes(phase));
}

// The canonical 19-character `YYYY-MM-DDTHH:MM:SS` form, declared locally
// (this module imports nothing, so `toCanonicalDatetime` is not available).
// `Date.parse` and `new Date` are BANNED in this file, exactly as in
// `election-phase.js` -- callers must pass already-normalised values.
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isCanonicalInstant(value) {
	return typeof value === 'string' && CANONICAL_INSTANT_RE.test(value);
}

/**
 * @typedef {Object} HeadlineOpts
 * @property {string | null} [registrationEndsCanonical]
 * @property {string | null} [atCanonical]
 */

/**
 * The headline's textKey/tone, pure -- no `t`. Total over every phase the
 * shared model can derive, including the two D-10 "cannot read" states
 * (`indeterminate` and any unrecognised value): both say so explicitly
 * (`public.headline.unknown` / `bad`) rather than rendering nothing, unlike
 * `LifecyclePill`. The schedule cannot be read, so the phase is unknown --
 * that is the whole D-10 state, restated here for `headline()`'s own
 * consumers.
 * @param {HeadlinePhaseId | 'indeterminate' | string | null} phase
 * @param {HeadlineOpts} [opts]
 * @returns {{ textKey: string, tone: Tone }}
 */
export function headlineKey(phase, opts = {}) {
	const { registrationEndsCanonical = null, atCanonical = null } = opts;
	switch (phase) {
		case 'pre': {
			if (isCanonicalInstant(atCanonical) && isCanonicalInstant(registrationEndsCanonical)) {
				return atCanonical < registrationEndsCanonical
					? { textKey: 'public.headline.pre.registrationOpen', tone: 'go' }
					: { textKey: 'public.headline.pre.registrationClosed', tone: 'wait' };
			}
			// Never-guess (election-phase.js's own header rule, restated here):
			// either value is missing or non-canonical, so this is an unusable
			// input, not a "closed" answer -- 088 collapsed this into "closed",
			// which is a guess this repo's derivation rule forbids.
			return { textKey: 'public.headline.pre.registrationUnknown', tone: 'wait' };
		}
		case 'voting':
			return { textKey: 'public.headline.voting', tone: 'go' };
		case 'settling':
			return { textKey: 'public.headline.settling', tone: 'wait' };
		case 'closed':
			return { textKey: 'public.headline.closed', tone: 'done' };
		default:
			return { textKey: 'public.headline.unknown', tone: 'bad' };
	}
}

/**
 * D-17: `{ text, tone }`, text produced only by the injected `t` -- never an
 * import, which is what keeps this module dependency-free while still
 * routing every sentence through `t()`'s throw-on-unknown-key guard. A
 * missing key is a loud render failure by design; this function does not
 * catch it.
 * @param {HeadlinePhaseId | 'indeterminate' | string | null} phase
 * @param {HeadlineOpts} opts
 * @param {(key: string) => string} t
 * @returns {{ text: string, tone: Tone }}
 */
export function headline(phase, opts, t) {
	const { textKey, tone } = headlineKey(phase, opts);
	return { text: t(textKey), tone };
}

/**
 * @param {string | null} value
 * @returns {value is string}
 */
function isNonNullKey(value) {
	return value !== null;
}

/**
 * The seven distinct textKeys `headlineKey` can return, listed once so
 * `FACT_COPY_KEYS`'s derivation below is total rather than re-deriving them
 * ad hoc.
 * @type {ReadonlyArray<string>}
 */
const HEADLINE_TEXT_KEYS = Object.freeze([
	'public.headline.pre.registrationOpen',
	'public.headline.pre.registrationClosed',
	'public.headline.pre.registrationUnknown',
	'public.headline.voting',
	'public.headline.settling',
	'public.headline.closed',
	'public.headline.unknown',
]);

/**
 * Every `public.*` key this module can emit -- frozen, de-duplicated,
 * sorted. This is the contract 54-09 authors against (every key here must
 * exist in `COPY` by the end of wave 3) and 54-13/54-14 gate against.
 * @type {ReadonlyArray<string>}
 */
export const FACT_COPY_KEYS = Object.freeze(
	Array.from(
		new Set(
			[
				...FACTS.flatMap((f) => [f.labelKey, f.sentenceKey, f.detailKey, f.emptyKey]),
				...FACT_GROUPS.map((g) => groupCopyKey(g)),
				...TONES.map((tn) => toneCopyKey(tn)),
				...HEADLINE_TEXT_KEYS,
			].filter(isNonNullKey),
		),
	).sort(),
);
