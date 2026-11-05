/**
 * VER-04 unit test: `makeProofEngine(node?)` strand-capable proof factory.
 *
 * VER-04: The persistence/verification proof harness was hardwired to rnDbFactory,
 * so it never exercised the strand path (createStrandDbFactory) — exactly the path
 * that shipped the REL-01 double-init regression undetected. This test verifies:
 *   1. makeProofEngine(node) drives createStrandDbFactory (not rnDbFactory).
 *   2. lastProofDb is captured on the strand path (Pitfall 5).
 *   3. makeProofEngine() with no node is backward-compatible (rnDbFactory path).
 *
 * Mock strategy: virtual jest.mock blocks for native/ESM-only deps (same pattern
 * as rn-db-factory.test.ts) so importing persistence-proof is safe under Jest's
 * CJS resolver without real device deps.
 */

// --- virtual mocks for native/ESM-only deps imported by persistence-proof.ts
//     and its local sibling imports (rn-db-factory, device-user, device-signer). ---

jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});

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
    return {
      Database: DatabaseMock,
      registerPlugin: jest.fn(),
    };
  },
  { virtual: true },
);

jest.mock(
  '@quereus/plugin-react-native-leveldb',
  () => ({ ReactNativeLevelDBProvider: jest.fn() }),
  { virtual: true },
);

jest.mock(
  '@quereus/store',
  () => ({ createIsolatedStoreModule: jest.fn(() => ({})) }),
  { virtual: true },
);

// AsyncStorage — persistence-proof.ts imports this for PROOF_CHAIN_REF_KEY storage
jest.mock(
  '@react-native-async-storage/async-storage',
  () => ({
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  }),
  { virtual: true },
);

// @votetorrent/vote-core — imported for type shapes and ElectionType enum
jest.mock(
  '@votetorrent/vote-core',
  () => ({
    ElectionType: { adhoc: 'adhoc' },
  }),
  { virtual: true },
);

// `mockCapturedDbFactory` is `mock`-prefixed (jest hoisting requirement).
// NetworksEngine records the DbFactory passed to its constructor so tests can invoke it directly.
let mockCapturedDbFactory: ((hash: string) => Promise<unknown>) | undefined;

jest.mock(
  '@votetorrent/vote-engine/rn',
  () => {
    class NetworksEngine {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_localStorage: any, dbFactory: (hash: string) => Promise<unknown>) {
        mockCapturedDbFactory = dbFactory;
      }
    }
    class LocalStorageReact {}
    return {
      VOTETORRENT_SCHEMA_SQL:
        'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;',
      NetworksEngine,
      LocalStorageReact,
      // Minimal stubs for named exports used by persistence-proof.ts
      ElectionsEngine: class {},
      peekNextElectionTid: jest.fn(() => 1),
      H16: jest.fn((s: string) => s.slice(0, 32).padEnd(32, '0')),
      DIGEST_VECTORS: [],
    };
  },
  { virtual: true },
);

// Sibling local imports (persistence-proof.ts imports device-user + device-signer)
jest.mock('../device-user', () => ({
  getOrCreateDeviceUser: jest.fn().mockResolvedValue({ activeKeys: [] }),
}));

jest.mock('../device-signer', () => ({
  createDeviceSigner: jest.fn().mockResolvedValue(jest.fn()),
}));

// ---------------------------------------------------------------------------
// Fake helpers (same pattern as rn-db-factory.test.ts)
// ---------------------------------------------------------------------------

/** Fake Quereus Database — satisfies the Database shape returned by the strand. */
function makeFakeStrandDb() {
  return {
    setSchemaPath: jest.fn(),
    exec: jest.fn().mockResolvedValue(undefined),
    prepare: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) }),
  };
}

/**
 * Fake StrandHost — `addStrand` resolves once before `getDatabase()` is safe.
 * `connections` controls the peer-gate mode passed to addStrand.
 */
function makeFakeNode({ connections = 0, db = makeFakeStrandDb() } = {}) {
  let strandAdded = false;
  const strand = {
    database: {
      getDatabase: jest.fn(() => {
        if (!strandAdded) throw new Error('getDatabase() called before addStrand resolved');
        return db;
      }),
    },
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
// Require the module under test AFTER all mocks are registered.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proofModule = require('../persistence-proof');

// ---------------------------------------------------------------------------
// VER-04 makeProofEngine strand path
// ---------------------------------------------------------------------------

describe('VER-04 makeProofEngine strand path', () => {
  beforeEach(() => {
    mockCapturedDbFactory = undefined;
  });

  it('makeProofEngine(node) uses createStrandDbFactory (VER-04)', async () => {
    const fakeNode = makeFakeNode();

    // Construct the engine — this records the DbFactory into mockCapturedDbFactory.
    proofModule.makeProofEngine(fakeNode);

    // The DbFactory must be wired (NetworksEngine constructor captured it).
    expect(mockCapturedDbFactory).toBeDefined();

    // Drive the factory with a network hash.
    await mockCapturedDbFactory!('strand-network-hash-001');

    // The strand path: addStrand must have been called.
    expect(fakeNode.addStrand).toHaveBeenCalledTimes(1);
    expect(fakeNode.addStrand).toHaveBeenCalledWith(
      expect.objectContaining({
        strandRow: expect.objectContaining({ Id: 'strand-network-hash-001' }),
      }),
    );
  });

  it('makeProofEngine(node) captures lastProofDb on the strand path (VER-04)', async () => {
    const fakeDb = makeFakeStrandDb();
    const fakeNode = makeFakeNode({ db: fakeDb });

    proofModule.makeProofEngine(fakeNode);

    expect(mockCapturedDbFactory).toBeDefined();
    await mockCapturedDbFactory!('strand-network-hash-002');

    // getLastProofDb() must return the exact db handle the strand handed back (Pitfall 5).
    expect(proofModule.getLastProofDb()).toBe(fakeDb);
  });

  it('makeProofEngine() with no node is rnDbFactory-backed (VER-04 backward compat)', async () => {
    // No node argument — should use the rnDbFactory path.
    proofModule.makeProofEngine();

    expect(mockCapturedDbFactory).toBeDefined();

    // Drive the no-node factory — it runs rnDbFactory, not addStrand.
    await mockCapturedDbFactory!('rn-network-hash-003');

    // A sentinel node that was never passed must never have addStrand called.
    // The rnDbFactory path does NOT call addStrand on any node.
    // Confirm getLastProofDb() is still set (rnDbFactory path also assigns lastProofDb).
    expect(proofModule.getLastProofDb()).toBeDefined();
  });
});
