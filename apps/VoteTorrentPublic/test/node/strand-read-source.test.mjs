/**
 * strand-read-source.test.mjs — behaviour contract for
 * `src/peer/strand-read.js` (`56-16` Task 2).
 *
 * FAKES THE SEAMS, NEVER THE MODULE UNDER TEST. `openStrandReadHandle`
 * accepts an injected `deps.StrandDatabase` constructor (`strand-read.js`'s
 * own header explains why: `node:test`'s native `mock.module` needs
 * `--experimental-test-module-mocks`, a flag this plan is not permitted to
 * add to `package.json`'s `scripts` block). The fake `StrandDatabase` below
 * implements the SAME four-method surface
 * (`initialize`/`getDatabase`/`getTransactor`/`close`) the real class does —
 * it is a fake of the SEAM `@serfab/cadre-core` exposes, not a restatement of
 * `strand-read.js`'s own logic. `createStrandRowSource` is exercised against
 * a fake `uiDb` (`schemaManager` only) and a fake `strandDb` handle (a fake
 * Quereus `Database`'s `eval`/`getDefaultVtabModule`, plus a `close` spy) —
 * neither is the real Quereus engine, because this file's job is
 * `strand-read.js`'s OWN row-ordering, allowlist-iteration and error-hygiene
 * logic, not Quereus's SQL execution.
 *
 * THIS FILE DOES NOT PROVE: liveness (`56-11`), the D-16 inversion (`56-13`)
 * or a real strand connection (Task 1's `strand-entry-reachability.test.mjs`
 * and Task 3's `strand-read-provenance.test.mjs` own the real-composition and
 * anti-false-green proofs respectively). This file is Node tier, against
 * fakes of the seams.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';
import { PeerReplicationError, startPeerReplication } from '../../src/peer/reactivity-bridge.js';
import {
	StrandReadError,
	STRAND_READ_ROW_LIMIT,
	strandIdForNetwork,
	publicSAppConfig,
	openStrandReadHandle,
	createStrandRowSource,
} from '../../src/peer/strand-read.js';

/** A real, subscribed table -- never a fixture name, so the "allowed" tests
 * are not vacuous. @type {string} */
const TABLE_A = PUBLIC_SUBSCRIBED_TABLES[0];
/** A second real, subscribed table, distinct from TABLE_A. @type {string} */
const TABLE_B = PUBLIC_SUBSCRIBED_TABLES[1];

const NETWORK_HASH = 'aBcDeF0123456789aBcDeF0123456789fixture';

/** A sentinel that must never reach a thrown error's message. @type {string} */
const SECRET = 'PLANTED-STRAND-ROW-SECRET-MUST-NOT-ESCAPE-0123456789';

/**
 * Minimal fake `node`/`coordinatedRepo` values. `openStrandReadHandle` only
 * checks truthiness on these two and forwards them verbatim to the injected
 * `StrandDatabase` constructor -- it never dereferences their real shape
 * itself, so a bare marker object is a faithful fake of this SEAM.
 * @type {any}
 */
