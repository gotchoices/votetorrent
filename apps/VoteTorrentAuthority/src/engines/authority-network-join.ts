/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * authority-network-join.ts — wires vote-engine's `joinNetwork` to this Authority's CadreNode (D-26).
 *
 * vote-engine never imports cadre-core (D-03), so every cadre-core call the join needs is supplied
 * here: decoding the invitation, redeeming it, the self-admission check (`isSelfVouched`), and the
 * post-redemption steps a redemption that throws would have skipped. It copies
 * `apps/VoteTorrentVoter/src/engines/voter-network-join.ts`, with the Authority additions below.
 *
 * Authority additions (the order is a test contract):
 *  - The whole join runs inside `withJoining(networkHash)` (D-30), so every strand open of that hash
 *    during the join reads intent 'joining' and is never a founder, even with zero control
 *    connections. On success the hash is recorded INSIDE the window.
 *  - `completeAuthorityJoin` runs selectNetwork, then the bounded own-key wiring, then the owner
 *    trust refresh only when this node's own row is self-vouched (D-09; RESEARCH C15).
 *
 * OQ1 decision (64-GATE-REVIEW, Branch B): the user chose a guard. A node whose identity key is a
 * live owner of its own cadre is refused, before `joinNetwork` runs, when the invitation shares none
 * of its control-DB owners. The 107c measurement was an untyped refusal with a self-vouched founder
 * taking the already-member path, which skips the redeem, and the foreign owner pins landing before
 * the dial. The guard therefore sits before `joinNetwork`, for both values of that measurement. It
 * guards a founder against a foreign cadre only. A fresh keyholder install and a same-cadre join
 * pass. A non-founder member of one cadre redeeming another cadre's invitation is not measured and
 * is not guarded. The screen copy for the refusal belongs to the plan that renders the reason.
 *
 * D-06: the join code is a bearer credential. The only console calls are closed literal tags, and the
 * only dynamic argument is `errorClassName(<caught>)`.
 */
import { decodeCadreInvitation, mergeSeedPeers } from '@serfab/cadre-core';
import { joinNetwork } from '@votetorrent/vote-engine/rn';
import type { NetworkJoinCode, NetworkJoinResult, NetworkJoinStep } from '@votetorrent/vote-engine/rn';
import type { INetworksEngine, NetworkReference, User } from '@votetorrent/vote-core';
import { withJoining } from './founder-intent';
import { rememberJoinedNetwork } from './joined-networks';
import { rememberJoinBootstrap } from './join-bootstrap';
import { isSelfVouched } from './self-voucher';
import { reanchorOwnKey } from './owner-trust';
import { errorClassName } from '../utils/errorClassName';

/** The slice of a cadre-core `CadreNode` a join uses (the real class satisfies it; callers cast through unknown). */
export interface AuthorityJoinNode {
	readonly partyId: string;
	readonly peerId?: { toString(): string };
	redeemCadreInvitation(invitation: any): Promise<unknown>;
	getControlDatabase(): {
		queryCadrePeers(retry?: boolean): Promise<ReadonlyArray<any>>;
		queryCadreInvites(retry?: boolean): Promise<ReadonlyArray<any>>;
		queryCadreInviteUsages(retry?: boolean): Promise<ReadonlyArray<any>>;
		querySeedPeers(): Promise<ReadonlyArray<any>>;
		getOwnerKeys(): Promise<ReadonlySet<string>>;
	} | null;
	getTrustedOwnerStore(): { has(ownerKey: string): boolean } | null;
	getIdentityOwnerKey(): { publicKeyB64: string };
	getControlNode(): { getConnections(): ReadonlyArray<any> } | null | undefined;
	refreshMembershipGate(reason: any): Promise<unknown>;
	reconcileControlCohort(): Promise<unknown>;
	wireOwnKeyIfOwner(signer?: unknown): Promise<boolean>;
	/** The identity owner signer (identity-owner-key.ts), handed to wireOwnKeyIfOwner by reanchorOwnKey. */
	getIdentityOwnerSigner?(): unknown;
}

