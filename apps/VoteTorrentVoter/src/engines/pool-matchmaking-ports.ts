/**
 * pool-matchmaking-ports.ts — binds vote-engine's `PoolMatchmakingPorts` to Optimystic matchmaking on this
 * phone's live strand node (optimystic 1.24; user decision 2026-11-02: discover pools through matchmaking
 * AND the Authority rendezvous, merged).
 *
 * Provider side: one upstream `MatchmakingProviderSession` per pool topic, registered at the topic's cohort
 * (cohort-topic tier T2), signed with the node's peer key. Seeker side: a one-shot `QueryV1` through the
 * upstream libp2p matchmaking transport. Every returned entry's provider signature is re-checked here
 * (`verifyProviderEntry`), so a cohort primary cannot invent an entry for a peer that did not register it;
 * vote-engine then checks the pool identity's own signature on the listing inside it.
 *
 * Needs a strand node built with the cohort-topic substrate (`strandReactivity` on, CadreNodeProvider): that
 * is what gives the node its cohort-topic host and matchmaking handlers. Returns null otherwise, and the send
 * flow falls back to the rendezvous alone.
 *
 * The cohort-topic host is not on db-p2p's typed host surface (OptimysticNodeAttachments says typing it is a
 * separate job), so it is read off the node by name, as the Public view's reactivity bridge already does.
 *
 * Self-primary: FRET can route a topic's cohort primary to this very node, which libp2p cannot dial. The
 * upstream transport then calls `selfServe.query`, bound here to the node's own query handler over its own
 * registry, exactly what a remote seeker's query would reach.
 */
import {
	MatchmakingProviderSession,
	createLibp2pMatchmakingTransport,
	createMatchmakingQueryHandler,
	signPeer,
} from '@optimystic/db-p2p';
import {
	b64urlToBytes,
	bytesToB64url,
	createMatchTopicAnchor,
	createRingHash,
	createTierAddressing,
	decodeQueryReplyV1,
	encodeQueryV1,
	verifyProviderEntry,
} from '@optimystic/db-core';
import type {CohortTopicService, QueryV1} from '@optimystic/db-core';
import type {Libp2p, PrivateKey} from '@libp2p/interface';
import {poolMatchTopic} from '@votetorrent/vote-engine/rn';
import type {PoolMatchEntry, PoolMatchmakingPorts} from '@votetorrent/vote-engine/rn';

/** The host's cohort registry type (db-p2p does not export it by name). */
type CoordRegistry = Parameters<typeof createMatchmakingQueryHandler>[0]['registry'];

/** db-p2p's default cohort width (`cohortTopic.wantK`); cadre-core passes no override. */
export const POOL_MATCH_WANT_K = 16;

/** The parts of a db-p2p strand node this module reads. */
interface MatchmakingNode {
	peerId: {toString(): string};
	services?: {fret?: unknown};
	peerPrivateKey?: PrivateKey;
	matchmakingArrivalPush?: unknown;
	cohortTopicHost?: {service?: CohortTopicService; registry?: CoordRegistry};
}

/** The cadre node surface this module needs: the strand instance for a network. */
export interface StrandNodeSource {
	getStrand?(strandId: string): {libp2pNode?: unknown} | undefined;
}

/**
 * Ports for the strand of `networkHash`, or null when the node is not booted, the strand is not live, or it
 * was built without the cohort-topic substrate.
 */
export function poolMatchmakingPorts(source: StrandNodeSource | null | undefined, networkHash: string | undefined): PoolMatchmakingPorts | null {
	if (source?.getStrand === undefined || networkHash === undefined) return null;
	const raw = source.getStrand(networkHash)?.libp2pNode as MatchmakingNode | undefined;
	const host = raw?.cohortTopicHost;
	const service = host?.service;
	const registry = host?.registry;
	const key = raw?.peerPrivateKey;
	const fret = raw?.services?.fret;
	if (raw === undefined || service === undefined || registry === undefined || key === undefined || fret === undefined) return null;

	const selfPeerId = raw.peerId.toString();
	const anchor = createMatchTopicAnchor();
	const sign = async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(key, payload));
	const serveOwnQuery = createMatchmakingQueryHandler({
		registry,
		addressing: createTierAddressing(createRingHash()),
		sign,
	});
	const transport = createLibp2pMatchmakingTransport({
		node: raw as unknown as Libp2p,
		fret: fret as Parameters<typeof createLibp2pMatchmakingTransport>[0]['fret'],
		selfPeerId,
		key,
		wantK: POOL_MATCH_WANT_K,
		selfServe: {
			query: async (q: QueryV1) => {
				const frame = await serveOwnQuery(encodeQueryV1(q), raw.peerId as never);
				return frame === undefined ? undefined : decodeQueryReplyV1(frame);
			},
		},
	});

	return {
		selfPeerId,
		openProvider: () => {
			const session = new MatchmakingProviderSession({service, sign, anchor});
			return {
				register: async (topicLabel, reg) => {
					await session.register(poolMatchTopic(topicLabel), reg);
				},
				withdraw: async () => {
					await session.withdraw();
				},
			};
		},
		query: async (topicLabel, limit) => {
			const {kind, label} = poolMatchTopic(topicLabel);
			const topicId = anchor.topicId(kind, label);
			const q: QueryV1 = {
				v: 1,
				topicId: bytesToB64url(topicId),
				includeProviders: true,
				includeSeekers: false,
				limit,
				requesterId: selfPeerId,
				timestamp: Date.now(),
				// The serve side checks the connection's verified peer, not this field (same as upstream's own walk query).
				signature: 'AA',
			};
			const reply = await transport.queryCohort(q);
			const out: PoolMatchEntry[] = [];
			for (const entry of reply.providers ?? []) {
				if (!verifyProviderEntry(b64urlToBytes(q.topicId), entry, transport.verifyEntry)) continue;
				out.push({participantId: entry.participantId, capabilities: entry.capabilities, contactHint: entry.contactHint});
			}
			return out;
		},
	};
}
