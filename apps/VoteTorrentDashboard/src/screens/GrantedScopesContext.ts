/**
 * GrantedScopesContext.ts — the single seam `PanelGrid.tsx` reads for the
 * effective (real-or-previewed) scope set that reaches `evaluate()`.
 *
 * The PROVIDER lives in `./PreviewAsControl.tsx`, not here. The plan
 * permits either file for `PreviewAsProvider`; this file picks
 * `PreviewAsControl.tsx` deliberately, for two reasons: (1) that is where
 * `../auth/preview-scopes.js`'s `toggleScope`/`resetToReal`/`badgeKey` are
 * already imported to drive the checkbox control's own state, so building
 * the context value there needs no second copy of that wiring; and (2) it
 * lets `DashboardShell.tsx`'s bounded wiring edit pull `PreviewAsProvider`,
 * `PreviewAsControl` and (re-exported) `AdvisoryDisclosure` from ONE import
 * line instead of three, which matters for that edit's hard line budget.
 * This file owns only the context object and the two hooks that read it.
 *
 * `useEffectiveScopes()` returning the DEFAULT (an empty array) rather than
 * throwing when called outside a provider matters: a panel grid that
 * renders before the shell mounts a provider must degrade to rendering
 * nothing, never crash.
 */
import { createContext, useContext } from 'react';
import type { ScopeCode } from '../auth/capabilities.js';

export interface GrantedScopesValue {
	/** The scope set `evaluate()` should be called with — the officer's real
	 * scopes until the control is touched, a previewed set after. */
	effective: ReadonlyArray<ScopeCode>;
	/** Sticky from the first toggle until Reset — see `preview-scopes.js`'s
	 * `touched` doc for why this is never a set comparison. */
	simulated: boolean;
	/** A COPY-TABLE KEY, never a rendered string — `t()` is the only renderer. */
	badgeKey: 'gate.badgeReal' | 'gate.badgeSimulated';
	toggle: (code: ScopeCode) => void;
	reset: () => void;
	/** True once the officer's real scopes have been answered by the
	 * database at least once for the currently active network. Before that
	 * moment the previewed set is not a preview of anything, and a click
	 * would latch a baseline the database never supplied — see
	 * `PreviewAsControl.tsx`'s `disabled={!scopesResolved}` wiring. */
	scopesResolved: boolean;
}

function noop(): void {
	// Intentionally inert — the default context value below is only ever
	// observed by a consumer that renders outside a provider (see the file
	// header), which has nothing to toggle or reset yet.
}

const DEFAULT_VALUE: GrantedScopesValue = Object.freeze({
	effective: Object.freeze([]),
	simulated: false,
	badgeKey: 'gate.badgeReal',
	toggle: noop,
	reset: noop,
	// Fail-safe: a consumer rendered outside a provider has no
	// database-answered scopes to preview, so it must never appear resolved.
	scopesResolved: false,
});

export const GrantedScopesContext = createContext<GrantedScopesValue>(DEFAULT_VALUE);

/** The one thing `PanelGrid.tsx` reads — nothing else supplies `evaluate()`'s `grantedScopes` argument. */
export function useEffectiveScopes(): ReadonlyArray<ScopeCode> {
	return useContext(GrantedScopesContext).effective;
}

/** Everything `PreviewAsControl.tsx` needs, badge state included. */
export function usePreview(): GrantedScopesValue {
	return useContext(GrantedScopesContext);
}
