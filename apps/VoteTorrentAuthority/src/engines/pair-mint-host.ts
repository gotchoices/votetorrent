/**
 * pair-mint-host.ts — the owner side of `/votetorrent/pair-mint/1.0.0` (D-22, D-26, D-28).
 *
 * A current officer whose phone is a cadre member but not an owner asks an owner phone for ONE single-use
 * cadre invitation, so the officer's browser can join the cadre (D-22, D-26). This module binds the
 * vote-engine service's ports (`createPairMintService`, 66-03) to this phone's cadre-core node and to the
 * owner's own strand database, and serves it on the control node. It runs on owner phones only
 * ({@link startPairMintHost}), best effort: the provider never awaits it and a failure never fails boot.
 *
 * D-28: the owner approves automatically, records every member request's outcome in its mint log
 * (`pairing-owner-store.ts`) and honours its off switch for MINTS only; a remove request is never gated.
 * An unreadable switch reads as OFF for mints (fail closed).
 *
 * Own-network rule (T-66-03-12): every statement, remove request and current-officer check is verified
 * against the network this phone's app has open (`recentNetworks[0]`, the strand database of that hash),
 * never against the request's `networkHash`. A statement signed for another network therefore fails its
 * signature check here, and an owner of two networks can never be talked into minting for the wrong one.
 * No open network means every check fails closed.
 *
 * R-A: `handleLocal` (the owner pairing its own browser) calls the same service with this phone's own
 * identity peer id as the caller, so the statement's `requesterPeerId` must be that id.
 * R-B: the current-officer check is `isCurrentPairingOfficer` on the owner's strand database, at the
 * owner's clock.
 *
 * Nothing here writes a strand row: the strand database is only read through vote-engine's verifiers, and
 * the invitation lives only in the reply frame (never logged, stored or put in an error). Nothing here logs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
	PairMintLibp2pLike,
	PairMintMintRequest,
	PairMintPorts,
	PairMintRemoveRequest,
	PairMintReply,
	PairMintRequest,
	PairingVerifyResult,
} from '@votetorrent/vote-engine/rn';
import { createPairingInvitation, PairingInviteError, voterInviteCapability, type PairingInviteNode } from './voter-invite';
import { createPairMintLog, readPairingSwitch } from './pairing-owner-store';

type VoteEngineRn = typeof import('@votetorrent/vote-engine/rn');
type OwnDb = Parameters<VoteEngineRn['verifyPairingStatement']>[0];

/**
 * Required lazily (the `voter-invite.ts` idiom): `CadreNodeProvider` imports this module, and a phone or a
 * test suite that never reaches an owner must not load the vote-engine runtime for it.
 */
function voteEngine(): VoteEngineRn {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('@votetorrent/vote-engine/rn') as VoteEngineRn;
}

/** NetworksEngine's recent-networks key (read here, never written). */
export const ACTIVE_NETWORKS_KEY = 'recentNetworks';

/**
 * The hash of the network this phone's app has open: `recentNetworks[0].hash`. `NetworksEngine.open()`
 * moves the opened network to index 0 and AppProvider re-attaches index 0 at boot, so the first entry is
 * the active network. Null when absent, malformed, empty or longer than 128 chars; never throws.
 */
export async function readActiveNetworkHash(): Promise<string | null> {
	try {
		const raw = await AsyncStorage.getItem(ACTIVE_NETWORKS_KEY);
		if (raw === null) return null;
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list) || list.length === 0) return null;
		const first = list[0] as { hash?: unknown } | null;
		const hash = first?.hash;
		return typeof hash === 'string' && hash.length > 0 && hash.length <= 128 ? hash : null;
	} catch {
		return null;
	}
}

