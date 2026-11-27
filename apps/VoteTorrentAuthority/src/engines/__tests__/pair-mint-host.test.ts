/**
 * pair-mint-host (D-22, D-26, D-28): the owner side of /votetorrent/pair-mint/1.0.0. The host binds the
 * vote-engine service's ports to this phone's cadre-core node and to its OWN network's strand database
 * (never the request's networkHash, T-66-03-12), serves members and the owner itself (R-A), honours the
 * switch for mints only, and authorizes removes through the kept mint log and the usage rows.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	isPairingRevoked,
	PAIR_MINT_PROTOCOL,
	PairingRevocationError,
	pairingRevokeDigest,
	pairingStatementDigest,
	parsePairMintRequest,
	revokeDashboardPairing,
	type PairMintReply,
	type PairMintRequest,
} from '@votetorrent/vote-engine/rn';
import { createTestNetwork, makeDistinctTestUser, makeTestSignCallback } from '@votetorrent/vote-engine/test/fixtures/test-context';
import {
	ACTIVE_NETWORKS_KEY,
	hostPairMint,
	planRevocationActions,
	readActiveNetworkHash,
	REVOCATION_BACKSTOP_MS,
	REVOCATION_SWEEP_MAX_ACTIONS,
	REVOCATION_SWEEP_MAX_LOOKUPS,
	REVOCATION_TABLE,
	startPairMintHost,
	type PairMintHostNode,
	type PairMintHostOverrides,
} from '../pair-mint-host';
import {
	appendMintLog,
	liveMintsFor,
	PAIRING_SWITCH_KEY,
	readMintLog,
	REVOCATION_GRACE_MS,
	writePairingSwitch,
	type OwnerMintLogEntry,
} from '../pairing-owner-store';

const OWNER_KEY = { publicKeyB64: 'self-pub', privateKeyB64: 'self-priv' };
const OWN_HASH = 'ownNetHash1';
const OTHER_HASH = 'otherNetHash2';
const OWN_DB = { tag: 'own-strand-db' };
/** Stands in for cadre-core's encoded invitation (a bearer credential): long and distinctive. */
const MINT_TEXT = 'sereus-invite:1.' + 'Zq9Xv4Lm2Rt7Wp1Ks8Hd3Fg6Jb0Nc5Ya'.repeat(4);

const getItemMock = AsyncStorage.getItem as unknown as jest.Mock;
let priorGetItem: ((...a: never[]) => unknown) | undefined;
let consoleSpies: Record<string, jest.SpyInstance> = {};

beforeEach(async () => {
	priorGetItem = getItemMock.getMockImplementation();
	await AsyncStorage.clear();
	consoleSpies = {};
	for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
		consoleSpies[m] = jest.spyOn(console, m).mockImplementation(() => undefined);
	}
});

afterEach(() => {
	jest.restoreAllMocks();
	getItemMock.mockImplementation(priorGetItem);
});

/** H-13: assert inside each H test, so a later describe may allow its one sweep warn. */
function expectNoConsole(): void {
	for (const spy of Object.values(consoleSpies)) expect(spy).not.toHaveBeenCalled();
}

const canonical = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const zoneless = (ms: number) => new Date(ms).toISOString().slice(0, 23);

let nonceCounter = 0;
function freshNonce(): string {
	nonceCounter += 1;
	return `nonce${String(nonceCounter).padStart(16, '0')}`;
}

/** Count the 16-char windows of `secret` that occur in `haystack`. */
function windowHits(haystack: string, secret: string): number {
	let hits = 0;
	for (let i = 0; i + 16 <= secret.length; i++) if (haystack.includes(secret.slice(i, i + 16))) hits++;
	return hits;
}

function fakeControl() {
	const handlers = new Map<string, (stream: unknown, connection: unknown) => void>();
	return {
		handlers,
		handle: jest.fn(async (protocol: string, handler: (s: unknown, c: unknown) => void) => {
			handlers.set(protocol, handler);
		}),
		unhandle: jest.fn(async (protocol: string) => {
			handlers.delete(protocol);
		}),
		dialProtocol: jest.fn(),
	};
}

/** A one-request stream: yields the request frame, captures the reply frame. */
function requestStream(request: unknown) {
	const body = new TextEncoder().encode(JSON.stringify(request));
	const frame = new Uint8Array(4 + body.length);
	new DataView(frame.buffer).setUint32(0, body.length, false);
	frame.set(body, 4);
	let reply: unknown;
	let resolveReply: () => void = () => undefined;
	const replied = new Promise<void>((r) => {
		resolveReply = r;
	});
	return {
		stream: {
			[Symbol.asyncIterator]: () => {
				let sent = false;
				return { next: async () => (sent ? new Promise(() => undefined) : ((sent = true), { done: false, value: frame })) };
			},
			send: (bytes: Uint8Array) => {
				reply = JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
				resolveReply();
			},
			close: async () => undefined,
			abort: () => resolveReply(),
		},
		replied,
		reply: () => reply as PairMintReply,
	};
}

type UsageRow = { inviteKey: string; peerId: string };

