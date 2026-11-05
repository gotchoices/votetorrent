/**
 * PreviewAsControl.tsx — the nine-scope "Preview as" control (D-18) and its
 * provider.
 *
 * This control exists because the only real officer this phase can have
 * holds all nine scopes — the schema admits exactly one user through the
 * unsigned founding shoe-in (`User.InsertValid`'s `count(*) = 1` clause),
 * and a second officer needs the deferred invite ceremony — so without this
 * control the scope gate (`../auth/gate.js`) would otherwise never be
 * observed doing anything. The gate function is never stubbed: only the
 * scope set handed to it, produced by `../auth/preview-scopes.js` and
 * carried through `GrantedScopesContext`, ever varies. A previewed set is a
 * preview of what an officer WOULD see, not a change to what anyone is
 * allowed to do — there is no write path in this phase for it to affect.
 *
 * Also re-exports `AdvisoryDisclosure` (now `@votetorrent/ui-web/components`,
 * moved there in 53-05 under D-01/D-02/D-07) so `DashboardShell.tsx`'s
 * bounded wiring edit needs one import line instead of two. This is a
 * disclosed consolidation for that edit's hard line budget, recorded in the
 * plan's summary — not a restructuring of either component's own module
 * boundary; `AdvisoryDisclosure` lives in the shared package now, not in
 * this dashboard, exactly as 53-05's artifact list requires.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CAPABILITIES } from '../auth/capabilities.js';
import type { ScopeCode } from '../auth/capabilities.js';
import {
	createPreviewState,
	toggleScope,
	resetToReal,
	resyncRealScopes,
	isSimulated,
	effectiveScopes,
	badgeKey,
} from '../auth/preview-scopes.js';
import { GrantedScopesContext, usePreview } from './GrantedScopesContext.js';
import type { GrantedScopesValue } from './GrantedScopesContext.js';
import { t } from '@votetorrent/ui-web';
import './preview-as.css';

export { AdvisoryDisclosure } from '@votetorrent/ui-web/components';

export interface PreviewAsProviderProps {
	/** The officer's real, database-granted scopes — the as-built expression
	 * `DashboardShell.tsx` already computes via `readGrantedScopes`.
	 *
	 * ARRIVES ASYNCHRONOUSLY, AND THAT IS THE WHOLE POINT OF THE EFFECT
	 * BELOW. `DashboardShell` renders this provider with `[]` on its first
	 * render and only fills the array in once `attachNetworkDb` and
	 * `readGrantedScopes` resolve. A `useState` lazy initializer runs on the
	 * first render ONLY, so seeding from it alone froze `realScopes: []`
	 * forever: every capability evaluated as denied and the grid rendered
	 * nothing for a fully-privileged officer. Treat this prop as a live
	 * value, never as a mount-time constant. */
	realScopes: ReadonlyArray<ScopeCode>;
	/** True once the officer's real, database-granted scopes have resolved
	 * at least once for the currently active network. REQUIRED —
	 * deliberately, so TypeScript forces every mount site to make an
	 * explicit decision instead of silently inheriting a permissive
	 * default. Before this is true, the nine checkboxes and the Reset
	 * control are `disabled`: a click during the multi-second attach
	 * window used to latch a preview against an empty `realScopes: []`
	 * baseline, and the officer had no way back short of reloading the
	 * page. */
	scopesResolved: boolean;
	children: ReactNode;
}

/**
 * Holds the preview state in `useState` and nowhere else — no storage, no
 * URL parameter, no module-level variable. That is what makes a preview
 * unable to outlive the page (T-50-12-04); the tier-3 `mode=fresh` page
 * load proves it across a genuinely fresh page boundary.
 */
export function PreviewAsProvider({ realScopes, scopesResolved, children }: PreviewAsProviderProps) {
	const [state, setState] = useState(() => createPreviewState(realScopes));

	// Re-seed when the officer's real scopes actually arrive (or change). The
	// decision itself — touched-guard, referential stability, validation —
	// lives entirely in the pure, tier-1-tested `resyncRealScopes`; this
	// effect body is a single `setState` call with no branch of its own, so
	// there is no second, independently-drifting copy of that decision. The
	// dependency is the JOINED scope string rather than the array identity,
	// so a re-render that produces an equal-but-new array does not re-seed.
	const realKey = realScopes.join(',');
	useEffect(() => {
		setState((prev) => resyncRealScopes(prev, realScopes));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- realKey IS realScopes, by value
	}, [realKey]);

	const value: GrantedScopesValue = useMemo(
		() => ({
			effective: effectiveScopes(state),
			simulated: isSimulated(state),
			// The real gate's own `badgeKey` decides this — never a second,
			// independently-branching copy of that decision.
			badgeKey: badgeKey(state) as 'gate.badgeReal' | 'gate.badgeSimulated',
			toggle: (code: ScopeCode) => setState((prev) => toggleScope(prev, code)),
			reset: () => setState((prev) => resetToReal(prev)),
			// Published unchanged — this provider does not gate `toggle` or
			// `reset` in the state model, only whether the control renders
			// them as clickable (see PreviewAsControl's `disabled` wiring).
			scopesResolved,
		}),
		[state, scopesResolved],
	);

	return <GrantedScopesContext.Provider value={value}>{children}</GrantedScopesContext.Provider>;
}

export function PreviewAsControl() {
	const { effective, simulated, toggle, reset, scopesResolved } = usePreview();

	// Class and copy key are derived from this SAME `simulated` boolean in
	// one statement each, right here, rather than reading two independent
	// sources that could drift apart — a refactor cannot leave the
	// real-answer class on the simulated words, or vice versa, without
	// touching this one variable.
	const badgeModifierClass = simulated ? 'pv-badge--sim' : 'pv-badge--real';
	const badgeCopyKey: 'gate.badgeReal' | 'gate.badgeSimulated' = simulated
		? 'gate.badgeSimulated'
		: 'gate.badgeReal';

	return (
		<fieldset className="pv-control">
			{/* Inert until scopesResolved: a click before the officer's real
			 * scopes arrive used to latch a preview against an empty baseline,
			 * and the officer had no way back short of reloading the page. */}
			<legend>{t('preview.title')}</legend>
			{CAPABILITIES.map((capability) => (
				<div key={capability.id} className="pv-row">
					<input
						id={`pv-scope-${capability.id}`}
						type="checkbox"
						checked={effective.includes(capability.scope)}
						onChange={() => toggle(capability.scope)}
						disabled={!scopesResolved}
					/>
					<label htmlFor={`pv-scope-${capability.id}`}>{t(capability.titleKey)}</label>
					<span className="pv-scope" title={capability.schemaName}>
						{capability.scope}
					</span>
				</div>
			))}
			<span className={`pv-badge ${badgeModifierClass}`}>{t(badgeCopyKey)}</span>
			<button type="button" className="pv-reset" onClick={reset} disabled={!scopesResolved}>
				{t('gate.resetScopesCta')}
			</button>
		</fieldset>
	);
}

export default PreviewAsControl;
