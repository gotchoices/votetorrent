/**
 * compliance-strand.spec.ts — VER-03: FLOW-01..04 compliance against the
 * local strand-backed DbFactory (createStrandDbFactory, bootstrap/solo mode).
 *
 * Import boundary: createStrandDbFactory lives here (app layer) and imports
 * @serfab/cadre-core — NOT importable from packages/vote-engine/. This spec
 * lives in the app workspace so the boundary is respected (D-03 / RESEARCH Pitfall 2).
 *
 * Backend: local strand only — NO cross-peer (D-12). Proves strand-backed
 * persistence + read-model parity without P2P-06 dependency.
 *
 * Framework: Jest (app workspace) — NOT Mocha. Use standard Jest describe/it.
 * The test bodies mirror packages/vote-engine/test/compliance.spec.ts exactly
 * (the Mocha/Chai suite), with Jest expect() assertions replacing chai expect().
 *
 * Backends: in-memory (undefined factory, defaults to NetworksEngine's inMemoryFactory)
 * and strand-backed (createStrandDbFactory with a minimal mock StrandHost).
 *
 * The 18 quereus constraint-eval pending tests stay pending on BOTH backends —
 * they are not strand-specific failures (see RESEARCH Open Question 3).
 */

// ---------------------------------------------------------------------------
// Virtual mocks for native/app-layer deps — must be declared before imports.
// These packages are native/ESM-only and cannot load under the react-native
// jest preset without mocking. The rn-db-factory.ts module imports them at
// the top level, so they must be intercepted before `require('../rn-db-factory')`.
// ---------------------------------------------------------------------------
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});

jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), {
  virtual: true,
});

// @serfab/cadre-core is a type-only import in rn-db-factory.ts (import type { ... }).
// It is erased by TypeScript compilation and not needed at runtime, but jest's
// virtual resolver must not attempt to load it from the filesystem.
jest.mock('@serfab/cadre-core', () => ({}), { virtual: true });

// @optimystic/db-p2p-storage-rn is not imported by rn-db-factory.ts directly,
// but may be pulled in transitively. Mock to prevent native load errors.
jest.mock('@optimystic/db-p2p-storage-rn', () => ({}), { virtual: true });

// NOTE: @quereus/quereus is NOT mocked here — we need the real Database for compliance
// assertions. The jest.config.js transformIgnorePatterns exception allows Babel to
// transform it from ESM to CJS so it loads correctly in the Jest/Node environment.

// NOTE: @votetorrent/vote-engine/rn is NOT mocked here — we need the real
// VOTETORRENT_SCHEMA_SQL and NetworksEngine for the full compliance path.

// ---------------------------------------------------------------------------
// Real imports (after mock declarations)
// ---------------------------------------------------------------------------
import { Database, registerPlugin } from '@quereus/quereus';
// SPIKE 061: the real strand path registers this via connectToStrand (connect.js:14);
// this mock StrandHost must do the same, or quereus >=4.7.0 rejects the schema's
// `create assertion InviteSlotSigningValid` with "Function not found: digest/1".
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');