function fakeOwnerNode(
	o: {
		owners?: string[];
		members?: string[];
		ownHash?: string;
		ownDb?: unknown;
		noStrandDb?: boolean;
		usage?: UsageRow[];
		usageThrows?: boolean;
		noControl?: boolean;
		noPeerId?: boolean;
		noDb?: boolean;
		identityThrows?: boolean;
		memberThrows?: boolean;
		/** The seed bootstrap cannot author owner writes (not wired, or not an owner). */
		cannotAuthorize?: boolean;
	} = {},
) {
	const control = fakeControl();
	const state = { owners: new Set(o.owners ?? [OWNER_KEY.publicKeyB64]), usage: o.usage ?? ([] as UsageRow[]) };
	let minted = 0;
	const node = {
		...(o.noPeerId ? {} : { peerId: { toString: () => 'ownerPeer1' } }),
		getMultiaddrs: jest.fn(() => ['/ip4/203.0.113.7/tcp/443/wss/p2p/relayPeer/p2p-circuit/p2p/ownerPeer1']),
		getIdentityOwnerKey: jest.fn(() => {
			if (o.identityThrows) throw new Error('ephemeral identity');
			return OWNER_KEY;
		}),
		getControlDatabase: jest.fn(() =>
			o.noDb
				? null
				: {
						getOwnerKeys: async () => new Set(state.owners),
						ensureOwnerKey: jest.fn(async () => false),
						queryCadrePeers: jest.fn(async () => []),
						queryCadreInviteUsages: jest.fn(async () => {
							if (o.usageThrows) throw new Error('usage unreadable');
							return state.usage;
						}),
					},
		),
		trustOwnerKeys: jest.fn(async () => undefined),
		getSeedBootstrapService: jest.fn(() => ({ canAuthorize: () => o.cannotAuthorize !== true })),
		initializeSeedBootstrap: jest.fn(async () => undefined),
		createCadreInvitation: jest.fn(async (opts: { uses?: number; expiresInMs?: number }) => {
			minted += 1;
			return { encoded: MINT_TEXT, invitation: { invite: { key: `inviteKey${minted}`, expiresAt: zoneless(Date.now() + (opts.expiresInMs ?? 0)) } } };
		}),
		getControlNode: jest.fn(() => (o.noControl ? null : control)),
		isAuthorizedMember: jest.fn(async (peer: string) => {
			if (o.memberThrows) throw new Error('membership unreadable');
			return (o.members ?? ['officerPeer1']).includes(peer);
		}),
		removeMachine: jest.fn(async (_peer: string): Promise<unknown> => ({ removedPeer: true, removedDeviceToken: true, withdrawnInvitations: [] })),
		withdrawCadreInvitation: jest.fn(async (_key: string) => true),
		getStrand: jest.fn((hash: string) =>
			hash === (o.ownHash ?? OWN_HASH) ? (o.noStrandDb ? {} : { database: { getDatabase: () => o.ownDb ?? OWN_DB } }) : undefined,
		),
	};
	return { node: node as unknown as PairMintHostNode & typeof node, control, state };
}

function stubVerifiers(statement: { ok: true } | { ok: false; reason: string } = { ok: true }) {
	return {
		verifyPairingStatement: jest.fn(async (_db: unknown, _args: unknown) => statement),
		verifyPairingRemove: jest.fn(async (_db: unknown, _args: unknown) => ({ ok: true })),
		isCurrentPairingOfficer: jest.fn(async (_db: unknown, _args: unknown) => true),
		isPairingRevoked: jest.fn(async (_db: unknown, _args: { userId: string; nonce: string }) => false),
	};
}

function overrides(v: ReturnType<typeof stubVerifiers>, extra: PairMintHostOverrides = {}): PairMintHostOverrides {
	// The revocation watch is driven by hand in its own describe; here it never fires.
	return {
		readOwnNetworkHash: async () => OWN_HASH,
		verifiers: v as unknown as PairMintHostOverrides['verifiers'],
		subscribeRevocations: () => () => undefined,
		...extra,
	};
}

function mintReq(over: Partial<Extract<PairMintRequest, { t: 'mint' }>> = {}): PairMintRequest {
	return {
		t: 'mint',
		v: 1,
		networkHash: OWN_HASH,
		userId: 'officerUser1',
		nonce: freshNonce(),
		expiresAt: canonical(Date.now() + 10 * 60_000),
		requesterPeerId: 'officerPeer1',
		keyPub: 'ab'.repeat(33),
		sig: 'cd'.repeat(64),
		...over,
	};
}

function removeReq(over: Partial<Extract<PairMintRequest, { t: 'remove' }>> = {}): PairMintRequest {
	return {
		t: 'remove',
		v: 1,
		networkHash: OWN_HASH,
		userId: 'officerUser1',
		nonce: freshNonce(),
		peerId: 'browserPeer1',
		expiresAt: canonical(Date.now() + 10 * 60_000),
		keyPub: 'ab'.repeat(33),
		sig: 'cd'.repeat(64),
		...over,
	};
}

async function overWire(control: ReturnType<typeof fakeControl>, from: string, request: unknown): Promise<PairMintReply> {
	const handler = control.handlers.get(PAIR_MINT_PROTOCOL);
	if (!handler) throw new Error('no pair-mint handler registered');
	const s = requestStream(request);
	handler(s.stream, { remotePeer: { toString: () => from } });
	await s.replied;
	return s.reply();
}

/** Seed an approved mint-log entry for a remove (the same store the host reads). */
async function seedApproved(nonce: string, inviteKey: string, userId = 'officerUser1'): Promise<void> {
	await appendMintLog({ nonce, userId, inviteKey, at: Date.now(), expiresAt: zoneless(Date.now() + 10 * 60_000), outcome: 'approved' });
}

async function storageDump(): Promise<string> {
	const keys = await AsyncStorage.getAllKeys();
	const pairs = await AsyncStorage.multiGet(keys);
	return pairs.map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
}

describe('pair-mint host fixtures', () => {
	it('builds requests the wire parser accepts (alphanumeric peer ids)', () => {
		expect(parsePairMintRequest(mintReq())).not.toBeNull();
		expect(parsePairMintRequest(removeReq())).not.toBeNull();
		expectNoConsole();
	});
});

describe('readActiveNetworkHash (the owner own network)', () => {
	it('reads recentNetworks[0].hash and nothing else', async () => {
		await expect(readActiveNetworkHash()).resolves.toBeNull();
		await AsyncStorage.setItem(ACTIVE_NETWORKS_KEY, JSON.stringify([{ hash: OWN_HASH, name: 'A' }, { hash: OTHER_HASH }]));
		await expect(readActiveNetworkHash()).resolves.toBe(OWN_HASH);
		expect(ACTIVE_NETWORKS_KEY).toBe('recentNetworks');
		expectNoConsole();
	});

	it.each([
		['malformed JSON', '[{'],
		['an empty list', '[]'],
		['not a list', '{"hash":"x"}'],
		['an empty hash', '[{"hash":""}]'],
		['a non-string hash', '[{"hash":5}]'],
		['an over-long hash', JSON.stringify([{ hash: 'h'.repeat(129) }])],
	])('%s gives null', async (_name, raw) => {
		await AsyncStorage.setItem(ACTIVE_NETWORKS_KEY, raw);
		await expect(readActiveNetworkHash()).resolves.toBeNull();
		expectNoConsole();
	});

	it('a storage read failure gives null', async () => {
		jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('io'));
		await expect(readActiveNetworkHash()).resolves.toBeNull();
		expectNoConsole();
	});
});

