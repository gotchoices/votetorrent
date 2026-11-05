/**
 * fact-groups.js — the pure grouping/ordering logic behind the fact body
 * (D-11, D-35). No React, no DOM, no database, no import of anything under
 * `test/`. Its only bare specifier is `@votetorrent/ui-web/facts`.
 *
 * Four things a later reader cannot infer:
 *
 * 1. WHY THIS IS A `.js` SIBLING RATHER THAN LIVING INSIDE `FactSections.tsx`.
 *    So the group order, the declaration order and the fails-never-defaults
 *    behaviour are provable by a tier-1 `node --test` file with no browser, no
 *    JSX transform and no DOM. `election-address.js` plus
 *    `election-address.test.mjs` is the precedent this file follows exactly:
 *    the decision lives in plain JS, the render layer only consumes it. A
 *    guarantee that can only be checked by matching JSX source text is a
 *    guarantee that is not really checked.
 *
 * 2. WHY `ElectionShell.tsx` MUST NOT ABSORB THIS. That file is held to
 *    EXACTLY ONE `return` statement by `test/node/election-shell.test.mjs`
 *    case 1. That rule is not style — it is what makes `AdvisoryDisclosure`
 *    and `DetailsToggle` structurally unbranchable: the moment the shell can
 *    take a second return, the advisory can sit inside a conditional and be
 *    hidden. Any helper carrying its own `return` therefore belongs in a
 *    different file, permanently. This one carries several.
 *
 * 3. D-11: gaps render INLINE in declaration order, so a gap card sits beside
 *    the fact it belongs to (turnout next to polls). A separate "not yet
 *    available" section was explicitly REJECTED, because severing that
 *    adjacency lets a reader skim the page and never meet the absence at the
 *    point where they were forming a belief about the thing it qualifies.
 *    `factsFor` already preserves declaration order; this module's job is to
 *    bucket WITHOUT re-sorting, which is why nothing below ever sorts.
 *
 * 4. D-35: an unknown or missing group FAILS rather than defaulting. The
 *    reason a later reader cannot infer: a defaulted bucket would silently
 *    RELOCATE a fact a reader is looking for — the electorate count filed
 *    under the ballot, say — and that failure is invisible to every gate that
 *    only counts cards. The card count is identical either way. So the throw
 *    is the only place the mistake is observable at all.
 *
 * ERROR HYGIENE: `FactGroupingError`'s message names the offending fact's
 * `id` and the offending group's VALUE SHAPE (its `typeof`), never any row
 * content — the repo's standing rule that an error names the error class,
 * never the data.
 *
 * This module returns copy KEYS, never copy. There is no English sentence
 * anywhere in it, and `scripts/lint-copy.mjs` is what keeps that true.
 */

import { FACT_GROUPS, factsFor, groupCopyKey } from '@votetorrent/ui-web/facts';

/**
 * Raised when a fact declares a group the model does not know about, or no
 * group at all. Named rather than anonymous so a caller can discriminate it
 * from an engine or render failure by `name` — the same discipline
 * `public-election-source.js` header point 5 records, and for the same
 * reason: `nmHoistingLimits: workspaces` makes `instanceof` an unreliable
 * discriminator across package boundaries.
 */
export class FactGroupingError extends Error {
	/**
	 * @param {string} message
	 */
	constructor(message) {
		super(message);
		this.name = 'FactGroupingError';
	}
}

/**
 * @typedef {object} FactGroupBucket
 * @property {string} group - a `FACT_GROUPS` member.
 * @property {string} headingKey - the `public.group.*` copy key for that group.
 * @property {ReadonlyArray<any>} facts - the group's facts, in `FACTS` declaration order.
 */

/** The one shape with no variable part. Frozen once and returned for every
 * empty-phase path, so a caller cannot mutate the empty answer.
 * @type {ReadonlyArray<Readonly<FactGroupBucket>>} */
const EMPTY_GROUPS = Object.freeze([]);

