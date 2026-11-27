/**
 * join-bootstrap (spike 100): the dial targets and joined-network record a network join leaves for
 * the next launch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	JOIN_BOOTSTRAP_KEY,
	JOINED_NETWORKS_KEY,
	readJoinBootstrap,
	readJoinedNetworkHashes,
	rememberJoinBootstrap,
	rememberJoinedNetwork,
	sanitizeJoinBootstrap,
} from '../join-bootstrap';

const MEMBER = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWAuthorityAuthorityAuthorityAuthorityAuthor';

beforeEach(async () => {
	await AsyncStorage.clear();
});

describe('sanitizeJoinBootstrap', () => {
	it('keeps peer-bound multiaddrs, trimmed and deduplicated', () => {
		expect(sanitizeJoinBootstrap([` ${MEMBER} `, MEMBER])).toEqual([MEMBER]);
	});

	it('drops anything that is not a peer-bound multiaddr string', () => {
		expect(sanitizeJoinBootstrap([42, null, 'not-an-addr', '/ip4/1.2.3.4/tcp/1', `/x${'a'.repeat(300)}/p2p/x`])).toEqual([]);
		expect(sanitizeJoinBootstrap('nope')).toEqual([]);
	});

	it('caps the list at the shipped config limit (16)', () => {
		const many = Array.from({length: 40}, (_, i) => `/ip4/10.0.0.${i}/tcp/4001/ws/p2p/peer${i}`);
		expect(sanitizeJoinBootstrap(many)).toHaveLength(16);
	});
});

describe('join bootstrap record', () => {
	it('round-trips what a join stored', async () => {
		await rememberJoinBootstrap([MEMBER]);
		expect(await readJoinBootstrap()).toEqual([MEMBER]);
	});

	it('reads [] when nothing was stored, or the record is not JSON', async () => {
		expect(await readJoinBootstrap()).toEqual([]);
		await AsyncStorage.setItem(JOIN_BOOTSTRAP_KEY, '{oops');
		expect(await readJoinBootstrap()).toEqual([]);
	});
});

describe('joined-network record', () => {
	it('records each joined network once', async () => {
		await rememberJoinedNetwork('a1b2c3d4e5f60718');
		await rememberJoinedNetwork('a1b2c3d4e5f60718');
		await rememberJoinedNetwork('ffffeeeeddddcccc');
		expect(await readJoinedNetworkHashes()).toEqual(['a1b2c3d4e5f60718', 'ffffeeeeddddcccc']);
	});

	it('reads [] for a missing or corrupt record', async () => {
		expect(await readJoinedNetworkHashes()).toEqual([]);
		await AsyncStorage.setItem(JOINED_NETWORKS_KEY, '"x"');
		expect(await readJoinedNetworkHashes()).toEqual([]);
	});
});
