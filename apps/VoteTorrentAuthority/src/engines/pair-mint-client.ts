/**
 * pair-mint-client.ts — find the cadre's owner phones and ask them, one at a time, for a mint over
 * the pair-mint protocol (D-22, D-26).
 *
 * A current officer whose phone is not a cadre owner cannot mint the single-use invitation a
 * browser pairing needs; an owner phone can. `findOwnerTargets` turns the replicated control rows
 * into dial targets: the TRUSTED live owner keys (`listOwnerKeys`) matched against
 * `CadrePeer.publicKey` (`queryCadrePeers`), this phone excluded, connected owners first, then the
 * most recently seen. Each owner's addresses come from its signed peer record first
 * (`resolvePeerAddrs`, relay addresses first), then from a live connection's remote address, then
 * from the join-bootstrap list. Every address ends in `/p2p/<ownerPeerId>`, so libp2p authenticates
 * the peer it reaches. The lookup never throws: a failed read is "no target".
 *
 * `createPairMintFailoverClient` walks those targets with the same failover rules as the Voter's
 * vote-send flow:
 *  - a throw BEFORE the request frame went out (`requestSent: false`) moves to the next target;
 *  - a REPLY of any kind (minted, removed or refused) is returned as is, and nobody else is asked;
 *  - a throw marked `requestSent: true` is NEVER resent elsewhere. The owner may already have
 *    minted, and a resend would spend a second single-use invitation for one pairing. The caller
 *    gets `PairMintNoReplyError`; a Retry is a NEW request with a fresh nonce and signature.
 *  - when nobody answered, one stable `PairMintUnreachableError`.
 * The client is generic over the request (mint or remove), so the paired-browsers list can reuse it.
 *
 * Bearer hygiene: a reply can carry an invitation's private key. Errors here are fixed-message
 * classes that carry no target, address, peer id or cause. No console calls in this file.
 */
import type { PairMintLibp2pLike, PairMintReply, PairMintRequest, requestPairMint } from '@votetorrent/vote-engine/rn';
import { multiaddr } from '@multiformats/multiaddr';
import { readJoinBootstrap } from './join-bootstrap';

/** Covers the ~18 s first relay attempt seen on phones. */
export const PAIR_MINT_TARGET_TIMEOUT_MS = 20_000;
export const PAIR_MINT_TOTAL_BUDGET_MS = 60_000;
export const PAIR_MINT_MAX_TARGETS = 8;
export const PAIR_MINT_ADDRS_PER_OWNER = 3;

export interface DialTarget {
	readonly peerId: string;
	/** A Multiaddr (or whatever the control node's dialProtocol accepts). */
	readonly addr: unknown;
	readonly source: 'record' | 'connection' | 'join-bootstrap';
}

/** The slice of a cadre-core `CadreNode` the owner lookup needs. */
export interface PairMintClientNode {
	readonly peerId?: { toString(): string };
	getControlNode(): unknown;
	listOwnerKeys(): Promise<ReadonlyArray<{ key: string; trusted: boolean }>>;
	getControlDatabase(): {
		queryCadrePeers(
			retry?: boolean,
		): Promise<ReadonlyArray<{ peerId: string; publicKey: string | null; updatedAt: number }>>;
	} | null;
	resolvePeerAddrs(peerId: string): Promise<ReadonlyArray<unknown>>;
}

export class PairMintUnreachableError extends Error {
	readonly requestSent = false;
	constructor() {
		super('pair-mint: no owner answered');
		this.name = 'PairMintUnreachableError';
	}
}

export class PairMintNoReplyError extends Error {
	readonly requestSent = true;
	constructor() {
		super('pair-mint: the request was sent but no reply arrived');
		this.name = 'PairMintNoReplyError';
	}
}

export class PairMintCancelledError extends Error {
	constructor() {
		super('pair-mint: cancelled');
		this.name = 'PairMintCancelledError';
	}
}

type RequestPairMint = typeof requestPairMint;

function str(value: unknown): string | null {
	try {
		const s = (value as { toString(): string } | null | undefined)?.toString();
		return typeof s === 'string' && s.length > 0 ? s : null;
	} catch {
		return null;
	}
}

/** `/p2p/<id>` at the end of an address string, or null. */
function trailingPeerId(addr: string): string | null {
	const m = /\/p2p\/([^/]+)$/.exec(addr);
	return m ? m[1] : null;
}

interface LiveConnection {
	peer: string;
	addr: unknown;
}

function liveConnections(control: unknown): LiveConnection[] {
	try {
		const get = (control as { getConnections?: () => unknown } | null)?.getConnections;
		if (typeof get !== 'function') return [];
		const conns = get.call(control);
		if (!Array.isArray(conns)) return [];
		const out: LiveConnection[] = [];
		for (const c of conns) {
			const peer = str((c as { remotePeer?: unknown } | null)?.remotePeer);
			if (peer) out.push({ peer, addr: (c as { remoteAddr?: unknown }).remoteAddr });
		}
		return out;
	} catch {
		return [];
	}
}

function defaultToDialTarget(addr: string): unknown {
	return multiaddr(addr);
}

/**
 * The owner phones to ask, in order, with at most `PAIR_MINT_MAX_TARGETS` addresses deduplicated
 * by their string form. Never throws: any read failure gives [].
 */
