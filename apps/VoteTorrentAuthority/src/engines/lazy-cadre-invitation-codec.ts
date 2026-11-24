/**
 * lazy-cadre-invitation-codec.ts — the app's ONE call-time cadre-core accessor (phase 67 plan 17).
 *
 * cadre-core's `exports` carry no `require`/`default` condition, so the RN jest environment cannot resolve
 * it, and the navigator, the invite card, the settings screen and the pairing screens import the
 * authority-network-join, voter-invite, pair-mint-host and dashboard-pairing bindings at module load. Those
 * bindings therefore load cadre-core only when a join, a mint or a pairing actually calls it, through this
 * module: the same lazy load `voter-invite.ts` and `dashboard-pairing.ts` did before the move, and the id
 * the lean rig's dashboard shim answers. Nothing here holds state, logs or keeps a reference to an invitation.
 */
import type { CadreInvitation } from '@serfab/cadre-core';
import type { InvitationCodec } from '@votetorrent/workflows/authority';

/** The cadre-core functions the Authority bindings hand to the shared workflows as required parameters. */
export type LazyCadreCore = Pick<
	typeof import('@serfab/cadre-core'),
	'decodeCadreInvitation' | 'encodeCadreInvitation' | 'mergeSeedPeers' | 'verifyCadrePeerVoucher' | 'verifyInvitationAdmission'
>;

/** cadre-core, resolved on every call (so a per-test `jest.doMock` keeps governing it) and never at module load. */
export function lazyCadreCore(): LazyCadreCore {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('@serfab/cadre-core') as LazyCadreCore;
}

export const lazyCadreInvitationCodec: InvitationCodec = {
	decodeCadreInvitation(encoded: string): CadreInvitation {
		return lazyCadreCore().decodeCadreInvitation(encoded);
	},
	encodeCadreInvitation(invitation: CadreInvitation): string {
		return lazyCadreCore().encodeCadreInvitation(invitation);
	},
};
