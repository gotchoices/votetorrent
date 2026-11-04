/**
 * Boot sweep of the retired dashboard sign-in code storage (R1-R5).
 *
 * AsyncStorage resolves to the official in-memory jest mock through jest.config.js. Its methods
 * are module-level `jest.fn`s that keep their call history across tests (no clearMocks), so a
 * `jest.spyOn` on one returns that same shared mock. Counts are therefore taken after an explicit
 * `mockClear()`, and nothing is `mockRestore()`d: on a bare `jest.fn` that would drop the in-memory
 * implementation for every later test.
 */

import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	RETIRED_DASHBOARD_CODE_STORAGE_KEYS,
	sweepRetiredDashboardCodeStorage,
} from '../retired-dashboard-code-storage';

const STAGED_KEY = 'votetorrent.dashboardBootstrap.stagedCode';
const REVOKE_KEY = 'votetorrent.dashboardBootstrap.pendingRevoke';
const UNRELATED_KEY = 'recentNetworks';
const CANARY = 'CANARY-retired-secret-7f3a';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

describe('retired dashboard code storage sweep', () => {
	let consoleSpies: jest.SpyInstance[] = [];
	const asMock = AsyncStorage as unknown as Record<'getItem' | 'multiGet' | 'multiRemove', jest.Mock>;

	beforeEach(async () => {
		await AsyncStorage.clear();
		consoleSpies = CONSOLE_METHODS.map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
	});

	afterEach(() => {
		for (const s of consoleSpies) {
			expect(s).not.toHaveBeenCalled();
			s.mockRestore();
		}
		consoleSpies = [];
	});

	it('R1 removes both retired keys and leaves an unrelated key alone', async () => {
		await AsyncStorage.setItem(STAGED_KEY, JSON.stringify({ secret: CANARY, snapshotJson: `{"db":"${CANARY}"}` }));
		await AsyncStorage.setItem(REVOKE_KEY, JSON.stringify({ lookupId: CANARY, expiresAt: 1 }));
		await AsyncStorage.setItem(UNRELATED_KEY, '["h1","h2"]');

		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('removed');

		await expect(AsyncStorage.getItem(STAGED_KEY)).resolves.toBeNull();
		await expect(AsyncStorage.getItem(REVOKE_KEY)).resolves.toBeNull();
		await expect(AsyncStorage.getItem(UNRELATED_KEY)).resolves.toBe('["h1","h2"]');
	});

	it('R2 resolves removed when neither key is present, and again on a second call', async () => {
		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('removed');
		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('removed');
		await expect(AsyncStorage.getItem(STAGED_KEY)).resolves.toBeNull();
		await expect(AsyncStorage.getItem(REVOKE_KEY)).resolves.toBeNull();
	});

	it('R3 a storage failure resolves failed, never rejects, and logs nothing', async () => {
		await AsyncStorage.setItem(STAGED_KEY, JSON.stringify({ secret: CANARY }));
		asMock.multiRemove.mockClear();
		asMock.multiRemove.mockRejectedValueOnce(new Error(`storage broke near ${CANARY}`));

		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('failed');
		expect(asMock.multiRemove).toHaveBeenCalledTimes(1);
		// The once-only rejection was consumed: the next sweep reaches the real in-memory removal.
		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('removed');
		await expect(AsyncStorage.getItem(STAGED_KEY)).resolves.toBeNull();
	});

	it('R4 the key list is exactly the two retired keys, frozen, and the sweep never reads a value', async () => {
		expect([...RETIRED_DASHBOARD_CODE_STORAGE_KEYS]).toEqual([STAGED_KEY, REVOKE_KEY]);
		expect(Object.isFrozen(RETIRED_DASHBOARD_CODE_STORAGE_KEYS)).toBe(true);

		await AsyncStorage.setItem(STAGED_KEY, JSON.stringify({ secret: CANARY }));
		await AsyncStorage.setItem(REVOKE_KEY, JSON.stringify({ lookupId: CANARY }));
		asMock.getItem.mockClear();
		asMock.multiGet.mockClear();
		asMock.multiRemove.mockClear();

		await expect(sweepRetiredDashboardCodeStorage()).resolves.toBe('removed');
		expect(asMock.getItem).toHaveBeenCalledTimes(0);
		expect(asMock.multiGet).toHaveBeenCalledTimes(0);
		expect(asMock.multiRemove).toHaveBeenCalledTimes(1);
		expect(asMock.multiRemove.mock.calls[0][0]).toEqual([STAGED_KEY, REVOKE_KEY]);
	});

	it('R5 the module source, comments stripped, has no console call and no value read', () => {
		const src = fs.readFileSync(path.join(__dirname, '..', 'retired-dashboard-code-storage.ts'), 'utf8');
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(code).toContain('multiRemove');
		expect(code.match(/console\./g) ?? []).toHaveLength(0);
		expect(code.match(/getItem/g) ?? []).toHaveLength(0);
		expect(code.match(/multiGet/g) ?? []).toHaveLength(0);
	});
});
