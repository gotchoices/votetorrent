/**
 * preview-scopes.js — the pure, frozen, in-memory state model behind the
 * "Preview as" scope control (D-18).
 *
 * WHY THIS EXISTS: every real officer this phase can have holds all nine
 * scopes (the schema admits exactly one user through the unsigned founding
 * shoe-in, and a second officer needs the deferred invite ceremony) — so
 * without a way to preview a smaller scope set, the scope gate
 * (`./gate.js`) could ship having never been seen doing anything. This
 * module produces the scope array a caller hands to that gate; it never
 * imports the gate itself, and the gate is never stubbed — only the
 * `grantedScopes` array this module produces varies between the officer's
 * real scopes and a previewed subset.
 *
 * RE-ENTRY CONDITION for the phase that adds panel actions: a previewed
 * scope set produced here must never condition a mutation. There is no
 * write path in this phase to condition one on, so that claim cannot be
 * proven here — it can only be asserted structurally (see
 * test/node/preview-control.test.mjs's confinement scan). The phase that
 * adds a write path must re-verify this deliberately rather than inherit it
 * silently.
 *
 * Seven exports: `createPreviewState`, `toggleScope`, `resetToReal`,
 * `resyncRealScopes`, `isSimulated`, `effectiveScopes`, `badgeKey`. Every
 * returned state is deep-frozen; `toggleScope`, `resetToReal` and
 * `resyncRealScopes` never mutate their input.
 * Plain ESM with JSDoc types (no React, no database handle, no import of
 * `./gate.js`) — this directory is walked by
 * `test/node/gate-contract.test.mjs`, which rejects TypeScript here.
 */

import { CAPABILITIES, SCOPE_CODES } from './capabilities.js';

/** @typedef {import('./capabilities.js').ScopeCode} ScopeCode */

/**
 * @typedef {object} PreviewState
 * @property {ReadonlyArray<ScopeCode>} realScopes - the officer's actual granted scopes. NOT fixed for the lifetime of this state chain: `resyncRealScopes` advances this baseline whenever the database-answered set changes, even while `touched` is true, so `resetToReal` always has a current target to fall back to.
 * @property {ReadonlyArray<ScopeCode>} selected - the scope set currently being previewed (equal to `realScopes` until the first toggle)
 * @property {boolean} touched - STICKY, not a set comparison. Set to `true`
 *   the moment ANY `toggleScope` call happens, and cleared ONLY by
 *   `resetToReal`. This is the security-relevant detail: an officer who
 *   un-checks a box and then re-checks the SAME box has landed back on the
 *   real scope set by value, but `touched` stays `true` and the badge stays
 *   on the simulated wording until Reset is clicked. Deriving this flag from
 *   a set-equality check instead would let the badge silently reclaim the
 *   real-answer wording for a set the database was never actually asked
 *   about, the moment the values happened to coincide again.
 */

/** CAPABILITIES-order index, keyed by scope code — the one ordering source
 * every exported array is sorted through, regardless of the order codes
 * were supplied or toggled in.
 * @type {Map<ScopeCode, number>} */
const SCOPE_ORDER = new Map(CAPABILITIES.map((capability, index) => [capability.scope, index]));

/**
 * De-duplicate and sort `codes` into `CAPABILITIES` order, validating every
 * entry against the closed `SCOPE_CODES` set first.
 *
 * @param {ReadonlyArray<ScopeCode>} codes
 * @returns {ScopeCode[]}
 */
function order(codes) {
	const unique = new Set();
	for (const code of codes) {
		if (!SCOPE_CODES.includes(code)) {
			throw new Error(`preview-scopes.js: unknown scope code ${JSON.stringify(code)}`);
		}
		unique.add(code);
	}
	return [...unique].sort((a, b) => /** @type {number} */ (SCOPE_ORDER.get(a)) - /** @type {number} */ (SCOPE_ORDER.get(b)));
}

/**
 * @param {{ realScopes: ReadonlyArray<ScopeCode>, selected: ReadonlyArray<ScopeCode>, touched: boolean }} shape
 * @returns {PreviewState}
 */
function freeze(shape) {
	return Object.freeze({
		realScopes: Object.freeze([...shape.realScopes]),
		selected: Object.freeze([...shape.selected]),
		touched: shape.touched,
	});
}

/**
 * The starting state: previewing exactly the officer's real scopes, not yet
 * touched. Throws (naming the offending code) if `realScopes` contains
 * anything outside the closed `SCOPE_CODES` set; silently de-duplicates a
 * repeated code.
 *
 * @param {ReadonlyArray<ScopeCode>} realScopes
 * @returns {PreviewState}
 */
export function createPreviewState(realScopes) {
	const ordered = order(realScopes);
	return freeze({ realScopes: ordered, selected: ordered, touched: false });
}

