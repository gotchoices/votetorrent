/**
 * self-voucher.ts — binding. The predicate moved to
 * `packages/workflows/src/authority/self-voucher.ts` (phase 67 plan 07) so the vt CLI shares it. This
 * path stays so existing imports, tests and jest mocks keep working, and it is the one place the app
 * supplies its cadre-core verifiers: the shared code takes them as a required parameter (no default,
 * so a missing verifier can never answer true) because the shared authority subpath must load where
 * cadre-core's import-only `exports` cannot be resolved. The forwarders read the cadre-core export at
 * call time, so replication-proof-runner.test.ts's in-test `jest.doMock` factories keep governing the
 * result.
 */
import { verifyCadrePeerVoucher, verifyInvitationAdmission } from '@serfab/cadre-core';
import { isSelfVouched as sharedIsSelfVouched, type SelfVoucherNode } from '@votetorrent/workflows/authority';

export type { SelfVoucherNode } from '@votetorrent/workflows/authority';

/**
 * True when THIS peer's own replicated `CadrePeer` row carries a proof that chains to an owner
 * anchored in the node-local trust store, judged by the app's cadre-core.
 */
export async function isSelfVouched(node: SelfVoucherNode, peerId: string): Promise<boolean> {
	return sharedIsSelfVouched(node, peerId, {
		verifyCadrePeerVoucher: (...args: Parameters<typeof verifyCadrePeerVoucher>) => verifyCadrePeerVoucher(...args),
		verifyInvitationAdmission: (...args: Parameters<typeof verifyInvitationAdmission>) => verifyInvitationAdmission(...args),
	});
}
