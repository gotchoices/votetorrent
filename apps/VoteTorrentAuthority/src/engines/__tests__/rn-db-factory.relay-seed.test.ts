/**
 * The network's relays reach the strand's bootstrap seed (strand-relay-seed.ts).
 *
 * `NetworksEngine.open` passes the stored relays as `DbFactoryOptions.relays` on a re-attach. The
 * strand factory merges them into `recordCarriedStrandAddrs(strandId, …)` BEFORE `addStrand`, which
 * is what puts them in that strand's launch `bootstrapNodes` (cadre-core 1.24 `resolveCohortSeed`).
 * A founding create never seeds. Before this change the factory took no relays at all, so RS-1, RS-2
 * and RS-5 fail on the old code.
 */

jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
jest.mock(
	'@quereus/quereus',
	() => {
		const DatabaseMock = jest.fn(function (this: Record<string, jest.Mock>) {
			this.registerModule = jest.fn();
			this.setDefaultVtabName = jest.fn();
			this.setSchemaPath = jest.fn();
			this.exec = jest.fn().mockResolvedValue(undefined);
			this.prepare = jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) });
		});
		return { Database: DatabaseMock, registerPlugin: jest.fn() };
	},
	{ virtual: true },
);
jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });
jest.mock('@quereus/store', () => ({ createIsolatedStoreModule: jest.fn(() => ({})) }), { virtual: true });
jest.mock(
	'@votetorrent/vote-engine/rn',
	() => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;' }),
	{ virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const seedMod = require('../strand-relay-seed');

export {};

const RELAY_A = '/dns4/relay-a.example.org/tcp/443/wss/p2p/12D3KooWLWM7y6gkEz3mNygZ3oERGZT1RyH9XaKQ6Ag3X1RpEXR6';
const RELAY_B = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWNNo8m53WB3YhGQtZXBiVfcDL3pY7qDsNmoNhyWfJQmca';

function makeFakeNode(opts: { carried?: string[]; recordThrows?: boolean; noSeedApi?: boolean } = {}) {
	const db = { setSchemaPath: jest.fn(), exec: jest.fn().mockResolvedValue(undefined), prepare: jest.fn() };
	const strand = { strandId: 'fake', database: { getDatabase: () => db, watch: jest.fn() } };
	const carried = new Map<string, string[]>();
	const node: Record<string, jest.Mock> = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		addStrand: jest.fn(async (_config: any) => strand),
		getControlNode: jest.fn(() => ({ getConnections: () => [] })),
		whenStrandWritable: jest.fn(async () => {
			throw new Error('not configured');
		}),
	};
	if (!opts.noSeedApi) {
		node.getCarriedStrandAddrs = jest.fn((id: string) => [...(carried.get(id) ?? opts.carried ?? [])]);
		node.recordCarriedStrandAddrs = jest.fn(async (id: string, addrs: readonly string[]) => {
			if (opts.recordThrows) throw new Error('record failed');
			carried.set(id, [...addrs]);
		});
	}
	return { node, carried };
}

describe('createStrandDbFactory — relays reach the strand bootstrap seed (Authority)', () => {
	let info: jest.SpyInstance;
	let warn: jest.SpyInstance;
	beforeEach(() => {
		info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
		warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});
	afterEach(() => {
		info.mockRestore();
		warn.mockRestore();
		expect(fi.takeFounderIntent('__probe__')).toBeNull();
	});

	it('RS-1 a re-attach records the relays as the strand seed BEFORE addStrand', async () => {
		const { node, carried } = makeFakeNode();
		await createStrandDbFactory(node)('net1', { relays: [RELAY_A, RELAY_B] });
		expect(node.recordCarriedStrandAddrs).toHaveBeenCalledWith('net1', [RELAY_A, RELAY_B]);
		expect(carried.get('net1')).toEqual([RELAY_A, RELAY_B]);
		expect(node.recordCarriedStrandAddrs.mock.invocationCallOrder[0]).toBeLessThan(
			node.addStrand.mock.invocationCallOrder[0],
		);
		// Scoped to THIS strand: the strand id handed to addStrand is the one the seed was recorded for.
		expect(node.addStrand.mock.calls[0][0].strandRow.Id).toBe('net1');
		expect(info).toHaveBeenCalledWith('[strand-factory] relay seed', { relaySeed: 'seeded' });
	});

	it('RS-2 merges with the addresses already carried; blanks and duplicates are dropped', async () => {
		const { node } = makeFakeNode({ carried: [RELAY_B] });
		await createStrandDbFactory(node)('net2', { relays: ['  ', ` ${RELAY_A} `, RELAY_B, RELAY_A] });
		expect(node.recordCarriedStrandAddrs).toHaveBeenCalledWith('net2', [RELAY_B, RELAY_A]);
	});

	it('RS-3 a founding create never seeds, even when relays are passed', async () => {
		const { node } = makeFakeNode();
		await fi.withFounding(() => createStrandDbFactory(node)('net3', { relays: [RELAY_A] }));
		expect(node.recordCarriedStrandAddrs).not.toHaveBeenCalled();
		expect(node.addStrand.mock.calls[0][0].founder).toBe(true);
		expect(info).toHaveBeenCalledWith('[strand-factory] relay seed', { relaySeed: 'founding-skipped' });
	});

	it('RS-4 no relays: nothing is recorded and addStrand is still called synchronously', () => {
		const { node } = makeFakeNode();
		const pending = createStrandDbFactory(node)('net4', { relays: [] });
		expect(node.addStrand).toHaveBeenCalledTimes(1);
		expect(node.recordCarriedStrandAddrs).not.toHaveBeenCalled();
		return pending;
	});

	it('RS-5 a failed seed write does not fail the open', async () => {
		const { node } = makeFakeNode({ recordThrows: true });
		await expect(createStrandDbFactory(node)('net5', { relays: [RELAY_A] })).resolves.toBeDefined();
		expect(node.recordCarriedStrandAddrs).toHaveBeenCalled();
		expect(node.addStrand).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith('[strand-factory] relay seed not recorded', { reason: 'record-failed' });
	});

	it('RS-6 a host without the seed API opens unseeded', async () => {
		const { node } = makeFakeNode({ noSeedApi: true });
		await createStrandDbFactory(node)('net6', { relays: [RELAY_A] });
		expect(node.addStrand).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith('[strand-factory] relay seed', { relaySeed: 'unsupported' });
	});

	it('RS-7 log lines carry closed tokens only — never a relay address or the network hash', async () => {
		const { node } = makeFakeNode();
		await createStrandDbFactory(node)('net7secret', { relays: [RELAY_A] });
		const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
		expect(logged).not.toContain('relay-a.example.org');
		expect(logged).not.toContain('net7secret');
	});

	it('normalizeRelaySeed trims, drops blanks and non-strings, and de-duplicates in order', () => {
		expect(seedMod.normalizeRelaySeed(undefined)).toEqual([]);
		expect(seedMod.normalizeRelaySeed([' a ', '', 'b', 'a', 7])).toEqual(['a', 'b']);
	});
});
