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
// 58-05 Task 3: NOT previously mocked here. Copied from
// CadreNodeProvider.test.tsx's virtual mock rather than re-derived — the
// disjointness describe block below drives `createScopedRnStorageProvider`
// (storage-guard.ts), which imports this module for its own strand-path
// LevelDB open.
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
    // Phase 43 (D-13/D-14): EngineFactory's class-field `integrityKeyProvider`
    // constructs a `LocalConfigKeyProvider` at object-construction time — this
    // virtual mock must provide a stand-in so `new EngineFactory(...)` doesn't
    // throw here (this test only exercises the DbFactory dispatch seam, not
    // the association verifier seam — see engine-factory.association.test.ts).
    class LocalConfigKeyProvider {}
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
const { createStrandDbFactory, rnDbFactory } = require('../rn-db-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EngineFactory } = require('../engine-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createScopedRnStorageProvider } = require('../storage-guard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StrandWaitCancelledError, StrandLaunchFailedError, failOnStrandError } = require('../strand-first-sync');

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
 *
 * `whenStrandWritable` is a jest.fn() the first-sync gate tests below reconfigure per
 * case; it defaults to rejecting so a test that forgets to configure it fails loudly
 * rather than hanging.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    whenStrandWritable: jest.fn(async (_strandId: string): Promise<any> => {
      throw new Error('whenStrandWritable not configured for this test');
    }),
    // Marks the strand's database as present + resolved, mirroring what a real
    // whenStrandWritable resolution guarantees per Pitfall 3.
    __markWritable(): void {
      strandAdded = true;
    },
  };
}

