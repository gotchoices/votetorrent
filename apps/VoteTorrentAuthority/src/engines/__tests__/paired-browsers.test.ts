/**
 * paired-browsers (D-07, D-08, D-25, D-27 under ruling R-D): the list derives each pairing's state
 * from local metadata plus the replicated usage and machine rows by IDENTITY peer id, and Remove is
 * one signed revocation insert (one prompt), with no wire request. The "real database" block runs
 * the REAL `revokeDashboardPairing` on a test-context network. Host tests use software signers; the
 * single hardware prompt is proven on a device only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as fs from 'fs';
import * as path from 'path';
import { createTestNetwork, makeTestSignCallback } from '@votetorrent/vote-engine/test/fixtures/test-context';
import { isPairingRevoked } from '@votetorrent/vote-engine/rn';
import type { PairingRevocationSigner } from '@votetorrent/vote-engine/rn';
import {
	PAIRED_BROWSER_UNUSED_GRACE_MS,
	PairedBrowserRemoveError,
	PairedBrowsersNetworkUnavailableError,
	__resetPairedBrowsersStateForTests,
	derivePairedBrowserState,
	listPairedBrowsers,
	removePairedBrowser,
	type PairedBrowsersNode,
	type PairedBrowsersStorePort,
	type RemovePairedBrowserDeps,
} from '../paired-browsers';
import {
	PAIRED_BROWSERS_KEY,
	PairedBrowsersUnreadableError,
	markPairedBrowserRemovalDone,
	markPairedBrowserRevoked,
	pairedBrowserRemoval,
	readPairedBrowsers,
	recordPairedBrowser,
	type PairedBrowserEntry,
} from '../paired-browsers-store';
import { captureConsole, expectNoSecretInConsole } from '../__fixtures__/console-leak';

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

// ------------------------------------------------------------------------------------------------

interface CountingSigner extends PairingRevocationSigner {
	calls: number;
	signatures: string[];
}

function countingSigner(userId = 'officer1', key = 'officerKey1', fail?: unknown): CountingSigner {
	const s: CountingSigner = {
		userId,
		signingPublicKey: key,
		calls: 0,
		signatures: [],
		sign: async () => {
			s.calls++;
			if (fail !== undefined) throw fail;
			const signature = 'ab'.repeat(32) + String(s.calls).padStart(4, '0');
			s.signatures.push(signature);
			return { signature, signerKey: key, signerUserId: userId };
		},
	};
	return s;
}

class FakeRevocationError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super('pairing revocation: refused');
		this.name = 'PairingRevocationError';
		this.reason = reason;
	}
}

/** Mirrors 66-04's idempotence: signs once when the row is absent, zero times when present. */
function fakeRevoke(rows = new Set<string>()) {
	const fn = jest.fn(async (_ctx: { db: unknown }, a: { userId: string; nonce: string; signer: PairingRevocationSigner }) => {
		if (a.signer.userId !== a.userId) throw new FakeRevocationError('signer-mismatch');
		const k = `${a.userId}|${a.nonce}`;
		if (rows.has(k)) return;
		await a.signer.sign(new Uint8Array([1, 2, 3]));
		rows.add(k);
	});
	return { fn, rows };
}

async function storedRaw(): Promise<string | null> {
	return AsyncStorage.getItem(PAIRED_BROWSERS_KEY);
}

