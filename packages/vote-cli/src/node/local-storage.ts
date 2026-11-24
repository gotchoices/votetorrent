// vote-core's `LocalStorage` (the NetworksEngine's `recentNetworks` home) over the peer's file kv:
// JSON in and out, `undefined` for an absent key, bigint written as a decimal string. Port of the lean
// rig's hr5-lib.ts `roleLocalStorage` onto the 67-13 FileKvStorage (strings only, write-through).

import type { LocalStorage } from '@votetorrent/vote-core'
import type { FileKvStorage } from '../vault/file-kv.js'

const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

export function createFileLocalStorage(kv: FileKvStorage): LocalStorage {
  return {
    async getItem<TValue>(key: string): Promise<TValue | undefined> {
      const raw = await kv.getItem(key)
      if (raw === null) return undefined
      try {
        return JSON.parse(raw) as TValue
      } catch {
        throw new Error('local storage: unreadable value')
      }
    },
    async setItem<TValue>(key: string, value: TValue): Promise<void> {
      await kv.setItem(key, JSON.stringify(value, bigintReplacer))
    },
    async removeItem(key: string): Promise<void> {
      await kv.removeItem(key)
    },
    async clear(): Promise<void> {
      for (const key of kv.keys()) await kv.removeItem(key)
    }
  }
}
