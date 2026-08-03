/**
 * cadre-core-node.smoke.spec.ts — STR-02 (Node half): real @serfab/cadre-core
 * load proof + strand-DB crypto-UDF wiring discrimination (D-12/D-13/D-03/D-04).
 *
 * Runs under jest.node.config.js — a dedicated Node-environment Jest project
 * OUTSIDE the react-native preset (D-13). This is the key difference from
 * compliance-strand.spec.ts, which type-only-*mocks* `@serfab/cadre-core`
 * (`jest.mock('@serfab/cadre-core', () => ({}), { virtual: true })`) — that
 * mock is erased at runtime by TypeScript's type-only import in rn-db-factory.ts,
 * so a "green" compliance-strand run never actually proves cadre-core LOADS on
 * Node at all (D-12). This smoke closes that gap with a genuine value-level
 * import.
 *
 * Scope (RESEARCH Open Question 1 / narrow bar): a real `import` of
 * `@serfab/cadre-core` resolving + executing under plain Node, plus the
 * existing mock-StrandHost pattern (real in-memory Database, fake addStrand)
 * — NOT a full networked CadreNode.start() boot. cadre-core's own dependency
 * tree is pure-JS/WASM-free (libp2p/multiformats, no native .node addons), so
 * this narrower bar is sufficient to prove the ESM/native-load class of
 * problem the virtual mock was hiding.
 */

// ---------------------------------------------------------------------------
// Virtual mocks for native/app-layer deps — must be declared before imports.
// rn-db-factory.ts imports `rn-leveldb` and `@quereus/plugin-react-native-leveldb`
// unconditionally at the top level (solo-path deps, unrelated to the strand
// path this smoke exercises) — these still need virtual mocks under plain
// Node (Pitfall 3: the Node smoke does NOT need rn-leveldb for the strand path).
//
// @serfab/cadre-core is deliberately NOT mocked here (D-12) — see the real
// import below.
// ---------------------------------------------------------------------------
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});

jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), {
  virtual: true,
});

jest.mock('@optimystic/db-p2p-storage-rn', () => ({}), { virtual: true });

// @optimystic/db-p2p/testing (createMesh/buildNetworkTransactor) is a
// dev/test-fixture-only module pulled in transitively by
// @optimystic/quereus-plugin-optimystic's own `createMeshTestTransactor()`
// helper (used only by THAT package's own test suite, never called on the
// real-cadre-core boot path this smoke exercises). Its own transitive tree
// (libp2p, @libp2p/interface, etc.) is unrelated dev-only surface — mock it
// to keep the smoke scoped to cadre-core's actual runtime dependency graph
// (mirrors Pitfall 3: don't chase unrelated native/test-only surface).
jest.mock('@optimystic/db-p2p/testing', () => ({ createMesh: jest.fn(), buildNetworkTransactor: jest.fn() }), {
  virtual: true,
});

// ---------------------------------------------------------------------------
// Real imports (after mock declarations)
// ---------------------------------------------------------------------------
import { Database } from '@quereus/quereus';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
// Real value-level import of @serfab/cadre-core (D-12) — this is the entire
// point of this smoke: prove the module actually resolves and executes under
// plain Node, unlike compliance-strand.spec.ts's virtual mock.
import * as CadreCore from '@serfab/cadre-core';
// registerDbPlugins is internal to vote-engine (not part of its package
// `exports` map) — deep-imported via moduleNameMapper (jest.node.config.js),
// mirroring the test-context fixture mapping pattern already used for the
// RN-preset compliance-strand.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerDbPlugins } = require('@votetorrent/vote-engine/database/initialize');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');

// ---------------------------------------------------------------------------
// Mock StrandHost — reused verbatim from compliance-strand.spec.ts (D-04: this
// shape is still correct; only cadre-core stops being mocked).
// ---------------------------------------------------------------------------
function makeMockStrandHost() {
  return {
    getControlNode: () => ({
      getConnections: () => [], // 0 peers → bootstrap mode (D-12)
    }),
    addStrand: jest.fn(async (_config: {
      strandRow: { Id: string; MemberPrivateKey: null; Type: string };
      sAppConfig: { id: string; version: string; schema: string; latencyHint: string };
      mode: string;
    }) => {
      const db = new Database();
      await db.exec(VOTETORRENT_SCHEMA_SQL);
      await db.exec('declare schema App {} apply schema App;');
      return {
        strandId: _config.strandRow.Id,
        database: { getDatabase: () => db },
        connectedPeers: 0,
      };
    }),
  };
}

const PROOF_AUTH_ID = 'cadre-core-node-smoke-auth';
const PROOF_AUTH_NAME = 'Cadre-Core Node Smoke Authority';

/** Fire the same Digest-gated Authority shoe-in insert replication-proof-runner.ts uses. */
async function insertProofAuthority(db: Database): Promise<void> {
  await db.exec(
    `insert into Authority (Id, Name)
      with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
      values ('${PROOF_AUTH_ID}', '${PROOF_AUTH_NAME}');`,
  );
}

describe('cadre-core-node.smoke (STR-02 Node half — D-12/D-13/D-03/D-04)', () => {
  // -------------------------------------------------------------------------
  // Test 1 (D-12): real value-level import of @serfab/cadre-core resolves and
  // executes under plain Node — the exact class of problem the virtual mock
  // in compliance-strand.spec.ts hides. Assert a real export is defined.
  // -------------------------------------------------------------------------
  it('D-12: real @serfab/cadre-core import resolves under plain Node (CadreNode export defined)', () => {
    expect(CadreCore).toBeDefined();
    expect(typeof CadreCore.CadreNode).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Test 2 (D-03/D-04): strand-built Database + explicit registerDbPlugins
  // fires a Digest-gated CHECK successfully — proves the crypto UDF wiring
  // obligation createStrandDbFactory itself does NOT satisfy.
  // -------------------------------------------------------------------------
  it('D-03/D-04: strand Database with registerDbPlugins accepts the Digest-gated Authority insert', async () => {
    const factory = createStrandDbFactory(makeMockStrandHost());
    const db: Database = await factory('smoke-network-hash-positive');

    await registerDbPlugins(db);

    await expect(insertProofAuthority(db)).resolves.toBeUndefined();

    const row = (await db.prepare('select count(*) as n from Authority').get()) as
      | { n: number }
      | undefined;
    expect(row?.n).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 3 (negative discrimination): WITHOUT registerDbPlugins, the same
  // insert must throw a UDF-not-found error — proving Test 2's success is
  // genuinely the plugin wiring, not a no-op CHECK.
  // -------------------------------------------------------------------------
  it('negative: without registerDbPlugins, the same Digest-gated insert throws a UDF-not-found error', async () => {
    const factory = createStrandDbFactory(makeMockStrandHost());
    const db: Database = await factory('smoke-network-hash-negative');

    // Deliberately skip registerDbPlugins(db) here.

    let caught: unknown;
    try {
      await insertProofAuthority(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/function not found/i);
  });
});
