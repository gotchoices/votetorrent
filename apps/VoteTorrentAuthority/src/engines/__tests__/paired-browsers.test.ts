/**
 * paired-browsers (D-07, D-08, D-25, D-27 under ruling R-D): the list derives each pairing's state
 * from local metadata plus the replicated usage and machine rows by IDENTITY peer id, and Remove is
 * one signed revocation insert (one prompt), with no wire request. The "real database" block runs
 * the REAL `revokeDashboardPairing` on a test-context network. Host tests use software signers; the
 * single hardware prompt is proven on a device only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	PAIRED_BROWSER_UNUSED_GRACE_MS,
	PairedBrowsersNetworkUnavailableError,
	derivePairedBrowserState,
	listPairedBrowsers,
	type PairedBrowsersNode,
	type PairedBrowsersStorePort,
} from '../paired-browsers';
import {
	PairedBrowsersUnreadableError,
	markPairedBrowserRevoked,
	pairedBrowserRemoval,
	readPairedBrowsers,
	recordPairedBrowser,
	type PairedBrowserEntry,
} from '../paired-browsers-store';

const NOW = Date.parse('2026-11-03T10:00:00Z');
const LIVE_EXPIRY = '2026-11-03T10:14:00';
const PAST_EXPIRY = '2026-11-03T09:40:00'; // 20 min before NOW: past expiry plus the 10 min grace
const RECENT_EXPIRY = '2026-11-03T09:55:00'; // 5 min before NOW: inside the grace
const ROW_KEYS = ['label', 'lastSeenAt', 'mintedAt', 'nonce', 'state'];

function entry(i: number, over: Partial<PairedBrowserEntry> = {}): PairedBrowserEntry {
	return {
		nonce: `pairNonce${i}`,
		userId: 'officer1',
		networkHash: 'netA',
		inviteKey: `inviteKey${i}`,
		mintedAt: NOW - 100_000 + i * 1000,
		expiresAt: LIVE_EXPIRY,
		label: `Browser ${i}`,
		...over,
	};
}

interface FakeNodeState {
	usages: Array<{ inviteKey: string; peerId: string }>;
	machines: Array<{ peerId: string; lastPublishedAt: number | null; isSelf?: boolean }>;
	control: boolean;
	usageThrows: boolean;
	machinesThrows: boolean;
}

function fakeNode(init: Partial<FakeNodeState> = {}) {
	const state: FakeNodeState = {
		usages: [],
		machines: [{ peerId: 'selfPeer', lastPublishedAt: 1, isSelf: true }],
		control: true,
		usageThrows: false,
		machinesThrows: false,
		...init,
	};
	const queryCadreInviteUsages = jest.fn(async () => {
		if (state.usageThrows) throw new Error('control read failed for browserPeer1');
		return state.usages;
	});
	const listMachines = jest.fn(async () => {
		if (state.machinesThrows) throw new Error('machines read failed for browserPeer1');
		return state.machines;
	});
	const node = {
		getControlDatabase: jest.fn(() => (state.control ? { queryCadreInviteUsages } : null)),
		listMachines,
		// Present to prove they are never touched (R-D: nothing on the wire; identity ids only).
		getStrand: jest.fn(() => ({ libp2pNode: { peerId: { toString: () => 'strandPeerX' } } })),
		getControlNode: jest.fn(),
		listOwnerKeys: jest.fn(),
		resolvePeerAddrs: jest.fn(),
	};
	return { node: node as typeof node & PairedBrowsersNode, state, queryCadreInviteUsages, listMachines };
}

function memoryStore(entries: PairedBrowserEntry[], markDone?: jest.Mock): PairedBrowsersStorePort & { markDone: jest.Mock; read: jest.Mock } {
	return {
		read: jest.fn(async () => [...entries]),
		markDone: markDone ?? jest.fn(async () => null),
	};
}

// ------------------------------------------------------------------------------------------------

describe('derivation and listPairedBrowsers (D-07, D-08, D-27)', () => {
	beforeEach(async () => {
		await AsyncStorage.clear();
	});

	it('L1 paired: usage row maps the inviteKey to a live machine; lastSeenAt is its lastPublishedAt', async () => {
		const e = entry(1);
		const { node } = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: 5000 }],
		});
		const rows = await listPairedBrowsers(node, memoryStore([e]), { nowMs: NOW });
		expect(rows).toEqual([{ nonce: e.nonce, label: e.label, mintedAt: e.mintedAt, state: 'paired', lastSeenAt: 5000 }]);
	});

	it('L2 not seen yet: a live machine with lastPublishedAt null reads paired with lastSeenAt null', async () => {
		const { node } = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: null }],
		});
		const rows = await listPairedBrowsers(node, memoryStore([entry(1)]), { nowMs: NOW });
		expect(rows[0]).toMatchObject({ state: 'paired', lastSeenAt: null });
	});

	it('L3 waiting: no usage row inside the grace; past the grace an unrevoked unused code is not listed', async () => {
		const { node } = fakeNode();
		const store = memoryStore([entry(1), entry(2, { expiresAt: RECENT_EXPIRY }), entry(3, { expiresAt: PAST_EXPIRY })]);
		const rows = await listPairedBrowsers(node, store, { nowMs: NOW });
		expect(rows.map((r) => [r.nonce, r.state, r.lastSeenAt])).toEqual([
			['pairNonce2', 'waiting', null],
			['pairNonce1', 'waiting', null],
		]);
		expect(PAIRED_BROWSER_UNUSED_GRACE_MS).toBe(600_000);
		expect(derivePairedBrowserState(entry(3, { expiresAt: PAST_EXPIRY }), null, null, NOW)).toBeNull();
	});

	it('L4 removal-pending: a revoked entry with a live machine keeps its lastSeenAt; a revoked live unused code is pending', async () => {
		const { node } = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: 7000 }],
		});
		const store = memoryStore([
			entry(1, { removal: 'pending', revokedAt: 1 }),
			entry(2, { removal: 'pending', revokedAt: 1 }),
		]);
		const rows = await listPairedBrowsers(node, store, { nowMs: NOW });
		expect(rows.find((r) => r.nonce === 'pairNonce1')).toMatchObject({ state: 'removal-pending', lastSeenAt: 7000 });
		expect(rows.find((r) => r.nonce === 'pairNonce2')).toMatchObject({ state: 'removal-pending', lastSeenAt: null });
	});

	it('L5 removed: done; pending with the machine gone; revoked unused past the grace; unrevoked with the machine gone', async () => {
		expect(derivePairedBrowserState(entry(1, { removal: 'done' }), null, null, NOW)).toBe('removed');
		expect(derivePairedBrowserState(entry(1, { removal: 'done' }), 'browserPeer1', { lastPublishedAt: 1 }, NOW)).toBe('removed');
		expect(derivePairedBrowserState(entry(1, { removal: 'pending', revokedAt: 1 }), 'browserPeer1', null, NOW)).toBe('removed');
		expect(
			derivePairedBrowserState(entry(1, { removal: 'pending', revokedAt: 1, expiresAt: PAST_EXPIRY }), null, null, NOW),
		).toBe('removed');
		expect(derivePairedBrowserState(entry(1), 'browserPeer1', null, NOW)).toBe('removed');
		// A revoked entry never derives paired or waiting (D-07: only revocation or network removal leaves paired).
		for (const machine of [null, { lastPublishedAt: 1 }]) {
			for (const usage of [null, 'browserPeer1']) {
				const s = derivePairedBrowserState(entry(1, { removal: 'pending', revokedAt: 1 }), usage, machine, NOW);
				expect(['removal-pending', 'removed']).toContain(s);
			}
		}
		// Age alone never moves a pairing out of paired.
		expect(derivePairedBrowserState(entry(1, { expiresAt: PAST_EXPIRY }), 'browserPeer1', { lastPublishedAt: 1 }, NOW + 365 * 86_400_000)).toBe(
			'paired',
		);
	});

	it('L6 pending to done: live machine then gone reads removal-pending then removed; markDone once; a markDone failure still lists', async () => {
		const { node, state } = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: 9000 }],
		});
		const markDone = jest.fn(async () => null);
		const store = memoryStore([entry(1, { removal: 'pending', revokedAt: 1 })], markDone);
		expect((await listPairedBrowsers(node, store, { nowMs: NOW }))[0].state).toBe('removal-pending');
		expect(markDone).not.toHaveBeenCalled();
		state.machines = [];
		const second = await listPairedBrowsers(node, store, { nowMs: NOW });
		expect(second[0]).toMatchObject({ state: 'removed', lastSeenAt: null });
		expect(markDone).toHaveBeenCalledTimes(1);
		expect(markDone).toHaveBeenCalledWith('pairNonce1');

		const failing = jest.fn(async () => {
			throw new PairedBrowsersUnreadableError();
		});
		const rows = await listPairedBrowsers(node, memoryStore([entry(1, { removal: 'pending', revokedAt: 1 })], failing), { nowMs: NOW });
		expect(rows[0].state).toBe('removed');
		expect(failing).toHaveBeenCalledTimes(1);

		// The real store: the pending entry becomes done on disk.
		await recordPairedBrowser(entry(1));
		await markPairedBrowserRevoked('pairNonce1', 5);
		await listPairedBrowsers(node, undefined, { nowMs: NOW });
		expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('done');
	});

	it('L7 identity id: resolves by the usage row identity peer id; never calls getStrand', async () => {
		const { node } = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [
				{ peerId: 'browserPeer1', lastPublishedAt: 4000 },
				{ peerId: 'strandPeerX', lastPublishedAt: 1 },
			],
		});
		const rows = await listPairedBrowsers(node, memoryStore([entry(1)]), { nowMs: NOW });
		expect(rows[0]).toMatchObject({ state: 'paired', lastSeenAt: 4000 });
		expect(node.getStrand).not.toHaveBeenCalled();

		// Only the strand id is live: the identity machine is gone, so it reads removed, not paired.
		const strandOnly = fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'strandPeerX', lastPublishedAt: 1 }],
		});
		expect((await listPairedBrowsers(strandOnly.node, memoryStore([entry(1)]), { nowMs: NOW }))[0].state).toBe('removed');
		expect(strandOnly.node.getStrand).not.toHaveBeenCalled();
	});

	it('L8 filter and order: other officers and networks are excluded; newest first; exactly the five row keys', async () => {
		const { node } = fakeNode();
		const store = memoryStore([
			entry(1),
			entry(3),
			entry(2),
			entry(4, { userId: 'officer2' }),
			entry(5, { networkHash: 'netB' }),
		]);
		const rows = await listPairedBrowsers(node, store, { userId: 'officer1', networkHash: 'netA', nowMs: NOW });
		expect(rows.map((r) => r.nonce)).toEqual(['pairNonce3', 'pairNonce2', 'pairNonce1']);
		expect(store.read).toHaveBeenCalledWith({ userId: 'officer1', networkHash: 'netA' });
		for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
		const all = await listPairedBrowsers(node, store, { nowMs: NOW });
		expect(all).toHaveLength(5);
	});

	it('L9 failures: unreadable store propagates; no control db, a usage or machine read failure rejects network-unavailable', async () => {
		const unreadable: PairedBrowsersStorePort = {
			read: async () => {
				throw new PairedBrowsersUnreadableError();
			},
		};
		await expect(listPairedBrowsers(fakeNode().node, unreadable, { nowMs: NOW })).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);

		const secrets = ['browserPeer1', 'pairNonce1', 'inviteKey1'];
		for (const init of [{ control: false }, { usageThrows: true }, { machinesThrows: true }]) {
			const markDone = jest.fn(async () => null);
			const { node } = fakeNode({ usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }], ...init });
			const err = await listPairedBrowsers(node, memoryStore([entry(1, { removal: 'pending', revokedAt: 1 })], markDone), {
				nowMs: NOW,
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PairedBrowsersNetworkUnavailableError);
			expect((err as Error).name).toBe('PairedBrowsersNetworkUnavailableError');
			for (const s of secrets) expect((err as Error).message).not.toContain(s);
			expect(markDone).not.toHaveBeenCalled();
		}
	});
});
