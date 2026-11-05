/**
 * paired-browsers-store (D-25): the local record of the browsers this phone paired. AsyncStorage
 * resolves to the official in-memory jest mock through jest.config.js.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	PAIRED_BROWSERS_KEY,
	PAIRED_BROWSERS_MAX_ENTRIES,
	PairedBrowsersUnreadableError,
	readPairedBrowsers,
	recordPairedBrowser,
	type PairedBrowserEntry,
} from '../paired-browsers-store';
import {
	PAIRED_BROWSER_LABEL_MAX_CHARS,
	markPairedBrowserRevoked,
	markPairedBrowserRemovalDone,
	pairedBrowserRemoval,
	renamePairedBrowser,
} from '../paired-browsers-store';

const FIELDS = ['expiresAt', 'inviteKey', 'label', 'mintedAt', 'networkHash', 'nonce', 'userId'];

function entry(i: number, over: Partial<PairedBrowserEntry> = {}): PairedBrowserEntry {
	return {
		nonce: `nonce-${String(i).padStart(4, '0')}-aaaaaaaaaa`,
		userId: 'user-1',
		networkHash: 'net-a',
		inviteKey: `invite-key-${i}`,
		mintedAt: 1_700_000_000_000 + i * 1000,
		expiresAt: '2026-11-03T10:14:00',
		label: null,
		...over,
	};
}

const getMock = (): jest.Mock => AsyncStorage.getItem as unknown as jest.Mock;
const setMock = (): jest.Mock => AsyncStorage.setItem as unknown as jest.Mock;

describe('paired-browsers-store (D-25)', () => {
	beforeEach(async () => {
		await AsyncStorage.clear();
		setMock().mockClear();
	});

	it('S0 the key and the cap are pinned', () => {
		expect(PAIRED_BROWSERS_KEY).toBe('@votetorrent/pairedBrowsers');
		expect(PAIRED_BROWSERS_MAX_ENTRIES).toBe(200);
	});

	it('S1 record then read returns the entry; the stored item has exactly the 7 fields', async () => {
		const e = entry(1, { label: 'Office laptop' });
		// An extra field on the input (e.g. a bearer string) must never be persisted.
		await recordPairedBrowser({ ...e, invitation: 'sereus-invite:1.SECRET', code: 'vtpair1.SECRET' } as unknown as PairedBrowserEntry);
		await expect(readPairedBrowsers()).resolves.toEqual([e]);
		const raw = await AsyncStorage.getItem(PAIRED_BROWSERS_KEY);
		const parsed = JSON.parse(raw as string);
		expect(Object.keys(parsed[0]).sort()).toEqual(FIELDS);
		expect(raw).not.toContain('SECRET');
	});

	it('S2 recording the same nonce twice keeps the first entry', async () => {
		const first = entry(1, { label: 'first' });
		await recordPairedBrowser(first);
		await recordPairedBrowser({ ...first, label: 'second', mintedAt: first.mintedAt + 5 });
		await expect(readPairedBrowsers()).resolves.toEqual([first]);
	});

	it('S3 corrupt JSON, a non-array or a getItem rejection: read rejects unreadable and record writes nothing', async () => {
		for (const bad of ['{not json', '{"a":1}', '"text"']) {
			await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, bad);
			setMock().mockClear();
			await expect(readPairedBrowsers()).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
			await expect(recordPairedBrowser(entry(1))).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
			expect(setMock()).not.toHaveBeenCalled();
			expect(await AsyncStorage.getItem(PAIRED_BROWSERS_KEY)).toBe(bad);
		}
		getMock().mockRejectedValueOnce(new Error('io'));
		const err = await readPairedBrowsers().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PairedBrowsersUnreadableError);
		expect((err as Error).name).toBe('PairedBrowsersUnreadableError');
		getMock().mockRejectedValueOnce(new Error('io'));
		setMock().mockClear();
		await expect(recordPairedBrowser(entry(2))).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
		expect(setMock()).not.toHaveBeenCalled();
	});

	it('S4 malformed items are dropped on read', async () => {
		const good = entry(1);
		const { nonce: _omit, ...missingNonce } = entry(2);
		await AsyncStorage.setItem(
			PAIRED_BROWSERS_KEY,
			JSON.stringify([
				good,
				missingNonce,
				{ ...entry(3), mintedAt: '1700000000000' },
				{ ...entry(4), mintedAt: Number.NaN },
				{ ...entry(5), expiresAt: '2026-11-03T10:14:00.000Z' },
				{ ...entry(6), expiresAt: '2026-11-03' },
				{ ...entry(7), label: 42 },
				{ ...entry(8), label: undefined },
				{ ...entry(9), userId: '' },
				'string item',
				null,
				[1, 2],
			]),
		);
		await expect(readPairedBrowsers()).resolves.toEqual([good]);
	});

	it('S5 the 201st entry evicts the oldest mintedAt; filters work; newest first', async () => {
		const list: PairedBrowserEntry[] = [];
		for (let i = 0; i < PAIRED_BROWSERS_MAX_ENTRIES; i++) {
			list.push(entry(i, { networkHash: i % 2 === 0 ? 'net-a' : 'net-b', userId: i % 3 === 0 ? 'user-2' : 'user-1' }));
		}
		await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify(list));
		await recordPairedBrowser(entry(500));
		const all = await readPairedBrowsers();
		expect(all).toHaveLength(PAIRED_BROWSERS_MAX_ENTRIES);
		expect(all[0].nonce).toBe(entry(500).nonce);
		expect(all.some((e) => e.nonce === entry(0).nonce)).toBe(false);
		expect(all.some((e) => e.nonce === entry(1).nonce)).toBe(true);
		for (let i = 1; i < all.length; i++) expect(all[i - 1].mintedAt).toBeGreaterThanOrEqual(all[i].mintedAt);

		const netB = await readPairedBrowsers({ networkHash: 'net-b' });
		expect(netB.length).toBeGreaterThan(0);
		expect(netB.every((e) => e.networkHash === 'net-b')).toBe(true);
		const u2b = await readPairedBrowsers({ networkHash: 'net-b', userId: 'user-2' });
		expect(u2b.length).toBeGreaterThan(0);
		expect(u2b.every((e) => e.networkHash === 'net-b' && e.userId === 'user-2')).toBe(true);
		expect(u2b[0].mintedAt).toBeGreaterThan(u2b[u2b.length - 1].mintedAt);
	});

	it('S6 an absent list reads empty; a malformed entry is refused without a write', async () => {
		await expect(readPairedBrowsers()).resolves.toEqual([]);
		await expect(recordPairedBrowser({ ...entry(1), mintedAt: Number.NaN })).rejects.toBeInstanceOf(TypeError);
		expect(setMock()).not.toHaveBeenCalled();
	});
});

// Revocation, removal and local rename (C-14 extension). Every 66-11 case above is unchanged.
describe('paired-browsers-store: revocation, removal and rename (D-25, D-27)', () => {
	beforeEach(async () => {
		await AsyncStorage.clear();
		setMock().mockClear();
		getMock().mockClear();
	});

	async function rawItems(): Promise<Array<Record<string, unknown>>> {
		return JSON.parse((await AsyncStorage.getItem(PAIRED_BROWSERS_KEY)) as string);
	}

	async function rawItem(nonce: string): Promise<Record<string, unknown>> {
		const found = (await rawItems()).find((i) => i.nonce === nonce);
		if (!found) throw new Error('item not stored');
		return found;
	}

	it('S6a legacy: a 7-field item reads as removal none with no revokedAt; a fresh record keeps exactly 7 fields', async () => {
		const legacy = entry(1);
		await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify([legacy]));
		const [read] = await readPairedBrowsers();
		expect(pairedBrowserRemoval(read)).toBe('none');
		expect(read.revokedAt).toBeUndefined();
		expect(read).toEqual(legacy);

		await AsyncStorage.clear();
		await recordPairedBrowser({ ...entry(2), removal: 'done', revokedAt: 5 } as unknown as PairedBrowserEntry);
		expect(Object.keys((await rawItems())[0]).sort()).toEqual(FIELDS);
		expect(pairedBrowserRemoval((await readPairedBrowsers())[0])).toBe('none');
	});

	it('S7 mark revoked: sets revokedAt once and moves none to pending; never downgrades done; unknown nonce writes nothing', async () => {
		const e = entry(1);
		await recordPairedBrowser(e);
		const first = await markPairedBrowserRevoked(e.nonce, 1000);
		expect(first).toMatchObject({ nonce: e.nonce, revokedAt: 1000, removal: 'pending' });
		const second = await markPairedBrowserRevoked(e.nonce, 2000);
		expect(second).toMatchObject({ revokedAt: 1000, removal: 'pending' });
		expect(await rawItem(e.nonce)).toMatchObject({ revokedAt: 1000, removal: 'pending' });

		await markPairedBrowserRemovalDone(e.nonce);
		const third = await markPairedBrowserRevoked(e.nonce, 3000);
		expect(third).toMatchObject({ revokedAt: 1000, removal: 'done' });
		expect(await rawItem(e.nonce)).toMatchObject({ revokedAt: 1000, removal: 'done' });

		setMock().mockClear();
		await expect(markPairedBrowserRevoked('no-such-nonce', 1000)).resolves.toBeNull();
		expect(setMock()).not.toHaveBeenCalled();
	});

	it('S8 mark done: removal becomes done; unknown nonce resolves null with no write', async () => {
		const e = entry(1);
		await recordPairedBrowser(e);
		await expect(markPairedBrowserRemovalDone(e.nonce)).resolves.toMatchObject({ removal: 'done' });
		const [read] = await readPairedBrowsers();
		expect(pairedBrowserRemoval(read)).toBe('done');
		expect(read.revokedAt).toBeUndefined();
		setMock().mockClear();
		await expect(markPairedBrowserRemovalDone('no-such-nonce')).resolves.toBeNull();
		expect(setMock()).not.toHaveBeenCalled();
	});

	it('S9 rename: trims, blank gives null, 80 chars are cut to 64, unknown nonce writes nothing, only label changes', async () => {
		const e = entry(1, { label: 'old' });
		await recordPairedBrowser(e);
		const before = await rawItem(e.nonce);

		await expect(renamePairedBrowser(e.nonce, '  Office laptop  ')).resolves.toMatchObject({ label: 'Office laptop' });
		const after = await rawItem(e.nonce);
		expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
		expect({ ...after, label: before.label }).toEqual(before);

		await expect(renamePairedBrowser(e.nonce, '   ')).resolves.toMatchObject({ label: null });
		const long = 'x'.repeat(80);
		const cut = await renamePairedBrowser(e.nonce, long);
		expect(PAIRED_BROWSER_LABEL_MAX_CHARS).toBe(64);
		expect(cut?.label).toBe('x'.repeat(64));
		expect((await readPairedBrowsers())[0].label).toBe('x'.repeat(64));
		await expect(renamePairedBrowser(e.nonce, null)).resolves.toMatchObject({ label: null });

		setMock().mockClear();
		await expect(renamePairedBrowser('no-such-nonce', 'x')).resolves.toBeNull();
		expect(setMock()).not.toHaveBeenCalled();

		// A revoked entry keeps its revocation fields through a rename.
		await markPairedBrowserRevoked(e.nonce, 777);
		await renamePairedBrowser(e.nonce, 'kept');
		expect(await rawItem(e.nonce)).toMatchObject({ label: 'kept', revokedAt: 777, removal: 'pending' });
	});

	it('S10 an item with a bad removal value or a non-finite revokedAt is dropped on read', async () => {
		const good = { ...entry(1), removal: 'pending', revokedAt: 10 };
		await AsyncStorage.setItem(
			PAIRED_BROWSERS_KEY,
			JSON.stringify([
				good,
				{ ...entry(2), removal: 'gone' },
				{ ...entry(3), removal: null },
				{ ...entry(4), removal: 1 },
				{ ...entry(5), revokedAt: '1000' },
				{ ...entry(6), revokedAt: null },
				{ ...entry(7), removal: 'done', revokedAt: 'x' },
			]),
		);
		// JSON turns NaN into null, so the non-finite case is the null item above.
		await expect(readPairedBrowsers()).resolves.toEqual([good]);
	});

	it('S11 an unreadable list: each new mutator rejects unreadable and writes nothing', async () => {
		await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, '{not json');
		setMock().mockClear();
		await expect(markPairedBrowserRevoked('n', 1)).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
		await expect(markPairedBrowserRemovalDone('n')).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
		await expect(renamePairedBrowser('n', 'x')).rejects.toBeInstanceOf(PairedBrowsersUnreadableError);
		expect(setMock()).not.toHaveBeenCalled();
		expect(await AsyncStorage.getItem(PAIRED_BROWSERS_KEY)).toBe('{not json');
	});

	it('S12 eviction drops the oldest NON-pending entry; every pending entry survives', async () => {
		const list: PairedBrowserEntry[] = [];
		for (let i = 0; i < PAIRED_BROWSERS_MAX_ENTRIES; i++) {
			list.push(i < 5 ? { ...entry(i), removal: 'pending', revokedAt: 1 } : entry(i));
		}
		await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify(list));
		await recordPairedBrowser(entry(500));
		const all = await readPairedBrowsers();
		expect(all).toHaveLength(PAIRED_BROWSERS_MAX_ENTRIES);
		for (let i = 0; i < 5; i++) {
			const kept = all.find((e) => e.nonce === entry(i).nonce);
			expect(kept && pairedBrowserRemoval(kept)).toBe('pending');
		}
		expect(all.some((e) => e.nonce === entry(5).nonce)).toBe(false);
		expect(all.some((e) => e.nonce === entry(6).nonce)).toBe(true);
		expect(all.some((e) => e.nonce === entry(500).nonce)).toBe(true);

		// Only pending entries over the cap: the list may exceed it, no pending entry is lost.
		const allPending: PairedBrowserEntry[] = [];
		for (let i = 0; i < PAIRED_BROWSERS_MAX_ENTRIES; i++) allPending.push({ ...entry(i), removal: 'pending', revokedAt: 1 });
		await AsyncStorage.setItem(PAIRED_BROWSERS_KEY, JSON.stringify(allPending));
		await recordPairedBrowser(entry(600));
		const over = await readPairedBrowsers();
		expect(over.filter((e) => pairedBrowserRemoval(e) === 'pending')).toHaveLength(PAIRED_BROWSERS_MAX_ENTRIES);
	});

	it('S13 concurrent writers never lose an update', async () => {
		const existing = entry(1);
		const other = entry(2);
		await recordPairedBrowser(existing);
		await recordPairedBrowser(other);
		const fresh = entry(3);
		await Promise.all([
			recordPairedBrowser(fresh),
			markPairedBrowserRevoked(existing.nonce, 4242),
			renamePairedBrowser(other.nonce, 'x'),
		]);
		const items = await rawItems();
		expect(items).toHaveLength(3);
		expect(items.find((i) => i.nonce === fresh.nonce)).toBeDefined();
		expect(items.find((i) => i.nonce === existing.nonce)).toMatchObject({ revokedAt: 4242, removal: 'pending' });
		expect(items.find((i) => i.nonce === other.nonce)).toMatchObject({ label: 'x' });

		// A failed write does not block the next one.
		setMock().mockRejectedValueOnce(new Error('io'));
		await expect(renamePairedBrowser(other.nonce, 'y')).rejects.toThrow();
		await expect(renamePairedBrowser(other.nonce, 'z')).resolves.toMatchObject({ label: 'z' });
	});
});
