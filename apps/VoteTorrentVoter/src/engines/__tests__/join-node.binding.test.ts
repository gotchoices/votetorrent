/**
 * join-node.binding.test.ts — the join-bootstrap store and the Voter's joined list moved to
 * `@votetorrent/workflows` (phase 67 plan 08); `engines/join-bootstrap.ts` is a binding that supplies
 * the app key-value store. This pins the persisted key literals (a changed key silently orphans every
 * phone's stored list), identity with the shared exports, the exact old export set, the lenient joined
 * list (preserved, not changed, in this phase) and the writes through the app store. AsyncStorage
 * resolves to the official in-memory jest mock through jest.config.js.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require('@votetorrent/workflows') as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jb = require('../join-bootstrap');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bc = require('../../config/bootstrap-config');

const MEMBER = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWAuthorityAuthorityAuthorityAuthorityAuthor';

const spies: jest.SpyInstance[] = [];

describe('67-08 join-node bindings (Voter)', () => {
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

	it('B-V1 the persisted key literals are unchanged and are the shared VOTER_* constants', () => {
		expect(jb.JOIN_BOOTSTRAP_KEY).toBe('@votetorrent/voterJoinBootstrap');
		expect(jb.JOINED_NETWORKS_KEY).toBe('@votetorrent/voterJoinedNetworks');
		expect(jb.JOIN_BOOTSTRAP_KEY).toBe(shared.VOTER_JOIN_BOOTSTRAP_KEY);
		expect(jb.JOINED_NETWORKS_KEY).toBe(shared.VOTER_JOINED_NETWORKS_KEY);
	});

	it('B-V2 the sanitizer and the validator are the shared functions by identity', () => {
		expect(jb.sanitizeJoinBootstrap).toBe(shared.sanitizeVoterJoinBootstrap);
		expect(bc.readBootstrapConfig).toBe(shared.readBootstrapConfig);
	});

	it('B-V3 the binding keeps exactly its old seven exports', () => {
		expect(Object.keys(jb).sort()).toEqual([
			'JOINED_NETWORKS_KEY',
			'JOIN_BOOTSTRAP_KEY',
			'readJoinBootstrap',
			'readJoinedNetworkHashes',
			'rememberJoinBootstrap',
			'rememberJoinedNetwork',
			'sanitizeJoinBootstrap',
		]);
	});

	it('B-V4 the lenient joined list is preserved: corrupt reads as [] and is overwritten on remember', async () => {
		await AsyncStorage.setItem(jb.JOINED_NETWORKS_KEY, '{corrupt');
		expect(await jb.readJoinedNetworkHashes()).toEqual([]);
		await jb.rememberJoinedNetwork('h');
		expect(await AsyncStorage.getItem('@votetorrent/voterJoinedNetworks')).toBe('["h"]');
	});

	it('B-V5 the bindings write through the app store under the two literals', async () => {
		await jb.rememberJoinBootstrap([` ${MEMBER} `, MEMBER]);
		expect(await AsyncStorage.getItem('@votetorrent/voterJoinBootstrap')).toBe(JSON.stringify([MEMBER]));
		expect(await jb.readJoinBootstrap()).toEqual([MEMBER]);
		await jb.rememberJoinedNetwork('n1');
		await jb.rememberJoinedNetwork('n1');
		expect(await AsyncStorage.getItem('@votetorrent/voterJoinedNetworks')).toBe('["n1"]');
	});

	it('B-V6 nothing above logged', () => {
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});
});
