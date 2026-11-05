/**
 * gate.js — the D-17 `hasScope`-only advisory gate.
 *
 * `visible = hasScope` ALONE. Spike 078's model carried a second, independent
 * gate — `writable = hasScope && withinWindow` — but this phase makes no
 * writes, so there is nothing to condition on a deadline for. A `writable`
 * field kept "for later" would be exactly the misleading write affordance
 * D-17 exists to prevent; this module asserts its absence rather than
 * merely its value (see test/node/gate.test.mjs).
 *
 * Reinstating the time gate is the entry condition for the phase that adds
 * panel actions — say so in those exact words if you are that phase. Until
 * then, `evaluate()` takes no `phaseId` and returns no `inWindow`.
 *
 * `denialReason` is a MACHINE CODE, never a rendered sentence — the copy
 * table (packages/ui-web/src/copy.js) is frozen and carries no deny-reason key. The
 * denied-panel UI communicates the reason with the capability's own
 * scope-code pill, which is data, not copy.
 *
 * THIS GATE IS ADVISORY. It hides what an officer should not see; it stops
 * nothing. There is no CHECK constraint behind a read — every capability
 * this gate evaluates is read-only in this phase. Anyone holding this
 * browser's bootstrapped snapshot holds the whole database regardless of
 * what evaluate() returns. The in-product disclosure of this fact is
 * `gate.advisoryDisclosure` in the copy table (rendered by a later plan).
 *
 * Pure by design: no database handle, no import of is-privileged.js, no
 * `async`. Only `grantedScopes` may ever vary — that purity is what lets a
 * later "preview as" control vary it without stubbing this module.
 */

/**
 * @typedef {object} GateResult
 * @property {boolean} hasScope
 * @property {boolean} visible
 * @property {'missing-scope' | null} denialReason
 */

/**
 * @param {import('./capabilities.js').Capability} capability
 * @param {ReadonlyArray<import('./capabilities.js').ScopeCode>} grantedScopes
 * @returns {GateResult}
 */
export function evaluate(capability, grantedScopes) {
	// Exact equality, never a prefix/substring test — mirrors the engine's
	// own `json_each(O.Scopes) WHERE value = :scope` (T-18-02's original
	// mitigation reason: a substring match could admit a scope that was
	// never actually granted).
	const hasScope = grantedScopes.includes(capability.scope);
	return {
		hasScope,
		visible: hasScope,
		denialReason: hasScope ? null : 'missing-scope',
	};
}