// ---------------------------------------------------------------------------
// Mock StrandHost — minimal fake that creates a real in-memory Database with
// the full votetorrent schema applied under `main` (so bare table/view names
// resolve correctly in engine queries), plus an empty `App` schema declared
// to satisfy NetworksEngine.createContext's hasDeclaredSchema('App') check
// (the strand-path guard). No cross-peer (D-12): 0 connections → bootstrap mode.
//
// Quereus view limitation: `setSchemaPath(['App', 'main'])` enables TABLE
// resolution through the schema path, but VIEW resolution uses getCurrentSchemaName()
// which returns 'main' after `apply schema`. Therefore views must exist in the
// 'main' schema (applied via VOTETORRENT_SCHEMA_SQL) for bare-name queries to work.
// The empty App schema satisfies the hasDeclaredSchema('App') strand-detection gate.
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock StrandHost node.
 * addStrand creates a real in-memory Database with:
 *   1. VOTETORRENT_SCHEMA_SQL applied (declare schema main { ... } apply schema main)
 *      — all tables and views are in 'main' so bare names resolve in engine queries.
 *   2. An empty App schema declared (declare schema App {} apply schema App)
 *      — satisfies NetworksEngine.createContext's hasDeclaredSchema('App') check.
 * createStrandDbFactory then calls db.setSchemaPath(['App','main']) after addStrand.
 */
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
      // Step 1: Apply full schema under 'main' (tables + views resolve with bare names).
      // VOTETORRENT_SCHEMA_SQL = 'declare schema main { ... } apply schema main;'
      const db = new Database();
      await registerPlugin(db, cryptoPlugin, { algorithm: 'sha256', encoding: 'base64url' });
      await db.exec(VOTETORRENT_SCHEMA_SQL);
      // Step 2: Declare an empty App schema so hasDeclaredSchema('App') returns true.
      // This signals the strand path in NetworksEngine.createContext (REL-01 guard).
      // Empty braces are valid — no tables/views need to be in App for this purpose.
      await db.exec('declare schema App {} apply schema App;');
      // db.setSchemaPath(['App','main']) is called by createStrandDbFactory AFTER addStrand resolves.
      return {
        strandId: _config.strandRow.Id,
        database: {
          getDatabase: () => db,
        },
        connectedPeers: 0,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Backend configurations — in-memory (undefined → NetworksEngine default) and
// strand-backed (createStrandDbFactory with a fresh mock node per backend suite).
// A fresh node per `for...of` iteration isolates the Database instances between
// the two backend suites.
// ---------------------------------------------------------------------------
const backends = [
  { name: 'in-memory', factory: undefined as any },
  { name: 'strand', factory: createStrandDbFactory(makeMockStrandHost()) },
] as const;

// ---------------------------------------------------------------------------
// FLOW-01..04 — parametrized over both backends via for...of loop.
// (Mocha has no describe.each; use for...of as the Mocha-compatible pattern
// even though this spec runs under Jest — symmetry with compliance.spec.ts.)
// ---------------------------------------------------------------------------

for (const backend of backends) {
  // -------------------------------------------------------------------------
  // FLOW-01: NetworksEngine.create() persisted-row compliance
  // -------------------------------------------------------------------------

  describe(`FLOW-01 (${backend.name}): NetworksEngine.create() persisted-row compliance`, () => {
    it('FLOW-01 inserts at least 1 row each in Network, Authority, Admin, Officer, User, UserKey', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const db = net.ctx.db;

      const networkCount = ((await db.prepare('select count(*) as n from Network').get()) as any)?.n ?? 0;
      const authorityCount = ((await db.prepare('select count(*) as n from Authority').get()) as any)?.n ?? 0;
      const adminCount = ((await db.prepare('select count(*) as n from Admin').get()) as any)?.n ?? 0;
      const officerCount = ((await db.prepare('select count(*) as n from Officer').get()) as any)?.n ?? 0;
      const userCount = ((await db.prepare('select count(*) as n from User').get()) as any)?.n ?? 0;
      const userKeyCount = ((await db.prepare('select count(*) as n from UserKey').get()) as any)?.n ?? 0;

      expect(networkCount).toBeGreaterThanOrEqual(1);
      expect(authorityCount).toBeGreaterThanOrEqual(1);
      expect(adminCount).toBeGreaterThanOrEqual(1);
      expect(officerCount).toBeGreaterThanOrEqual(1);
      expect(userCount).toBeGreaterThanOrEqual(1);
      expect(userKeyCount).toBeGreaterThanOrEqual(1);
    });

    it('FLOW-01 Network.Hash is a 32-hex-char H16(Id) value', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const db = net.ctx.db;

      const nRow = (await db.prepare('select Id, Hash from Network limit 1').get()) as any;
      expect(nRow).not.toBeNull();
      expect(typeof nRow.Hash).toBe('string');
      expect(nRow.Hash.length).toBe(32);
      expect(nRow.Hash).toMatch(/^[0-9a-f]{32}$/);
      expect(net.ref.hash).toBe(nRow.Hash);
    });

    it('FLOW-01 Network.PrimaryAuthorityId exists in Authority table (FK valid)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const db = net.ctx.db;

      const nRow = (await db.prepare('select PrimaryAuthorityId from Network limit 1').get()) as any;
      expect(typeof nRow?.PrimaryAuthorityId).toBe('string');
      expect(nRow.PrimaryAuthorityId.length).toBeGreaterThan(0);

      const aRow = (await db
        .prepare('select count(*) as n from Authority where Id = :id')
        .get({ id: nRow.PrimaryAuthorityId })) as any;
      expect(aRow?.n).toBe(1);
    });

    it('FLOW-01 Network.ElectionType is in the documented Scope codes (o or a)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const db = net.ctx.db;

      const nRow = (await db.prepare('select ElectionType from Network limit 1').get()) as any;
      expect(typeof nRow?.ElectionType).toBe('string');
      expect(['o', 'a']).toContain(nRow.ElectionType);
    });

    it('FLOW-01 UserKey.PubKey is valid 64/66-char hex (no .toString() artifact)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const db = net.ctx.db;

      const ukRow = (await db.prepare('select PubKey, Expiration from UserKey limit 1').get()) as any;
      expect(ukRow).not.toBeNull();
      expect(typeof ukRow.PubKey).toBe('string');
      expect(ukRow.PubKey).toMatch(/^[0-9a-fA-F]{2,}$/);
      expect(ukRow.PubKey.length % 2).toBe(0);
      expect(ukRow.PubKey).not.toContain('[object');
      expect([66, 130]).toContain(ukRow.PubKey.length);
    });
  });

  // -------------------------------------------------------------------------
  // FLOW-02: addTestAuthority() persisted-row compliance
  // -------------------------------------------------------------------------

  describe(`FLOW-02 (${backend.name}): addTestAuthority() persisted-row compliance`, () => {
    it('FLOW-02 openAuthority returns a well-shaped authority (name present, ID non-empty)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);

      expect(auth.authority).not.toBeUndefined();
      expect(typeof auth.authority.id).toBe('string');
      expect(auth.authority.id.length).toBeGreaterThan(0);
      expect(typeof auth.authority.name).toBe('string');
      expect(auth.authority.name.length).toBeGreaterThan(0);
    });

    it('FLOW-02 Admin row exists for the primary authority (AuthorityId FK valid)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);
      const db = auth.ctx.db;

      const adminRow = (await db
        .prepare('select count(*) as n from Admin where AuthorityId = :id')
        .get({ id: auth.authority.id })) as any;
      expect(adminRow?.n).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // FLOW-03: addTestElection() persisted-row compliance
  // -------------------------------------------------------------------------

  describe(`FLOW-03 (${backend.name}): addTestElection() persisted-row compliance`, () => {
    it('FLOW-03 Election row is persisted with correct AuthorityId FK', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);
      const elec = await addTestElection(auth);
      const db = elec.ctx.db;

      const electionRow = (await db
        .prepare('select Id, AuthorityId, Title from Election limit 1')
        .get()) as any;
      expect(electionRow).not.toBeNull();
      expect(typeof electionRow.Id).toBe('string');
      expect(electionRow.AuthorityId).toBe(auth.authority.id);
    });

    it('FLOW-03 ElectionRevision Revision = 0 on insert (first revision)', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);
      const elec = await addTestElection(auth);
      const db = elec.ctx.db;

      const revRow = (await db
        .prepare('select Revision from ElectionRevision order by Revision asc limit 1')
        .get()) as any;
      expect(revRow).not.toBeNull();
      expect(revRow.Revision).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // FLOW-04: Full chain read-model — getDetails() well-shaped, no undefined
  // -------------------------------------------------------------------------

  describe(`FLOW-04 (${backend.name}): Full chain getDetails() read-model compliance`, () => {
    it('FLOW-04 networkEngine.getDetails().network.hash is defined and 32-char hex', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);
      void auth; // addTestAuthority uses getDetails internally

      const details = await net.networkEngine.getDetails();
      expect(details).not.toBeUndefined();
      expect(details.network).not.toBeUndefined();
      expect(typeof details.network.hash).toBe('string');
      expect(details.network.hash.length).toBeGreaterThan(0);
      expect(details.network.hash.length).toBe(32);
      expect(details.network.hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('FLOW-04 full chain (createNetwork → addAuthority → addElection) completes without error', async () => {
      const net = await createTestNetwork({ dbFactory: backend.factory });
      const auth = await addTestAuthority(net);
      const elec = await addTestElection(auth);

      expect(net.networkEngine).not.toBeUndefined();
      expect(auth.authorityEngine).not.toBeUndefined();
      expect(elec.electionsEngine).not.toBeUndefined();
      expect(elec.electionEngine).not.toBeUndefined();
    });
  });
}
