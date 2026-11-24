/**
 * voter-network-join.ts — binding over the shared join, which moved to
 * `packages/workflows/src/voter/voter-network-join.ts` (phase 67 plan 19). This path stays so existing
 * imports (`VoterAppProvider`'s lazy require), `jest.mock` paths and tests keep working, with the old
 * signatures. It is the ONE place the app supplies its two platform seams: the cadre-core functions
 * (the only value import of cadre-core on the voter side, which the tests virtual-mock here) and the
 * app's join-bootstrap store (`./join-bootstrap`, over AsyncStorage).
 */
import {decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission} from '@serfab/cadre-core';
import type {NetworkJoinCode, NetworkJoinResult, NetworkJoinStep} from '@votetorrent/vote-engine/rn';
import type {INetworksEngine, User} from '@votetorrent/vote-core';
import {
	isSelfAdmitted as sharedIsSelfAdmitted,
	runVoterNetworkJoin as sharedRunVoterNetworkJoin,
} from '@votetorrent/workflows/voter';
import type {VoterJoinBootstrapWriter, VoterJoinCadre, VoterJoinNode} from '@votetorrent/workflows/voter';
import {rememberJoinBootstrap} from './join-bootstrap';

export type {VoterJoinNode};
export {belongsToOtherCadre, invitationExpiresAtMs} from '@votetorrent/workflows/voter';

/** The app's cadre-core functions, handed to the shared join. */
const appCadre: VoterJoinCadre = {decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission};

/** The app's join-bootstrap store (AsyncStorage-backed), handed to the shared join. */
const appJoinBootstrapStore: VoterJoinBootstrapWriter = {rememberJoinBootstrap};

/** The invitation branch of self-admission, verified with the app's cadre-core verifier. */
export function isSelfAdmitted(node: VoterJoinNode): Promise<boolean> {
	return sharedIsSelfAdmitted(node, verifyInvitationAdmission);
}

/** Run a join from a decoded code. Never throws for a join problem (see `NetworkJoinResult`). */
export function runVoterNetworkJoin(args: {
	node: VoterJoinNode;
	networksEngine: Pick<INetworksEngine, 'joinFromStrand'>;
	user: User | undefined;
	code: NetworkJoinCode;
	onStep?: (step: NetworkJoinStep) => void;
	/** UAT 65 F1: release the first-sync wait a join left pending when its budget ran out. */
	onSyncAbandoned?: () => Promise<void> | void;
}): Promise<NetworkJoinResult> {
	return sharedRunVoterNetworkJoin({...args, cadre: appCadre, joinBootstrapStore: appJoinBootstrapStore});
}