export async function findOwnerTargets(
	node: PairMintClientNode,
	deps?: { readJoinBootstrap?: () => Promise<string[]>; toDialTarget?: (addr: string) => unknown },
): Promise<DialTarget[]> {
	try {
		const self = str(node.peerId);
		const ownerKeys = new Set((await node.listOwnerKeys()).filter((k) => k.trusted === true).map((k) => k.key));
		if (ownerKeys.size === 0) return [];
		const db = node.getControlDatabase();
		if (!db) return [];
		const rows = await db.queryCadrePeers();
		const owners = rows.filter(
			(r) => typeof r.peerId === 'string' && r.peerId.length > 0 && r.publicKey !== null && ownerKeys.has(r.publicKey) && r.peerId !== self,
		);
		if (owners.length === 0) return [];

		let control: unknown = null;
		try {
			control = node.getControlNode();
		} catch {
			control = null;
		}
		const conns = liveConnections(control);
		const connected = new Set(conns.map((c) => c.peer));
		const ordered = [...owners].sort((a, b) => {
			const ca = connected.has(a.peerId) ? 1 : 0;
			const cb = connected.has(b.peerId) ? 1 : 0;
			if (ca !== cb) return cb - ca;
			return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
		});

		const toDialTarget = deps?.toDialTarget ?? defaultToDialTarget;
		let bootstrap: string[] | null = null;
		const targets: DialTarget[] = [];
		const seen = new Set<string>();
		const push = (peerId: string, addr: unknown, source: DialTarget['source']): void => {
			if (targets.length >= PAIR_MINT_MAX_TARGETS) return;
			const key = String(addr);
			if (seen.has(key)) return;
			seen.add(key);
			targets.push({ peerId, addr, source });
		};

		for (const owner of ordered) {
			if (targets.length >= PAIR_MINT_MAX_TARGETS) break;
			let record: ReadonlyArray<unknown> = [];
			try {
				record = await node.resolvePeerAddrs(owner.peerId);
				if (!Array.isArray(record)) record = [];
			} catch {
				record = [];
			}
			if (record.length > 0) {
				for (const addr of record.slice(0, PAIR_MINT_ADDRS_PER_OWNER)) push(owner.peerId, addr, 'record');
				continue;
			}
			const live = conns.find((c) => c.peer === owner.peerId && str(c.addr)?.endsWith(`/p2p/${owner.peerId}`) === true);
			if (live) {
				push(owner.peerId, live.addr, 'connection');
				continue;
			}
			if (bootstrap === null) {
				try {
					bootstrap = await (deps?.readJoinBootstrap ?? readJoinBootstrap)();
					if (!Array.isArray(bootstrap)) bootstrap = [];
				} catch {
					bootstrap = [];
				}
			}
			for (const text of bootstrap) {
				if (typeof text !== 'string' || trailingPeerId(text) !== owner.peerId) continue;
				let addr: unknown;
				try {
					addr = toDialTarget(text);
				} catch {
					continue;
				}
				push(owner.peerId, addr, 'join-bootstrap');
			}
		}
		return targets;
	} catch {
		return [];
	}
}

/** Resolves the call, or rejects `PairMintCancelledError` as soon as `signal` aborts. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			reject(new PairMintCancelledError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				if (settled) return;
				settled = true;
				resolve(value);
			},
			(err: unknown) => {
				signal.removeEventListener('abort', onAbort);
				if (settled) return;
				settled = true;
				reject(err);
			},
		);
	});
}

/**
 * A client that asks `targets` in order over `control` (the CONTROL node), with the no-resend rule
 * in the header. `request` defaults to vote-engine's `requestPairMint`, required lazily.
 */
export function createPairMintFailoverClient(
	control: unknown,
	targets: readonly DialTarget[],
	options?: {
		targetTimeoutMs?: number;
		totalBudgetMs?: number;
		nowMs?: () => number;
		request?: RequestPairMint;
	},
): { call(request: PairMintRequest, opts?: { signal?: AbortSignal }): Promise<PairMintReply> } {
	const targetTimeoutMs = options?.targetTimeoutMs ?? PAIR_MINT_TARGET_TIMEOUT_MS;
	const totalBudgetMs = options?.totalBudgetMs ?? PAIR_MINT_TOTAL_BUDGET_MS;
	const nowMs = options?.nowMs ?? Date.now;
	const list = [...targets];
	return {
		async call(request: PairMintRequest, opts?: { signal?: AbortSignal }): Promise<PairMintReply> {
			const signal = opts?.signal;
			const start = nowMs();
			let send: RequestPairMint | undefined = options?.request;
			for (const target of list) {
				if (signal?.aborted) throw new PairMintCancelledError();
				if (nowMs() - start >= totalBudgetMs) break;
				if (!send) {
					// Required lazily: screens import this module and several screen suites stub vote-core.
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					send = (require('@votetorrent/vote-engine/rn') as { requestPairMint: RequestPairMint }).requestPairMint;
				}
				let reply: PairMintReply;
				try {
					reply = await raceAbort(send(control as PairMintLibp2pLike, target.addr, request, { timeoutMs: targetTimeoutMs }), signal);
				} catch (err) {
					if (err instanceof PairMintCancelledError) throw err;
					if ((err as { requestSent?: unknown } | null)?.requestSent === true) throw new PairMintNoReplyError();
					continue;
				}
				return reply;
			}
			if (signal?.aborted) throw new PairMintCancelledError();
			throw new PairMintUnreachableError();
		},
	};
}
