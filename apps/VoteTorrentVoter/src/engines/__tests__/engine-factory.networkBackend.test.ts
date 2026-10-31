/**
 * UAT 65 gap 4 (D-98): the dispatcher re-opens a network on the store that created it.
 * NetworksEngine is replaced by a fake that exposes the dispatcher callback; the db factories are mocks.
 */
import {LocalStorageReact} from '@votetorrent/vote-engine/rn';

jest.mock('../proof-flags.generated', () => ({
	USE_LOCAL_DB_FACTORY: false,
	USE_STUB_ATTESTATION_VERIFIER: false,
}));

const mockStrandOpen = jest.fn();
jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(() => (hash: string) => mockStrandOpen(hash)),
}));

jest.mock('@votetorrent/vote-engine/rn', () => {
	const actual = jest.requireActual('@votetorrent/vote-engine/rn');
	class FakeNetworksEngine {
		dbFactory: (hash: string) => Promise<unknown>;
		constructor(_ls: unknown, dbFactory: (hash: string) => Promise<unknown>) {
			this.dbFactory = dbFactory;
		}
		async create(hash: string) {
			return this.dbFactory(hash);
		}
		async open(hash: string) {
			return this.dbFactory(hash);
		}
	}
	return {...actual, NetworksEngine: FakeNetworksEngine};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {EngineFactory} = require('../engine-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require('../network-backend-store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const asMod = require('@react-native-async-storage/async-storage');
const AsyncStorage = asMod.default ?? asMod;

const node = {} as never;

function build() {
	const solo = jest.fn(async (hash: string) => {
		fi.takeFounderIntent(hash);
		return {backend: 'solo'};
	});
	const factory = new EngineFactory(new LocalStorageReact(), solo);
	return {factory, solo, engine: factory.getNetworksEngine()};
}

beforeEach(async () => {
	await AsyncStorage.clear();
	mockStrandOpen.mockReset();
	mockStrandOpen.mockImplementation(async (hash: string) => {
		return {backend: 'strand', intent: fi.takeFounderIntent(hash)};
	});
});

describe('EngineFactory network backend (D-98)', () => {
	it('NB-1 a network created while no node is set re-opens on the solo store after the node is set', async () => {
		const {factory, solo, engine} = build();
		await engine.create('h1');
		expect(solo).toHaveBeenCalledTimes(1);
		factory.setNode(node);
		const db = await engine.open('h1');
		expect(db).toEqual({backend: 'solo'});
		expect(solo).toHaveBeenCalledTimes(2);
		expect(mockStrandOpen).not.toHaveBeenCalled();
	});

	it('NB-2 a network created on the strand re-opens on the strand', async () => {
		const {factory, solo, engine} = build();
		factory.setNode(node);
		await engine.create('h2');
		await engine.open('h2');
		expect(mockStrandOpen).toHaveBeenCalledTimes(2);
		expect(solo).not.toHaveBeenCalled();
	});

	it('NB-3 a hash with no record keeps today\'s dispatch', async () => {
		const {factory, solo, engine} = build();
		factory.setNode(node);
		await engine.open('joined');
		expect(mockStrandOpen).toHaveBeenCalledTimes(1);
		factory.setNode(null);
		await engine.open('joined');
		expect(solo).toHaveBeenCalledTimes(1);
	});

	it('NB-4 the strand factory sees the founding intent on a create', async () => {
		const {factory, engine} = build();
		factory.setNode(node);
		const db = (await engine.create('h4')) as {intent: string};
		expect(db.intent).toBe('founding');
	});

	it('NB-5 peekFounderIntent does not consume', async () => {
		expect(fi.peekFounderIntent()).toBeNull();
		await fi.withFounding(async () => {
			expect(fi.peekFounderIntent()).toBe('founding');
			expect(fi.takeFounderIntent('x')).toBe('founding');
		});
		await fi.withFounding(async () => {
			expect(fi.peekFounderIntent()).toBe('founding');
			expect(fi.peekFounderIntent()).toBe('founding');
		});
	});

	it('NB-6 the store round-trips and fails closed', async () => {
		expect(await store.readNetworkBackend('a')).toBeNull();
		await store.recordNetworkBackend('a', 'solo');
		expect(await store.readNetworkBackend('a')).toBe('solo');
		await AsyncStorage.setItem(`${store.NETWORK_BACKEND_KEY_PREFIX}b`, 'bogus');
		expect(await store.readNetworkBackend('b')).toBeNull();
		expect(await AsyncStorage.getItem(`${store.NETWORK_BACKEND_KEY_PREFIX}a`)).toBe('solo');
	});

	it('NB-7 the record is on storage before the db factory resolves', async () => {
		for (const path of ['solo', 'strand'] as const) {
			const {factory, solo, engine} = build();
			const never = new Promise(() => undefined);
			if (path === 'solo') {
				solo.mockImplementation(async (hash: string) => {
					fi.takeFounderIntent(hash);
					return never;
				});
			} else {
				factory.setNode(node);
				mockStrandOpen.mockImplementation((hash: string) => {
					fi.takeFounderIntent(hash);
					return never;
				});
			}
			void engine.create(`h7${path}`);
			await new Promise(r => setTimeout(r, 20));
			expect(await store.readNetworkBackend(`h7${path}`)).toBe(path);
		}
	});
});