const FAKE_NODE = { marker: 'fake-56-05-node' };
/** @type {any} */
const FAKE_REPO = { marker: 'fake-coordinatedRepo' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fake `StrandDatabase`-shaped constructor. `instances` records every
 * constructed fake so a test can assert `close()` call counts.
 * @param {{
 *   transactor?: string,
 *   dbForConfig?: (config: any) => any,
 *   initializeImpl?: (config: any) => Promise<void> | void,
 *   closeImpl?: () => Promise<void> | void,
 * }} [opts]
 */
function makeFakeStrandDatabaseCtor(opts = {}) {
	const transactor = opts.transactor ?? 'network';
	/** @type {any[]} */
	const instances = [];
	class FakeStrandDatabase {
		/** @param {any} config */
		constructor(config) {
			this.config = config;
			this.closeCallCount = 0;
			instances.push(this);
		}
		async initialize() {
			if (opts.initializeImpl) await opts.initializeImpl(this.config);
		}
		getDatabase() {
			return opts.dbForConfig ? opts.dbForConfig(this.config) : makeFakeQuereusDb({});
		}
		getTransactor() {
			return transactor;
		}
		async close() {
			this.closeCallCount += 1;
			if (opts.closeImpl) await opts.closeImpl();
		}
	}
	return { FakeStrandDatabase, instances };
}

/**
 * A fake Quereus `Database`. `tableRows` maps table name -> row objects (or
 * an `Error` instance, which `eval` throws synchronously for that table).
 * Typed `any` on return -- this is a fake of the SEAM `strand-read.js` reads
 * (`eval`/`getDefaultVtabModule`/`setSchemaPath`), not the real `Database`'s
 * full structural shape; see `peer-reactivity-bridge.test.mjs`'s own
 * `makeFakeDb` for the same convention.
 * @param {Record<string, Record<string, any>[] | Error>} tableRows
 * @returns {any}
 */
function makeFakeQuereusDb(tableRows) {
	/** @type {string[]} */
	const evalCalls = [];
	return {
		evalCalls,
		getDefaultVtabModule: () => ({ name: 'optimystic', args: {} }),
		setSchemaPath: () => undefined,
		eval: (/** @type {string} */ sql) => {
			evalCalls.push(sql);
			const match = /from (\w+)/.exec(sql);
			const table = match ? match[1] : '';
			const rows = tableRows[table];
			if (rows instanceof Error) throw rows;
			const list = Array.isArray(rows) ? rows : [];
			return (async function* () {
				for (const row of list) yield row;
			})();
		},
	};
}

/**
 * A fake `uiDb` exposing only `schemaManager`. `schemas` maps table name to
 * its UI-side column-name list, in UI ORDER.
 * @param {Record<string, string[]>} schemas
 * @returns {any}
 */
function makeFakeUiDb(schemas) {
	return {
		schemaManager: {
			getCurrentSchemaName: () => 'main',
			getTable: (/** @type {string} */ _schemaName, /** @type {string} */ tableName) => {
				const columns = schemas[tableName];
				if (!columns) return undefined;
				return { name: tableName, columns: columns.map((name) => ({ name })) };
			},
		},
	};
}

/**
 * `readRows` iterates EVERY member of `PUBLIC_SUBSCRIBED_TABLES` on every
 * call (see `strand-read.js`'s own header on the deliberate non-decode), so
 * any fixture that calls `readRows` needs a UI schema for all eight members,
 * not only the one or two under test -- otherwise the FIRST undeclared table
 * throws before the test's own table is ever reached. `overrides` replaces
 * one or more tables' generic `['Id']` column list with the shape a specific
 * test needs.
 * @param {Record<string, string[]>} [overrides]
 */
function makeFullUiDb(overrides = {}) {
	/** @type {Record<string, string[]>} */
	const schemas = {};
	for (const table of PUBLIC_SUBSCRIBED_TABLES) schemas[table] = ['Id'];
	return makeFakeUiDb({ ...schemas, ...overrides });
}

/**
 * A ready-made `StrandReadHandle`-shaped fake, for tests that exercise
 * `createStrandRowSource` directly without going through
 * `openStrandReadHandle`.
 * @param {Record<string, Record<string, any>[] | Error>} tableRows
 * @returns {any}
 */
function makeFakeStrandHandle(tableRows) {
	let closeCallCount = 0;
	const db = makeFakeQuereusDb(tableRows);
	return {
		db,
		strandDatabase: {},
		transactor: 'network',
		get closeCallCount() {
			return closeCallCount;
		},
		close: async () => {
			closeCallCount += 1;
		},
	};
}

// ---------------------------------------------------------------------------
// strandIdForNetwork
// ---------------------------------------------------------------------------

test('strandIdForNetwork returns the networkHash unchanged', () => {
	assert.equal(strandIdForNetwork('abc123'), 'abc123');
});

test('strandIdForNetwork throws StrandReadError -- never returns a default -- for "", null, and a number', () => {
	for (const bad of ['', null, 42]) {
		assert.throws(
			() => strandIdForNetwork(/** @type {any} */ (bad)),
			(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'networkHash',
		);
	}
});

// ---------------------------------------------------------------------------
// publicSAppConfig
// ---------------------------------------------------------------------------

test('publicSAppConfig returns a frozen object whose schema is VOTETORRENT_SCHEMA_SQL with the outer wrapper stripped, and carries no signature field', () => {
	const config = publicSAppConfig();
	assert.ok(Object.isFrozen(config));
	assert.equal(config.id, 'org.votetorrent');
	assert.equal(config.version, '1.0.0');
	assert.equal(config.latencyHint, 'interactive');
	assert.ok(!('signature' in config));
	assert.ok(!config.schema.trim().startsWith('declare schema'), 'the outer "declare schema ... {" wrapper must be stripped');
	assert.ok(!/apply\s+schema\s+\w+\s*;\s*$/.test(config.schema.trim()), 'the trailing "apply schema ...;" statement must be stripped');
	assert.ok(config.schema.trim().length > 0, 'the stripped body must be non-empty');
});

test('publicSAppConfig is frozen -- a write attempt does not mutate the returned object', () => {
	const config = publicSAppConfig();
	assert.throws(() => {
		'use strict';
		// @ts-expect-error -- deliberately mutating a frozen object under test
		config.id = 'someone-else';
	});
});

// ---------------------------------------------------------------------------
// openStrandReadHandle
// ---------------------------------------------------------------------------

test('openStrandReadHandle rejects with StrandReadError naming the missing option, for each of networkHash/node/coordinatedRepo', async () => {
	const { FakeStrandDatabase } = makeFakeStrandDatabaseCtor();
	const base = { networkHash: NETWORK_HASH, node: FAKE_NODE, coordinatedRepo: FAKE_REPO };
	for (const omitted of /** @type {const} */ (['networkHash', 'node', 'coordinatedRepo'])) {
		const options = { ...base, [omitted]: undefined };
		await assert.rejects(
			openStrandReadHandle(/** @type {any} */ (options), /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase })),
			(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === omitted,
		);
	}
});

test('openStrandReadHandle rejects when called with no options object at all', async () => {
	const { FakeStrandDatabase } = makeFakeStrandDatabaseCtor();
	await assert.rejects(
		openStrandReadHandle(/** @type {any} */ (undefined), /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase })),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'options',
	);
});