/** Builds a fake gate error exactly as the real StrandAwaitingFirstSyncError shapes it. */
function makeGateError(strandId: string, waitedMs = 300_000): Error {
  const err = new Error(`Strand ${strandId} is not yet reachable`);
  err.name = 'StrandAwaitingFirstSyncError';
  (err as unknown as { strandId: string; waitedMs: number }).strandId = strandId;
  (err as unknown as { strandId: string; waitedMs: number }).waitedMs = waitedMs;
  return err;
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

  // Spike 064: cadre-core 0.11.0 DELETED `StrandMode` / `StrandConfig.mode` (a
  // deliberate breaking change). The peer probe survives with its meaning intact —
  // no control peers means nobody else can have provisioned this strand, so we are
  // the founder. `founder` must be passed EXPLICITLY on the solo path: it defaults
  // to false upstream, and a strand founded by nobody never gets its `Strand.Header`.
  it('passes founder: true to addStrand when there are no connected peers', async () => {
    const node = makeFakeNode({ connections: 0 });
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    expect(node.addStrand.mock.calls[0][0].founder).toBe(true);
  });

  it('passes founder: false to addStrand when peers are connected', async () => {
    const node = makeFakeNode({ connections: 2 });
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    expect(node.addStrand.mock.calls[0][0].founder).toBe(false);
  });

  it('F-1: logs one closed-token attach marker with the founder flag and connection count, never the strand id', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await createStrandDbFactory(makeFakeNode({ connections: 0 }))('networkhash123');
      await createStrandDbFactory(makeFakeNode({ connections: 1 }))('networkhash123');
      const marks = info.mock.calls.filter((c) => c[0] === '[strand-factory] attach');
      expect(marks.length).toBe(2);
      expect(marks[0][1]).toEqual({ founder: true, controlConnections: 0, intent: 'none' });
      expect(marks[1][1]).toEqual({ founder: false, controlConnections: 1, intent: 'none' });
      expect(JSON.stringify(info.mock.calls)).not.toContain('networkhash123');
    } finally {
      info.mockRestore();
    }
  });

  it('never passes the retired `mode` key (cadre-core 0.11.0 deleted it)', async () => {
    const node = makeFakeNode({ connections: 0 });
    const factory = createStrandDbFactory(node);

    await factory('networkhash123');

    expect(node.addStrand.mock.calls[0][0].mode).toBeUndefined();
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
      FounderOwnerKey: null,
      FounderPeerId: null,
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

// ---------------------------------------------------------------------------
// Backend store-namespace disjointness — RESEARCH Open Question 1, in-process
// half (58-05 Task 3).
//
// What this proves: the solo path's `votetorrent-q2-<hash>` and the strand
// path's `votetorrent-strand-<hash>` are disjoint for the SAME network hash,
// so a transient wrong-backend `open()` (T-58-05-01 — the race Plan 58-05
// Tasks 1/2 remove) cannot mint the store the correct backend later
// re-attaches to; the namespaces cannot collide.
//
// What this does NOT prove: anything about residue already written to disk
// by a build that shipped the defect. No in-process/jest test can observe an
// on-disk LevelDB directory — that half is handed to 58-07's device leg, on
// a device that already ran the defective build.
// ---------------------------------------------------------------------------
describe('Backend store-namespace disjointness — RESEARCH Open Question 1 (in-process half, 58-05)', () => {
  it('derives disjoint store names for the solo and strand backends from the SAME network hash', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReactNativeLevelDBProvider } = require('@quereus/plugin-react-native-leveldb');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { openOptimysticRNDb } = require('@optimystic/db-p2p-storage-rn');

    const sameHash = 'sharedhash789';

    // Solo path: rnDbFactory derives `votetorrent-q2-<hash>` (rn-db-factory.ts:50).
    await rnDbFactory(sameHash);
    const soloCalls = (ReactNativeLevelDBProvider as jest.Mock).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const soloName: string = (soloCalls[soloCalls.length - 1][0] as any).databaseName;

    // Strand path: createScopedRnStorageProvider() derives
    // `votetorrent-strand-<scopeId>` (storage-guard.ts:62) — the strandId IS
    // the network hash (D-05), so invoking it with the SAME hash is the
    // correct like-for-like comparison.
    const scopedProvider = createScopedRnStorageProvider();
    scopedProvider(sameHash);
    const strandCalls = (openOptimysticRNDb as jest.Mock).mock.calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const strandName: string = (strandCalls[strandCalls.length - 1][0] as any).name;

    // Both names are COMPUTED from the same `sameHash` variable — not two
    // independently hard-coded strings — so this is a live assertion on the
    // real derivation, not a restatement of it.
    expect(soloName).toBe(`votetorrent-q2-${sameHash}`);
    expect(strandName).toBe(`votetorrent-strand-${sameHash}`);
    expect(soloName).not.toBe(strandName);
    expect(soloName.startsWith(strandName)).toBe(false);
    expect(strandName.startsWith(soloName)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// first-sync gate (StrandAwaitingFirstSyncError) — quick task 260928-kkf.
//
// addStrand can now REJECT with the retryable StrandAwaitingFirstSyncError for a
// joiner whose sibling has not been reachable since it joined. These cases prove the
// factory treats that ONE specific error as "keep waiting" (via whenStrandWritable),
// while every other error — including the same error for a DIFFERENT strand — still
// rejects the factory exactly as before.
// ---------------------------------------------------------------------------
describe('createStrandDbFactory — first-sync gate (StrandAwaitingFirstSyncError)', () => {
  it('(a) waits via whenStrandWritable and resolves once writable, calling onAwaitingFirstSync once before resolution', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    const callOrder: string[] = [];
    node.whenStrandWritable.mockImplementationOnce(async (strandId: string) => {
      callOrder.push('whenStrandWritable');
      expect(strandId).toBe('networkhash123');
      node.__markWritable();
      return node.db && { strandId, database: { getDatabase: () => node.db } };
    });
    const onAwaitingFirstSync = jest.fn((strandId: string) => {
      callOrder.push('onAwaitingFirstSync:' + strandId);
    });

    const factory = createStrandDbFactory(node, { onAwaitingFirstSync });
    const db = await factory('networkhash123');

    expect(db).toBe(node.db);
    expect(node.db.setSchemaPath).toHaveBeenCalledTimes(1);
    expect(node.db.setSchemaPath).toHaveBeenCalledWith(['App', 'main']);
    expect(node.addStrand).toHaveBeenCalledTimes(1);
    expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);
    expect(onAwaitingFirstSync).toHaveBeenCalledTimes(1);
    expect(onAwaitingFirstSync).toHaveBeenCalledWith('networkhash123');
    // onAwaitingFirstSync fired BEFORE the wait resolved.
    expect(callOrder).toEqual(['onAwaitingFirstSync:networkhash123', 'whenStrandWritable']);
  });

  it('(a2) a gate rejection followed by a resolution does not hot-loop (floored at MIN_FIRST_SYNC_RETRY_INTERVAL_MS), addStrand called exactly once', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const node = makeFakeNode();
      const gateError = makeGateError('networkhash123');
      node.addStrand.mockRejectedValueOnce(gateError);

      let calls = 0;
      node.whenStrandWritable.mockImplementation(async (strandId: string) => {
        calls += 1;
        if (calls === 1) {
          // Immediate rejection — the hot-loop guard must still floor the retry.
          throw makeGateError(strandId);
        }
        node.__markWritable();
        return { strandId, database: { getDatabase: () => node.db } };
      });

      const factory = createStrandDbFactory(node);
      const resultPromise = factory('networkhash123');

      // Flush the first (rejecting) whenStrandWritable attempt.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

      // Advance less than the floor — the second attempt must not have fired yet.
      await jest.advanceTimersByTimeAsync(1000);
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

      // Advance past the floor — the second attempt fires and resolves.
      await jest.advanceTimersByTimeAsync(5000);
      const db = await resultPromise;

      expect(db).toBe(node.db);
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(2);
      expect(node.addStrand).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('(b) a generic addStrand rejection rejects the factory with the SAME error object; whenStrandWritable and onAwaitingFirstSync never called', async () => {
    const node = makeFakeNode();
    const boom = new Error('boom');
    node.addStrand.mockRejectedValueOnce(boom);
    const onAwaitingFirstSync = jest.fn();

    const factory = createStrandDbFactory(node, { onAwaitingFirstSync });

    await expect(factory('networkhash123')).rejects.toBe(boom);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
    expect(onAwaitingFirstSync).not.toHaveBeenCalled();
  });

  it('(b2) a gate-named error for a DIFFERENT strand rejects the factory unchanged (not waited on)', async () => {
    const node = makeFakeNode();
    const otherStrandError = makeGateError('some-other-strand');
    node.addStrand.mockRejectedValueOnce(otherStrandError);

    const factory = createStrandDbFactory(node);

    await expect(factory('networkhash123')).rejects.toBe(otherStrandError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });

  it('(b3) a non-gate whenStrandWritable rejection rejects the factory with it', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);
    const notRunning = new Error('strand not running on this node');
    node.whenStrandWritable.mockRejectedValueOnce(notRunning);

    const factory = createStrandDbFactory(node);

    await expect(factory('networkhash123')).rejects.toBe(notRunning);
  });

  it('(c) aborting the signal while whenStrandWritable is pending rejects with StrandWaitCancelledError, removes the abort listener, and never touches the orphaned resolution', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    let resolveOrphan!: (value: unknown) => void;
    node.whenStrandWritable.mockImplementationOnce(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Promise<any>((resolve) => {
          resolveOrphan = resolve;
        }),
    );

    const controller = new AbortController();
    const addSpy = jest.spyOn(controller.signal, 'addEventListener');
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

    const factory = createStrandDbFactory(node, { signal: controller.signal });
    const resultPromise = factory('networkhash123');

    // Let addStrand reject and the wait begin (whenStrandWritable called, pending).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(StrandWaitCancelledError);
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // Orphaned whenStrandWritable resolving later must not call setSchemaPath/getDatabase,
    // and must not surface as an unhandled rejection.
    resolveOrphan({ strandId: 'networkhash123', database: { getDatabase: () => node.db } });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.db.setSchemaPath).not.toHaveBeenCalled();
  });

  it('(c2) an already-aborted signal rejects with StrandWaitCancelledError without calling whenStrandWritable', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    const controller = new AbortController();
    controller.abort();

    const factory = createStrandDbFactory(node, { signal: controller.signal });

    await expect(factory('networkhash123')).rejects.toBeInstanceOf(StrandWaitCancelledError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// 64-08 D-30: founder intent in createStrandDbFactory
// ---------------------------------------------------------------------------

describe('64-08 D-30: founder intent in createStrandDbFactory (DF)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fi: any;
  beforeAll(() => {
    // Lazy: the existing cases must still load while the module is missing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fi = require('../founder-intent');
  });

  function deferredValue<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Like makeFakeNode, but the connection count is read on every getConnections() call. */
  function makeMutableFakeNode(initial = 0) {
    const state = { connections: initial };
    const node = makeFakeNode({ connections: 0 });
    node.getControlNode = jest.fn(() => ({
      getConnections: () => new Array(state.connections).fill({}),
    }));
    return { node, state };
  }

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

  const attachLines = () => info.mock.calls.filter((c) => c[0] === '[strand-factory] attach').map((c) => c[1]);

  type Mode = 'founding' | 'joining' | 'none';
  const rows: Array<[Mode, boolean, number]> = [];
  for (const mode of ['founding', 'joining', 'none'] as Mode[]) {
    for (const joined of [true, false]) {
      for (const connections of [0, 2]) rows.push([mode, joined, connections]);
    }
  }

  it.each(rows)('DF-1 intent=%s joined=%s connections=%s follows the resolution table', async (mode, joined, connections) => {
    const node = makeFakeNode({ connections });
    const factory = createStrandDbFactory(node, { isJoinedNetwork: async () => joined });
    const run = () => factory('hashDF1');
    if (mode === 'founding') await fi.withFounding(run);
    else if (mode === 'joining') await fi.withJoining('hashDF1', run);
    else await run();
    const intent = mode === 'none' ? null : mode;
    const expected = fi.resolveFounderFlag({ intent, joined, controlConnections: connections });
    expect(node.addStrand.mock.calls[0][0].founder).toBe(expected);
    expect(attachLines()).toEqual([{ founder: expected, controlConnections: connections, intent: mode }]);
  });

  it('DF-2 no options keeps addStrand synchronous; with isJoinedNetwork it waits for the list', async () => {
    const plain = makeFakeNode();
    const p1 = createStrandDbFactory(plain)('hashDF2');
    expect(plain.addStrand).toHaveBeenCalledTimes(1);
    await p1;

    const withList = makeFakeNode();
    const p2 = createStrandDbFactory(withList, { isJoinedNetwork: async () => false })('hashDF2');
    expect(withList.addStrand).not.toHaveBeenCalled();
    await p2;
    expect(withList.addStrand).toHaveBeenCalledTimes(1);
  });

  it('DF-3 an unreadable list refuses the open and calls no addStrand', async () => {
    const check = async (opt: () => boolean | Promise<boolean>, wrap: boolean) => {
      info.mockClear();
      warn.mockClear();
      const node = makeFakeNode();
      const factory = createStrandDbFactory(node, { isJoinedNetwork: opt });
      const run = () => factory('hashDF3');
      const err = await (wrap ? fi.withFounding(run) : run()).catch((e: unknown) => e);
      expect(fi.isJoinedNetworksUnreadableError(err)).toBe(true);
      expect(node.addStrand).not.toHaveBeenCalled();
      expect(attachLines()).toEqual([]);
      const refusals = warn.mock.calls.filter((c) => c[0] === '[strand-factory] attach refused');
      expect(refusals.length).toBe(1);
      expect(refusals[0][1]).toEqual({ reason: 'joined-list-unreadable' });
    };
    await check(async () => { throw new Error('io'); }, false);
    await check(() => { throw new Error('io'); }, false);
    await check(async () => { throw new Error('io'); }, true);
    await check(() => { throw new Error('io'); }, true);
  });

  it('DF-4 a joined hash is never founder, even in a founding window with no connections', async () => {
    const node = makeFakeNode({ connections: 0 });
    const factory = createStrandDbFactory(node, { isJoinedNetwork: async () => true });
    await fi.withFounding(() => factory('hashDF4'));
    expect(node.addStrand.mock.calls[0][0].founder).toBe(false);
    expect(attachLines()[0].intent).toBe('founding');
    expect(fi.takeFounderIntent('hashDF4')).toBeNull();
  });

  it('DF-5 one founding window serves one open only', async () => {
    const node = makeFakeNode({ connections: 2 });
    const factory = createStrandDbFactory(node, { isJoinedNetwork: async () => false });
    await fi.withFounding(async () => {
      await factory('hashA');
      await factory('hashB');
    });
    const calls = node.addStrand.mock.calls.map((c: any[]) => [c[0].strandRow.Id, c[0].founder]);
    expect(calls).toEqual([['hashA', true], ['hashB', false]]);
    expect(attachLines().map((l: any) => l.intent)).toEqual(['founding', 'none']);
  });

  it('DF-6 an open that started before the window does not inherit it', async () => {
    const node = makeFakeNode({ connections: 2 });
    const gateB = deferredValue<boolean>();
    const factoryB = createStrandDbFactory(node, { isJoinedNetwork: () => gateB.promise });
    const factoryA = createStrandDbFactory(node, { isJoinedNetwork: async () => false });
    const pB = factoryB('hashB');
    const pA = fi.withFounding(() => factoryA('hashA'));
    gateB.resolve(false);
    await Promise.all([pA, pB]);
    const by = (id: string) => node.addStrand.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.strandRow.Id === id);
    expect(by('hashB').founder).toBe(false);
    expect(by('hashA').founder).toBe(true);
    const intents = attachLines().map((l: any) => l.intent).sort();
    expect(intents).toEqual(['founding', 'none']);
  });

  it('DF-7 the claim is made at call time, not after the window ended', async () => {
    const node = makeFakeNode({ connections: 2 });
    const gate = deferredValue<boolean>();
    const factory = createStrandDbFactory(node, { isJoinedNetwork: () => gate.promise });
    let pA!: Promise<unknown>;
    await fi.withFounding(() => {
      pA = factory('hashA');
      return Promise.resolve();
    });
    gate.resolve(false);
    await pA;
    expect(node.addStrand.mock.calls[0][0].founder).toBe(true);
    expect(attachLines()[0].intent).toBe('founding');
  });

  it('DF-8 a joining window covers every open of its own hash only', async () => {
    const node = makeFakeNode({ connections: 0 });
    const factory = createStrandDbFactory(node, { isJoinedNetwork: async () => false });
    await fi.withJoining('hashJ', async () => {
      await factory('hashJ');
      await factory('hashJ');
      await factory('hashK');
    });
    const calls = node.addStrand.mock.calls.map((c: any[]) => [c[0].strandRow.Id, c[0].founder]);
    expect(calls).toEqual([['hashJ', false], ['hashJ', false], ['hashK', true]]);
    expect(attachLines().map((l: any) => l.intent)).toEqual(['joining', 'joining', 'none']);
  });

  it('DF-9 attach payloads hold exactly the closed keys and never a hash', async () => {
    const node = makeFakeNode({ connections: 1 });
    const factory = createStrandDbFactory(node, { isJoinedNetwork: async () => false });
    await factory('hashNineA');
    await fi.withFounding(() => factory('hashNineB'));
    await fi.withJoining('hashNineC', () => factory('hashNineC'));
    const lines = attachLines();
    expect(lines.length).toBe(3);
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(['controlConnections', 'founder', 'intent']);
    const text = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    for (const h of ['hashNineA', 'hashNineB', 'hashNineC']) expect(text).not.toContain(h);
  });

  it('DF-10 controlConnections is read after the joined-list await', async () => {
    const { node, state } = makeMutableFakeNode(0);
    const gate = deferredValue<boolean>();
    const factory = createStrandDbFactory(node, { isJoinedNetwork: () => gate.promise });
    const p = factory('hashDF10');
    state.connections = 2;
    gate.resolve(false);
    await p;
    expect(attachLines()[0]).toEqual({ founder: false, controlConnections: 2, intent: 'none' });
    expect(node.addStrand.mock.calls[0][0].founder).toBe(false);
  });
});

describe('createStrandDbFactory — a strand that fails to start is not waited on forever', () => {
  // 2026-10-31: a joiner whose deferred database build failed (`Missing block` from a slow seed)
  // was left `'error'` by cadre-core with its writable waiters never rejected; the join hung.
  function withStatus(node: ReturnType<typeof makeFakeNode>) {
    let status = 'starting';
    const stopStrand = jest.fn(async (_strandId: string) => undefined);
    const extended = Object.assign(node, {
      getStrand: jest.fn((_strandId: string) => ({ status })),
      stopStrand,
    });
    return { node: extended, fail: () => { status = 'error'; }, stopStrand };
  }

  it('(e1) a pending addStrand whose strand turns error rejects with StrandLaunchFailedError and stops the strand', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockImplementationOnce(() => new Promise(() => undefined));

    const opened = createStrandDbFactory(node)('networkhash123');
    fail();

    await expect(opened).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(stopStrand).toHaveBeenCalledWith('networkhash123');
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });

  it('(e2) a gate wait whose strand turns error rejects with StrandLaunchFailedError and stops the strand', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockRejectedValueOnce(makeGateError('networkhash123'));
    node.whenStrandWritable.mockImplementation(() => new Promise(() => undefined));

    const opened = createStrandDbFactory(node)('networkhash123');
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail();

    await expect(opened).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(stopStrand).toHaveBeenCalledTimes(1);
  });

  it('(e3) the wait loop does not start another attempt on a strand already in error', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockRejectedValueOnce(makeGateError('networkhash123'));
    fail();

    await expect(createStrandDbFactory(node)('networkhash123')).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
    expect(stopStrand).toHaveBeenCalledTimes(1);
  });

  it('(e4) a strand that stays healthy opens exactly as before, and a host without getStrand is passed through', async () => {
    const { node, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    await expect(createStrandDbFactory(node)('networkhash123')).resolves.toBe(node.db);
    expect(stopStrand).not.toHaveBeenCalled();

    const pending = Promise.resolve('value');
    expect(failOnStrandError({}, 'networkhash123', pending)).toBe(pending);
  });
});
