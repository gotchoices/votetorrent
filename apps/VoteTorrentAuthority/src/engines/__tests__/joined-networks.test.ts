/**
 * D-30: the persisted joined-network list (fail-closed reader).
 *
 * AsyncStorage resolves to the official in-memory jest mock through jest.config.js.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jn = require('../joined-networks');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');

const spies: jest.SpyInstance[] = [];

describe('64-08 D-30: joined-network list (JN)', () => {
	beforeAll(() => {
		for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			spies.push(jest.spyOn(console, m).mockImplementation(() => undefined));
		}
	});

	beforeEach(async () => {
		// restore only the per-test AsyncStorage spies; the console spies stay for JN-9
		await AsyncStorage.clear();
	});

	afterAll(() => {
		for (const s of spies) s.mockRestore();
	});

	it('JN-1 the key is Authority-specific', () => {
		expect(jn.AUTHORITY_JOINED_NETWORKS_KEY).toBe('@votetorrent/authorityJoinedNetworks');
		expect(jn.AUTHORITY_JOINED_NETWORKS_KEY).not.toBe('@votetorrent/voterJoinedNetworks');
	});

	it('JN-2 absent key reads as an empty list', async () => {
		await expect(jn.readJoinedNetworkHashes()).resolves.toEqual([]);
		await expect(jn.isJoinedNetwork('h')).resolves.toBe(false);
	});

	it('JN-3 remember is idempotent and keeps order', async () => {
		await jn.rememberJoinedNetwork('h1');
		await jn.rememberJoinedNetwork('h2');
		await jn.rememberJoinedNetwork('h1');
		expect(await AsyncStorage.getItem(jn.AUTHORITY_JOINED_NETWORKS_KEY)).toBe('["h1","h2"]');
		await expect(jn.isJoinedNetwork('h2')).resolves.toBe(true);
		await expect(jn.isJoinedNetwork('h3')).resolves.toBe(false);
	});

	it('JN-4 a getItem rejection makes read, isJoinedNetwork and remember reject unreadable', async () => {
		const get = AsyncStorage.getItem as unknown as jest.Mock;
		const set = AsyncStorage.setItem as unknown as jest.Mock;
		set.mockClear();
		get.mockRejectedValueOnce(new Error('io'));
		const e1 = await jn.readJoinedNetworkHashes().catch((e: unknown) => e);
		expect(fi.isJoinedNetworksUnreadableError(e1)).toBe(true);
		get.mockRejectedValueOnce(new Error('io'));
		const e2 = await jn.isJoinedNetwork('h').catch((e: unknown) => e);
		expect(fi.isJoinedNetworksUnreadableError(e2)).toBe(true);
		get.mockRejectedValueOnce(new Error('io'));
		const e3 = await jn.rememberJoinedNetwork('h').catch((e: unknown) => e);
		expect(fi.isJoinedNetworksUnreadableError(e3)).toBe(true);
		expect(set).not.toHaveBeenCalled();
	});

	it.each(['{not json', '{}', '"h1"', '5', 'null'])(
		'JN-5 stored %s is unreadable; remember neither writes nor changes the bytes',
		async (stored) => {
			await AsyncStorage.setItem(jn.AUTHORITY_JOINED_NETWORKS_KEY, stored);
			const set = AsyncStorage.setItem as unknown as jest.Mock;
			set.mockClear();
			const e1 = await jn.readJoinedNetworkHashes().catch((e: unknown) => e);
			expect(fi.isJoinedNetworksUnreadableError(e1)).toBe(true);
			const e2 = await jn.rememberJoinedNetwork('h9').catch((e: unknown) => e);
			expect(fi.isJoinedNetworksUnreadableError(e2)).toBe(true);
			expect(set).not.toHaveBeenCalled();
			expect(await AsyncStorage.getItem(jn.AUTHORITY_JOINED_NETWORKS_KEY)).toBe(stored);
		},
	);

	it('JN-6 non-strings and empties are dropped, deduped, order kept', async () => {
		await AsyncStorage.setItem(jn.AUTHORITY_JOINED_NETWORKS_KEY, '["h1",5,"",null,"h2","h1"]');
		await expect(jn.readJoinedNetworkHashes()).resolves.toEqual(['h1', 'h2']);
	});

	it('JN-7 remember validates its hash', async () => {
		const set = AsyncStorage.setItem as unknown as jest.Mock;
		set.mockClear();
		await expect(jn.rememberJoinedNetwork('')).rejects.toBeInstanceOf(TypeError);
		await expect(jn.rememberJoinedNetwork(7 as never)).rejects.toBeInstanceOf(TypeError);
		expect(set).not.toHaveBeenCalled();
	});

	it('JN-8 a setItem rejection surfaces', async () => {
		const set = AsyncStorage.setItem as unknown as jest.Mock;
		set.mockRejectedValueOnce(new Error('disk full'));
		await expect(jn.rememberJoinedNetwork('h1')).rejects.toThrow('disk full');
	});

	// MUST stay the last `it` in the file.
	it('JN-9 the module never logs and no stored hash reaches the console', () => {
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});
});