describe('pair-mint host: attach and detach', () => {
	it.each([
		['not-owner', { owners: ['other-owner'] }],
		['needs-owner-setup', { owners: [] as string[] }],
		['unavailable (identity)', { identityThrows: true }],
		['unavailable (no control database)', { noDb: true }],
	])('H-1 a %s phone hosts nothing and reads no storage', async (_name, opts) => {
		// spyOn hands back the mock's own jest.fn, which keeps earlier tests' calls: clear them first.
		const getItem = jest.spyOn(AsyncStorage, 'getItem');
		getItem.mockClear();
		const { node, control } = fakeOwnerNode(opts);
		await expect(startPairMintHost(node, overrides(stubVerifiers()))).resolves.toBeNull();
		expect(control.handle).not.toHaveBeenCalled();
		expect(getItem).not.toHaveBeenCalled();
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
		expectNoConsole();
	});

	it('H-1 an owner whose seed bootstrap cannot author owner writes hosts nothing and reads no owner rows', async () => {
		const { node, control } = fakeOwnerNode({ cannotAuthorize: true });
		await expect(startPairMintHost(node, overrides(stubVerifiers()))).resolves.toBeNull();
		expect(control.handle).not.toHaveBeenCalled();
		expect(node.getControlDatabase).not.toHaveBeenCalled();
		expectNoConsole();
	});

	it('H-1 an owner phone registers exactly the pair-mint protocol', async () => {
		const { node, control } = fakeOwnerNode();
		const host = await startPairMintHost(node, overrides(stubVerifiers()));
		expect(host).not.toBeNull();
		expect(control.handle).toHaveBeenCalledTimes(1);
		expect(control.handle.mock.calls[0][0]).toBe(PAIR_MINT_PROTOCOL);
		await host!.detach();
		expectNoConsole();
	});

	it('H-2 refuses to attach without a control node or a peer id', async () => {
		await expect(hostPairMint(fakeOwnerNode({ noControl: true }).node, overrides(stubVerifiers()))).rejects.toThrow('pair-mint: the control node is not running');
		await expect(hostPairMint(fakeOwnerNode({ noPeerId: true }).node, overrides(stubVerifiers()))).rejects.toThrow('pair-mint: this device has no peer id yet');
		expectNoConsole();
	});

	it('H-3 detach unhandles once; handleLocal afterwards is switched-off and calls no port', async () => {
		const v = stubVerifiers();
		const { node, control } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(v));
		await host.detach();
		await host.detach();
		expect(control.unhandle).toHaveBeenCalledTimes(1);
		expect(control.unhandle).toHaveBeenCalledWith(PAIR_MINT_PROTOCOL);
		node.isAuthorizedMember.mockClear();
		await expect(host.handleLocal(mintReq({ requesterPeerId: 'ownerPeer1' }))).resolves.toEqual({ t: 'refused', v: 1, code: 'switched-off' });
		expect(node.isAuthorizedMember).not.toHaveBeenCalled();
		expect(node.createCadreInvitation).not.toHaveBeenCalled();
		expect(v.verifyPairingStatement).not.toHaveBeenCalled();
		expect(v.isCurrentPairingOfficer).not.toHaveBeenCalled();
		await expect(readMintLog()).resolves.toEqual([]);
		expectNoConsole();
	});
});

