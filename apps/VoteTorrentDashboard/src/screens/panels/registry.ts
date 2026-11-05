/**
 * registry.ts — the frozen capability-id-to-component map (contract C8).
 *
 * FROZEN AT NINE ENTRIES. 50-10 and 50-11 fill the nine component bodies in
 * parallel, in wave 6, against this file as a fixed contract — NEITHER
 * PLAN EDITS THIS FILE. Adding a tenth panel would require a tenth schema
 * scope, which fails `test/node/capabilities.test.mjs` first, by design.
 *
 * The `Record<CapabilityId, PanelComponent>` annotation is the mechanism
 * that makes `tsc --noEmit` reject a missing or extra panel — 50-10/50-11
 * get a compile error rather than a silently absent panel if this ever
 * drifts from `CAPABILITIES`.
 *
 * Static and greppable by design: nine static named imports, no dynamic
 * import, no computed key, no `React.lazy`. That is what lets
 * `test/node/registry.test.mjs` — a `node:test` file that cannot import
 * TypeScript — freeze this file's *content*, complementing `tsc`'s freeze of
 * its *shape*.
 */
import type { CapabilityId } from '../../auth/capabilities.js';
import type { PanelComponent } from './types.js';

import RegistrationsPanel from './RegistrationsPanel';
import ElectionsPanel from './ElectionsPanel';
import BallotsQuestionsPanel from './BallotsQuestionsPanel';
import NetworkSettingsPanel from './NetworkSettingsPanel';
import AuthorityProfilePanel from './AuthorityProfilePanel';
import AuthorityPeersPanel from './AuthorityPeersPanel';
import AdministrationOfficersPanel from './AdministrationOfficersPanel';
import KeyholdersPanel from './KeyholdersPanel';
import InviteAuthoritiesPanel from './InviteAuthoritiesPanel';

// Assigned to a directly-typed local first (rather than passed inline to
// `Object.freeze`) so a missing OR an extra key is a `tsc` error at this
// literal — TypeScript's excess-property check only fires against an object
// literal's immediate contextual type, and that contextual type does not
// propagate through a wrapping generic call the way a direct assignment's
// annotation does.
const registry: Record<CapabilityId, PanelComponent> = {
	registrations: RegistrationsPanel,
	elections: ElectionsPanel,
	ballotsQuestions: BallotsQuestionsPanel,
	networkSettings: NetworkSettingsPanel,
	authorityProfile: AuthorityProfilePanel,
	authorityPeers: AuthorityPeersPanel,
	administrationOfficers: AdministrationOfficersPanel,
	keyholders: KeyholdersPanel,
	inviteAuthorities: InviteAuthoritiesPanel,
};

export const PANEL_REGISTRY: Readonly<Record<CapabilityId, PanelComponent>> = Object.freeze(registry);
