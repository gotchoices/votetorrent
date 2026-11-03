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