describe('removePairedBrowser (D-27, R-D: one prompt, nothing on the wire)', () => {
	const DB = { fake: 'db' };

	beforeEach(async () => {
		await AsyncStorage.clear();
		__resetPairedBrowsersStateForTests();
	});

	function liveNode() {
		return fakeNode({
			usages: [{ inviteKey: 'inviteKey1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: 5000 }],
		});
	}

	it('R1 one prompt: revoke gets { db } and the signer unchanged; result removal-pending; entry pending with revokedAt = now', async () => {
		await recordPairedBrowser(entry(1));
		const signer = countingSigner();
		const revoke = fakeRevoke();
		const { node } = liveNode();
		const r = await removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn, nowMs: () => 1234 } });
		expect(r).toBe('removal-pending');
		expect(signer.calls).toBe(1);
		expect(revoke.fn).toHaveBeenCalledTimes(1);
		const [ctx, args] = revoke.fn.mock.calls[0];
		expect(ctx).toEqual({ db: DB });
		expect((ctx as { db: unknown }).db).toBe(DB);
		expect(args.signer).toBe(signer);
		expect(args).toMatchObject({ userId: 'officer1', nonce: 'pairNonce1' });
		const [stored] = await readPairedBrowsers();
		expect(stored).toMatchObject({ removal: 'pending', revokedAt: 1234 });
	});

	it('R2 nothing on the wire: no owner lookup, dial or address resolution; the module names no pair-mint client', async () => {
		await recordPairedBrowser(entry(1));
		const { node } = liveNode();
		await removePairedBrowser({ node, db: DB, signer: countingSigner(), entry: { nonce: 'pairNonce1' }, deps: { revoke: fakeRevoke().fn } });
		expect(node.getControlNode).not.toHaveBeenCalled();
		expect(node.listOwnerKeys).not.toHaveBeenCalled();
		expect(node.resolvePeerAddrs).not.toHaveBeenCalled();
		expect(node.getStrand).not.toHaveBeenCalled();
		const src = fs.readFileSync(path.join(__dirname, '..', 'paired-browsers.ts'), 'utf8');
		expect(src).not.toMatch(/from '\.\/pair-mint-client'/);
		expect(src).not.toMatch(/require\('\.\/pair-mint-client'\)/);
	});

	it('R3 refusals: signer mismatch before any prompt; revocation reasons mapped; other errors not-saved; coded signer errors pass through', async () => {
		await recordPairedBrowser(entry(1));
		const before = await storedRaw();
		const { node } = liveNode();
		const reasonOf = (e: unknown) => (e as PairedBrowserRemoveError).reason;

		const other = countingSigner('officer2');
		const revoke = fakeRevoke();
		const e1 = await removePairedBrowser({ node, db: DB, signer: other, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } }).catch(
			(e: unknown) => e,
		);
		expect(e1).toBeInstanceOf(PairedBrowserRemoveError);
		expect(reasonOf(e1)).toBe('signer-mismatch');
		expect(other.calls).toBe(0);
		expect(revoke.fn).not.toHaveBeenCalled();

		for (const reason of ['signer-mismatch', 'key-not-current', 'refused']) {
			const signer = countingSigner();
			const err = await removePairedBrowser({
				node,
				db: DB,
				signer,
				entry: { nonce: 'pairNonce1' },
				deps: { revoke: async () => Promise.reject(new FakeRevocationError(reason)) },
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PairedBrowserRemoveError);
			expect(reasonOf(err)).toBe(reason);
			expect(signer.calls).toBe(0);
		}

		const shortfall = await removePairedBrowser({
			node,
			db: DB,
			signer: countingSigner(),
			entry: { nonce: 'pairNonce1' },
			deps: { revoke: async () => Promise.reject(new Error('PromiseShortfallError: 1/2 approvals for pairNonce1')) },
		}).catch((e: unknown) => e);
		expect(reasonOf(shortfall)).toBe('not-saved');
		expect((shortfall as Error).message).not.toContain('pairNonce1');

		const cancel = Object.assign(new Error('user cancelled'), { code: 'E_BIOMETRIC_CANCELLED' });
		const cancelling = countingSigner('officer1', 'officerKey1', cancel);
		const passed = await removePairedBrowser({
			node,
			db: DB,
			signer: cancelling,
			entry: { nonce: 'pairNonce1' },
			deps: { revoke: fakeRevoke().fn },
		}).catch((e: unknown) => e);
		expect(passed).toBe(cancel);
		expect(cancelling.calls).toBe(1);

		const unknown = await removePairedBrowser({ node, db: DB, signer: countingSigner(), entry: { nonce: 'noSuchNonce' }, deps: { revoke: revoke.fn } }).catch(
			(e: unknown) => e,
		);
		expect(reasonOf(unknown)).toBe('unknown-entry');

		const wrongNet = await removePairedBrowser({
			node,
			db: DB,
			signer: countingSigner(),
			entry: { nonce: 'pairNonce1' },
			networkHash: 'netB',
			deps: { revoke: revoke.fn },
		}).catch((e: unknown) => e);
		expect(reasonOf(wrongNet)).toBe('wrong-network');
		expect(revoke.fn).not.toHaveBeenCalled();

		expect(await storedRaw()).toBe(before);
	});

	it('R4 re-run: a second Remove signs nothing, stays removal-pending and keeps the first revokedAt', async () => {
		await recordPairedBrowser(entry(1));
		const signer = countingSigner();
		const revoke = fakeRevoke();
		const { node } = liveNode();
		await removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn, nowMs: () => 1000 } });
		const again = await removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn, nowMs: () => 9000 } });
		expect(again).toBe('removal-pending');
		expect(signer.calls).toBe(1);
		expect((await readPairedBrowsers())[0]).toMatchObject({ removal: 'pending', revokedAt: 1000 });
	});

	it('R5 already done resolves removed with no revoke; machine already gone resolves removed and marks done; a read failure stays pending', async () => {
		await recordPairedBrowser(entry(1));
		await markPairedBrowserRemovalDone('pairNonce1');
		const signer = countingSigner();
		const revoke = fakeRevoke();
		const { node } = liveNode();
		await expect(removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } })).resolves.toBe('removed');
		expect(signer.calls).toBe(0);
		expect(revoke.fn).not.toHaveBeenCalled();

		await recordPairedBrowser(entry(2));
		const gone = fakeNode({ usages: [{ inviteKey: 'inviteKey2', peerId: 'browserPeer2' }], machines: [] });
		const s2 = countingSigner();
		await expect(removePairedBrowser({ node: gone.node, db: DB, signer: s2, entry: { nonce: 'pairNonce2' }, deps: { revoke: revoke.fn } })).resolves.toBe(
			'removed',
		);
		expect(s2.calls).toBe(1);
		const stored2 = (await readPairedBrowsers()).find((e) => e.nonce === 'pairNonce2');
		expect(stored2 && pairedBrowserRemoval(stored2)).toBe('done');

		await recordPairedBrowser(entry(3));
		const broken = fakeNode({ usageThrows: true });
		const s3 = countingSigner();
		await expect(removePairedBrowser({ node: broken.node, db: DB, signer: s3, entry: { nonce: 'pairNonce3' }, deps: { revoke: revoke.fn } })).resolves.toBe(
			'removal-pending',
		);
		expect(s3.calls).toBe(1);
		const noControl = fakeNode({ control: false });
		await recordPairedBrowser(entry(4));
		await expect(
			removePairedBrowser({ node: noControl.node, db: DB, signer: countingSigner(), entry: { nonce: 'pairNonce4' }, deps: { revoke: revoke.fn } }),
		).resolves.toBe('removal-pending');
	});

	it('R6 single flight: two concurrent calls for one nonce share one execution', async () => {
		await recordPairedBrowser(entry(1));
		const signer = countingSigner();
		const revoke = fakeRevoke();
		const { node } = liveNode();
		const a = removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } });
		const b = removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } });
		expect(b).toBe(a);
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra).toBe('removal-pending');
		expect(rb).toBe(ra);
		expect(revoke.fn).toHaveBeenCalledTimes(1);
		expect(signer.calls).toBe(1);
	});

	it('R7 a store failure after the row landed propagates; a re-run after recovery signs nothing', async () => {
		await recordPairedBrowser(entry(1));
		const signer = countingSigner();
		const revoke = fakeRevoke();
		const { node } = liveNode();
		const failingStore: NonNullable<RemovePairedBrowserDeps['store']> = {
			read: readPairedBrowsers,
			markRevoked: async () => {
				throw new PairedBrowsersUnreadableError();
			},
			markDone: markPairedBrowserRemovalDone,
		};
		await expect(
			removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn, store: failingStore } }),
		).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
		expect(signer.calls).toBe(1);
		expect(revoke.rows.size).toBe(1);
		expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('none');

		await expect(removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn, nowMs: () => 77 } })).resolves.toBe(
			'removal-pending',
		);
		expect(signer.calls).toBe(1);
		expect((await readPairedBrowsers())[0]).toMatchObject({ removal: 'pending', revokedAt: 77 });
	});

	it('R8 hygiene: no console call on any path; no rejected message carries a peer id, nonce, inviteKey or signature hex', async () => {
		const capture = captureConsole();
		const errors: unknown[] = [];
		const signer = countingSigner();
		try {
			const revoke = fakeRevoke();
			await recordPairedBrowser(entry(1));
			await recordPairedBrowser(entry(2));
			const { node } = liveNode();
			await removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } });
			await removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce1' }, deps: { revoke: revoke.fn } });
			const attempts: Array<Promise<unknown>> = [
				removePairedBrowser({ node, db: DB, signer: countingSigner('officer2'), entry: { nonce: 'pairNonce2' }, deps: { revoke: revoke.fn } }),
				removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'pairNonce2' }, networkHash: 'netB', deps: { revoke: revoke.fn } }),
				removePairedBrowser({ node, db: DB, signer, entry: { nonce: 'noSuchNonce' }, deps: { revoke: revoke.fn } }),
				removePairedBrowser({
					node,
					db: DB,
					signer,
					entry: { nonce: 'pairNonce2' },
					deps: { revoke: async () => Promise.reject(new Error('db said pairNonce2 browserPeer1 inviteKey2')) },
				}),
				listPairedBrowsers(fakeNode({ usageThrows: true }).node, undefined, { nowMs: NOW }),
				listPairedBrowsers(fakeNode({ control: false }).node, undefined, { nowMs: NOW }),
			];
			for (const p of attempts) errors.push(await p.catch((e: unknown) => e));
			await removePairedBrowser({
				node: fakeNode({ usages: [{ inviteKey: 'inviteKey2', peerId: 'browserPeer2' }], machines: [] }).node,
				db: DB,
				signer,
				entry: { nonce: 'pairNonce2' },
				deps: { revoke: revoke.fn },
			});
			expect(capture.calls()).toHaveLength(0);
			expectNoSecretInConsole(capture, ['pairNonce1', 'pairNonce2', 'inviteKey1', 'inviteKey2', 'browserPeer1', 'browserPeer2', ...signer.signatures]);
		} finally {
			capture.restore();
		}
		expect(errors).toHaveLength(6);
		for (const err of errors) {
			expect(err).toBeInstanceOf(Error);
			const msg = (err as Error).message;
			for (const s of ['pairNonce', 'inviteKey', 'browserPeer', 'abab']) expect(msg).not.toContain(s);
		}
		expect(signer.signatures.length).toBeGreaterThan(0);
		const raw = (await storedRaw()) as string;
		for (const sig of signer.signatures) expect(raw).not.toContain(sig.slice(0, 16));
	});
});