test('openStrandReadHandle returns a handle whose db.getDefaultVtabModule().name is "optimystic"', async () => {
	const { FakeStrandDatabase } = makeFakeStrandDatabaseCtor();
	const handle = await openStrandReadHandle({ networkHash: NETWORK_HASH, node: FAKE_NODE, coordinatedRepo: FAKE_REPO }, /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase }));
	assert.equal(handle.db.getDefaultVtabModule().name, 'optimystic');
});

test('openStrandReadHandle passes strandId === networkHash, sAppConfig from publicSAppConfig(), the injected node and coordinatedRepo, strandType "o" and founder false to StrandDatabase', async () => {
	const { FakeStrandDatabase, instances } = makeFakeStrandDatabaseCtor();
	/** @type {any} */
	const fakeNode = { marker: 'the-injected-56-05-node' };
	/** @type {any} */
	const fakeRepo = { marker: 'the-injected-coordinatedRepo' };
	await openStrandReadHandle({ networkHash: NETWORK_HASH, node: fakeNode, coordinatedRepo: fakeRepo }, /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase }));
	assert.equal(instances.length, 1);
	const config = instances[0].config;
	assert.equal(config.strandId, NETWORK_HASH);
	assert.deepEqual(config.sAppConfig, publicSAppConfig());
	assert.equal(config.libp2pNode, fakeNode);
	assert.equal(config.coordinatedRepo, fakeRepo);
	assert.equal(config.strandType, 'o');
	assert.equal(config.founder, false);
});

test('openStrandReadHandle asserts the RESOLVED transactor is "network" and rejects (naming the resolved value) when it is not', async () => {
	const { FakeStrandDatabase } = makeFakeStrandDatabaseCtor({ transactor: 'local' });
	await assert.rejects(
		openStrandReadHandle({ networkHash: NETWORK_HASH, node: FAKE_NODE, coordinatedRepo: FAKE_REPO }, /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase })),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'local',
	);
});

test('openStrandReadHandle succeeds and reports "network" when the resolved transactor is "network"', async () => {
	const { FakeStrandDatabase } = makeFakeStrandDatabaseCtor({ transactor: 'network' });
	const handle = await openStrandReadHandle({ networkHash: NETWORK_HASH, node: FAKE_NODE, coordinatedRepo: FAKE_REPO }, /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase }));
	assert.equal(handle.transactor, 'network');
});

