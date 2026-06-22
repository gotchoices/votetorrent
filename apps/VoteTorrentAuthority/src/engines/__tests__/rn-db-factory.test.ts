/**
 * RED → GREEN test for the strand-backed DbFactory (P2P-03 / D-07 / D-14).
 *
 * P2P-03: Engine contexts can be strand-backed — a CadreNode strand's Quereus
 *         Database is wired as the EngineContext.db with zero engine-SQL rewrites.
 * D-14:   setSchemaPath(['App','main']) makes bare table names (e.g. "Network")
 *         resolve to App.Network — the namespace transparency fix.
 * D-07:   addStrand mode is peer-gated — 'bootstrap' when solo, 'networked' when
 *         peers are connected (omitting mode defaults to 'networked' → solo hang).
 *
 * The strand path is injected with an addStrand-capable seam (the CadreNode), so
 * the heavy native/runtime deps of rn-db-factory.ts are mocked at module load and
 * the strand behaviour is driven entirely by the fake node below.
 */

// --- mock the module-load-time native/runtime deps so importing the factory is safe ---
// These packages publish ESM-only `exports` maps (no "require" condition), which
// jest's CommonJS resolver cannot resolve — so the mocks are registered `virtual`
// to intercept the source's imports without touching the filesystem.
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});
// UPDATED @quereus/quereus mock — Database is a jest.fn() constructor so .mock.instances
// tracks created instances. Each instance gets per-instance jest.fn() method spies so the
// test can assert registerModule, setDefaultVtabName, setSchemaPath calls on the specific DB.
jest.mock('@quereus/quereus', () => {
  const DatabaseMock = jest.fn(function(this: Record<string, jest.Mock>) {
    this.registerModule = jest.fn();
    this.setDefaultVtabName = jest.fn();
    this.setSchemaPath = jest.fn();    // keep — strand path tests use this
    this.exec = jest.fn().mockResolvedValue(undefined);
    this.prepare = jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) });
  });
  return {
    Database: DatabaseMock,
    // registerPlugin no longer called by solo path; kept for forward compat / strand path.
    registerPlugin: jest.fn(),
  };
}, { virtual: true });

// ADD: new plugin mocks for the solo @quereus/plugin-react-native-leveldb path
// Use jest.fn() as a constructor spy — jest is in the allowed scope list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });

jest.mock('@quereus/store', () => ({
  createIsolatedStoreModule: jest.fn(() => ({ /* stub VirtualTableModule */ })),
}), { virtual: true });
// `capturedDbFactory` is `mock`-prefixed (via the name) to satisfy jest hoisting rules.
// NetworksEngine records the DbFactory passed to its constructor so dispatch tests can
// invoke that captured factory and assert which underlying path ran.
let mockCapturedDbFactory: ((hash: string) => Promise<unknown>) | undefined;

jest.mock(
  '@votetorrent/vote-engine/rn',
  () => {
    class NetworksEngine {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_localStorage: any, dbFactory: (hash: string) => Promise<unknown>) {
        mockCapturedDbFactory = dbFactory;
      }
      // Minimal stub — open() and create() not needed for dispatch tests.
    }
    class LocalStorageReact {}
    return {
      VOTETORRENT_SCHEMA_SQL: 'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;',
      NetworksEngine,
      LocalStorageReact,
    };
  },
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory, rnDbFactory } = require('../rn-db-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EngineFactory } = require('../engine-factory');

// ---------------------------------------------------------------------------
// Fakes: a strand DB whose bare table names resolve, and a CadreNode seam.
// ---------------------------------------------------------------------------

/** Fake Quereus Database — setSchemaPath spy + a query path that accepts bare names. */
function makeFakeStrandDb() {
  return {
    setSchemaPath: jest.fn(),
    // After setSchemaPath(['App','main']) a BARE table name resolves to App.Network.
    exec: jest.fn().mockResolvedValue(undefined),
    prepare: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) }),
  };
}

/**
 * Fake CadreNode seam. `connections` controls getControlNode().getConnections().length.
 * addStrand records that it resolved BEFORE getDatabase() is read (ordering guard).
 */
