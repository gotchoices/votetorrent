/**
 * dashboard-pairing.ts — binding. The officer-side browser pairing moved to
 * `packages/workflows/src/authority/dashboard-pairing.ts` (phase 67 plan 17) so the vt CLI shares it. This
 * path stays so the pairing screens, the tests, their jest mocks and the lean rig keep working, and it is the
 * one place the app supplies its platform: the device user, the paired-browsers store, the pair-mint client
 * (owner lookup, failover client and its error classes) and cadre-core's codec through
 * `lazy-cadre-invitation-codec`, all read at call time so every existing jest mock keeps governing the result.
 */
import {
	loadPairingCapabilityState as sharedLoadPairingCapabilityState,
	requestPairingCode as sharedRequestPairingCode,
	type PairingCapabilityState,
	type PairingPlatform,
	type PairingRequestResult,
	type RequestPairingCodeArgs,
} from '@votetorrent/workflows/authority';
import { getDeviceUser } from './device-user';
import { lazyCadreInvitationCodec } from './lazy-cadre-invitation-codec';
import { createPairMintFailoverClient, findOwnerTargets, PairMintCancelledError, PairMintNoReplyError, PairMintUnreachableError } from './pair-mint-client';
import { recordPairedBrowser } from './paired-browsers-store';

export { PAIRING_INVITE_MAX_ADDRS, PAIRING_STATEMENT_LIFETIME_MS, pairingCapability, trimInvitationMembers, pairingRefusalReason } from '@votetorrent/workflows/authority';
export type {
	PairingCapability,
	PairingCapabilityState,
	PairingAnchorFailure,
	PairingAnchorResult,
	ReadPairingAnchor,
	PairingRequestFailureReason,
	PairingRequestResult,
	PairingNode,
	InvitationCodec,
	RequestPairingCodeDeps,
} from '@votetorrent/workflows/authority';

function classifyError(err: unknown): ReturnType<PairingPlatform['pairMintClient']['classifyError']> {
	if (err instanceof PairMintCancelledError) return 'cancelled';
	if (err instanceof PairMintNoReplyError) return 'no-reply';
	if (err instanceof PairMintUnreachableError) return 'unreachable';
	return 'other';
}

/** Gather the capability inputs, reading the app's device user. Never throws. */
export function loadPairingCapabilityState(args: Parameters<typeof sharedLoadPairingCapabilityState>[0]): Promise<PairingCapabilityState> {
	return sharedLoadPairingCapabilityState(args, { getDeviceUser: () => getDeviceUser() });
}

/** Build one pairing code with the app's pair-mint client, codec and paired-browsers store. */
export function requestPairingCode(args: RequestPairingCodeArgs): Promise<PairingRequestResult> {
	return sharedRequestPairingCode(args, {
		recordPairedBrowser: (record) => recordPairedBrowser(record),
		invitationCodec: lazyCadreInvitationCodec,
		pairMintClient: {
			findOwnerTargets: (node) => findOwnerTargets(node),
			createFailoverClient: (control, targets, options) => createPairMintFailoverClient(control, targets, options),
			classifyError,
		},
	});
}
