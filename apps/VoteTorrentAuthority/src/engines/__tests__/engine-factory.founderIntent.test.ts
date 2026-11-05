/**
 * D-30: EngineFactory installs the founding window around its own NetworksEngine.create,
 * the method Add Network's builder commit() reaches, and passes the joined list to the
 * strand factory. Neither ../rn-db-factory, ../founder-intent nor ../joined-networks is
 * mocked: they are the code under test.
 *
 * This file is a TypeScript module (import/export below), so its top-level helper names never
 * collide with the standing TS2451 trap in sibling suites.
 */

import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
jest.mock(
	'@optimystic/db-p2p-storage-rn',
	() => ({
		openOptimysticRNDb: jest.fn((cfg: { name: string }) => ({ __openedName: cfg.name })),
		LevelDBRawStorage: class {
			db: unknown;
			constructor(db: unknown) {
				this.db = db;
			}
		},
		loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
	}),
	{ virtual: true },
);
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
	() => {
		// Mirrors the real call shapes: create() calls the factory synchronously as its first
		// statement; buildCreate().update().commit() reaches this.create with no await.
		class NetworksEngine {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dbFactory: (hash: string) => Promise<any>;
			counter = 0;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			constructor(_localStorage: any, dbFactory: (hash: string) => Promise<any>) {
				this.dbFactory = dbFactory;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async create(_networkInit: any, _user: any) {
				this.counter += 1;
				const db = await this.dbFactory('created-' + this.counter);
				return { db };
			}
			buildCreate() {
				return {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					update: (p: any) => ({ commit: () => this.create(p.networkInit, p.user) }),
				};
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async importFoundingBundle(bundle: any) {
				return { db: await this.dbFactory(bundle.hash) };
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async joinFromStrand(anchor: any) {
				return { db: await this.dbFactory(anchor.networkHash) };
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async open(ref: any) {
				return { db: await this.dbFactory(ref.hash) };
			}
		}
		class LocalStorageReact {}
		class LocalConfigKeyProvider {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			constructor(_c: any) {}
		}
		class AssociationEngine {}
		class PlayIntegrityVerifier {}
		class StubAttestationVerifier {}
		return {
			VOTETORRENT_SCHEMA_SQL: 'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;',
			NetworksEngine,
			LocalStorageReact,
			LocalConfigKeyProvider,
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
		};
	},
	{ virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EngineFactory } = require('../engine-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jn = require('../joined-networks');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rn = require('@votetorrent/vote-engine/rn');

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeFakeStrandDb() {
	return {
		setSchemaPath: jest.fn(),
		exec: jest.fn().mockResolvedValue(undefined),
		prepare: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) }),
	};
}

/** Fake CadreNode seam; addStrand can be held per call through `hold`. */
function makeFakeNode(connections: number) {
	const db = makeFakeStrandDb();
	const holds: Array<ReturnType<typeof deferred<void>> | null> = [];
	const strand = { strandId: 'fake', database: { getDatabase: () => db } };
	return {
		db,
		holds,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		addStrand: jest.fn(async (_config: any) => {
			const hold = holds.shift();
			if (hold) await hold.promise;
			return strand;
		}),
		getControlNode: jest.fn(() => ({ getConnections: () => new Array(connections).fill({}) })),
		whenStrandWritable: jest.fn(async () => {
			throw new Error('not configured');
		}),
	};
}

const USER = { id: 'u' };
const INIT = { name: 'n' };

type Fake = ReturnType<typeof makeFakeNode>;
const founderOf = (node: Fake, id: string) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	node.addStrand.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.strandRow.Id === id)?.founder;

describe('64-08 D-30: EngineFactory founding window (EF)', () => {
	let info: jest.SpyInstance;
	let warn: jest.SpyInstance;
	beforeEach(async () => {
		await AsyncStorage.clear();
		info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
		warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});
	afterEach(() => {
		info.mockRestore();
		warn.mockRestore();
		expect(fi.takeFounderIntent('__probe__')).toBeNull();
	});
	const attaches = () => info.mock.calls.filter((c) => c[0] === '[strand-factory] attach').map((c) => c[1]);

	function build(node: Fake | null, rnDb: (h: string) => Promise<unknown> = jest.fn(async () => ({}))) {
		const factory = new EngineFactory(new rn.LocalStorageReact(), rnDb);
		if (node) factory.setNode(node);
		return factory;
	}

	it('EF-1 Add Network builder path founds with the relay connected', async () => {
		const node = makeFakeNode(2);
		const factory = build(node);
		await factory.getNetworksEngine().buildCreate().update({ networkInit: INIT, user: USER }).commit();
		expect(node.addStrand).toHaveBeenCalledTimes(1);
		expect(node.addStrand.mock.calls[0][0].founder).toBe(true);
		expect(attaches()).toEqual([{ founder: true, controlConnections: 2, intent: 'founding' }]);
	});

	it('EF-2 a direct create() gives the same result', async () => {
		const node = makeFakeNode(2);
		const factory = build(node);
		await factory.getNetworksEngine().create(INIT, USER);
		expect(attaches()).toEqual([{ founder: true, controlConnections: 2, intent: 'founding' }]);
	});

	it('EF-3 importFoundingBundle keeps the default', async () => {
		const withPeers = makeFakeNode(2);
		await build(withPeers).getNetworksEngine().importFoundingBundle({ hash: 'bundle-a' });
		expect(founderOf(withPeers, 'bundle-a')).toBe(false);
		const alone = makeFakeNode(0);
		await build(alone).getNetworksEngine().importFoundingBundle({ hash: 'bundle-b' });
		expect(founderOf(alone, 'bundle-b')).toBe(true);
		expect(attaches().map((a: { intent: string }) => a.intent)).toEqual(['none', 'none']);
	});

	it('EF-4 open keeps the default, and a joined hash is never founder after a cold restart', async () => {
		const node = makeFakeNode(0);
		const factory = build(node);
		await factory.getNetworksEngine().open({ hash: 'plain-hash' });
		expect(founderOf(node, 'plain-hash')).toBe(true);
		await AsyncStorage.setItem(jn.AUTHORITY_JOINED_NETWORKS_KEY, '["joined-hash"]');
		await factory.getNetworksEngine().open({ hash: 'joined-hash' });
		expect(founderOf(node, 'joined-hash')).toBe(false);
		expect(attaches().map((a: { intent: string }) => a.intent)).toEqual(['none', 'none']);
	});

	it('EF-5 joinFromStrand inside withJoining is never founder', async () => {
		const node = makeFakeNode(0);
		const factory = build(node);
		await fi.withJoining('join-hash', () => factory.getNetworksEngine().joinFromStrand({ networkHash: 'join-hash' }));
		expect(founderOf(node, 'join-hash')).toBe(false);
		expect(attaches()).toEqual([{ founder: false, controlConnections: 0, intent: 'joining' }]);
	});

	it('EF-6 an unreadable list refuses the open', async () => {
		const node = makeFakeNode(0);
		const factory = build(node);
		(AsyncStorage.getItem as unknown as jest.Mock).mockRejectedValueOnce(new Error('io'));
		const err = await factory.getNetworksEngine().open({ hash: 'h6' }).catch((e: unknown) => e);
		expect(fi.isJoinedNetworksUnreadableError(err)).toBe(true);
		expect(node.addStrand).not.toHaveBeenCalled();
	});

	it('EF-7 solo path: a pending create holds the window; a second is busy; a third succeeds', async () => {
		const pending = deferred<unknown>();
		const rnDb = jest.fn(() => pending.promise);
		const factory = build(null, rnDb);
		const first = factory.getNetworksEngine().create(INIT, USER);
		const err = await factory.getNetworksEngine().create(INIT, USER).catch((e: unknown) => e);
		expect(fi.isFounderIntentBusyError(err)).toBe(true);
		pending.resolve({});
		await first;
		rnDb.mockImplementation(async () => ({}));
		await expect(factory.getNetworksEngine().create(INIT, USER)).resolves.toBeDefined();
	});

	it('EF-8 strand path: a pending first create does not lock out a second', async () => {
		const node = makeFakeNode(2);
		const hold = deferred<void>();
		node.holds.push(hold);
		const factory = build(node);
		const first = factory.getNetworksEngine().create(INIT, USER);
		// let the first reach its pending addStrand
		await new Promise((r) => setImmediate(r));
		await factory.getNetworksEngine().create(INIT, USER);
		expect(founderOf(node, 'created-1')).toBe(true);
		expect(founderOf(node, 'created-2')).toBe(true);
		expect(attaches().map((a: { intent: string }) => a.intent)).toEqual(['founding', 'founding']);
		hold.resolve();
		await first;
	});

	it('EF-9 an open started right after a pending create gets intent none', async () => {
		const node = makeFakeNode(2);
		const factory = build(node);
		const created = factory.getNetworksEngine().create(INIT, USER);
		const opened = factory.getNetworksEngine().open({ hash: 'stored' });
		await Promise.all([created, opened]);
		expect(founderOf(node, 'stored')).toBe(false);
		const intents = attaches().map((a: { intent: string }) => a.intent).sort();
		expect(intents).toEqual(['founding', 'none']);
	});

	describe('EF-10 vote-engine synchronous-prefix source guard', () => {
		const dir = path.resolve(__dirname, '../../../../../packages/vote-engine/src/networks');
		const read = (rel: string) =>
			fs
				.readFileSync(path.join(dir, rel), 'utf8')
				.split('\n')
				.map((l) => l.replace(/\/\/.*$/, ''))
				.join('\n');

		const bodyFrom = (src: string, marker: string, until: string) => {
			const start = src.indexOf(marker);
			expect(start).toBeGreaterThanOrEqual(0);
			const end = src.indexOf(until, start);
			expect(end).toBeGreaterThan(start);
			return src.slice(start, end);
		};

		it('EF-10a create reaches createContext with no await before it', () => {
			const src = read('networks-engine.ts');
			const text = bodyFrom(src, 'async create(', 'this.createContext(').replace(/\bawait\s*$/, '');
			expect(text).not.toMatch(/\bawait\b/);
		});

		it('EF-10b createContext reaches dbFactory with no other await', () => {
			const src = read('networks-engine.ts');
			const text = bodyFrom(src, 'private async createContext(', 'this.dbFactory(').replace(/\bawait\s*$/, '');
			expect(text).not.toMatch(/\bawait\b/);
		});

		it('EF-10c the builder commit reaches engine.create with no await', () => {
			const src = read('builders/networks-create-builder.ts');
			const text = bodyFrom(src, 'commit ()', 'this.engine.create(');
			expect(text).not.toMatch(/\bawait\b/);
		});

		it('EF-10d import, join and open never call this.create(', () => {
			const src = read('networks-engine.ts');
			for (const marker of ['importFoundingBundle(', 'joinFromStrand(', 'async open(']) {
				const start = src.indexOf(marker);
				expect(start).toBeGreaterThanOrEqual(0);
				// body: up to the next method-level declaration at tab depth 1
				const rest = src.slice(start + marker.length);
				const m = rest.match(/\n\t(?:async |private |public |static )?[A-Za-z_]+\s*\(/);
				const body = m ? rest.slice(0, m.index) : rest;
				expect(body).not.toContain('this.create(');
			}
		});
	});
});
