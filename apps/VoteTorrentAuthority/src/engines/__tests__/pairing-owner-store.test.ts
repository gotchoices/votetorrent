/**
 * pairing-owner-store (D-28, D-26): the owner's browser-pairing switch and mint log. The switch reads ON
 * when absent, the log keeps every approved entry (a later remove is authorized only through it) and the
 * newest 500 others, shows the newest 20, fails closed on a corrupt document without overwriting it, never
 * stores invitation text, and its nonce rule matches the 66-03 service's replay-check position (V-17).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPairMintService, PAIR_MINT_REFUSAL_CODES, type PairMintPorts, type PairMintRequest } from '@votetorrent/vote-engine/rn';
import {
	appendMintLog,
	createPairMintLog,
	findMintByNonce,
	hasMintNonce,
	listRevocationCandidates,
	liveMintsFor,
	markMintRevocation,
	MINT_LOG_MAX_OTHER,
	PAIRING_MINT_LOG_KEY,
	PAIRING_REFUSAL_CODES,
	PAIRING_SWITCH_KEY,
	PairingOwnerStoreError,
	PRE_REPLAY_REFUSALS,
	readMintLog,
	readPairingSwitch,
	REVOCATION_GRACE_MS,
	REVOCATION_RESULTS,
	writePairingSwitch,
	type OwnerMintLogEntry,
} from '../pairing-owner-store';
import type { PairMintLogEntry } from '@votetorrent/vote-engine/rn';

const getItemMock = AsyncStorage.getItem as unknown as jest.Mock;
let priorGetItem: ((...a: never[]) => unknown) | undefined;
const consoleSpies: jest.SpyInstance[] = [];

beforeEach(async () => {
	priorGetItem = getItemMock.getMockImplementation();
	await AsyncStorage.clear();
	consoleSpies.length = 0;
	for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
		consoleSpies.push(jest.spyOn(console, m).mockImplementation(() => undefined));
	}
});

afterEach(() => {
	// O-10: no test in this file may reach a console call.
	for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	jest.restoreAllMocks();
	// restoreAllMocks cannot undo a mockImplementation on the mock's own jest.fn: put it back by hand.
	getItemMock.mockImplementation(priorGetItem);
});

const canonical = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const zoneless = (ms: number) => new Date(ms).toISOString().slice(0, 23);

function entry(over: Partial<PairMintLogEntry> = {}): PairMintLogEntry {
	return {
		nonce: 'nonceAAAAAAAAAAAAAAA',
		userId: 'userA',
		inviteKey: null,
		at: 1,
		expiresAt: null,
		outcome: 'refused:not-officer',
		...over,
	};
}

function approved(over: Partial<PairMintLogEntry> = {}): PairMintLogEntry {
	return entry({
		outcome: 'approved',
		inviteKey: 'inviteKeyA',
		expiresAt: zoneless(Date.now() + 10 * 60_000),
		...over,
	});
}

async function rawLog(): Promise<string | null> {
	return AsyncStorage.getItem(PAIRING_MINT_LOG_KEY);
}

describe('pairing owner store: keys and switch (D-28)', () => {
	it('O-1 pins the keys and the cap', () => {
		expect(PAIRING_SWITCH_KEY).toBe('@votetorrent/settings/allowBrowserPairing');
		expect(PAIRING_MINT_LOG_KEY).toBe('@votetorrent/pairingMintLog');
		expect(MINT_LOG_MAX_OTHER).toBe(500);
	});

	it('O-2 an absent switch reads ON', async () => {
		await expect(readPairingSwitch()).resolves.toBe(true);
	});

	it('O-2 reads the two stored strings and writes exactly them', async () => {
		await AsyncStorage.setItem(PAIRING_SWITCH_KEY, 'false');
		await expect(readPairingSwitch()).resolves.toBe(false);
		await AsyncStorage.setItem(PAIRING_SWITCH_KEY, 'true');
		await expect(readPairingSwitch()).resolves.toBe(true);
		await writePairingSwitch(false);
		await expect(AsyncStorage.getItem(PAIRING_SWITCH_KEY)).resolves.toBe('false');
		await expect(readPairingSwitch()).resolves.toBe(false);
		await writePairingSwitch(true);
		await expect(AsyncStorage.getItem(PAIRING_SWITCH_KEY)).resolves.toBe('true');
	});

	it('O-2 any other stored text rejects without repeating it; a read failure propagates', async () => {
		await AsyncStorage.setItem(PAIRING_SWITCH_KEY, 'yes-planted');
		const err = await readPairingSwitch().then(
			() => null,
			(e: unknown) => e as Error,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err?.message).not.toContain('planted');
		jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('planted-io'));
		await expect(readPairingSwitch()).rejects.toThrow('planted-io');
	});
});

describe('pairing owner store: the mint log', () => {
	it('O-3 newest first, the UI window is 20, a limit is honoured, an empty store is []', async () => {
		await expect(readMintLog()).resolves.toEqual([]);
		for (let at = 1; at <= 25; at++) await appendMintLog(entry({ at, nonce: `nonce${String(at).padStart(16, '0')}` }));
		const shown = await readMintLog();
		expect(shown).toHaveLength(20);
		expect(shown.map((e) => e.at)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
		await expect(readMintLog(5)).resolves.toHaveLength(5);
	});

	it('O-4 keeps every approved entry and only the newest 500 others', async () => {
		const entries: PairMintLogEntry[] = [];
		for (let i = 0; i < 30; i++) entries.push(approved({ at: i, nonce: `approved${String(i).padStart(12, '0')}`, inviteKey: `key${i}` }));
		for (let i = 0; i < 600; i++) entries.push(entry({ at: 1000 + i, nonce: `refused${String(i).padStart(12, '0')}` }));
		// Seed all but the last entry directly (630 serialized appends would only slow the suite), then append
		// the last one through the store, which prunes.
		await AsyncStorage.setItem(PAIRING_MINT_LOG_KEY, JSON.stringify({ v: 1, entries: entries.slice(0, -1) }));
		await appendMintLog(entries[entries.length - 1]);
		const all = await readMintLog(10_000);
		const kept = all.filter((e) => e.outcome === 'approved');
		const others = all.filter((e) => e.outcome !== 'approved');
		expect(kept).toHaveLength(30);
		expect(others).toHaveLength(500);
		expect(Math.min(...others.map((e) => e.at))).toBe(1100);
		expect(Math.max(...others.map((e) => e.at))).toBe(1599);
		// Remove authorization survives the UI's last-20 window.
		await expect(findMintByNonce(`approved${'0'.repeat(12)}`)).resolves.toMatchObject({ at: 0, outcome: 'approved', inviteKey: 'key0' });
	});

	it('O-5 PRE_REPLAY_REFUSALS is the service order up to the replay check, frozen', () => {
		expect([...PRE_REPLAY_REFUSALS]).toEqual(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch']);
		expect(Object.isFrozen(PRE_REPLAY_REFUSALS)).toBe(true);
	});

	it('O-5 an unknown nonce is not used', async () => {
		await expect(hasMintNonce('nonceUnknown0000000')).resolves.toBe(false);
	});

	it.each(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch'] as const)(
		'O-5 a nonce whose only entry is %s is not used',
		async (outcome) => {
			await appendMintLog(entry({ outcome }));
			await expect(hasMintNonce('nonceAAAAAAAAAAAAAAA')).resolves.toBe(false);
		},
	);

	it('O-5 all three pre-replay refusals under one nonce still leave it unused', async () => {
		for (const outcome of PRE_REPLAY_REFUSALS) await appendMintLog(entry({ outcome }));
		await expect(hasMintNonce('nonceAAAAAAAAAAAAAAA')).resolves.toBe(false);
	});

	it.each(['approved', 'refused:not-officer', 'refused:bad-signature', 'refused:rate-limited', 'refused:not-owner', 'unreachable'] as const)(
		'O-5 a %s entry marks its nonce used',
		async (outcome) => {
			await appendMintLog(outcome === 'approved' ? approved() : entry({ outcome }));
			await expect(hasMintNonce('nonceAAAAAAAAAAAAAAA')).resolves.toBe(true);
		},
	);

	it('O-5 findMintByNonce prefers the approved entry, else the newest, else null', async () => {
		await appendMintLog(entry({ at: 1, outcome: 'refused:requester-mismatch' }));
		await appendMintLog(approved({ at: 2 }));
		await appendMintLog(entry({ at: 3, outcome: 'refused:not-officer' }));
		await expect(findMintByNonce('nonceAAAAAAAAAAAAAAA')).resolves.toMatchObject({ at: 2, outcome: 'approved' });

		await appendMintLog(approved({ at: 4, nonce: 'nonceBBBBBBBBBBBBBBB' }));
		await appendMintLog(entry({ at: 5, nonce: 'nonceBBBBBBBBBBBBBBB', outcome: 'refused:bad-signature' }));
		await expect(findMintByNonce('nonceBBBBBBBBBBBBBBB')).resolves.toMatchObject({ at: 4, outcome: 'approved' });

		await appendMintLog(entry({ at: 6, nonce: 'nonceCCCCCCCCCCCCCCC', outcome: 'refused:switched-off' }));
		await appendMintLog(entry({ at: 7, nonce: 'nonceCCCCCCCCCCCCCCC', outcome: 'refused:expired' }));
		await expect(findMintByNonce('nonceCCCCCCCCCCCCCCC')).resolves.toMatchObject({ at: 7, outcome: 'refused:expired' });

		await expect(findMintByNonce('nonceDDDDDDDDDDDDDDD')).resolves.toBeNull();
	});

	it('O-5 liveMintsFor returns only unexpired approved entries of that user', async () => {
		const now = Date.now();
		await appendMintLog(approved({ nonce: 'live1AAAAAAAAAAAAAAA', expiresAt: zoneless(now + 60_000) }));
		await appendMintLog(approved({ nonce: 'past1AAAAAAAAAAAAAAA', expiresAt: zoneless(now - 60_000) }));
		await appendMintLog(approved({ nonce: 'null1AAAAAAAAAAAAAAA', expiresAt: null }));
		await appendMintLog(approved({ nonce: 'junk1AAAAAAAAAAAAAAA', expiresAt: 'later' }));
		await appendMintLog(approved({ nonce: 'userB1AAAAAAAAAAAAAA', userId: 'userB', expiresAt: zoneless(now + 60_000) }));
		await appendMintLog(entry({ nonce: 'refd1AAAAAAAAAAAAAAA', expiresAt: zoneless(now + 60_000) }));
		const live = await liveMintsFor('userA', now);
		expect(live.map((e) => e.nonce)).toEqual(['live1AAAAAAAAAAAAAAA']);
	});

	it('O-5 createPairMintLog wires the four port members to the store', async () => {
		const port = createPairMintLog();
		expect(Object.keys(port).sort()).toEqual(['findByNonce', 'hasNonce', 'liveMintsFor', 'record']);
		await port.record(approved());
		await expect(port.hasNonce('nonceAAAAAAAAAAAAAAA')).resolves.toBe(true);
		await expect(port.findByNonce('nonceAAAAAAAAAAAAAAA')).resolves.toMatchObject({ outcome: 'approved' });
		await expect(port.liveMintsFor('userA', Date.now())).resolves.toHaveLength(1);
		await expect(readMintLog()).resolves.toHaveLength(1);
	});

	it('O-6 stores only the six fields: no invitation text reaches AsyncStorage', async () => {
		const leaky = {
			...approved(),
			invitation: 'sereus-invite:1.SECRETMARKaaaaaaaaaaaaaaaaaaaa',
			invitePrivateKey: 'SECRETMARK2',
		} as PairMintLogEntry;
		await appendMintLog(leaky);
		const [stored] = await readMintLog();
		expect(Object.keys(stored).sort()).toEqual(['at', 'expiresAt', 'inviteKey', 'nonce', 'outcome', 'userId']);
		const keys = await AsyncStorage.getAllKeys();
		const pairs = await AsyncStorage.multiGet(keys);
		const dump = pairs.map(([, v]) => v ?? '').join('\n');
		expect(dump).toContain('inviteKeyA'); // non-vacuous: the entry is there
		expect(dump).not.toContain('SECRETMARK');
		expect(dump).not.toContain('sereus-invite');
	});

	it('O-7 rejects a malformed entry with a fixed message and writes nothing', async () => {
		const bad: unknown[] = [
			entry({ outcome: 'refused:bogus' as never }),
			entry({ outcome: 'minted' as never }),
			entry({ at: Number.NaN }),
			entry({ at: Number.POSITIVE_INFINITY }),
			entry({ nonce: '' }),
			entry({ userId: '' }),
			entry({ userId: 5 as never }),
			entry({ inviteKey: 7 as never }),
			entry({ expiresAt: 7 as never }),
			null,
		];
		for (const e of bad) {
			const err = await appendMintLog(e as PairMintLogEntry).then(
				() => null,
				(x: unknown) => x as Error,
			);
			expect(err).toBeInstanceOf(Error);
			expect(err?.message).toBe('pairing mint log entry invalid');
		}
		await expect(rawLog()).resolves.toBeNull();
	});

	it('O-7 the outcome validator accepts every vote-engine refusal code and nothing else', async () => {
		expect([...PAIRING_REFUSAL_CODES]).toEqual([...PAIR_MINT_REFUSAL_CODES]);
		for (const code of PAIR_MINT_REFUSAL_CODES) await appendMintLog(entry({ outcome: `refused:${code}`, at: 2 }));
		await appendMintLog(entry({ outcome: 'unreachable', at: 3 }));
		await expect(readMintLog(100)).resolves.toHaveLength(PAIR_MINT_REFUSAL_CODES.length + 1);
	});

	it.each([
		['not json', '{not json planted'],
		['wrong-shaped entries', JSON.stringify({ v: 1, entries: [{ planted: true }] })],
		['a bare array', JSON.stringify([{ planted: true }])],
		['a future version', JSON.stringify({ v: 2, entries: [], planted: 'x' })],
		['a revocation with an unknown result', JSON.stringify({ v: 1, entries: [{ ...approved(), revocation: { result: 'planted', at: 1 } }] })],
		['a revocation with a non-finite at', JSON.stringify({ v: 1, entries: [{ ...approved(), revocation: { result: 'removed', at: 'planted' } }] })],
		['a revocation on a refused entry', JSON.stringify({ v: 1, entries: [{ ...entry(), revocation: { result: 'removed', at: 1 } }] })],
	])('O-8 a corrupt log (%s) fails closed and is never overwritten', async (_name, planted) => {
		await AsyncStorage.setItem(PAIRING_MINT_LOG_KEY, planted);
		const calls: Array<() => Promise<unknown>> = [
			() => readMintLog(),
			() => hasMintNonce('nonceAAAAAAAAAAAAAAA'),
			() => findMintByNonce('nonceAAAAAAAAAAAAAAA'),
			() => liveMintsFor('userA', Date.now()),
			() => appendMintLog(approved()),
			() => markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'removed', at: 1 }),
			() => listRevocationCandidates(Date.now()),
		];
		for (const call of calls) {
			const err = await call().then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(PairingOwnerStoreError);
			expect((err as PairingOwnerStoreError).reason).toBe('unreadable');
			expect((err as PairingOwnerStoreError).name).toBe('PairingOwnerStoreError');
			expect((err as Error).message).toBe('pairing owner store unreadable');
			expect((err as Error).message).not.toContain('planted');
		}
		await expect(rawLog()).resolves.toBe(planted);
	});

	it('O-9 ten concurrent appends all land', async () => {
		await Promise.all(Array.from({ length: 10 }, (_, i) => appendMintLog(entry({ at: i, nonce: `conc${String(i).padStart(16, '0')}` }))));
		await expect(readMintLog(100)).resolves.toHaveLength(10);
	});
});

describe('pairing owner store: V-17 parity with the real service (O-11)', () => {
	function service(enabled: boolean, minted: jest.Mock) {
		const ports: PairMintPorts = {
			isAllowed: () => true,
			isEnabled: () => enabled,
			now: () => Date.now(),
			createInvitation: minted,
			isCurrentOfficer: async () => true,
			verifyStatement: async () => ({ ok: true }),
			verifyRemove: async () => false,
			inviteUsagePeer: async () => null,
			removeMachine: async () => undefined,
			mintLog: createPairMintLog(),
		};
		return createPairMintService(ports);
	}

	function request(nonce: string): PairMintRequest {
		return {
			t: 'mint',
			v: 1,
			networkHash: 'ownNetHash1',
			userId: 'userA',
			nonce,
			expiresAt: canonical(Date.now() + 10 * 60_000),
			requesterPeerId: 'peerA',
			keyPub: 'ab'.repeat(33),
			sig: 'cd'.repeat(64),
		};
	}

	const mintFn = () =>
		jest.fn(async () => ({ encoded: 'sereus-invite:1.fakeinvitationtext', inviteKey: 'inviteKeyA', expiresAt: zoneless(Date.now() + 10 * 60_000) }));

	it('a requester-mismatch first attempt does not burn the nonce, also across a restart', async () => {
		const nonce = 'v17mismatchNonce0001';
		const first = service(true, mintFn());
		await expect(first.handle('peerB', request(nonce))).resolves.toEqual({ t: 'refused', v: 1, code: 'requester-mismatch' });
		const log = await readMintLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ nonce, outcome: 'refused:requester-mismatch' });

		const restarted = service(true, mintFn());
		await expect(restarted.handle('peerA', request(nonce))).resolves.toMatchObject({ t: 'minted', inviteKey: 'inviteKeyA' });
		await expect(findMintByNonce(nonce)).resolves.toMatchObject({ outcome: 'approved', inviteKey: 'inviteKeyA' });

		// Control: the approved mint DOES burn the nonce for any later instance.
		const third = service(true, mintFn());
		await expect(third.handle('peerA', request(nonce))).resolves.toEqual({ t: 'refused', v: 1, code: 'replayed' });
	});

	it('a switched-off first attempt does not burn the nonce, also across a restart', async () => {
		const nonce = 'v17switchedNonce0001';
		const minted = mintFn();
		const off = service(false, minted);
		await expect(off.handle('peerA', request(nonce))).resolves.toEqual({ t: 'refused', v: 1, code: 'switched-off' });
		expect(minted).not.toHaveBeenCalled();
		await expect(readMintLog()).resolves.toEqual([expect.objectContaining({ nonce, outcome: 'refused:switched-off' })]);

		const on = service(true, mintFn());
		await expect(on.handle('peerA', request(nonce))).resolves.toMatchObject({ t: 'minted' });
		await expect(findMintByNonce(nonce)).resolves.toMatchObject({ outcome: 'approved' });

		const third = service(true, mintFn());
		await expect(third.handle('peerA', request(nonce))).resolves.toEqual({ t: 'refused', v: 1, code: 'replayed' });
	});
});

describe('pairing owner store: revocation marks (R-D, O-12)', () => {
	it('REVOCATION_RESULTS and the grace are pinned', () => {
		expect([...REVOCATION_RESULTS]).toEqual(['removed', 'gone', 'not-owner', 'refused', 'withdrawn', 'expired']);
		expect(Object.isFrozen(REVOCATION_RESULTS)).toBe(true);
		expect(REVOCATION_GRACE_MS).toBe(10 * 60_000);
	});

	it('marks the approved entry, and refuses an unknown or refused-only nonce without writing', async () => {
		await appendMintLog(entry({ at: 1, outcome: 'refused:requester-mismatch' }));
		await appendMintLog(approved({ at: 2 }));
		await appendMintLog(entry({ at: 3, nonce: 'refusedOnly000000000', outcome: 'refused:bad-signature' }));
		const before = await rawLog();
		await expect(markMintRevocation('unknownNonce00000000', { result: 'removed', at: 5 })).resolves.toBe(false);
		await expect(markMintRevocation('refusedOnly000000000', { result: 'removed', at: 5 })).resolves.toBe(false);
		await expect(rawLog()).resolves.toBe(before);

		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'removed', at: 5 })).resolves.toBe(true);
		const log = await readMintLog();
		const marked = log.find((e) => e.outcome === 'approved') as OwnerMintLogEntry;
		expect(marked.revocation).toEqual({ result: 'removed', at: 5 });
		expect(log.filter((e) => e.revocation !== undefined)).toHaveLength(1);
	});

	it('a terminal mark is never overwritten; withdrawn can be replaced once', async () => {
		await appendMintLog(approved());
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'withdrawn', at: 1 })).resolves.toBe(true);
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'withdrawn', at: 2 })).resolves.toBe(false);
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'removed', at: 3 })).resolves.toBe(true);
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'gone', at: 4 })).resolves.toBe(false);
		const [e] = await readMintLog();
		expect((e as OwnerMintLogEntry).revocation).toEqual({ result: 'removed', at: 3 });
	});

	it('an invalid mark rejects with a fixed message', async () => {
		await appendMintLog(approved());
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'planted' as never, at: 1 })).rejects.toThrow('pairing mint revocation mark invalid');
		await expect(markMintRevocation('nonceAAAAAAAAAAAAAAA', { result: 'removed', at: Number.NaN })).rejects.toThrow('pairing mint revocation mark invalid');
	});

	it('liveMintsFor excludes withdrawn and terminally marked entries', async () => {
		await appendMintLog(approved({ nonce: 'liveAAAAAAAAAAAAAAAA' }));
		await appendMintLog(approved({ nonce: 'wdrnAAAAAAAAAAAAAAAA', inviteKey: 'k2' }));
		await appendMintLog(approved({ nonce: 'rmvdAAAAAAAAAAAAAAAA', inviteKey: 'k3' }));
		await markMintRevocation('wdrnAAAAAAAAAAAAAAAA', { result: 'withdrawn', at: 1 });
		await markMintRevocation('rmvdAAAAAAAAAAAAAAAA', { result: 'removed', at: 1 });
		const live = await liveMintsFor('userA', Date.now());
		expect(live.map((e) => e.nonce)).toEqual(['liveAAAAAAAAAAAAAAAA']);
	});

	it('listRevocationCandidates: unmarked approved oldest first, withdrawn only within the grace', async () => {
		const exp = Date.now() + 5 * 60_000;
		await appendMintLog(approved({ at: 30, nonce: 'cand3AAAAAAAAAAAAAAA', inviteKey: 'k3', expiresAt: zoneless(exp) }));
		await appendMintLog(approved({ at: 10, nonce: 'cand1AAAAAAAAAAAAAAA', inviteKey: 'k1', expiresAt: zoneless(exp) }));
		await appendMintLog(approved({ at: 20, nonce: 'cand2AAAAAAAAAAAAAAA', inviteKey: 'k2', expiresAt: zoneless(exp) }));
		await appendMintLog(approved({ at: 40, nonce: 'gone1AAAAAAAAAAAAAAA', inviteKey: 'k4', expiresAt: zoneless(exp) }));
		await appendMintLog(entry({ at: 50, nonce: 'refd1AAAAAAAAAAAAAAA', outcome: 'refused:not-officer' }));
		await appendMintLog(entry({ at: 60, nonce: 'unre1AAAAAAAAAAAAAAA', outcome: 'unreachable' }));
		await markMintRevocation('cand2AAAAAAAAAAAAAAA', { result: 'withdrawn', at: 1 });
		await markMintRevocation('gone1AAAAAAAAAAAAAAA', { result: 'gone', at: 1 });

		const now = Date.now();
		expect((await listRevocationCandidates(now)).map((e) => e.nonce)).toEqual(['cand1AAAAAAAAAAAAAAA', 'cand2AAAAAAAAAAAAAAA', 'cand3AAAAAAAAAAAAAAA']);
		const afterGrace = exp + REVOCATION_GRACE_MS + 1;
		expect((await listRevocationCandidates(afterGrace)).map((e) => e.nonce)).toEqual(['cand1AAAAAAAAAAAAAAA', 'cand3AAAAAAAAAAAAAAA']);
	});

	it('appendMintLog ignores a revocation field passed in', async () => {
		await appendMintLog({ ...approved(), revocation: { result: 'removed', at: 1 } } as PairMintLogEntry);
		const [e] = await readMintLog();
		expect((e as OwnerMintLogEntry).revocation).toBeUndefined();
		await expect(listRevocationCandidates(Date.now())).resolves.toHaveLength(1);
	});
});