describe('pair-mint host: mint and remove over the wire', () => {
	it('H-4 a member officer gets one single-use invitation; only the log entry is stored', async () => {
		const { node, control } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));
		const reply = await overWire(control, 'officerPeer1', mintReq());
		expect(reply).toMatchObject({ t: 'minted', v: 1, invitation: MINT_TEXT, inviteKey: 'inviteKey1' });
		expect(node.createCadreInvitation).toHaveBeenCalledTimes(1);
		const [opts] = node.createCadreInvitation.mock.calls[0];
		expect(opts.uses).toBe(1);
		expect(opts.expiresInMs).toBeGreaterThan(0);
		expect(opts.expiresInMs).toBeLessThanOrEqual(900_000);
		const log = await readMintLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ outcome: 'approved', inviteKey: 'inviteKey1', userId: 'officerUser1' });
		const dump = await storageDump();
		expect(dump).toContain('inviteKey1');
		expect(windowHits(dump, MINT_TEXT)).toBe(0);
		await host.detach();
		expectNoConsole();
	});

	it('H-5 every verifier gets the OWN network and db, never the request networkHash', async () => {
		const v = stubVerifiers();
		const { node, control, state } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(v));
		await overWire(control, 'officerPeer1', mintReq({ networkHash: OTHER_HASH }));
		expect(v.isCurrentPairingOfficer).toHaveBeenCalledTimes(1);
		const [officerDb, officerArgs] = v.isCurrentPairingOfficer.mock.calls[0] as [unknown, { userId: string; nowCanonical: string }];
		expect(officerDb).toBe(OWN_DB);
		expect(officerArgs.userId).toBe('officerUser1');
		expect(officerArgs.nowCanonical).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		expect(v.verifyPairingStatement).toHaveBeenCalledTimes(1);
		const [stmtDb, stmtArgs] = v.verifyPairingStatement.mock.calls[0] as [unknown, { networkHash: string; checkExpiry: boolean; nowCanonical: string; statement: Record<string, unknown> }];
		expect(stmtDb).toBe(OWN_DB);
		expect(stmtArgs.networkHash).toBe(OWN_HASH);
		expect(stmtArgs.checkExpiry).toBe(true);
		expect(stmtArgs.nowCanonical).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		expect(Object.keys(stmtArgs.statement).sort()).toEqual(['expiresAt', 'keyPub', 'nonce', 'requesterPeerId', 'sig', 'userId']);

		const nonce = freshNonce();
		await seedApproved(nonce, 'inviteKeyR');
		state.usage = [{ inviteKey: 'inviteKeyR', peerId: 'browserPeer1' }];
		await expect(overWire(control, 'officerPeer1', removeReq({ nonce, networkHash: OTHER_HASH }))).resolves.toEqual({ t: 'removed', v: 1, peerId: 'browserPeer1' });
		const [removeDb, removeArgs] = v.verifyPairingRemove.mock.calls[0] as [unknown, { networkHash: string; nowCanonical: string }];
		expect(removeDb).toBe(OWN_DB);
		expect(removeArgs.networkHash).toBe(OWN_HASH);
		expect(removeArgs.nowCanonical).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		const allArgs = JSON.stringify([v.isCurrentPairingOfficer.mock.calls, v.verifyPairingStatement.mock.calls, v.verifyPairingRemove.mock.calls]);
		expect(allArgs).not.toContain(OTHER_HASH);
		await host.detach();
		expectNoConsole();
	});

	it.each([
		['no open network', { ownHash: OWN_HASH }, async () => null],
		['no strand for the open network', { ownHash: 'someOtherOpenHash' }, undefined],
		['a strand without a database yet', { noStrandDb: true }, undefined],
	])('H-6 %s fails closed as not-officer without minting', async (_name, opts, readOwn) => {
		const v = stubVerifiers();
		const { node, control } = fakeOwnerNode(opts);
		const host = await hostPairMint(node, overrides(v, readOwn ? { readOwnNetworkHash: readOwn } : {}));
		await expect(overWire(control, 'officerPeer1', mintReq())).resolves.toEqual({ t: 'refused', v: 1, code: 'not-officer' });
		expect(node.createCadreInvitation).not.toHaveBeenCalled();
		expect(v.isCurrentPairingOfficer).not.toHaveBeenCalled();
		await host.detach();
		expectNoConsole();
	});

	it('H-7 a stranger, or a membership read that throws, is not-officer and leaves the log empty', async () => {
		const a = fakeOwnerNode();
		const hostA = await hostPairMint(a.node, overrides(stubVerifiers()));
		await expect(overWire(a.control, 'strangerPeer1', mintReq({ requesterPeerId: 'strangerPeer1' }))).resolves.toEqual({ t: 'refused', v: 1, code: 'not-officer' });
		const b = fakeOwnerNode({ memberThrows: true });
		const hostB = await hostPairMint(b.node, overrides(stubVerifiers()));
		await expect(overWire(b.control, 'officerPeer1', mintReq())).resolves.toEqual({ t: 'refused', v: 1, code: 'not-officer' });
		await expect(readMintLog()).resolves.toEqual([]);
		expect(a.node.createCadreInvitation).not.toHaveBeenCalled();
		expect(b.node.createCadreInvitation).not.toHaveBeenCalled();
		await hostA.detach();
		await hostB.detach();
		expectNoConsole();
	});

	it('H-8 switched off: mints refused, removes still served', async () => {
		await writePairingSwitch(false);
		const { node, control, state } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));
		await expect(overWire(control, 'officerPeer1', mintReq())).resolves.toEqual({ t: 'refused', v: 1, code: 'switched-off' });
		expect(node.createCadreInvitation).not.toHaveBeenCalled();

		const nonce = freshNonce();
		await seedApproved(nonce, 'inviteKeyS');
		state.usage = [{ inviteKey: 'inviteKeyS', peerId: 'browserPeer1' }];
		await expect(overWire(control, 'officerPeer1', removeReq({ nonce }))).resolves.toEqual({ t: 'removed', v: 1, peerId: 'browserPeer1' });
		expect(node.removeMachine).toHaveBeenCalledTimes(1);
		expect(node.removeMachine).toHaveBeenCalledWith('browserPeer1');
		await host.detach();
		expectNoConsole();
	});

	it('H-8 an unreadable switch value refuses mints (fail closed)', async () => {
		await AsyncStorage.setItem(PAIRING_SWITCH_KEY, 'yes-planted');
		const { node, control } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));
		await expect(overWire(control, 'officerPeer1', mintReq())).resolves.toEqual({ t: 'refused', v: 1, code: 'switched-off' });
		expect(node.createCadreInvitation).not.toHaveBeenCalled();
		await host.detach();
		expectNoConsole();
	});

	it('H-9 remove mapping: not-an-owner, other failures, a different peer, unreadable usage', async () => {
		const { node, control, state } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));

		const n1 = freshNonce();
		await seedApproved(n1, 'inviteKey9a');
		state.usage = [{ inviteKey: 'inviteKey9a', peerId: 'browserPeer1' }];
		node.removeMachine.mockRejectedValueOnce(Object.assign(new Error('cadre-core refusal with ids'), { code: 'not-an-owner' }));
		await expect(overWire(control, 'officerPeer1', removeReq({ nonce: n1 }))).resolves.toEqual({ t: 'refused', v: 1, code: 'not-owner' });

		const n2 = freshNonce();
		await seedApproved(n2, 'inviteKey9b');
		state.usage = [{ inviteKey: 'inviteKey9b', peerId: 'browserPeer1' }];
		node.removeMachine.mockRejectedValueOnce(new Error('network down'));
		await expect(overWire(control, 'officerPeer1', removeReq({ nonce: n2 }))).resolves.toEqual({ t: 'refused', v: 1, code: 'not-reachable' });

		const n3 = freshNonce();
		await seedApproved(n3, 'inviteKey9c');
		state.usage = [{ inviteKey: 'inviteKey9c', peerId: 'browserPeerOther' }];
		node.removeMachine.mockClear();
		await expect(overWire(control, 'officerPeer1', removeReq({ nonce: n3 }))).resolves.toEqual({ t: 'refused', v: 1, code: 'unknown-pairing' });
		expect(node.removeMachine).not.toHaveBeenCalled();
		await host.detach();

		const t = fakeOwnerNode({ usageThrows: true });
		const hostT = await hostPairMint(t.node, overrides(stubVerifiers()));
		const n4 = freshNonce();
		await seedApproved(n4, 'inviteKey9d');
		await expect(overWire(t.control, 'officerPeer1', removeReq({ nonce: n4 }))).resolves.toEqual({ t: 'refused', v: 1, code: 'unknown-pairing' });
		expect(t.node.removeMachine).not.toHaveBeenCalled();
		await hostT.detach();
		expectNoConsole();
	});

	it('H-10 ownership lost after attach: a valid mint is not-owner', async () => {
		const { node, control, state } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));
		state.owners = new Set(['other-owner']);
		await expect(overWire(control, 'officerPeer1', mintReq())).resolves.toEqual({ t: 'refused', v: 1, code: 'not-owner' });
		expect(node.createCadreInvitation).not.toHaveBeenCalled();
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		await host.detach();
		expectNoConsole();
	});

	it('H-11 handleLocal: the owner itself is the caller (R-A)', async () => {
		const { node } = fakeOwnerNode();
		const host = await hostPairMint(node, overrides(stubVerifiers()));
		const { handleLocal } = host; // must work detached from the object
		await expect(handleLocal(mintReq({ requesterPeerId: 'ownerPeer1' }))).resolves.toMatchObject({ t: 'minted', invitation: MINT_TEXT });
		expect(await node.isAuthorizedMember('ownerPeer1')).toBe(false); // self is allowed without membership
		await expect(handleLocal(mintReq({ requesterPeerId: 'officerPeer1' }))).resolves.toEqual({ t: 'refused', v: 1, code: 'requester-mismatch' });
		await host.detach();
		expectNoConsole();
	});
});

