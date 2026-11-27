/**
 * phase-ids.js -- the dependency-free half of the election lifecycle phase
 * model (WR-11, Phase 53 review; renamed 3 -> 4 ids in Phase 54, D-06/D-07/D-12).
 *
 * Split out of `election-phase.js` specifically so `LifecyclePill.tsx` (a
 * `./components` barrel member, per `src/components.js`) can depend on
 * `PHASE_IDS`/`phaseCopyKey` WITHOUT transitively pulling in
 * `@votetorrent/vote-engine/browser` -- a database engine that
 * `election-phase.js`'s header explicitly names as the reason `./lifecycle`
 * is kept OUT of the `.` barrel (measured 0.30-0.44s vs 0.02s bare). Before
 * this split, `LifecyclePill.tsx` imported `phaseCopyKey` directly from
 * `election-phase.js`, so `@votetorrent/ui-web/components` (the bundler-only
 * barrel `index.js`'s own header says stays plain-JS-consumer-safe) pulled
 * the engine in anyway -- exactly the coupling `index.js`'s split rationale
 * says should not happen.
 *
 * This module imports NOTHING beyond plain JavaScript: no `vote-engine`, no
 * `react`. Do not add an import here without re-checking that invariant --
 * it is what makes it safe for a bundler-only, React-only barrel to depend
 * on.
 *
 * `election-phase.js` re-exports `PHASE_IDS`/`phaseCopyKey` unchanged, so its
 * own `./lifecycle` public surface (and every existing consumer of
 * `@votetorrent/ui-web/lifecycle`) is unaffected by this split.
 *
 * PHASE 54 RENAME (D-06/D-07, adjudicated I-12): the four lifecycle phase ids
 * are `pre`/`voting`/`settling`/`closed` -- a rename of all three prior ids
 * (`organizing`/`running`/`released`), not an insertion of a fourth. Spike
 * 086's `derivePhase` is the ONE shared derivation (`./election-phase.js`)
 * and its `PHASES` map declares exactly this vocabulary. `INDETERMINATE_PHASE`
 * ('indeterminate', D-10) is deliberately NOT a `PHASE_IDS` member and
 * `phaseCopyKey` returns `null` for it: both the dashboard's `TIER3_PHASE_IDS`
 * invariance loop and the public app's D-08 fixture tripwire iterate
 * `PHASE_IDS` expecting every member to be derivable from a well-formed
 * timeline, and `indeterminate` is the absence of a phase, not a fifth one.
 */

/** @typedef {'pre' | 'voting' | 'settling' | 'closed'} PhaseId */

/** The four lifecycle phase ids, in chronological order. Frozen; never derived at runtime. @type {ReadonlyArray<PhaseId>} */
export const PHASE_IDS = Object.freeze(['pre', 'voting', 'settling', 'closed']);

/**
 * The explicit "no confident phase" sentinel (D-10). See the header note
 * above for why it is deliberately not a `PHASE_IDS` member.
 * @type {'indeterminate'}
 */
export const INDETERMINATE_PHASE = 'indeterminate';

/** The copy key `LifecyclePill` resolves for `INDETERMINATE_PHASE`. @type {'lifecycle.indeterminate'} */
export const INDETERMINATE_COPY_KEY = 'lifecycle.indeterminate';

/**
 * @param {PhaseId | null} phase
 * @returns {string | null}
 */
export function phaseCopyKey(phase) {
	if (phase === 'pre' || phase === 'voting' || phase === 'settling' || phase === 'closed') {
		return `lifecycle.${phase}`;
	}
	return null;
}
