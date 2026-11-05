/**
 * LifecyclePill.tsx -- the computed, non-interactive lifecycle status pill.
 *
 * The phase is computed from the election's own timeline
 * (`../lifecycle/election-phase.js`) and never chosen by an officer --
 * there is deliberately no control anywhere in this app to change it.
 *
 * Phase 54 (D-10): renders a VISIBLE pill for `indeterminate`, not nothing.
 * `ElectionRevision.Timeline` carries zero CHECK constraints, so a foreign,
 * absent, incomplete or non-monotonic timeline is an EXPECTED input, not an
 * exception -- and on a page whose subject is the phase, silence reads as a
 * loading state. A `null` phase (not yet loaded, 53-D18's skeleton case)
 * still earns no pill: that is a distinct, genuinely-absent-value case from
 * a derived-but-unreadable one.
 *
 * Not a `PanelComponent` -- it takes a single `phase` prop and is mounted
 * by `ElectionsPanel`, not by the registry.
 *
 * Moved from apps/VoteTorrentDashboard/src/screens/panels/LifecyclePill.tsx
 * into this shared package under D-01/D-02 (53-05). The only change at that
 * time was the two import specifiers below, now direct package-relative
 * siblings rather than a dashboard-relative path.
 *
 * `.lifecycle-pill` and its three modifiers moved again at 53-CR01, into this
 * package's own `../components.css` (exported as `./components.css`) -- the
 * D-15 revision: the package that owns a shared component's markup now also
 * owns that component's default CSS, for exactly the class names it renders.
 * CR-01 measured the prior rule ("each app owns its own component styles")
 * leaving `.lifecycle-pill` with zero rules in `apps/VoteTorrentPublic`,
 * invisible to every gate this phase had built. See
 * `packages/ui-web/README.md`'s "Shared component default styles" section.
 *
 * `phaseCopyKey`/`INDETERMINATE_PHASE`/`INDETERMINATE_COPY_KEY` are imported
 * from `../lifecycle/phase-ids.js`, NOT `../lifecycle/election-phase.js`
 * (WR-11, Phase 53 review): the latter's only external dependency is
 * `@votetorrent/vote-engine/browser` -- a database engine -- and importing it
 * from here would transitively pull that engine into `./components` (this
 * file's own barrel, per `src/components.js`), contradicting `src/index.js`'s
 * stated reason for keeping `./lifecycle` a separate, plain-JS-only exports
 * entry. See `phase-ids.js`'s own header for the full split rationale.
 */
import { phaseCopyKey, INDETERMINATE_PHASE, INDETERMINATE_COPY_KEY } from '../lifecycle/phase-ids.js';
import { t } from '../copy.js';

export interface LifecyclePillProps {
	phase: 'pre' | 'voting' | 'settling' | 'closed' | 'indeterminate' | null;
}

export function LifecyclePill({ phase }: LifecyclePillProps) {
	const key = phase === INDETERMINATE_PHASE ? INDETERMINATE_COPY_KEY : phaseCopyKey(phase);
	if (key === null) {
		return null;
	}
	return <span className={`lifecycle-pill lifecycle-pill--${phase}`}>{t(key)}</span>;
}

export default LifecyclePill;
