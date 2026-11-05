/**
 * pool-rendezvous-host.ts — the Authority's node is the meeting point for its voters' vote pools
 * (spike 102, user decision: "through the rendezvous").
 *
 * Voters only dial OUT: each keeps its pool mailbox here and polls it, so a phone nobody can dial
 * still pools. The rendezvous never reads a message (pool envelopes are sealed end to end) and it
 * keys everything by throwaway pool identities, never by the voter's network identity. It admits
 * only peers that are members of this authority's cadre (voters join as members, spike 100).
 *
 * Best effort: a failure to attach is logged and never fails the node's boot.
 */
import {PoolRendezvous, attachPoolRendezvous} from '@votetorrent/vote-engine/rn';

interface RendezvousHostNode {
	peerId?: {toString(): string}
	getControlNode(): unknown
	/** cadre-core resolves this asynchronously */
	isAuthorizedMember(peerId: string): boolean | Promise<boolean>
}

/** Attach the pool rendezvous to `node`'s control libp2p node; resolves to a detach function. */
export async function hostPoolRendezvous(node: RendezvousHostNode): Promise<() => Promise<void>> {
	const self = node.peerId?.toString();
	const rendezvous = new PoolRendezvous({
		isAllowed: async (peer) => peer === self || (await node.isAuthorizedMember(peer)) === true,
	});
	const control = node.getControlNode() as Parameters<typeof attachPoolRendezvous>[0] | null;
	if (control === null || control === undefined) {
		throw new Error('pool rendezvous: the control node is not running');
	}
	return await attachPoolRendezvous(control, rendezvous);
}