/**
 * Flip one scope code on or off in the previewed set. Works in both
 * directions — a code the officer's real set does not contain can be
 * previewed on, and one it does contain can be previewed off. Always sets
 * `touched` to `true`, unconditionally — see the `touched` property doc for
 * why that must not be a set comparison.
 *
 * @param {PreviewState} state
 * @param {ScopeCode} code
 * @returns {PreviewState}
 */
export function toggleScope(state, code) {
	if (!SCOPE_CODES.includes(code)) {
		throw new Error(`preview-scopes.js: toggleScope: unknown scope code ${JSON.stringify(code)}`);
	}
	const next = new Set(state.selected);
	if (next.has(code)) {
		next.delete(code);
	} else {
		next.add(code);
	}
	return freeze({ realScopes: state.realScopes, selected: order([...next]), touched: true });
}

/**
 * The only operation that clears `touched`. Returns a state previewing
 * exactly the officer's real scopes again.
 *
 * @param {PreviewState} state
 * @returns {PreviewState}
 */
export function resetToReal(state) {
	return freeze({ realScopes: state.realScopes, selected: state.realScopes, touched: false });
}

/**
 * Re-seed a preview state when the officer's REAL scopes change after the
 * state was created — the entry point `PreviewAsControl.tsx`'s effect
 * delegates to. This exists because the officer's real scopes arrive
 * ASYNCHRONOUSLY: `DashboardShell` renders its `PreviewAsProvider` with `[]`
 * on first render, and only fills `realScopes` in once `attachNetworkDb` and
 * `readGrantedScopes` resolve. A `useState` lazy initializer runs on the
 * FIRST render only, so seeding from it alone froze `realScopes: []`
 * forever — every capability evaluated as denied for a fully-privileged
 * officer. This function is the pure decision a React effect calls on every
 * render where the real scopes might have changed.
 *
 * `nextRealScopes` is ALWAYS validated and normalised through the same path
 * `createPreviewState` uses (by constructing one and comparing against it) —
 * this entry point is not a validation bypass, so an unknown code throws
 * naming it regardless of `touched`.
 *
 * - If the normalised `nextRealScopes` is set-equal (by value, in
 *   `CAPABILITIES` order) to `state.realScopes`, returns `state` UNCHANGED
 *   (same reference) — referential stability matters here: the caller is a
 *   React effect that calls `setState` with this result, and returning a
 *   fresh-but-equal object on every render would loop. This covers both the
 *   touched and untouched cases.
 * - Otherwise, if `state.touched` is true, the officer is mid-preview:
 *   returns a NEW frozen state whose `realScopes` baseline advances to the
 *   new `nextRealScopes` while `selected` and `touched` carry forward
 *   UNCHANGED — the in-progress preview is not yanked out from under them,
 *   but `resetToReal` (which reads `state.realScopes`) now has a real
 *   baseline to fall back to instead of whatever was in effect at the
 *   moment of the first toggle. Freezing the baseline here used to strand a
 *   fully-privileged officer at zero panels forever: `DashboardShell` mounts
 *   `realScopes: []` and fills it in asynchronously, so one click before
 *   `readGrantedScopes` resolved permanently froze `resetToReal`'s target at
 *   `[]`, with no operation short of a page reload that recovered it.
 * - Otherwise (untouched, and scopes differ), returns a freshly created
 *   state (via `createPreviewState`, so it is byte-identical to calling it
 *   directly): previewing exactly the new `realScopes`, not yet touched.
 *
 * @param {PreviewState} state
 * @param {ReadonlyArray<ScopeCode>} nextRealScopes
 * @returns {PreviewState}
 */
export function resyncRealScopes(state, nextRealScopes) {
	// Validate/normalise unconditionally, BEFORE any branch below -- an
	// officer mid-preview still deserves the same validation guarantee a
	// fresh state gets; silently accepting an invalid code while touched
	// would be a quiet bypass of the one validator this module has.
	const next = createPreviewState(nextRealScopes);
	const sameRealScopes =
		next.realScopes.length === state.realScopes.length &&
		next.realScopes.every((code, index) => code === state.realScopes[index]);
	if (sameRealScopes) {
		return state;
	}
	if (state.touched) {
		return freeze({ realScopes: next.realScopes, selected: state.selected, touched: true });
	}
	return next;
}

/**
 * @param {PreviewState} state
 * @returns {boolean}
 */
export function isSimulated(state) {
	return state.touched;
}

/**
 * @param {PreviewState} state
 * @returns {ReadonlyArray<ScopeCode>}
 */
export function effectiveScopes(state) {
	return state.selected;
}

/**
 * A copy-table KEY, never a rendered string — the copy table is frozen and
 * `t()` is the only renderer.
 *
 * @param {PreviewState} state
 * @returns {'gate.badgeReal' | 'gate.badgeSimulated'}
 */
export function badgeKey(state) {
	return isSimulated(state) ? 'gate.badgeSimulated' : 'gate.badgeReal';
}
