import AsyncStorage from '@react-native-async-storage/async-storage';
import {AUTHORITY_JOINED_NETWORKS_KEY} from '../joined-networks';
import {AUTHORITY_JOIN_BOOTSTRAP_KEY, readJoinBootstrap, rememberJoinBootstrap, sanitizeJoinBootstrap} from '../join-bootstrap';

const RELAY = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
const PEER_1 = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const PEER_2 = '12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzNAc5dVLAHZmwCe';
const circuit = (peer: string) => `/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/${peer}`;
const C1 = circuit(PEER_1);
const C2 = circuit(PEER_2);
const DIRECT = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${RELAY}`;

const consoleSpies = {
	log: jest.spyOn(console, 'log'),
	info: jest.spyOn(console, 'info'),
	warn: jest.spyOn(console, 'warn'),
	error: jest.spyOn(console, 'error'),
	debug: jest.spyOn(console, 'debug'),
};

beforeAll(() => {
	for (const spy of Object.values(consoleSpies)) spy.mockImplementation(() => undefined);
});

afterAll(() => {
	for (const spy of Object.values(consoleSpies)) spy.mockRestore();
});

beforeEach(async () => {
	await AsyncStorage.clear();
});

describe('join-bootstrap (D-26, research M4)', () => {
	it('JB-1 the key is the Authority key, distinct from the Voter key and the joined list key', () => {
		expect(AUTHORITY_JOIN_BOOTSTRAP_KEY).toBe('@votetorrent/authorityJoinBootstrap');
		expect(AUTHORITY_JOIN_BOOTSTRAP_KEY).not.toBe('@votetorrent/voterJoinBootstrap');
		expect(AUTHORITY_JOIN_BOOTSTRAP_KEY).not.toBe(AUTHORITY_JOINED_NETWORKS_KEY);
	});

	it('JB-2 keeps relay-circuit addresses, trimmed, deduplicated, in first-seen order', () => {
		expect(sanitizeJoinBootstrap([`  ${C1} `, C2, C1, C2])).toEqual([C1, C2]);
	});

	it('JB-3 drops direct, bare-circuit, relay-less, empty-id, oversized, spaced and non-string entries', () => {
		const long = `/dns4/${'a'.repeat(240)}/tcp/443/wss/p2p/${RELAY}/p2p-circuit/p2p/${PEER_1}`;
		expect(long.length).toBeGreaterThan(256);
		expect(
			sanitizeJoinBootstrap([
				DIRECT,
				`/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY}/p2p-circuit`,
				`/ip4/192.168.1.7/tcp/4001/ws/p2p-circuit/p2p/${PEER_1}`,
				`/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/`,
				long,
				'not-an-addr',
				`/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/${PEER_1} extra`,
				42,
				null,
				{},
			]),
		).toEqual([]);
		for (const bad of [undefined, null, 'x', 5, {}]) {
			expect(sanitizeJoinBootstrap(bad)).toEqual([]);
		}
	});

	it('JB-4 caps the list at 16 addresses', () => {
		const many = Array.from({length: 40}, (_, i) =>
			`/ip4/192.168.1.${i + 1}/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/${PEER_1}${i}`,
		);
		expect(sanitizeJoinBootstrap(many)).toHaveLength(16);
	});

	it('JB-5 remember then read round-trips, and a second remember replaces the list', async () => {
		await rememberJoinBootstrap([C1]);
		expect(await readJoinBootstrap()).toEqual([C1]);
		await rememberJoinBootstrap([C2]);
		expect(await readJoinBootstrap()).toEqual([C2]);
	});

	it('JB-6 reads [] for an absent key, junk records and a rejecting getItem, and never rejects', async () => {
		expect(await readJoinBootstrap()).toEqual([]);
		for (const junk of ['{oops', '"x"', '5', 'null']) {
			await AsyncStorage.setItem(AUTHORITY_JOIN_BOOTSTRAP_KEY, junk);
			expect(await readJoinBootstrap()).toEqual([]);
		}
		jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('io'));
		await expect(readJoinBootstrap()).resolves.toEqual([]);
	});

	it('JB-7 sanitizes a record written directly', async () => {
		await AsyncStorage.setItem(AUTHORITY_JOIN_BOOTSTRAP_KEY, JSON.stringify([` ${C1} `, DIRECT, C1, C2]));
		expect(await readJoinBootstrap()).toEqual([C1, C2]);
	});

	it('JB-8 a setItem rejection makes remember reject, and the module logged nothing across the file', async () => {
		const failure = new Error('io');
		jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(failure);
		await expect(rememberJoinBootstrap([C1])).rejects.toBe(failure);
		for (const spy of Object.values(consoleSpies)) expect(spy).not.toHaveBeenCalled();
	});
});