describe('pair-mint host: real schema (H-12)', () => {
	jest.setTimeout(120_000);

	it('mints for the founder officer, refuses a statement for another network and a non-officer', async () => {
		const net = await createTestNetwork();
		const ownHash = net.ref.hash;
		const { node, control } = fakeOwnerNode({ ownHash, ownDb: net.ctx.db });
		const host = await hostPairMint(node, { readOwnNetworkHash: async () => ownHash, subscribeRevocations: () => () => undefined });
		const sign = makeTestSignCallback(net.user);
		const keyPub = net.user.activeKeys[0].key;

		async function signed(networkHash: string, userId: string): Promise<PairMintRequest> {
			const nonce = freshNonce();
			const expiresAt = canonical(Date.now() + 10 * 60_000);
			const digest = await pairingStatementDigest(net.ctx.db, { networkHash, userId, nonce, expiresAt, requesterPeerId: 'officerPeer1' });
			const sig = (await sign(digest)).signature;
			return { t: 'mint', v: 1, networkHash, userId, nonce, expiresAt, requesterPeerId: 'officerPeer1', keyPub, sig };
		}

		await expect(overWire(control, 'officerPeer1', await signed(ownHash, net.user.id))).resolves.toMatchObject({ t: 'minted', inviteKey: 'inviteKey1' });
		await expect(overWire(control, 'officerPeer1', await signed(OTHER_HASH, net.user.id))).resolves.toEqual({ t: 'refused', v: 1, code: 'bad-signature' });
		await expect(overWire(control, 'officerPeer1', await signed(ownHash, 'notAnOfficerUser'))).resolves.toEqual({ t: 'refused', v: 1, code: 'not-officer' });
		expect(node.createCadreInvitation).toHaveBeenCalledTimes(1);
		await host.detach();
		expectNoConsole();
	});
});

// ---------------------------------------------------------------------------------------------
// R-D: the owner acts on DashboardPairingRevocation rows for its own mints
// ---------------------------------------------------------------------------------------------

type Entry = OwnerMintLogEntry;

function logEntry(over: Partial<Entry> = {}): Entry {
	return {
		nonce: 'N1',
		userId: 'userA',
		inviteKey: 'K1',
		at: 1,
		expiresAt: zoneless(Date.now() + 10 * 60_000),
		outcome: 'approved',
		...over,
	};
}

describe('planRevocationActions (the pure R-D rule)', () => {
	const now = Date.now();
	const opts = { nowMs: now, maxActions: 10 };

	it('P-1 officer and nonce match an approved entry, redeemed: remove the redeeming machine', () => {
		expect(planRevocationActions([{ userId: 'userA', nonce: 'N1' }], [logEntry()], [{ inviteKey: 'K1', peerId: 'browserPeer1' }], opts)).toEqual([
			{ kind: 'remove', nonce: 'N1', peerId: 'browserPeer1' },
		]);
	});

	it('P-2 an unknown nonce does nothing', () => {
		expect(planRevocationActions([{ userId: 'userA', nonce: 'N9' }], [logEntry()], [{ inviteKey: 'K1', peerId: 'browserPeer1' }], opts)).toEqual([]);
	});

	it('P-3 a row of another officer for the same nonce does nothing', () => {
		expect(planRevocationActions([{ userId: 'userB', nonce: 'N1' }], [logEntry()], [{ inviteKey: 'K1', peerId: 'browserPeer1' }], opts)).toEqual([]);
	});

	it('P-4 refused, unreachable and key-less entries never match', () => {
		const usage = [{ inviteKey: 'K1', peerId: 'browserPeer1' }];
		const rows = [{ userId: 'userA', nonce: 'N1' }];
		expect(planRevocationActions(rows, [logEntry({ outcome: 'refused:not-officer' })], usage, opts)).toEqual([]);
		expect(planRevocationActions(rows, [logEntry({ outcome: 'refused:requester-mismatch', inviteKey: null })], usage, opts)).toEqual([]);
		expect(planRevocationActions(rows, [logEntry({ outcome: 'unreachable', inviteKey: null })], usage, opts)).toEqual([]);
		expect(planRevocationActions(rows, [logEntry({ inviteKey: null })], usage, opts)).toEqual([]);
	});

	it('P-5 never redeemed: withdraw, and nothing once withdrawn', () => {
		const rows = [{ userId: 'userA', nonce: 'N1' }];
		expect(planRevocationActions(rows, [logEntry()], [], opts)).toEqual([{ kind: 'withdraw', nonce: 'N1', inviteKey: 'K1' }]);
		expect(planRevocationActions(rows, [logEntry({ revocation: { result: 'withdrawn', at: 1 } })], [], opts)).toEqual([]);
	});

	it.each(['removed', 'gone', 'not-owner', 'refused', 'expired'] as const)('P-6 a %s mark is final: nothing, even with a usage row', (result) => {
		expect(
			planRevocationActions([{ userId: 'userA', nonce: 'N1' }], [logEntry({ revocation: { result, at: 1 } })], [{ inviteKey: 'K1', peerId: 'browserPeer1' }], opts),
		).toEqual([]);
	});

	it('P-7 a redemption that raced the withdrawal is removed within the grace, not after', () => {
		const exp = now + 60_000;
		const entry = logEntry({ expiresAt: zoneless(exp), revocation: { result: 'withdrawn', at: 1 } });
		const rows = [{ userId: 'userA', nonce: 'N1' }];
		const usage = [{ inviteKey: 'K1', peerId: 'browserPeer2' }];
		expect(planRevocationActions(rows, [entry], usage, { nowMs: exp + REVOCATION_GRACE_MS - 1, maxActions: 10 })).toEqual([
			{ kind: 'remove', nonce: 'N1', peerId: 'browserPeer2' },
		]);
		expect(planRevocationActions(rows, [entry], usage, { nowMs: exp + REVOCATION_GRACE_MS, maxActions: 10 })).toEqual([]);
	});

	it('P-8 duplicates give one action; maxActions keeps the first ones in row order', () => {
		const usage = [{ inviteKey: 'K1', peerId: 'browserPeer1' }];
		expect(
			planRevocationActions(
				[
					{ userId: 'userA', nonce: 'N1' },
					{ userId: 'userA', nonce: 'N1' },
				],
				[logEntry()],
				usage,
				opts,
			),
		).toHaveLength(1);
		const entries = Array.from({ length: 30 }, (_, i) => logEntry({ nonce: `N${i}`, inviteKey: `K${i}` }));
		const rows = entries.map((e) => ({ userId: 'userA', nonce: e.nonce }));
		const actions = planRevocationActions(rows, entries, [], { nowMs: now, maxActions: 10 });
		expect(actions.map((a) => a.nonce)).toEqual(Array.from({ length: 10 }, (_, i) => `N${i}`));
	});
});

