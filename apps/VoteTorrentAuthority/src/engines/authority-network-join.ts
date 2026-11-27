/**
 * authority-network-join.ts — binding. The join moved to
 * `packages/workflows/src/authority/authority-network-join.ts` (phase 67 plan 17) so the vt CLI shares it.
 * This path stays so existing imports, tests and jest mocks keep working, and it is the one place the app
 * supplies its cadre-core functions (decode, seed-peer merge, the two self-voucher verifiers) and its two
 * AsyncStorage-backed join stores, each read at call time so every existing jest mock keeps governing the
 * result. cadre-core is reached only through `lazy-cadre-invitation-codec`'s call-time accessor: the
 * navigator imports JoinNetworkScreen, which imports this file, and the RN jest environment cannot resolve
 * cadre-core's import-only `exports`, so a top-level value import here would break every navigator suite.
 */
import {
	completeAuthorityJoin as sharedCompleteAuthorityJoin,
	runAuthorityNetworkJoin as sharedRunAuthorityNetworkJoin,
	type AuthorityNetworkJoinResult,
} from '@votetorrent/workflows/authority';
import { rememberJoinBootstrap } from './join-bootstrap';
import { rememberJoinedNetwork } from './joined-networks';
import { lazyCadreCore, type LazyCadreCore } from './lazy-cadre-invitation-codec';

export { FounderGuardUnreadableError, isFounderGuardUnreadableError } from '@votetorrent/workflows/authority';
export type { AuthorityJoinNode, AuthorityNetworkJoinResult } from '@votetorrent/workflows/authority';

type SharedRunArgs = Parameters<typeof sharedRunAuthorityNetworkJoin>[0];
type SharedCompleteArgs = Parameters<typeof sharedCompleteAuthorityJoin>[0];

function appVerifiers(): SharedCompleteArgs['verifiers'] {
	return {
		verifyCadrePeerVoucher: (...args: Parameters<LazyCadreCore['verifyCadrePeerVoucher']>) => lazyCadreCore().verifyCadrePeerVoucher(...args),
		verifyInvitationAdmission: (...args: Parameters<LazyCadreCore['verifyInvitationAdmission']>) => lazyCadreCore().verifyInvitationAdmission(...args),
	};
}

/** Run a join from a decoded code (D-26, D-30) with the app's cadre-core and join stores. */
export function runAuthorityNetworkJoin(args: Omit<SharedRunArgs, 'cadre' | 'stores'>): Promise<AuthorityNetworkJoinResult> {
	return sharedRunAuthorityNetworkJoin({
		...args,
		cadre: {
			...appVerifiers(),
			decodeCadreInvitation: (...a: Parameters<LazyCadreCore['decodeCadreInvitation']>) => lazyCadreCore().decodeCadreInvitation(...a),
			mergeSeedPeers: (...a: Parameters<LazyCadreCore['mergeSeedPeers']>) => lazyCadreCore().mergeSeedPeers(...a),
		},
		stores: {
			rememberJoinBootstrap: (addrs) => rememberJoinBootstrap(addrs),
			rememberJoinedNetwork: (hash) => rememberJoinedNetwork(hash),
		},
	});
}

/** The locked completion order (D-26, D-09) with the app's self-voucher verifiers. */
export async function completeAuthorityJoin(args: Omit<SharedCompleteArgs, 'verifiers'>): Promise<{ trustSaved: boolean }> {
	return sharedCompleteAuthorityJoin({ ...args, verifiers: appVerifiers() });
}
