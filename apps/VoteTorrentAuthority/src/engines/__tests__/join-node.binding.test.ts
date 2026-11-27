/**
 * join-node.binding.test.ts — the join-bootstrap store, the joined-networks store and the bootstrap-config
 * validator moved to `@votetorrent/workflows` (phase 67 plan 08); the app paths under `engines/` and
 * `config/` are bindings that supply the app key-value store. This pins the persisted key literals (a
 * changed key silently orphans every install's stored list), identity with the shared exports, the exact
 * old export sets, the writes through the app store and that the D-30 reject error is founder-intent's
 * own class. AsyncStorage resolves to the official in-memory jest mock through jest.config.js.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require('@votetorrent/workflows') as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jb = require('../join-bootstrap');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jn = require('../joined-networks');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bc = require('../../config/bootstrap-config');

const RELAY = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const CIRCUIT = `/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/${PEER}`;

const spies: jest.SpyInstance[] = [];

describe('67-08 join-node bindings (Authority)', () => {
	beforeAll(() => {
		for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			spies.push(jest.spyOn(console, m).mockImplementation(() => undefined));
		}
	});

	beforeEach(async () => {
		await AsyncStorage.clear();
	});

	afterAll(() => {
		for (const s of spies) s.mockRestore();
	});

	it('B-A1 the persisted key literals are unchanged and are the shared constants', () => {
		expect(jb.AUTHORITY_JOIN_BOOTSTRAP_KEY).toBe('@votetorrent/authorityJoinBootstrap');
		expect(jn.AUTHORITY_JOINED_NETWORKS_KEY).toBe('@votetorrent/authorityJoinedNetworks');
		expect(jb.AUTHORITY_JOIN_BOOTSTRAP_KEY).toBe(shared.AUTHORITY_JOIN_BOOTSTRAP_KEY);
		expect(jn.AUTHORITY_JOINED_NETWORKS_KEY).toBe(shared.AUTHORITY_JOINED_NETWORKS_KEY);
	});

	it('B-A2 the sanitizer and the validator are the shared functions by identity', () => {
		expect(jb.sanitizeJoinBootstrap).toBe(shared.sanitizeAuthorityJoinBootstrap);
		expect(bc.readBootstrapConfig).toBe(shared.readBootstrapConfig);
		expect(bc.isBootstrapAddr).toBe(shared.isBootstrapAddr);
	});

	it('B-A3 each binding keeps exactly its old export set', () => {
		expect(Object.keys(jb).sort()).toEqual(['AUTHORITY_JOIN_BOOTSTRAP_KEY', 'readJoinBootstrap', 'rememberJoinBootstrap', 'sanitizeJoinBootstrap']);
		expect(Object.keys(jn).sort()).toEqual(['AUTHORITY_JOINED_NETWORKS_KEY', 'isJoinedNetwork', 'readJoinedNetworkHashes', 'rememberJoinedNetwork']);
	});

	it('B-A4 the bindings write through the app store under the two literals', async () => {
		await jb.rememberJoinBootstrap([CIRCUIT]);
		expect(await AsyncStorage.getItem('@votetorrent/authorityJoinBootstrap')).toBe(JSON.stringify([CIRCUIT]));
		expect(await jb.readJoinBootstrap()).toEqual([CIRCUIT]);
		await jn.rememberJoinedNetwork('h1');
		expect(await AsyncStorage.getItem('@votetorrent/authorityJoinedNetworks')).toBe('["h1"]');
		expect(await jn.isJoinedNetwork('h1')).toBe(true);
	});

	it("B-A5 the injected reject error is founder-intent's class and a corrupt record is never written over", async () => {
		await AsyncStorage.setItem(jn.AUTHORITY_JOINED_NETWORKS_KEY, '{corrupt');
		let caught: unknown;
		try {
			await jn.readJoinedNetworkHashes();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(fi.JoinedNetworksUnreadableError);
		expect(fi.isJoinedNetworksUnreadableError(caught)).toBe(true);
		await expect(jn.rememberJoinedNetwork('h2')).rejects.toBeInstanceOf(fi.JoinedNetworksUnreadableError);
		expect(await AsyncStorage.getItem(jn.AUTHORITY_JOINED_NETWORKS_KEY)).toBe('{corrupt');
	});

	it('B-A6 nothing above logged', () => {
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});
});