/**
 * Group an EXPLICIT fact list. Exported on purpose: this is the path
 * `fact-sections.test.mjs` rung 6 runs its planted-violation control
 * through, so the control exercises the real implementation rather than a
 * duplicate of it. A control over a copy proves nothing about the original.
 *
 * @param {ReadonlyArray<any>} facts facts already in `FACTS` declaration order.
 * @returns {ReadonlyArray<Readonly<FactGroupBucket>>} frozen, `FACT_GROUPS` order, empty groups omitted.
 */
export function groupFactList(facts) {
	if (!Array.isArray(facts) || facts.length === 0) return EMPTY_GROUPS;

	// One bucket PER `FACT_GROUPS` ENTRY, in that array's own index order, so
	// the output order is the model's declared group order and never the order
	// the facts happened to arrive in. A container built by insertion would
	// make the page's section order a function of `FACTS`, which is a
	// different (and unstated) contract.
	//
	// A parallel array rather than a `Map`, and that is forced rather than
	// stylistic: `election-shell.test.mjs`'s closed-URL-parameter-set case
	// resolves EVERY `.get(identifier)` call site under `src/` back to a
	// string literal and fails on any it cannot resolve. `Map.prototype.get`
	// is indistinguishable from `URLSearchParams.prototype.get` to that
	// matcher, so a map lookup here would report itself as an unresolved
	// third URL parameter and turn a live D-24 gate red for a reason the diff
	// would never explain. The gate is right to be indiscriminate; this module
	// simply has no need of a map.
	/** @type {any[][]} */
	const buckets = FACT_GROUPS.map(() => []);
	const groupNames = /** @type {ReadonlyArray<string>} */ (FACT_GROUPS);

	for (const entry of facts) {
		const group = entry && typeof entry.group === 'string' ? entry.group : null;
		const index = group === null ? -1 : groupNames.indexOf(group);
		if (index < 0) {
			// The throw PRECEDES the push, which is what makes "exactly one
			// group" and "no silent default" structural rather than asserted.
			const id = entry && typeof entry.id === 'string' ? entry.id : '(unnamed fact)';
			throw new FactGroupingError(
				`fact ${JSON.stringify(id)} declares a group that is not a FACT_GROUPS member (value type: ${typeof (entry && entry.group)})`,
			);
		}
		buckets[index].push(entry);
	}

	/** @type {Readonly<FactGroupBucket>[]} */
	const out = [];
	let placed = 0;
	for (let index = 0; index < groupNames.length; index += 1) {
		const group = groupNames[index];
		const bucket = buckets[index];
		// An empty group is OMITTED — an empty heading over nothing reads as a
		// section that failed to load, which is a claim this page must not make.
		if (bucket.length === 0) continue;
		placed += bucket.length;
		const headingKey = groupCopyKey(group);
		if (headingKey === null) {
			throw new FactGroupingError(`group ${JSON.stringify(group)} resolves to no copy key (value type: ${typeof group})`);
		}
		out.push(Object.freeze({ group, headingKey, facts: Object.freeze([...bucket]) }));
	}

	// THE DROP DETECTOR. Unreachable while the loop above throws first, and
	// that is precisely the point: a future edit that softens that throw into
	// a `continue` goes red HERE instead of quietly losing a card from the
	// page. A lost card is invisible to every gate that only counts what it
	// finds.
	if (placed !== facts.length) {
		throw new FactGroupingError(`grouping dropped ${facts.length - placed} of ${facts.length} facts`);
	}

	return Object.freeze(out);
}

/**
 * The four fact-group sections for one lifecycle phase, in `FACT_GROUPS`
 * order, each holding that phase's facts in `FACTS` declaration order.
 *
 * Never throws on an unrecognised phase: `factsFor` already answers `[]` for
 * anything it does not know, including `null` and the `indeterminate`
 * sentinel, and a page whose schedule could not be read must render 54-12's
 * explicit unknown headline rather than white-screening under the reader.
 *
 * @param {string | null} phase
 * @returns {ReadonlyArray<Readonly<FactGroupBucket>>}
 */
export function groupFactsForPhase(phase) {
	// No re-sort and no re-filter: `factsFor` is the single place the phase
	// membership and the declaration order are decided (D-11).
	return groupFactList(factsFor(/** @type {string} */ (phase)));
}
