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
jest.mock(
  '@optimystic/db-p2p-storage-rn',
  () => ({ openOptimysticRNDb: jest.fn(), LevelDBRawStorage: class {} }),
  { virtual: true },
);
jest.mock('@quereus/quereus', () => ({ Database: class {}, registerPlugin: jest.fn() }), {
  virtual: true,
});
jest.mock('@optimystic/quereus-plugin-optimystic', () => ({ register: jest.fn() }), {
  virtual: true,
});
jest.mock('@votetorrent/vote-engine/rn', () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }), {
  virtual: true,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');

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
    expect(config.sAppConfig.schema).toBe('declare schema main {}');
  });
});
