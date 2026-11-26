// One FileRawStorage per cadre-core storage scope (the control scope and one per strand), each in its
// own 0700 dir under `node/store/scope-<safe>`, so one network's blocks never share a keyspace with
// another's (the apps' ISO-01 rule). Port of node builder lines 62-86. `destroyScope` closes first:
// FileRawStorage shares its write log per directory, so a store removed from under a live instance
// poisons the next one. `closeStores` releases every scope's store.lock after node.stop().

import { mkdirSync, rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { scopeDir, storeDir } from './peer-layout.js'

export interface RawStorageLike {
  close?(): Promise<void>
}

export interface ScopedStorage<S extends RawStorageLike> {
  /** The store for `scope`, opened on first use and cached until destroyed or closed. */
  provider(scope: string): S
  /** Close (best effort), forget and remove ONLY this scope's directory. */
  destroyScope(scope: string): Promise<void>
  /** Close every open store once (best effort) and forget them all. Idempotent. */
  closeStores(): Promise<void>
  /** The scopes with an open store, in open order. */
  scopes(): string[]
}

export function createScopedStorage<S extends RawStorageLike>(peerDir: string, FileRawStorage: new (basePath: string) => S): ScopedStorage<S> {
  const stores = new Map<string, S>()
  const root = resolve(storeDir(peerDir))
  const dirOf = (scope: string): string => {
    const dir = scopeDir(peerDir, scope)
    if (!resolve(dir).startsWith(root + sep)) throw new Error('scoped storage: scope outside the store dir')
    return dir
  }
  const closeOne = async (store: S | undefined): Promise<void> => {
    try {
      await store?.close?.()
    } catch {
      // best effort: a store that cannot flush is still forgotten
    }
  }
  return {
    provider(scope) {
      let store = stores.get(scope)
      if (store === undefined) {
        const dir = dirOf(scope)
        mkdirSync(root, { recursive: true, mode: 0o700 })
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        store = new FileRawStorage(dir)
        stores.set(scope, store)
      }
      return store
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
      for (const store of open) await closeOne(store)
    },
    scopes() {
      return [...stores.keys()]
    }
  }
}
