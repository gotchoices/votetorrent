import type { Scope } from "@votetorrent/vote-core";

/**
 * D-15 — the founding officer of a fresh network/authority is the ONLY
 * officer until they invite others, so they are seeded with every scope: an
 * officer holding fewer than all nine scopes would be unable to reach some
 * of Phase 47's scope-gated screens (notably `'vrg'` and `'cap'`) on a
 * brand-new network, with no other officer able to grant it to them.
 *
 * The set below is the schema's `view Scope`
 * (packages/vote-core/schema/votetorrent.qsql:56-69). The TypeScript `Scope`
 * union used to drift from it — it declared `'rnp'`, which the view never
 * defined — and seeding that code would have made the founding-officer insert
 * (part of the network-creation transaction) throw against
 * `Officer.ScopesValid` (votetorrent.qsql:185), aborting "Add Network"
 * entirely. See 47-02-PLAN.md's `<blocking_correction>` for that trace. The
 * drift was removed on 2026-08-25, so union and view now agree; this array
 * still pins the seed set against the schema.
 *
 * This is exported as ONE shared constant, not duplicated as two inline
 * literals, because the two seed call sites (`AddNetworkScreen`,
 * `AdministratorInvitationScreen`) live in different screen trees and had
 * already drifted out of sync with the schema once (both previously seeded
 * only six of the nine codes) — a single exported array is the only shape a
 * seed-array unit assertion can actually pin against the schema.
 */
export const FOUNDING_OFFICER_SCOPES: readonly Scope[] = [
	"rn",
	"rad",
	"vrg", // unlocks registrant/association/challenge/polling-device administration
	"iad",
	"uai",
	"ceb",
	"mel",
	"cap", // unlocks authority-peer configuration
	"ik",
];
