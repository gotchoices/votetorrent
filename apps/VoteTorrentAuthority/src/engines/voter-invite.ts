/**
 * voter-invite.ts — binding. The voter join-code and pairing-invitation mints moved to
 * `packages/workflows/src/authority/voter-invite.ts` (phase 67 plan 17) so the vt CLI shares them. This
 * path stays so existing imports, tests, jest mocks and the lean rig keep working, and it is the one place
 * the app supplies cadre-core's invitation encoder: through `lazy-cadre-invitation-codec`, loaded at call
 * time, so the screens that import this module never load cadre-core at module load. The old optional
 * `encodeInvitation` test seams still win when given.
 */
import type { CadreInvitation } from '@serfab/cadre-core';
import {
	createPairingInvitation as sharedCreatePairingInvitation,
	createVoterJoinCode as sharedCreateVoterJoinCode,
	type PairingInviteNode,
	type VoterJoinCodeResult,
} from '@votetorrent/workflows/authority';
import { lazyCadreInvitationCodec } from './lazy-cadre-invitation-codec';

export {
	VOTER_INVITE_USES,
	VOTER_INVITE_LIFETIME_MS,
	PAIR_INVITE_USES,
	PAIR_INVITE_LIFETIME_MS,
	voterInviteCapability,
	ensureVoterInviteOwner,
	VoterInviteError,
	inviteExpiryMs,
	PairingInviteError,
} from '@votetorrent/workflows/authority';
export type {
	VoterInviteNode,
	VoterInviteCapability,
	VoterInviteFailureReason,
	VoterJoinCodeResult,
	PairingInviteNode,
	PairingInviteFailureReason,
	InvitationEncoder,
} from '@votetorrent/workflows/authority';

type SharedJoinCodeArgs = Parameters<typeof sharedCreateVoterJoinCode>[0];
type SharedPairingOptions = Parameters<typeof sharedCreatePairingInvitation>[1];

const appEncoder = (invitation: unknown): string => lazyCadreInvitationCodec.encodeCadreInvitation(invitation as CadreInvitation);

/** Mint an untargeted voter invitation and build the join code, encoding through the app's cadre-core. */
export function createVoterJoinCode(args: Omit<SharedJoinCodeArgs, 'encodeInvitation'> & { encodeInvitation?: SharedJoinCodeArgs['encodeInvitation'] }): Promise<VoterJoinCodeResult> {
	return sharedCreateVoterJoinCode({ ...args, encodeInvitation: args.encodeInvitation ?? appEncoder });
}

/** Mint one single-use pairing invitation on an owner phone, encoding through the app's cadre-core. */
export function createPairingInvitation(
	node: PairingInviteNode,
	options?: Omit<SharedPairingOptions, 'encodeInvitation'> & { encodeInvitation?: SharedPairingOptions['encodeInvitation'] },
): ReturnType<typeof sharedCreatePairingInvitation> {
	return sharedCreatePairingInvitation(node, { ...options, encodeInvitation: options?.encodeInvitation ?? appEncoder });
}
