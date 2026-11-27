// One FileNodeStorage per cadre-core storage scope (the control scope and one per strand), in its
// own 0700 dir under `node/store/scope-<safe>`, so one network's blocks never share a location with
// another's (the apps' ISO-01 rule). cadre-core 1.25 opens a scope through `open(scope)` and receives
// blocks, kv and pieces together; it closes nothing it is handed, so this module keeps the handles
// and closes them on destroy/stop.

import { mkdirSync, rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { OpenNodeStorage } from '@optimystic/db-p2p'
import { fileNodeStorage } from '@optimystic/db-p2p-storage-fs'
import { scopeDir, storeDir } from './peer-layout.js'

export interface ScopedStorage {
  /** The storage for `scope`, opened on first use and cached until destroyed or closed. */
  open(scope: string): Promise<OpenNodeStorage>
  /** Close (best effort), forget and remove ONLY this scope's directory. */
  destroyScope(scope: string): Promise<void>
  /** Close every open storage once (best effort) and forget them all. Idempotent. */
  closeStores(): Promise<void>
  /** The scopes with an open storage, in open order. */
  scopes(): string[]
}

export function createScopedStorage(
  peerDir: string,
  openStorage: (dir: string) => Promise<OpenNodeStorage> = async (dir) => fileNodeStorage(dir),
): ScopedStorage {
  const stores = new Map<string, Promise<OpenNodeStorage>>()
  const root = resolve(storeDir(peerDir))
  const dirOf = (scope: string): string => {
    const dir = scopeDir(peerDir, scope)
    if (!resolve(dir).startsWith(root + sep)) throw new Error('scoped storage: scope outside the store dir')
    return dir
  }
  const closeOne = async (pending: Promise<OpenNodeStorage> | undefined): Promise<void> => {
    try {
      await (await pending)?.close()
    } catch {
      // best effort: a store that cannot flush is still forgotten
    }
  }
  return {
    open(scope) {
      let pending = stores.get(scope)
      if (pending === undefined) {
        const dir = dirOf(scope)
        mkdirSync(root, { recursive: true, mode: 0o700 })
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        pending = Promise.resolve().then(() => openStorage(dir))
        stores.set(scope, pending)
      }
      return pending
    },
    async destroyScope(scope) {
      const dir = dirOf(scope)
      await closeOne(stores.get(scope))
      stores.delete(scope)
      rmSync(dir, { recursive: true, force: true })
    },
    async closeStores() {
      const open = [...stores.values()]
      stores.clear()
      for (const pending of open) await closeOne(pending)
    },
    scopes() {
      return [...stores.keys()]
    }
  }
}