/** A host whose revocation subscription is captured, and whose `isPairingRevoked` answers from `revoked`. */
async function sweepRig(
	o: {
		usage?: UsageRow[];
		revoked?: Array<{ userId: string; nonce: string }>;
		ownHash?: () => Promise<string | null>;
		noStrandDb?: boolean;
	} = {},
) {
	const made = fakeOwnerNode({ usage: o.usage ?? [], noStrandDb: o.noStrandDb });
	const revoked = new Set((o.revoked ?? []).map((r) => `${r.userId}\u0000${r.nonce}`));
	const v = {
		...stubVerifiers(),
		isPairingRevoked: jest.fn(async (_db: unknown, args: { userId: string; nonce: string }) => revoked.has(`${args.userId}\u0000${args.nonce}`)),
	};
	let listener: (() => Promise<void>) | null = null;
	const unsubscribe = jest.fn();
	const subscribeRevocations = jest.fn((l: () => Promise<void>) => {
		listener = l;
		return unsubscribe;
	});
	const host = await hostPairMint(made.node, {
		readOwnNetworkHash: o.ownHash ?? (async () => OWN_HASH),
		verifiers: v as unknown as PairMintHostOverrides['verifiers'],
		subscribeRevocations,
	});
	// The start sweep runs fire-and-forget; let it finish before the test drives the next one.
	await settle();
	return {
		...made,
		v,
		host,
		unsubscribe,
		subscribeRevocations,
		revoke: (userId: string, nonce: string) => revoked.add(`${userId}\u0000${nonce}`),
		fire: async () => {
			if (!listener) throw new Error('no subscription');
			await listener();
		},
	};
}

