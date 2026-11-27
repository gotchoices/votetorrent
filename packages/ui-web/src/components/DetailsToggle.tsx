/**
 * DetailsToggle.tsx -- the designated hook-calling shared component.
 *
 * D-12 anticipates a third shared component beyond `LifecyclePill` and
 * `AdvisoryDisclosure` -- "at least one hook-calling component" -- because
 * neither of those two may gain one: `AdvisoryDisclosure`'s own header
 * forbids it from becoming conditional on anything (D-16), and
 * `LifecyclePill` is deliberately a pure function of the computed phase.
 * `DetailsToggle` extracts nothing from the dashboard and removes nothing
 * from it -- D-01's "do not widen the extraction set" governs what MOVES,
 * not what this package may additionally author.
 *
 * `53-08`/`53-09` target this component as the D-19 React-identity gate's
 * subject: click the real `.dt-toggle` button on a BUILT page and assert
 * `aria-expanded` flips. A duplicate React is harmless for a purely
 * presentational component -- it is the HOOK DISPATCHER that needs one
 * React, and this component exists so that failure mode has a genuine
 * subject to bite. It must therefore keep calling a REAL hook: removing the
 * `useState` below would silently make the identity gate vacuous, passing
 * for the wrong reason. This file's own tier-1 test proves `aria-expanded`
 * is bound to live state, not a literal -- the behavioural proof that the
 * hook actually dispatches against a single React is 53-09's browser gate,
 * not this file's.
 *
 * Copy-free by design: `summary` and `children` arrive from the consumer as
 * `ReactNode`. This component holds no strings of its own, so it adds zero
 * copy keys and carries zero per-consumer copy risk -- each consumer
 * supplies its own already-planned `t()` output at the call site.
 *
 * Named `DetailsToggle`, deliberately not anything containing "Disclosure",
 * so nobody later "reuses" it on `AdvisoryDisclosure`. This component must
 * NEVER be wrapped around `AdvisoryDisclosure` -- D-16 forbids the advisory
 * disclosure from ever becoming conditional on anything, and wrapping it in
 * a collapsible would turn a binding security control into a hideable
 * element, which is the one failure mode D-16 exists to prevent.
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

export interface DetailsToggleProps {
	summary: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
}

export function DetailsToggle({ summary, children, defaultOpen = false }: DetailsToggleProps) {
	const [open, setOpen] = useState(defaultOpen);
	const bodyId = useId();

	return (
		<div className="dt-toggle-group">
			<button
				type="button"
				className="dt-toggle"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen((prev) => !prev)}
			>
				{summary}
			</button>
			{open ? (
				<div id={bodyId} className="dt-body">
					{children}
				</div>
			) : null}
		</div>
	);
}

export default DetailsToggle;
