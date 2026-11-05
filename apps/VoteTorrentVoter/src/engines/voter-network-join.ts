/**
 * voter-network-join.ts — wires vote-engine's `joinNetwork` (spike 100) to this phone's CadreNode.
 *
 * vote-engine never imports cadre-core (D-03), so every cadre-core call the join needs is supplied
 * here: decoding the invitation, redeeming it, the self-admission check, and the post-redemption
 * steps a redemption that throws would have skipped. Proven end to end on real CadreNodes by
 * `.planning/spikes/100-voter-joins-authority-network/product-join.ts`, which uses these exact
 * calls.
 */
import {decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission} from '@serfab/cadre-core';
import {joinNetwork} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinCode, NetworkJoinResult, NetworkJoinStep} from '@votetorrent/vote-engine/rn';
import type {INetworksEngine, User} from '@votetorrent/vote-core';
import {rememberJoinBootstrap} from './join-bootstrap';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The slice of a cadre-core `CadreNode` a join uses (the real class satisfies it). */
export interface VoterJoinNode {
	readonly partyId: string;
	readonly peerId: {toString(): string};
	redeemCadreInvitation(invitation: any): Promise<unknown>;
	getControlDatabase(): {
		queryCadrePeers(): Promise<ReadonlyArray<any>>;
		queryCadreInvites(): Promise<ReadonlyArray<any>>;
		queryCadreInviteUsages(): Promise<ReadonlyArray<any>>;
		querySeedPeers(): Promise<ReadonlyArray<any>>;
	} | null;
	getTrustedOwnerStore(): {has(ownerKey: string): boolean; all(): ReadonlySet<string>} | null;
	getControlNode(): {getConnections(): ReadonlyArray<any>} | null | undefined;
	refreshMembershipGate(reason: any): Promise<unknown>;
	reconcileControlCohort(): Promise<unknown>;
}

/**
 * True when this node's OWN replicated `CadrePeer` row carries an invitation admission that
 * chains to an anchored owner — the invitation branch of the Authority's `isSelfVouched`
 * (engines/self-voucher.ts), and `enrolment-smoke.mjs`'s waitForSelfAdmitted.
 */
export async function isSelfAdmitted(node: VoterJoinNode): Promise<boolean> {
	const store = node.getTrustedOwnerStore();
	const db = node.getControlDatabase();
	if (!store || !db) {
		return false;
	}
	const selfId = node.peerId.toString();
	const self = (await db.queryCadrePeers()).find(row => row.peerId === selfId);
	if (!self || !(self.vouchSig === null && self.vouchUsage != null)) {
		return false;
	}
	const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()]);
	const usage = usages.find(u => u.usageStampId === self.vouchUsage);
	const invite = usage === undefined ? undefined : invites.find(i => i.key === usage.inviteKey);
	if (usage === undefined || invite === undefined) {
		return false;
	}
	return verifyInvitationAdmission(node.partyId, self, usage, invite, (key: string) => store.has(key));
}

/**
 * UAT 65 F1: true when this phone already joined a DIFFERENT cadre than the invitation's. Both apps
 * run one party id ('votetorrent'), so every authority's cadre shares the control protocols and this
 * phone's one control store: a phone that joined authority 1 would pass `isSelfAdmitted` on
 * authority 1's rows, never redeem authority 2's invitation, and wait forever for its strand.
 * "Different" = the trust anchor pins owner keys and NONE of them is one the invitation pins.
 *
 * Only the trust anchor is read: only a redemption pins keys there. The control database's
 * OwnerKey rows are NOT evidence of a join: a fresh phone replicates them from its boot peer (a
 * relay or member of any 'votetorrent' cadre) before it joins anything, so reading them would
 * refuse a first join (host repro FRESH2, 2026-11-02). A phone with the anchor cleared but the
 * control store kept is not caught here; its join ends at the sync budget instead.
 */
export async function belongsToOtherCadre(node: VoterJoinNode, invitation: any): Promise<boolean> {
	const pinned: unknown = invitation?.ownerKeys;
	if (!Array.isArray(pinned) || pinned.length === 0) {
		return false;
	}
	const anchored = node.getTrustedOwnerStore()?.all() ?? new Set<string>();
	return anchored.size > 0 && !pinned.some(key => typeof key === 'string' && anchored.has(key));
}

/** cadre-core stores `expiresAt` as a T-form UTC datetime with no zone suffix. */
export function invitationExpiresAtMs(invitation: any): number | null {
	const at = invitation?.invite?.expiresAt;
	if (typeof at !== 'string' || at.length === 0) {
		return null;
	}
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`);
	return Number.isFinite(ms) ? ms : null;
}

const trailingPeerId = (addr: string): string | undefined => addr.split('/p2p/').pop();

/** Run a join from a decoded code. Never throws for a join problem (see `NetworkJoinResult`). */
export async function runVoterNetworkJoin(args: {
	node: VoterJoinNode;
	networksEngine: Pick<INetworksEngine, 'joinFromStrand'>;
	user: User | undefined;
	code: NetworkJoinCode;
	onStep?: (step: NetworkJoinStep) => void;
	/** UAT 65 F1: release the first-sync wait a join left pending when its budget ran out. */
	onSyncAbandoned?: () => Promise<void> | void;
}): Promise<NetworkJoinResult> {
	const {node} = args;
	let members: string[] = [];
	return joinNetwork({
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
		isSelfAdmitted: () => isSelfAdmitted(node),
		belongsToOtherCadre: (invitation: unknown) => belongsToOtherCadre(node, invitation),
		onSyncAbandoned: args.onSyncAbandoned,
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
			const selfId = node.peerId.toString();
			const seeds = (await node.getControlDatabase()?.querySeedPeers().catch(() => [])) ?? [];
			if (controlNode) {
				await mergeSeedPeers(controlNode as any, seeds.filter(p => p.peerId !== selfId) as any).catch(() => undefined);
			}
			await node.refreshMembershipGate('invitation-redeemed');
			await node.reconcileControlCohort().catch(() => undefined);
		},
		rememberBootstrap: async () => rememberJoinBootstrap(members),
		getPeerCount: () => node.getControlNode()?.getConnections().length ?? 0,
		onStep: args.onStep,
	});
}