export type AuthorityNetworkJoinResult =
	| NetworkJoinResult
	| { ok: false; reason: 'founder-cannot-join'; detail: string };

/** Thrown when the founder guard cannot read the owner list, so the join must not run. */
export class FounderGuardUnreadableError extends Error {
	readonly founderGuardUnreadable = true as const;

	constructor() {
		super('The owner check could not be read, so the network was not joined.');
		this.name = 'FounderGuardUnreadableError';
	}
}

export function isFounderGuardUnreadableError(e: unknown): boolean {
	return (
		typeof e === 'object' &&
		e !== null &&
		(e as { name?: unknown }).name === 'FounderGuardUnreadableError' &&
		(e as { founderGuardUnreadable?: unknown }).founderGuardUnreadable === true
	);
}

function selfPeerId(node: AuthorityJoinNode): string | null {
	return node.peerId?.toString() ?? null;
}

/** cadre-core stores `expiresAt` as a T-form UTC datetime with no zone suffix. */
function invitationExpiresAtMs(invitation: any): number | null {
	const at = invitation?.invite?.expiresAt;
	if (typeof at !== 'string' || at.length === 0) {
		return null;
	}
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`);
	return Number.isFinite(ms) ? ms : null;
}

const trailingPeerId = (addr: string): string | undefined => addr.split('/p2p/').pop();

/**
 * OQ1 Branch B. Runs before `joinNetwork`: `redeemCadreInvitation` pins the invitation's owners
 * before it dials, and a self-vouched founder takes the already-member path and never redeems, so a
 * guard inside either would be too late. Refuses exactly when this node's identity key is a live
 * owner of its own cadre and the invitation names none of the owners the control DB holds. It fails
 * closed when the owner list cannot be read.
 */
async function founderGuard(node: AuthorityJoinNode, code: NetworkJoinCode): Promise<'allow' | 'refuse'> {
	let invitation: any;
	try {
		invitation = decodeCadreInvitation(code.invitation);
	} catch {
		// joinNetwork's own decode fails with invitation-malformed (or its older-version check fires
		// first); neither can redeem.
		return 'allow';
	}
	const db = node.getControlDatabase();
	if (!db) {
		throw new FounderGuardUnreadableError();
	}
	let owners: ReadonlySet<string>;
	try {
		owners = await db.getOwnerKeys();
	} catch (error) {
		console.error('[authority-join] founder guard: unreadable:', errorClassName(error));
		throw new FounderGuardUnreadableError();
	}
	let selfKey: string | null = null;
	try {
		selfKey = node.getIdentityOwnerKey().publicKeyB64;
	} catch {
		selfKey = null;
	}
	const invited: string[] = Array.isArray(invitation?.ownerKeys)
		? invitation.ownerKeys.filter((k: unknown): k is string => typeof k === 'string')
		: [];
	return selfKey !== null && owners.has(selfKey) && !invited.some((k) => owners.has(k)) ? 'refuse' : 'allow';
}

/**
 * Run a join from a decoded code (D-26, D-30). Resolves a join problem as `ok: false`. It rejects
 * only with: FounderIntentBusyError (before any step), a TypeError on an empty hash, the error
 * `rememberJoinedNetwork` rejected with after an ok join, or FounderGuardUnreadableError.
 */
export function runAuthorityNetworkJoin(args: {
	node: AuthorityJoinNode;
	networksEngine: Pick<INetworksEngine, 'joinFromStrand'>;
	user: User | undefined;
	code: NetworkJoinCode;
	onStep?: (step: NetworkJoinStep) => void;
}): Promise<AuthorityNetworkJoinResult> {
	const { node } = args;
	return withJoining(args.code.networkHash, async (): Promise<AuthorityNetworkJoinResult> => {
		if ((await founderGuard(node, args.code)) === 'refuse') {
			console.warn('[authority-join] founder guard: refused');
			return { ok: false, reason: 'founder-cannot-join', detail: 'founder-of-own-cadre' };
		}
		let members: string[] = [];
		const result = await joinNetwork({
			node,
			networksEngine: args.networksEngine,
			user: args.user,
			code: args.code,
			decodeInvitation: (encoded: string) => {
				const invitation = decodeCadreInvitation(encoded);
				members = Array.isArray(invitation.members) ? [...invitation.members] : [];
				return invitation;
			},
			invitationExpiresAtMs,
			isSelfAdmitted: async () => {
				const id = selfPeerId(node);
				return id !== null && isSelfVouched(node, id);
			},
			// What redeemCadreInvitation does after a reply, through public API (spike 100 f1-mitigate):
			// drop the connection the lost reply rode on (it can linger half-open), merge the replicated
			// seed peers, refresh the membership gate and reconcile the control cohort.
			afterFallbackAdmission: async () => {
				const controlNode = node.getControlNode();
				const memberIds = new Set(members.map(trailingPeerId).filter(Boolean));
				for (const conn of controlNode?.getConnections() ?? []) {
					if (memberIds.has(conn?.remotePeer?.toString())) {
						await conn.close?.().catch(() => undefined);
					}
				}
				const selfId = selfPeerId(node);
				const seeds = (await node.getControlDatabase()?.querySeedPeers().catch(() => [])) ?? [];
				if (controlNode) {
					await mergeSeedPeers(controlNode as any, seeds.filter((p) => p.peerId !== selfId) as any).catch(() => undefined);
				}
				await node.refreshMembershipGate('invitation-redeemed');
				await node.reconcileControlCohort().catch(() => undefined);
			},
			rememberBootstrap: async () => rememberJoinBootstrap(members),
			getPeerCount: () => node.getControlNode()?.getConnections().length ?? 0,
			onStep: args.onStep,
		});
		if (result.ok) {
			// D-30: recorded inside the joining window and never swallowed. A hash left off the list
			// could open as founder on a cold start with the relay down (memory
			// project_strand_founder_derivation_deadlock). A retry of the same code heals it:
			// already-member, then already-joined, then the list is written again.
			try {
				await rememberJoinedNetwork(args.code.networkHash);
			} catch (error) {
				console.error('[authority-join] joined but not recorded:', errorClassName(error));
				throw error;
			}
		}
		return result;
	});
}

/**
 * The locked completion order (D-26; D-09 via RESEARCH C15): selectNetwork, then the bounded own-key
 * wiring, then the owner trust refresh ONLY when this node's own row is self-vouched. A failed redeem
 * can leave owner pins behind, and the notice must not clear for a node that is not a member.
 *
 * Rejects only with selectNetwork's own rejection (the same object, NO_KEY_PROVISIONED included).
 * Discretion: a not-self-vouched own row returns trustSaved false, so the caller shows the
 * trust-not-saved warning and the persistent notice stays accurate until the next classification.
 * Never pins: no trustOwnerKeys, no store.trust.
 */
export async function completeAuthorityJoin(args: {
	node: AuthorityJoinNode;
	networkRef: NetworkReference;
	selectNetwork: (ref: NetworkReference) => Promise<void>;
	refreshOwnerTrust: () => Promise<void>;
}): Promise<{ trustSaved: boolean }> {
	await args.selectNetwork(args.networkRef);
	const wired = await reanchorOwnKey(args.node);
	const trustSaved = wired === 'wired' || wired === 'not-owner';
	let vouched: boolean;
	try {
		const id = selfPeerId(args.node);
		vouched = id !== null && (await isSelfVouched(args.node, id));
	} catch (error) {
		console.error('[authority-join] complete: trust refresh failed:', errorClassName(error));
		return { trustSaved: false };
	}
	if (!vouched) {
		console.warn('[authority-join] complete: not self-vouched');
		return { trustSaved: false };
	}
	try {
		await args.refreshOwnerTrust();
	} catch (error) {
		console.error('[authority-join] complete: trust refresh failed:', errorClassName(error));
		return { trustSaved: false };
	}
	return { trustSaved };
}
