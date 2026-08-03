/**
 * Persistence guardrail + ISO-01 per-scope storage provider for cadre-core boots.
 *
 * optimystic/db-p2p's `resolveStorage(undefined)` silently defaults to an in-memory
 * `MemoryRawStorage` (data lost on restart). Every CadreNode boot in the app MUST
 * supply a durable provider; this module makes that hard to get wrong:
 *
 *  - `createScopedRnStorageProvider()` returns the correct ISO-01 per-scope provider
 *    (one distinct LevelDB per `scopeId` cadre-core passes — 'control' for the control
 *    DB, a strandId per strand — so networks never cross-contaminate).
 *  - `assertPersistentStorage()` (baked into the provider) fails loud in a RELEASE
 *    build if a resolved store is not the durable `LevelDBRawStorage`, so a mis-wire
 *    can never silently ship on the ephemeral fallback. No-op in dev/test.
 */
import { openOptimysticRNDb, LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

function isReleaseBuild(): boolean {
  const dev = (globalThis as { __DEV__?: boolean }).__DEV__;
  if (typeof dev === 'boolean') return !dev;
  return process.env.NODE_ENV === 'production';
}

/**
 * Guardrail: in a release build, refuse to boot on anything other than the durable
 * `LevelDBRawStorage`. Catches a future regression where a scope resolves to
 * optimystic's ephemeral `MemoryRawStorage` (silent data loss). No-op in dev/test so
 * mocked storage in unit tests is unaffected.
 */
export function assertPersistentStorage(storage: unknown, scopeId: string): void {
  if (!isReleaseBuild()) return;
  const name = (storage as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;
  if (name !== 'LevelDBRawStorage') {
    throw new Error(
      `[storage-guard] scope '${scopeId}' resolved to '${name ?? typeof storage}', not ` +
      `LevelDBRawStorage — refusing to boot a release build on a non-persistent store ` +
      `(committed data would be silently lost on restart).`,
    );
  }
}

/**
 * ISO-01 per-scope LevelDB storage provider with the persistence guardrail baked in.
 * cadre-core invokes `provider(scopeId)` with 'control' for the control DB and a
 * strandId per strand; each scope gets its own LevelDB (`${namePrefix}-${scopeId}`).
 *
 * @param namePrefix distinct store-name namespace. Defaults to the production
 *   `votetorrent-strand`; dev/proof harnesses pass their own so they never touch
 *   production LevelDBs.
 */
export function createScopedRnStorageProvider(
  namePrefix = 'votetorrent-strand',
): (scopeId: string) => LevelDBRawStorage {
  const dbs = new Map<string, ReturnType<typeof openOptimysticRNDb>>();
  return (scopeId: string): LevelDBRawStorage => {
    const safeId = scopeId.replace(/[^a-zA-Z0-9-]/g, '_');
    let db = dbs.get(safeId);
    if (!db) {
      db = openOptimysticRNDb({
        openFn: (n, c, e) => new LevelDB(n, c, e),
        WriteBatch: LevelDBWriteBatch,
        name: `${namePrefix}-${safeId}`,
      });
      if (!db) {
        throw new Error(`[storage-guard] LevelDB failed to open for scope '${scopeId}' (${namePrefix}-${safeId})`);
      }
      dbs.set(safeId, db);
    }
    const raw = new LevelDBRawStorage(db);
    assertPersistentStorage(raw, scopeId);
    return raw;
  };
}