/** The slice of a cadre-core `CadreNode` the host needs (the real class satisfies it). */
export interface PairMintHostNode extends PairingInviteNode {
	getControlNode(): unknown;
	/** cadre-core resolves this asynchronously. */
	isAuthorizedMember(peerId: string): boolean | Promise<boolean>;
	removeMachine(peerId: string): Promise<unknown>;
	withdrawCadreInvitation(key: string): Promise<boolean>;
	getStrand(strandId: string): { database?: { getDatabase(): unknown } } | undefined;
	getControlDatabase():
		| (NonNullable<ReturnType<PairingInviteNode['getControlDatabase']>> & {
				queryCadreInviteUsages(retry?: boolean): Promise<ReadonlyArray<{ inviteKey: string; peerId: string }>>;
		  })
		| null;
}

export interface PairMintHostDeps {
	readOwnNetworkHash(): Promise<string | null>;
	isEnabled(): Promise<boolean>;
	now(): number;
	mintLog: PairMintPorts['mintLog'];
	verifiers: {
		verifyPairingStatement: VoteEngineRn['verifyPairingStatement'];
		verifyPairingRemove: VoteEngineRn['verifyPairingRemove'];
		isCurrentPairingOfficer: VoteEngineRn['isCurrentPairingOfficer'];
	};
}

/** What a caller may override; nested groups merge over the defaults. */
export type PairMintHostOverrides = Partial<Omit<PairMintHostDeps, 'verifiers'>> & {
	verifiers?: Partial<PairMintHostDeps['verifiers']>;
};

export interface PairMintHost {
	/** Idempotent: removes the protocol handler and closes the service. */
	detach(): Promise<void>;
	/** The owner's own request (its browser), with this phone's identity peer id as the caller. */
	handleLocal(request: PairMintRequest): Promise<PairMintReply>;
}

/** The 19-char canonical UTC form vote-engine's `toCanonicalDatetime` gives for a number. */
function canonicalAt(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19);
}

function resolveDeps(overrides: PairMintHostOverrides): PairMintHostDeps {
	const ve = voteEngine();
	return {
		readOwnNetworkHash: overrides.readOwnNetworkHash ?? readActiveNetworkHash,
		// An unreadable switch is OFF for mints (fail closed).
		isEnabled: overrides.isEnabled ?? (() => readPairingSwitch().catch(() => false)),
		now: overrides.now ?? (() => Date.now()),
		mintLog: overrides.mintLog ?? createPairMintLog(),
		verifiers: {
			verifyPairingStatement: overrides.verifiers?.verifyPairingStatement ?? ve.verifyPairingStatement,
			verifyPairingRemove: overrides.verifiers?.verifyPairingRemove ?? ve.verifyPairingRemove,
			isCurrentPairingOfficer: overrides.verifiers?.isCurrentPairingOfficer ?? ve.isCurrentPairingOfficer,
		},
	};
}