// ------------------------------------------------------------------------------------------------

describe('real database (D-27)', () => {
	beforeEach(() => {
		__resetPairedBrowsersStateForTests();
	});

	async function realSetup() {
		const net = await createTestNetwork();
		// Start each network with an empty local list, recorded after the fixture's own storage setup.
		await AsyncStorage.removeItem(PAIRED_BROWSERS_KEY);
		await recordPairedBrowser({
			nonce: 'pairNonceA1',
			userId: net.user.id,
			networkHash: net.ref.hash,
			inviteKey: 'inviteKeyA1',
			mintedAt: Date.now() - 1000,
			expiresAt: new Date(Date.now() + 14 * 60_000).toISOString().slice(0, 19),
			label: null,
		});
		const real = makeTestSignCallback(net.user);
		const seen: string[] = [];
		const counter = { calls: 0 };
		const signer: PairingRevocationSigner = {
			userId: net.user.id,
			signingPublicKey: net.user.activeKeys[0]!.key,
			sign: async (d: Uint8Array) => {
				counter.calls++;
				const s = await real(d);
				seen.push(s.signature);
				return s;
			},
		};
		const fake = fakeNode({
			usages: [{ inviteKey: 'inviteKeyA1', peerId: 'browserPeer1' }],
			machines: [{ peerId: 'browserPeer1', lastPublishedAt: 5000 }],
		});
		return { net, signer, counter, seen, fake };
	}

	it('E2E-1..3 one prompt and the row lands; a re-run signs nothing; the machine leaving reads removed; a wrong key is refused before any prompt (LEAK-1)', async () => {
		const capture = captureConsole();
		const secrets: string[] = ['pairNonceA1', 'inviteKeyA1', 'browserPeer1'];
		try {
			// E2E-1
			const { net, signer, counter, seen, fake } = await realSetup();
			const db = net.ctx.db;
			const r1 = await removePairedBrowser({ node: fake.node, db, signer, entry: { nonce: 'pairNonceA1' } });
			expect(r1).toBe('removal-pending');
			expect(counter.calls).toBe(1);
			expect(await isPairingRevoked(db, { userId: net.user.id, nonce: 'pairNonceA1' })).toBe(true);
			expect(await isPairingRevoked(db, { userId: net.user.id, nonce: 'pairNonceB2' })).toBe(false);
			expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('pending');

			// E2E-2
			__resetPairedBrowsersStateForTests();
			const r2 = await removePairedBrowser({ node: fake.node, db, signer, entry: { nonce: 'pairNonceA1' } });
			expect(r2).toBe('removal-pending');
			expect(counter.calls).toBe(1);
			fake.state.machines = [];
			const rows = await listPairedBrowsers(fake.node, undefined, { userId: net.user.id, networkHash: net.ref.hash });
			expect(rows).toEqual([expect.objectContaining({ nonce: 'pairNonceA1', state: 'removed' })]);
			expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('done');

			// E2E-3: a fresh network, a signer key that is not one of the officer's keys.
			const second = await realSetup();
			const badSigner: PairingRevocationSigner & { calls: number } = {
				userId: second.net.user.id,
				signingPublicKey: '02' + 'cd'.repeat(32),
				calls: 0,
				sign: async () => {
					badSigner.calls++;
					throw new Error('must not sign');
				},
			};
			const err = await removePairedBrowser({
				node: second.fake.node,
				db: second.net.ctx.db,
				signer: badSigner,
				entry: { nonce: 'pairNonceA1' },
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PairedBrowserRemoveError);
			expect((err as PairedBrowserRemoveError).reason).toBe('key-not-current');
			expect(badSigner.calls).toBe(0);
			expect(await isPairingRevoked(second.net.ctx.db, { userId: second.net.user.id, nonce: 'pairNonceA1' })).toBe(false);
			expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('none');

			// LEAK-1
			secrets.push(...seen);
			expect(seen).toHaveLength(1);
			expectNoSecretInConsole(capture, secrets);
		} finally {
			capture.restore();
		}
		const raw = (await AsyncStorage.getItem(PAIRED_BROWSERS_KEY)) as string;
		const sigHex = secrets[secrets.length - 1];
		for (let o = 0; o + 16 <= sigHex.length; o++) expect(raw).not.toContain(sigHex.slice(o, o + 16));
	});
});
