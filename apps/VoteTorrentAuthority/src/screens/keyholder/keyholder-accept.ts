/**
 * keyholder-accept.ts — Phase 62 Plan 26 (D-21, D-26). Orchestrates a keyholder invite accept:
 * provision a fresh identity, pass it to 62-02's `respondToInvite`, and reconcile before ever
 * discarding the provisioned keys.
 *
 * Four points:
 *  1. The provisioning contract (62-02): `respondToInvite`'s sixth argument
 *     (`KeyholderAcceptProvisioning`) carries the fresh identity's public signing key, its DKG
 *     public key and a `sign` callback. The engine signs the binding digest through that callback
 *     BEFORE opening its accept transaction, and writes `InviteResult`, `User`, `UserKey`,
 *     `Keyholder` and `KeyholderDkgBinding` together, in one commit.
 *  2. `invokedId` (the engine's fifth argument) is the APP-MINTED userId from
 *     `provisionKeyholderIdentity` — never the officer's own id. Passing the officer's id collides
 *     on the `User` primary key and the whole accept rejects (D-21: the officer's device key is
 *     never used for a keyholder accept).
 *  3. The reconcile rule: on an error from `respondToInvite`, re-read the invite. If it shows this
 *     accept actually committed (an orphaned-keys-committed-keyholder race), the keys are KEPT and
 *     this call reports success — never orphan a committed keyholder without its keys. If the
 *     re-read shows no commit, the freshly-minted keys are inert (never bound to a Keyholder row)
 *     and are discarded. If the re-read itself fails, the outcome is UNKNOWN — discard nothing,
 *     and rethrow the original error (the keys might belong to a keyholder that did commit).
 *  4. D-21: every accept provisions a brand-new identity; this module never touches the officer's
 *     device signing key.
 *  5. The slot Cid is resolved from the pasted share (by InviteKey + Type) BEFORE provisioning, so an
 *     unknown, malformed or wrong-type invite costs zero auth wraps (zero biometric prompts) and
 *     leaves zero identities (UAT 62 test 10).
 *  6. One seat per device per election, and never the inviter's own (gap6/WR-09, user decision 8b, no
 *     override): after the slot resolves and BEFORE provisioning, the slot's seat facts are read
 *     (`getKeyholderSlotSeat`). A self-invite is refused ('self-invite'); so is a device that already holds a
 *     keyholder identity whose slot belongs to the same election ('seat-already-held'). Both cost zero auth
 *     wraps. The engine refuses a self-invite too (62-103); this check spares the biometric prompts.
 *     A held identity counts as a seat only when its slot's result is an acceptance invoking that identity.
 *     An orphan (unknown-outcome accept, or a kill between provisioning and responding) is skipped, and it
 *     is discarded once its slot's answer is known to be some other outcome. A failing read of the held
 *     slot's status propagates (fail closed, zero wraps) rather than guessing.
 */

import type { IInvitationEngine } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { discardKeyholderIdentity, listKeyholderIdentities, provisionKeyholderIdentity } from '../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../engines/key-vault';
import { InviteShareError, resolveInviteFromShare } from '../invitations/invite-share';

function keyholderAcceptError(message: string, code: 'self-invite' | 'seat-already-held'): Error {
	return Object.assign(new Error(message), { name: 'KeyholderAcceptError', code });
}

export interface KeyholderAcceptDeps {
	invitationEngine: IInvitationEngine;
	vault: IKeyVault;
	storage?: KeyVaultStorage;
	/** The election's current-revision seat facts (the DKG status read). Absent or failing means no proof. */
	readKeyholderSeatFacts?: (electionId: string) => Promise<SeatFacts | undefined>;
}

export interface SeatFacts {
	revision: number | null;
	liveRoster?: string[];
	earlierRevisionUserIds?: string[];
}

/** True only on positive proof that `userId` is an earlier-revision seat (never on an unread roster). */
function isProvenEarlierRevisionSeat(facts: SeatFacts | undefined, userId: string): boolean {
	return (
		!!facts &&
		typeof facts.revision === 'number' &&
		Array.isArray(facts.liveRoster) &&
		Array.isArray(facts.earlierRevisionUserIds) &&
		!facts.liveRoster.includes(userId) &&
		facts.earlierRevisionUserIds.includes(userId)
	);
}

export async function acceptKeyholderInvitation(
	deps: KeyholderAcceptDeps,
	shareText: string
): Promise<{ userId: string; slotCid: string }> {
	// Step 0: resolve and validate the slot BEFORE any identity is provisioned (zero prompts on failure).
	const { slotCid, invitePrivate } = await resolveInviteFromShare(deps.invitationEngine, shareText, 'k');
	const seat = await deps.invitationEngine.getKeyholderSlotSeat(slotCid);
	if (!seat) throw new InviteShareError('not-found');
	if (seat.selfInvite) {
		throw keyholderAcceptError('The officer who sent this keyholder invitation cannot accept it', 'self-invite');
	}
	let facts: SeatFacts | undefined;
	let factsRead = false;
	for (const held of await listKeyholderIdentities(deps.storage)) {
		const heldSeat = await deps.invitationEngine.getKeyholderSlotSeat(held.inviteSlotCid);
		if (heldSeat && heldSeat.electionId === seat.electionId) {
			// A held identity is a seat only on positive evidence that its accept committed: the slot's
			// result is an acceptance invoking THIS identity. An identity left behind by an accept whose
			// outcome was unknown (respond and re-read both failed) or by a kill between provisioning and
			// responding never became a seat, so it must not lock the keyholder out of the election.
			const heldStatus = await deps.invitationEngine.getKeyholderInvite(held.inviteSlotCid);
			const committed = heldStatus?.result?.isAccepted === true && heldStatus.result.invokedId === held.userId;
			if (!committed) {
				// Discard only when the slot's answer is known and is not this identity; an unanswered slot
				// leaves the identity in place (skipped, never counted).
				if (heldStatus?.result !== undefined) {
					await discardKeyholderIdentity({ vault: deps.vault, storage: deps.storage }, held.userId).catch(() => undefined);
				}
				continue;
			}
			if (!factsRead) {
				factsRead = true;
				try {
					facts = deps.readKeyholderSeatFacts ? await deps.readKeyholderSeatFacts(seat.electionId) : undefined;
				} catch {
					facts = undefined;
				}
			}
			if (isProvenEarlierRevisionSeat(facts, held.userId)) continue;
			throw keyholderAcceptError('This device already holds a keyholder seat for this election', 'seat-already-held');
		}
	}
	const identity = await provisionKeyholderIdentity({ vault: deps.vault, storage: deps.storage }, slotCid);

	try {
		try {
			await deps.invitationEngine.respondToInvite(slotCid, true, invitePrivate, undefined, identity.userId, identity.provisioning);
			return { userId: identity.userId, slotCid };
		} catch (originalError) {
			let reread: Awaited<ReturnType<IInvitationEngine['getKeyholderInvite']>>;
			try {
				reread = await deps.invitationEngine.getKeyholderInvite(slotCid);
			} catch {
				// The outcome is UNKNOWN — the keys might belong to a keyholder that DID commit.
				// Discard nothing; surface the original error.
				throw originalError;
			}
			if (reread?.result?.isAccepted === true && reread.result.invokedId === identity.userId) {
				// The accept actually committed despite the thrown error — never orphan a
				// committed keyholder's keys.
				return { userId: identity.userId, slotCid };
			}
			await discardKeyholderIdentity({ vault: deps.vault, storage: deps.storage }, identity.userId).catch(() => undefined);
			throw originalError;
		}
	} finally {
		identity.release();
	}
}