/** Serve the pair-mint service on `node`'s control node. Rejects when the node has no peer id or control node. */
export async function hostPairMint(node: PairMintHostNode, overrides: PairMintHostOverrides = {}): Promise<PairMintHost> {
	const self = node.peerId?.toString();
	if (!self) throw new Error('pair-mint: this device has no peer id yet');
	const control = node.getControlNode() as PairMintLibp2pLike | null | undefined;
	if (control === null || control === undefined) throw new Error('pair-mint: the control node is not running');
	const deps = resolveDeps(overrides);
	const { createPairMintService, attachPairMint } = voteEngine();

	/** The owner's own open network and its strand database, or null (every check then fails closed). */
	async function ownNetwork(): Promise<{ networkHash: string; db: OwnDb } | null> {
		try {
			const networkHash = await deps.readOwnNetworkHash();
			if (!networkHash) return null;
			const db = node.getStrand(networkHash)?.database?.getDatabase();
			if (db === null || db === undefined) return null;
			return { networkHash, db: db as OwnDb };
		} catch {
			return null;
		}
	}

	/** This cadre's redemption rows, or null when they cannot be read. */
	async function usageRows(): Promise<ReadonlyArray<{ inviteKey: string; peerId: string }> | null> {
		try {
			const db = node.getControlDatabase();
			if (!db) return null;
			return await db.queryCadreInviteUsages();
		} catch {
			return null;
		}
	}

	const ports: PairMintPorts = {
		isAllowed: async (peer) => {
			if (peer === self) return true;
			try {
				return (await node.isAuthorizedMember(peer)) === true;
			} catch {
				return false;
			}
		},
		isEnabled: () => deps.isEnabled(),
		now: () => deps.now(),
		createInvitation: ({ expiresInMs }) => createPairingInvitation(node, { expiresInMs }),
		isCurrentOfficer: async (userId, nowCanonical) => {
			const own = await ownNetwork();
			if (!own) return false;
			try {
				return (await deps.verifiers.isCurrentPairingOfficer(own.db, { userId, nowCanonical })) === true;
			} catch {
				return false;
			}
		},
		verifyStatement: async (req: PairMintMintRequest): Promise<PairingVerifyResult> => {
			const own = await ownNetwork();
			if (!own) return { ok: false, reason: 'not-officer' };
			try {
				return await deps.verifiers.verifyPairingStatement(own.db, {
					networkHash: own.networkHash,
					statement: {
						userId: req.userId,
						nonce: req.nonce,
						expiresAt: req.expiresAt,
						requesterPeerId: req.requesterPeerId,
						keyPub: req.keyPub,
						sig: req.sig,
					},
					nowCanonical: canonicalAt(deps.now()),
					checkExpiry: true,
				});
			} catch {
				return { ok: false, reason: 'not-officer' };
			}
		},
		verifyRemove: async (req: PairMintRemoveRequest): Promise<boolean> => {
			const own = await ownNetwork();
			if (!own) return false;
			try {
				const verdict = await deps.verifiers.verifyPairingRemove(own.db, {
					networkHash: own.networkHash,
					request: {
						userId: req.userId,
						nonce: req.nonce,
						peerId: req.peerId,
						expiresAt: req.expiresAt,
						keyPub: req.keyPub,
						sig: req.sig,
					},
					nowCanonical: canonicalAt(deps.now()),
				});
				return verdict.ok === true;
			} catch {
				return false;
			}
		},
		inviteUsagePeer: async (inviteKey) => {
			const rows = await usageRows();
			return rows?.find((row) => row.inviteKey === inviteKey)?.peerId ?? null;
		},
		removeMachine: async (peerId) => {
			try {
				await node.removeMachine(peerId);
			} catch (err) {
				// cadre-core's MachineRemovalRefusedError names the rule in `code`; its message is never passed on.
				if ((err as { code?: unknown } | null)?.code === 'not-an-owner') throw new PairingInviteError('not-owner');
				throw new Error('pair-mint: remove failed');
			}
		},
		mintLog: deps.mintLog,
	};

	const service = createPairMintService(ports);
	const detachWire = await attachPairMint(control, service);

	let detached: Promise<void> | null = null;
	const detach = (): Promise<void> => {
		if (!detached) {
			detached = (async () => {
				await detachWire();
				await service.close();
			})();
		}
		return detached;
	};
	const handleLocal = (request: PairMintRequest): Promise<PairMintReply> => service.handle(self, request);
	return { detach, handleLocal };
}

/** Can this node author owner writes (an invitation is one)? A read that throws counts as no. */
function canAuthorOwnerWrites(node: PairMintHostNode): boolean {
	try {
		return node.getSeedBootstrapService()?.canAuthorize() === true;
	} catch {
		return false;
	}
}

/**
 * Host the service only on a phone whose own identity owner key is a live owner key of its cadre
 * (`voterInviteCapability === 'ready'`); null otherwise. It never runs owner setup and reads no storage.
 *
 * A cheap gate runs first: the seed bootstrap must be able to author owner writes. The boot re-anchor
 * wires it on every owner phone before this is called, and a phone whose seed bootstrap cannot authorize
 * could not sign an invitation anyway, so it hosts nothing. On any other phone this returns null without
 * reading the control database's owner rows.
 */
export async function startPairMintHost(node: PairMintHostNode, overrides: PairMintHostOverrides = {}): Promise<PairMintHost | null> {
	if (!canAuthorOwnerWrites(node)) return null;
	return (await voterInviteCapability(node)) === 'ready' ? hostPairMint(node, overrides) : null;
}
