/**
 * pair-mint-host (D-22, D-26, D-28): the owner side of /votetorrent/pair-mint/1.0.0. The host binds the
 * vote-engine service's ports to this phone's cadre-core node and to its OWN network's strand database
 * (never the request's networkHash, T-66-03-12), serves members and the owner itself (R-A), honours the
 * switch for mints only, and authorizes removes through the kept mint log and the usage rows.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	PAIR_MINT_PROTOCOL,
	pairingStatementDigest,
	parsePairMintRequest,
	type PairMintReply,
	type PairMintRequest,
} from '@votetorrent/vote-engine/rn';
import { createTestNetwork, makeTestSignCallback } from '@votetorrent/vote-engine/test/fixtures/test-context';
import {
	ACTIVE_NETWORKS_KEY,
	hostPairMint,
	readActiveNetworkHash,
	startPairMintHost,
	type PairMintHostNode,
	type PairMintHostOverrides,
} from '../pair-mint-host';
import { appendMintLog, PAIRING_SWITCH_KEY, readMintLog, writePairingSwitch } from '../pairing-owner-store';

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
	};
}

function overrides(v: ReturnType<typeof stubVerifiers>, extra: PairMintHostOverrides = {}): PairMintHostOverrides {
	return { readOwnNetworkHash: async () => OWN_HASH, verifiers: v as unknown as PairMintHostOverrides['verifiers'], ...extra };
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
		const host = await hostPairMint(node, { readOwnNetworkHash: async () => ownHash });
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