function makeFakeNode({ connections = 0, db = makeFakeStrandDb() } = {}) {
  let strandAdded = false;
  const strand = {
    strandId: 'fake',
    database: {
      getDatabase: jest.fn(() => {
        // Pitfall 3: getDatabase() must never be called before addStrand resolves.
        if (!strandAdded) throw new Error('getDatabase() called before addStrand resolved');
        return db;
      }),
    },
    connectedPeers: connections,
  };
  return {
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addStrand: jest.fn(async (_config: any) => {
      strandAdded = true;
      return strand;
    }),
    getControlNode: jest.fn(() => ({
      getConnections: () => new Array(connections).fill({}),
    })),
  };
}

// ---------------------------------------------------------------------------
// P2P-03 / D-14: setSchemaPath transparency
// ---------------------------------------------------------------------------

describe('createStrandDbFactory — P2P-03 / D-14 / D-07', () => {
  it('invokes db.setSchemaPath(["App","main"]) exactly once after addStrand resolves', async () => {
    const node = makeFakeNode();
    const factory = createStrandDbFactory(node);

    const db = await factory('networkhash123');

    expect(node.addStrand).toHaveBeenCalledTimes(1);
    expect(node.db.setSchemaPath).toHaveBeenCalledTimes(1);
    expect(node.db.setSchemaPath).toHaveBeenCalledWith(['App', 'main']);
    expect(db).toBe(node.db);
  });

  it('lets a BARE table name query resolve against the strand DB (zero query rewrites)', async () => {
    const node = makeFakeNode();
    const factory = createStrandDbFactory(node);

    const db = await factory('networkhash123');

    // After the schema-path fix, an unqualified "Network" maps to App.Network.
    await expect(db.exec('SELECT * FROM Network')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // D-07: peer-gated mode literal
  // -------------------------------------------------------------------------

  it('passes mode "bootstrap" to addStrand when there are no connected peers', async () => {
    const node = makeFakeNode({ connections: 0 });
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    expect(node.addStrand.mock.calls[0][0].mode).toBe('bootstrap');
  });

  it('passes mode "networked" to addStrand when peers are connected', async () => {
    const node = makeFakeNode({ connections: 2 });
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    expect(node.addStrand.mock.calls[0][0].mode).toBe('networked');
  });

  it('derives the strandId from the network hash (D-05) and uses an official strand row', async () => {
    const node = makeFakeNode();
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    const config = node.addStrand.mock.calls[0][0];
    expect(config.strandRow).toEqual({
      Id: 'networkhash123',
      MemberPrivateKey: null,
      Type: 'o',
    });
    // The factory strips the `declare schema main { ... } apply schema main;` wrapper
    // so cadre-core (which re-wraps under `declare schema App { ... }`) does not nest
    // invalidly. Only the inner DDL is passed.
    expect(config.sAppConfig.schema).toBe('table Network ( Id text );');
  });
});

// ---------------------------------------------------------------------------
// EngineFactory setNode dispatch — D-04
//
// RED until Plan 02 adds `setNode(node: StrandHost | null): void` to EngineFactory
// and updates the constructor's DbFactory to dispatch lazily.
//
// Pattern: reuses `makeFakeNode` from above (lines 59–83). Spies on the
// `rnDbFactory` arg passed to the constructor; asserts which path the lazy
// DbFactory dispatches to when invoked with a network hash.
//
// The `mockCapturedDbFactory` variable (above, `mock`-prefixed) captures the
// DbFactory that EngineFactory passes to its internal NetworksEngine at
// construction time, so each test can invoke it directly.
// ---------------------------------------------------------------------------

describe('EngineFactory setNode dispatch — D-04', () => {
  beforeEach(() => {
    // Reset the captured factory before each test.
    mockCapturedDbFactory = undefined;
  });

  it('uses rnDbFactory when node is null (solo / SC1 no regression)', async () => {
    // Create a spy that represents the local RN factory (what is passed as the 2nd ctor arg).
    const rnDbFactorySpy = jest.fn(async (_hash: string) => ({ type: 'rnDb' }));
    // Spy on createStrandDbFactory to confirm it is NOT called on the local path.
    const createStrandSpy = jest.spyOn({ createStrandDbFactory }, 'createStrandDbFactory');

    // Construct EngineFactory — this triggers the NetworksEngine constructor which
    // records the lazy DbFactory into mockCapturedDbFactory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = new EngineFactory(new (require('@votetorrent/vote-engine/rn').LocalStorageReact)(), rnDbFactorySpy);

    // Do NOT call setNode (or explicitly pass null) — solo path.
    // If setNode exists, calling setNode(null) should also keep the rnDb path.
    if (typeof factory.setNode === 'function') {
      factory.setNode(null);
    }

    // Invoke the captured lazy DbFactory (the one actually wired into NetworksEngine).
    expect(mockCapturedDbFactory).toBeDefined();
    await mockCapturedDbFactory!('abc123hash');

    // The local rnDbFactory spy must have been reached.
    expect(rnDbFactorySpy).toHaveBeenCalledWith('abc123hash');
    // createStrandDbFactory must NOT have been invoked.
    expect(createStrandSpy).not.toHaveBeenCalled();

    createStrandSpy.mockRestore();
    void factory; // suppress unused-var lint
  });

  it('uses createStrandDbFactory(node) when node is set and USE_LOCAL_DB_FACTORY=false', async () => {
    const rnDbFactorySpy = jest.fn(async (_hash: string) => ({ type: 'rnDb' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = new EngineFactory(new (require('@votetorrent/vote-engine/rn').LocalStorageReact)(), rnDbFactorySpy);

    // Provide a real fake node — makeFakeNode() is defined above (lines 59–83).
    const fakeNode = makeFakeNode();
    // Call setNode(fakeNode) — RED: EngineFactory.setNode does not exist yet.
    factory.setNode(fakeNode);

    expect(mockCapturedDbFactory).toBeDefined();
    await mockCapturedDbFactory!('networkhash456');

    // The strand path: fakeNode.addStrand must have been called (not rnDbFactory).
    expect(fakeNode.addStrand).toHaveBeenCalled();
    expect(rnDbFactorySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STORE-01 / D-04 / D-06: solo rnDbFactory — no-cast provider path
//
// Asserts that the new solo factory:
//   - constructs ReactNativeLevelDBProvider with votetorrent-q2-<hash> databaseName
//   - calls db.registerModule('store', storeModule) — NO cast
//   - calls db.setDefaultVtabName('store')
//   - does NOT call registerPlugin (no-cast path confirmed)
//   - does NOT call db.setSchemaPath (solo path only; strand path owns setSchemaPath)
// ---------------------------------------------------------------------------

describe('rnDbFactory — STORE-01 / D-04 / D-06', () => {
  it('constructs ReactNativeLevelDBProvider with votetorrent-q2-<hash> databaseName', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReactNativeLevelDBProvider } = require('@quereus/plugin-react-native-leveldb');

    await rnDbFactory('abc123');

    expect(ReactNativeLevelDBProvider).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (ReactNativeLevelDBProvider as jest.Mock).mock.calls[0][0];
    expect(config.databaseName).toBe('votetorrent-q2-abc123');
    expect(typeof config.openFn).toBe('function');
    expect(config.WriteBatch).toBeDefined();
  });

  it('calls db.registerModule("store", storeModule) — no cast', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('@quereus/quereus');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createIsolatedStoreModule } = require('@quereus/store');

    await rnDbFactory('abc123');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbInstance = (Database as jest.Mock).mock.instances[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubModule = (createIsolatedStoreModule as jest.Mock).mock.results[0].value;
    expect(dbInstance.registerModule).toHaveBeenCalledWith('store', stubModule);
  });

  it('calls db.setDefaultVtabName("store") — required for USING-less schema', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('@quereus/quereus');

    await rnDbFactory('abc123');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbInstance = (Database as jest.Mock).mock.instances[0];
    expect(dbInstance.setDefaultVtabName).toHaveBeenCalledWith('store');
  });

  it('does NOT call registerPlugin — no-cast path confirmed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPlugin } = require('@quereus/quereus');

    await rnDbFactory('abc123');

    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it('does NOT call db.setSchemaPath — solo path only; strand path owns setSchemaPath', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('@quereus/quereus');

    await rnDbFactory('abc123');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbInstance = (Database as jest.Mock).mock.instances[0];
    expect(dbInstance.setSchemaPath).not.toHaveBeenCalled();
  });
});