test('openStrandReadHandle.close() calls the underlying StrandDatabase.close() exactly once, even across two calls', async () => {
	const { FakeStrandDatabase, instances } = makeFakeStrandDatabaseCtor();
	const handle = await openStrandReadHandle({ networkHash: NETWORK_HASH, node: FAKE_NODE, coordinatedRepo: FAKE_REPO }, /** @type {any} */ ({ StrandDatabase: FakeStrandDatabase }));
	await handle.close();
	await handle.close();
	assert.equal(instances[0].closeCallCount, 1);
});

// ---------------------------------------------------------------------------
// createStrandRowSource / readRows
// ---------------------------------------------------------------------------

test('createStrandRowSource throws StrandReadError naming the missing option when uiDb or strandDb is absent', () => {
	const strandDb = makeFakeStrandHandle({});
	const uiDb = makeFakeUiDb({});
	assert.throws(
		() => createStrandRowSource(/** @type {any} */ ({ strandDb })),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'uiDb',
	);
	assert.throws(
		() => createStrandRowSource(/** @type {any} */ ({ uiDb })),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'strandDb',
	);
});

test('createStrandRowSource returns an object with readRows and close functions', () => {
	const source = createStrandRowSource({ uiDb: makeFakeUiDb({}), strandDb: makeFakeStrandHandle({}) });
	assert.equal(typeof source.readRows, 'function');
	assert.equal(typeof source.close, 'function');
});

test('readRows on all-empty allowlisted tables returns an empty array', async () => {
	const uiDb = makeFullUiDb();
	const strandDb = makeFakeStrandHandle({});
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
	assert.deepEqual(batches, []);
});

test('readRows returns exactly one batch per allowlisted table that has rows, and skips a table that returned zero rows -- never an empty batch', async () => {
	const uiDb = makeFullUiDb();
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: [{ Id: '1' }] });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
	assert.equal(batches.length, 1);
	assert.equal(batches[0].table, TABLE_A);
	assert.equal(batches[0].ops.length, 1);
	assert.equal(batches[0].ops[0].op, 'upsert');
});

test('readRows never returns a batch for a table outside PUBLIC_SUBSCRIBED_TABLES', async () => {
	const uiDb = makeFullUiDb();
	const strandDb = makeFakeStrandHandle({});
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
	for (const batch of batches) {
		assert.ok(PUBLIC_SUBSCRIBED_TABLES.includes(batch.table));
	}
});

test('every returned row is column-ordered against the UI handle\'s schema, not the strand handle\'s -- a fixture whose two schemas declare different column order still produces UI-ordered rows', async () => {
	// UI declares [LastName, FirstName]; the strand row is keyed the other way
	// round on the wire (an ordinary JS object -- order is irrelevant to the
	// lookup, which is the whole point: this proves the OUTPUT order follows
	// the UI schema regardless of how the strand-side row was constructed).
	const uiDb = makeFullUiDb({ [TABLE_A]: ['LastName', 'FirstName'] });
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: [{ FirstName: 'Ada', LastName: 'Lovelace' }] });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
	assert.equal(batches.length, 1);
	assert.deepEqual(batches[0].ops[0].row, ['Lovelace', 'Ada']);
});

test('a UI schema column absent from the strand row maps to null, never throws', async () => {
	const uiDb = makeFullUiDb({ [TABLE_A]: ['Id', 'MissingOnStrand'] });
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: [{ Id: '1' }] });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	const batches = await readRows({ collectionId: 'x', revision: 1, invalidation: false });
	assert.deepEqual(batches[0].ops[0].row, ['1', null]);
});

test('readRows throws StrandReadError naming the table when the UI handle declares no schema for it', async () => {
	const uiDb = makeFakeUiDb({}); // declares nothing
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: [{ Id: '1' }] });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	await assert.rejects(
		readRows({ collectionId: 'x', revision: 1, invalidation: false }),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.subject === TABLE_A,
	);
});

