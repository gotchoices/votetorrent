/**
 * owner-trust.ts — binding. The code moved to `packages/workflows/src/authority/owner-trust.ts`
 * (phase 67 plan 07) so the vt CLI shares it. This path stays so existing imports, tests and jest
 * mocks keep working; it holds no logic of its own.
 */
export {
	OWNER_REANCHOR_TIMEOUT_MS,
	OWNER_TRUST_CLASSIFY_TIMEOUT_MS,
	OwnerTrustUnreadableError,
	classifyOwnerTrust,
	reanchorOwnKey,
	readOwnerTrustClassification,
} from '@votetorrent/workflows/authority';
export type { OwnerTrustState, OwnerStoreKind, OwnerTrustNode, ReanchorOutcome } from '@votetorrent/workflows/authority';