/** Let fire-and-forget work (the start sweep) run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function seed(entry: Partial<Entry>): Promise<void> {
	await appendMintLog({
		nonce: 'nonceRevoke000000001',
		userId: 'userA',
		inviteKey: 'K1',
		at: Date.now(),
		expiresAt: zoneless(Date.now() + 10 * 60_000),
		outcome: 'approved',
		...entry,
	} as Entry);
}

async function markOf(nonce: string): Promise<string | undefined> {
	const log = await readMintLog(10_000);
	return log.find((e) => e.nonce === nonce && e.outcome === 'approved')?.revocation?.result;
}

describe('pair-mint host: the R-D revocation sweep', () => {
	const N1 = 'nonceRevoke000000001';

	it('R-1 subscribes once to the revocation table, sweeps on start, removes once', async () => {
		await seed({ nonce: N1 });
		const rig = await sweepRig({ usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }], revoked: [{ userId: 'userA', nonce: N1 }] });
		expect(REVOCATION_TABLE).toBe('App.DashboardPairingRevocation');
		expect(rig.subscribeRevocations).toHaveBeenCalledTimes(1);
		expect(rig.node.removeMachine).toHaveBeenCalledTimes(1);
		expect(rig.node.removeMachine).toHaveBeenCalledWith('browserPeer1');
		await expect(markOf(N1)).resolves.toBe('removed');
		await rig.fire();
		await rig.fire();
		expect(rig.node.removeMachine).toHaveBeenCalledTimes(1);
		await rig.host.detach();
		expectNoConsole();
	});

	it('R-1 the default subscription is the app hub on the revocation table, with the 60 s backstop', async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { strandChanges } = require('../strand-changes') as typeof import('../strand-changes');
		const unsubscribe = jest.fn();
		const subscribe = jest.spyOn(strandChanges, 'subscribe').mockImplementation(() => unsubscribe);
		const { node } = fakeOwnerNode();
		const host = await hostPairMint(node, { readOwnNetworkHash: async () => OWN_HASH, verifiers: stubVerifiers() as unknown as PairMintHostOverrides['verifiers'] });
		expect(subscribe).toHaveBeenCalledTimes(1);
		const [tables, , options] = subscribe.mock.calls[0];
		expect(tables).toEqual(['App.DashboardPairingRevocation']);
		expect(options).toEqual({ label: 'pair-revocation', backstopMs: REVOCATION_BACKSTOP_MS });
		expect(REVOCATION_BACKSTOP_MS).toBe(60_000);
		await host.detach();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('R-2 looks up only its own approved entries, by their exact (userId, nonce), on its own db', async () => {
		await seed({ nonce: N1 });
		await appendMintLog({ nonce: 'refusedNonce00000001', userId: 'userA', inviteKey: null, at: 1, expiresAt: null, outcome: 'refused:not-officer' });
		await appendMintLog({ nonce: 'unreachNonce00000001', userId: 'userA', inviteKey: null, at: 1, expiresAt: null, outcome: 'unreachable' });
		const rig = await sweepRig({
			usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }],
			revoked: [
				{ userId: 'userB', nonce: N1 },
				{ userId: 'userA', nonce: 'nonceNeverMinted0001' },
			],
		});
		expect(rig.v.isPairingRevoked).toHaveBeenCalledTimes(1);
		expect(rig.v.isPairingRevoked.mock.calls[0]).toEqual([OWN_DB, { userId: 'userA', nonce: N1 }]);
		expect(rig.node.removeMachine).not.toHaveBeenCalled();
		expect(rig.node.withdrawCadreInvitation).not.toHaveBeenCalled();
		await rig.host.detach();
		expectNoConsole();
	});

	it('R-3 the off switch does not stop a removal', async () => {
		await writePairingSwitch(false);
		await seed({ nonce: N1 });
		const rig = await sweepRig({ usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }], revoked: [{ userId: 'userA', nonce: N1 }] });
		expect(rig.node.removeMachine).toHaveBeenCalledWith('browserPeer1');
		await expect(markOf(N1)).resolves.toBe('removed');
		await rig.host.detach();
		expectNoConsole();
	});

	it.each([
		['gone', async () => ({ removedPeer: false, removedDeviceToken: false, withdrawnInvitations: [] })],
		['not-owner', async () => Promise.reject(Object.assign(new Error('refused'), { code: 'not-an-owner' }))],
		['refused', async () => Promise.reject(Object.assign(new Error('refused'), { code: 'self' }))],
	] as const)('R-4 a %s outcome is final and never retried', async (expected, impl) => {
		await seed({ nonce: N1 });
		const made = await (async () => {
			const rig = await sweepRig({ usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }] });
			rig.node.removeMachine.mockImplementation(impl as () => Promise<unknown>);
			rig.revoke('userA', N1);
			await rig.fire();
			return rig;
		})();
		await expect(markOf(N1)).resolves.toBe(expected);
		await made.fire();
		expect(made.node.removeMachine).toHaveBeenCalledTimes(1);
		await made.host.detach();
		expectNoConsole();
	});

	it('R-4 any other failure leaves the entry unmarked and the next trigger retries it', async () => {
		await seed({ nonce: N1 });
		const rig = await sweepRig({ usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }] });
		rig.node.removeMachine.mockRejectedValueOnce(new Error('network down'));
		rig.revoke('userA', N1);
		await rig.fire();
		await expect(markOf(N1)).resolves.toBeUndefined();
		await rig.fire();
		expect(rig.node.removeMachine).toHaveBeenCalledTimes(2);
		await expect(markOf(N1)).resolves.toBe('removed');
		expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
		expect(consoleSpies.warn).toHaveBeenCalledWith('[pair-mint] revocation sweep:', 'Error');
		await rig.host.detach();
	});

	it('R-5 an unredeemed code is withdrawn once, stops counting as live, and a racing redemption is still removed', async () => {
		const exp = Date.now() + 5 * 60_000;
		await seed({ nonce: N1, expiresAt: zoneless(exp) });
		const rig = await sweepRig({ revoked: [{ userId: 'userA', nonce: N1 }] });
		expect(rig.node.withdrawCadreInvitation).toHaveBeenCalledTimes(1);
		expect(rig.node.withdrawCadreInvitation).toHaveBeenCalledWith('K1');
		expect(rig.node.removeMachine).not.toHaveBeenCalled();
		await expect(markOf(N1)).resolves.toBe('withdrawn');
		await expect(liveMintsFor('userA', Date.now())).resolves.toEqual([]);

		await rig.fire();
		expect(rig.node.withdrawCadreInvitation).toHaveBeenCalledTimes(1);

		rig.state.usage = [{ inviteKey: 'K1', peerId: 'browserPeer2' }];
		await rig.fire();
		expect(rig.node.removeMachine).toHaveBeenCalledTimes(1);
		expect(rig.node.removeMachine).toHaveBeenCalledWith('browserPeer2');
		await expect(markOf(N1)).resolves.toBe('removed');
		await rig.host.detach();
		expectNoConsole();
	});

	it('R-5 after the grace a withdrawn entry is no longer a candidate', async () => {
		const exp = Date.now() + 60_000;
		await seed({ nonce: N1, expiresAt: zoneless(exp) });
		let clock = Date.now();
		const made = fakeOwnerNode({ usage: [] });
		const v = { ...stubVerifiers(), isPairingRevoked: jest.fn(async () => true) };
		const host = await hostPairMint(made.node, {
			readOwnNetworkHash: async () => OWN_HASH,
			verifiers: v as unknown as PairMintHostOverrides['verifiers'],
			subscribeRevocations: () => () => undefined,
			now: () => clock,
		});
		await host.sweepRevocations();
		await expect(markOf(N1)).resolves.toBe('withdrawn');
		clock = exp + REVOCATION_GRACE_MS + 1;
		made.state.usage = [{ inviteKey: 'K1', peerId: 'browserPeer2' }];
		await host.sweepRevocations();
		expect(made.node.removeMachine).not.toHaveBeenCalled();
		await host.detach();
		expectNoConsole();
	});

	it('R-5 a withdrawal that fails stays unmarked before expiry and is marked expired after it', async () => {
		await seed({ nonce: N1, expiresAt: zoneless(Date.now() + 5 * 60_000) });
		await seed({ nonce: 'nonceRevokeExpired01', inviteKey: 'K2', expiresAt: zoneless(Date.now() - 60_000) });
		const rig = await (async () => {
			const r = await sweepRig({});
			r.node.withdrawCadreInvitation.mockRejectedValue(new Error('withdraw failed'));
			r.revoke('userA', N1);
			r.revoke('userA', 'nonceRevokeExpired01');
			await r.fire();
			return r;
		})();
		await expect(markOf(N1)).resolves.toBeUndefined();
		await expect(markOf('nonceRevokeExpired01')).resolves.toBe('expired');
		expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
		await rig.host.detach();
	});

	it.each([
		['no open network', { ownHash: async () => null }],
		['no strand database', { noStrandDb: true }],
	] as const)('R-6 %s: the sweep looks up and acts on nothing', async (_name, o) => {
		await seed({ nonce: N1 });
		const rig = await sweepRig({ ...o, usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }], revoked: [{ userId: 'userA', nonce: N1 }] });
		expect(rig.v.isPairingRevoked).not.toHaveBeenCalled();
		expect(rig.node.removeMachine).not.toHaveBeenCalled();
		expect(rig.node.withdrawCadreInvitation).not.toHaveBeenCalled();
		await rig.host.detach();
		expectNoConsole();
	});

	it('R-7 bounded lookups with a round-robin cursor, bounded actions, single flight', async () => {
		const entries: Entry[] = Array.from({ length: 300 }, (_, i) => ({
			nonce: `nonceBound${String(i).padStart(10, '0')}`,
			userId: 'userA',
			inviteKey: `KB${i}`,
			at: i,
			expiresAt: zoneless(Date.now() + 10 * 60_000),
			outcome: 'approved',
		}));
		await AsyncStorage.setItem('@votetorrent/pairingMintLog', JSON.stringify({ v: 1, entries }));
		const rig = await sweepRig({});
		expect(rig.v.isPairingRevoked).toHaveBeenCalledTimes(REVOCATION_SWEEP_MAX_LOOKUPS);
		expect(REVOCATION_SWEEP_MAX_LOOKUPS).toBe(200);
		const first = new Set(rig.v.isPairingRevoked.mock.calls.map((c) => (c[1] as { nonce: string }).nonce));
		rig.v.isPairingRevoked.mockClear();
		await rig.fire();
		expect(rig.v.isPairingRevoked).toHaveBeenCalledTimes(REVOCATION_SWEEP_MAX_LOOKUPS);
		const second = rig.v.isPairingRevoked.mock.calls.map((c) => (c[1] as { nonce: string }).nonce);
		// The second sweep starts with the 100 the first one did not reach.
		expect(second.slice(0, 100).every((n) => !first.has(n))).toBe(true);
		expect(new Set([...first, ...second]).size).toBe(300);

		// 30 revoked candidates inside the next sweep's window (it starts at the 101st): 10 actions, no more.
		for (let i = 100; i < 130; i++) rig.revoke('userA', entries[i].nonce);
		rig.node.withdrawCadreInvitation.mockClear();
		await rig.fire();
		expect(rig.node.withdrawCadreInvitation.mock.calls.length + rig.node.removeMachine.mock.calls.length).toBe(REVOCATION_SWEEP_MAX_ACTIONS);
		expect(REVOCATION_SWEEP_MAX_ACTIONS).toBe(10);

		// Three overlapping triggers while a sweep runs: exactly one follow-up sweep.
		rig.v.isPairingRevoked.mockClear();
		const a = rig.host.sweepRevocations();
		const b = rig.fire();
		const c = rig.fire();
		const d = rig.fire();
		await Promise.all([a, b, c, d]);
		expect(rig.v.isPairingRevoked.mock.calls.length).toBe(2 * REVOCATION_SWEEP_MAX_LOOKUPS);
		await rig.host.detach();
		expectNoConsole();
	});

	it('R-8 detach unsubscribes and a late trigger does nothing', async () => {
		await seed({ nonce: N1 });
		const rig = await sweepRig({ usage: [{ inviteKey: 'K1', peerId: 'browserPeer1' }] });
		await rig.host.detach();
		expect(rig.unsubscribe).toHaveBeenCalledTimes(1);
		rig.revoke('userA', N1);
		rig.v.isPairingRevoked.mockClear();
		await rig.fire();
		await rig.host.sweepRevocations();
		expect(rig.v.isPairingRevoked).not.toHaveBeenCalled();
		expect(rig.node.removeMachine).not.toHaveBeenCalled();
		expectNoConsole();
	});

	it('R-9 a failing sweep logs exactly one warn naming err.name and never rejects', async () => {
		await seed({ nonce: N1 });
		await seed({ nonce: 'nonceRevoke000000002', inviteKey: 'K2' });
		const rig = await sweepRig({});
		rig.v.isPairingRevoked.mockImplementation(async () => {
			throw new Error('PLANTED-row-text');
		});
		consoleSpies.warn.mockClear();
		await expect(rig.fire()).resolves.toBeUndefined();
		expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
		expect(consoleSpies.warn).toHaveBeenCalledWith('[pair-mint] revocation sweep:', 'Error');
		const everything = JSON.stringify(Object.values(consoleSpies).map((s) => s.mock.calls));
		expect(everything).not.toContain('PLANTED');
		await rig.host.detach();
	});
});

describe('pair-mint host: R-D on the real schema (R-10)', () => {
	jest.setTimeout(120_000);

	it('a signed revocation removes the machine; a forged one is refused at insert; an unknown nonce does nothing', async () => {
		const net = await createTestNetwork();
		const ownHash = net.ref.hash;
		const N1r = 'nonceRealRevoke00001';
		const N2r = 'nonceRealForged00002';
		const N3r = 'nonceRealNoEntry0003';
		await seed({ nonce: N1r, userId: net.user.id, inviteKey: 'K1' });
		await seed({ nonce: N2r, userId: net.user.id, inviteKey: 'K2' });
		const made = fakeOwnerNode({ ownHash, ownDb: net.ctx.db, usage: [
			{ inviteKey: 'K1', peerId: 'browserPeer1' },
			{ inviteKey: 'K2', peerId: 'browserPeer2' },
			{ inviteKey: 'K3', peerId: 'browserPeer3' },
		] });
		const host = await hostPairMint(made.node, { readOwnNetworkHash: async () => ownHash, subscribeRevocations: () => () => undefined });
		await host.sweepRevocations();
		expect(made.node.removeMachine).not.toHaveBeenCalled();

		await revokeDashboardPairing(net.ctx, {
			userId: net.user.id,
			nonce: N1r,
			signer: { userId: net.user.id, signingPublicKey: net.user.activeKeys[0].key, sign: makeTestSignCallback(net.user) },
		});
		await host.sweepRevocations();
		expect(made.node.removeMachine).toHaveBeenCalledTimes(1);
		expect(made.node.removeMachine).toHaveBeenCalledWith('browserPeer1');

		// FORGED: a row for this officer signed by a key that is not one of its UserKeys.
		const forger = makeDistinctTestUser();
		const digest = await pairingRevokeDigest(net.ctx.db, { userId: net.user.id, nonce: N2r });
		const forged = await makeTestSignCallback(forger)(digest);
		const forgedInsert = await net.ctx.db
			.exec(
				'insert into DashboardPairingRevocation (UserId, Nonce) with context UserKey = :signerKey, Signature = :signature, now = :now values (:userId, :nonce)',
				{ userId: net.user.id, nonce: N2r, signerKey: forger.activeKeys[0].key, signature: forged.signature, now: canonical(Date.now()) },
			)
			.then(
				() => 'inserted',
				(e: unknown) => (e instanceof Error ? e.name : 'rejected'),
			);
		expect(forgedInsert).not.toBe('inserted');
		const viaModule = await revokeDashboardPairing(net.ctx, {
			userId: net.user.id,
			nonce: N2r,
			signer: { userId: net.user.id, signingPublicKey: forger.activeKeys[0].key, sign: makeTestSignCallback(forger) },
		}).then(
			() => 'inserted',
			(e: unknown) => e,
		);
		expect(viaModule).toBeInstanceOf(PairingRevocationError);
		await expect(isPairingRevoked(net.ctx.db, { userId: net.user.id, nonce: N2r })).resolves.toBe(false);

		// MISMATCH: a valid row for a nonce this owner never minted.
		await revokeDashboardPairing(net.ctx, {
			userId: net.user.id,
			nonce: N3r,
			signer: { userId: net.user.id, signingPublicKey: net.user.activeKeys[0].key, sign: makeTestSignCallback(net.user) },
		});
		await expect(isPairingRevoked(net.ctx.db, { userId: net.user.id, nonce: N3r })).resolves.toBe(true);
		await host.sweepRevocations();
		expect(made.node.removeMachine).toHaveBeenCalledTimes(1);
		expect(made.node.withdrawCadreInvitation).not.toHaveBeenCalled();
		await host.detach();
		expectNoConsole();
	});
});