test('a single table exceeding STRAND_READ_ROW_LIMIT rejects with StrandReadError naming the table and the limit -- never truncates', async () => {
	const uiDb = makeFakeUiDb({ [TABLE_A]: ['Id'] });
	const overLimitRows = Array.from({ length: STRAND_READ_ROW_LIMIT + 1 }, (_, i) => ({ Id: String(i) }));
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: overLimitRows });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	await assert.rejects(
		readRows({ collectionId: 'x', revision: 1, invalidation: false }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof StrandReadError);
			assert.equal(err.subject, TABLE_A);
			assert.ok(err.message.includes(String(STRAND_READ_ROW_LIMIT)), 'the limit value must be named in the error');
			return true;
		},
	);
});

test('readRows rejects with StrandReadError carrying the underlying error\'s NAME only when a SELECT throws -- never the message', async () => {
	const uiDb = makeFakeUiDb({ [TABLE_A]: ['Id'] });
	const underlying = new Error(`constraint failed on value "${SECRET}"`);
	underlying.name = 'QuereusConstraintError';
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: underlying });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	await assert.rejects(
		readRows({ collectionId: 'x', revision: 1, invalidation: false }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof StrandReadError);
			assert.ok(err.message.includes('QuereusConstraintError'));
			assert.ok(!err.message.includes(SECRET), 'the underlying error MESSAGE must never reach the wrapped error');
			return true;
		},
	);
});

test('a SECRET planted in a strand row never appears in any thrown error message', async () => {
	const uiDb = makeFakeUiDb({ [TABLE_A]: ['Id'] });
	const overLimitRows = Array.from({ length: STRAND_READ_ROW_LIMIT + 1 }, (_, i) => ({ Id: i === 0 ? SECRET : String(i) }));
	const strandDb = makeFakeStrandHandle({ [TABLE_A]: overLimitRows });
	const { readRows } = createStrandRowSource({ uiDb, strandDb });
	await assert.rejects(
		readRows({ collectionId: 'x', revision: 1, invalidation: false }),
		(/** @type {any} */ err) => {
			assert.ok(!err.message.includes(SECRET));
			return true;
		},
	);
});

test('close() calls the strand handle\'s close() exactly once, and a second call is a no-op that does not throw', async () => {
	const strandDb = makeFakeStrandHandle({});
	const { close } = createStrandRowSource({ uiDb: makeFakeUiDb({}), strandDb });
	await close();
	await close();
	assert.equal(strandDb.closeCallCount, 1);
});

// ---------------------------------------------------------------------------
// The real-bridge contract proof -- 56-09's startPeerReplication must accept
// this module's readRows and NOT throw the missing-readRows PeerReplicationError.
// ---------------------------------------------------------------------------

test('the readRows produced by createStrandRowSource satisfies 56-09\'s startPeerReplication required-option check against the REAL bridge', async () => {
	const uiDb = makeFakeUiDb({ [TABLE_A]: ['Id'] });
	const strandDb = makeFakeStrandHandle({});
	const { readRows } = createStrandRowSource({ uiDb, strandDb });

	// Minimal fakes of startPeerReplication's OTHER required options -- see
	// `peer-reactivity-bridge.test.mjs`'s own `makeFakeWatch` for the pattern
	// this mirrors.
	const fakeNode = { reactivityWatch: { watch: () => ({ close: async () => undefined }) } };
	/** @type {any} */
	const fakeDb = {
		schemaManager: { getModule: () => undefined, getCurrentSchemaName: () => 'main', getTable: () => ({ name: TABLE_A, columns: [] }) },
		ingestExternalRowChanges: async () => undefined,
		onDataChange: () => () => undefined,
	};

	let handle;
	try {
		handle = startPeerReplication({
			db: fakeDb,
			networkHash: NETWORK_HASH,
			node: fakeNode,
			collections: [{ table: TABLE_A, collectionId: `default/${TABLE_A}` }],
			tails: { readTails: async () => new Map() },
			readRows,
		});
	} catch (err) {
		assert.ok(
			!(err instanceof PeerReplicationError && err.subject === 'readRows'),
			'startPeerReplication must not throw the missing-readRows PeerReplicationError once a real readRows is supplied',
		);
		throw err;
	}
	assert.equal(typeof handle.stop, 'function');
	await handle.stop();
});
