/**
 * AdvisoryDisclosure.tsx — the D-16 binding advisory-gate disclosure.
 *
 * No props, no state, no branch. An officer must read this sentence in the
 * DEFAULT (un-simulated, un-touched) state exactly as much as in a
 * previewed one — the moment this component can be conditioned on
 * anything, it can be hidden, and that is the one failure mode D-16 exists
 * to prevent. Read authorization in this phase is UI-only and advisory:
 * there is no CHECK constraint behind it, and anyone holding this browser's
 * bootstrapped snapshot holds the whole database regardless of what
 * renders. This component is the on-screen statement of exactly that fact,
 * and it must never itself become conditional on the fact it describes.
 *
 * Moved from apps/VoteTorrentDashboard/src/screens/AdvisoryDisclosure.tsx
 * into this shared package under D-01/D-02 (53-05) -- the extraction set is
 * settled by spike 090's closure tool, not widened here.
 *
 * D-07 (this plan's rewrite): the component now takes exactly one prop,
 * `variant: 'authority' | 'public'`. The prop is REQUIRED -- no default
 * parameter, no `?` optional marker, no fallback of any kind -- and it
 * selects VOICE, never VISIBILITY: it chooses which of two sentences this
 * component renders, not whether it renders at all, so it does not weaken
 * the "no branch" rule above. `t()` resolves `advisory.${variant}.body` by
 * TEMPLATE LITERAL, which is the whole mechanism -- there is nowhere in a
 * template literal to put a `??`/`||` fallback that would silently restore
 * one consumer's words on another consumer's page.
 *
 * This is the mechanism against the measured spike-091 defect: a shared
 * `AdvisoryDisclosure` rendered "What's shown here follows the officer's
 * permissions..." on a no-login public page with no officer and no
 * permission model to speak of -- clean imports, a green typecheck, every
 * automated gate green, caught only by looking at a screenshot. A missing
 * voice must reach `t()` and throw BY NAME, never silently render another
 * consumer's sentence. The required prop is what makes that possible: no
 * consumer can omit it and inherit a default.
 *
 * This component must never be wrapped in this package's designated
 * hook-calling collapsible component (D-19; see that component's own file
 * for its name). Doing so would turn a binding, unconditional security
 * disclosure into a hideable element -- exactly the failure mode D-16
 * exists to prevent. This file itself makes no reference to that
 * component, by name or otherwise, for the same reason.
 */
import { t } from '../copy.js';

export interface AdvisoryDisclosureProps {
	variant: 'authority' | 'public';
}

export function AdvisoryDisclosure({ variant }: AdvisoryDisclosureProps) {
	return <p className="pv-disclosure">{t(`advisory.${variant}.body`)}</p>;
}

export default AdvisoryDisclosure;
