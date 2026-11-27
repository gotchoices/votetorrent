/**
 * Persistence guardrail + ISO-01 per-scope storage opener for cadre-core boots.
 *
 * optimystic/db-p2p's `resolveStorage(undefined)` silently defaults to an in-memory
 * store (data lost on restart). Every CadreNode boot in the app MUST supply durable
 * storage; this module makes that hard to get wrong:
 *
 *  - `createScopedRnStorageProvider().open(scopeId)` returns one durable `NodeStorage`
 *    (blocks, kv and pieces over one LevelDB) for every scope cadre-core passes —
 *    the control scope and a strand id per strand, so networks never cross-contaminate.
 *  - `assertPersistentStorage()` (baked into the opener) fails loud in a RELEASE
 *    build if a scope resolves to a non-LevelDB block store. No-op in dev/test.
 */
import { openOptimysticRNDb, levelDbNodeStorage } from '@optimystic/db-p2p-storage-rn';
import type { OpenNodeStorage } from '@optimystic/db-p2p';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

function isReleaseBuild(): boolean {
  const dev = (globalThis as { __DEV__?: boolean }).__DEV__;
  if (typeof dev === 'boolean') return !dev;
  return process.env.NODE_ENV === 'production';
}

/**
 * Guardrail: in a release build, refuse to boot on anything other than the durable
 * LevelDB block store. No-op in dev/test so mocked storage in unit tests is unaffected.
 */
export function assertPersistentStorage(storage: OpenNodeStorage, scopeId: string): void {
  if (!isReleaseBuild()) return;
  const name = (storage?.blocks as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;
  if (name !== 'LevelDBRawStorage') {
    throw new Error(
      `[storage-guard] scope '${scopeId}' resolved to '${name ?? typeof storage}', not ` +
      `LevelDBRawStorage — refusing to boot a release build on a non-persistent store ` +
      `(committed data would be silently lost on restart).`,
    );
  }
}

/**
 * ISO-01 per-scope LevelDB storage opener with the persistence guardrail baked in.
 * cadre-core 1.25 invokes `open(scopeId)` once per scope; each scope gets its own
 * LevelDB (`${namePrefix}-${scopeId}`) holding blocks, kv and pieces together.
 */
export type ScopedRnStorageProvider = {
  open(scopeId: string): Promise<OpenNodeStorage>;
  /**
   * Close (if open) and DESTROY one scope's LevelDB, so the next `open(scopeId)` starts it
   * empty. Never call it for a strand scope.
   */
  destroyScope(scopeId: string): Promise<void>;
};

export function createScopedRnStorageProvider(
  namePrefix = 'votetorrent-strand',
): ScopedRnStorageProvider {
  const opened = new Map<string, { db: ReturnType<typeof openOptimysticRNDb>; storage: OpenNodeStorage }>();
  const safe = (scopeId: string) => scopeId.replace(/[^a-zA-Z0-9-]/g, '_');
  return {
    async open(scopeId: string): Promise<OpenNodeStorage> {
      const safeId = safe(scopeId);
      let entry = opened.get(safeId);
      if (!entry) {
        const db = openOptimysticRNDb({
          openFn: (n, c, e) => new LevelDB(n, c, e),
          WriteBatch: LevelDBWriteBatch,
          name: `${namePrefix}-${safeId}`,
        });
        if (!db) {
          throw new Error(`[storage-guard] LevelDB failed to open for scope '${scopeId}' (${namePrefix}-${safeId})`);
        }
        const storage = levelDbNodeStorage(db);
        assertPersistentStorage(storage, scopeId);
        entry = { db, storage };
        opened.set(safeId, entry);
      }
      return entry.storage;
    },
    async destroyScope(scopeId: string): Promise<void> {
      const safeId = safe(scopeId);
      const entry = opened.get(safeId);
      opened.delete(safeId);
      if (entry) {
        await entry.storage.close();
        await entry.db.close();
      }
      // rn-leveldb refuses to destroy an open DB; `force` also clears a stale lock.
      LevelDB.destroyDB(`${namePrefix}-${safeId}`, true);
    },
  };
}
