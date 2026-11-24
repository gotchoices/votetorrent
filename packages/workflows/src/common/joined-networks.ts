/**
 * joined-networks.ts — the persisted list of network hashes this install JOINED (as opposed to founded).
 *
 * D-30: a hash on this list never opens as founder (see `resolveFounderFlag` in the strand group),
 * which is what stops a cold restart with zero control connections from forking a joined network.
 *
 * Moved here (phase 67 plan 08) from `apps/VoteTorrentAuthority/src/engines/joined-networks.ts` and
 * the joined-list half of `apps/VoteTorrentVoter/src/engines/join-bootstrap.ts`. The store is a
 * factory over the platform `KvStorage` seam with two deliberately different read modes:
 *
 * - `reject` (the Authority, D-30 fail-closed): an I/O failure, corrupt JSON or a non-array value
 *   REJECTS with the caller's unreadable error, and `rememberJoinedNetwork` never writes over a
 *   list it could not read. The error class is INJECTED (`unreadableError`), never defined here:
 *   the caller passes the strand group's `JoinedNetworksUnreadableError` factory so the shared
 *   strand factory recognises the very same class.
 * - `empty` (the Voter's lenient reader, preserved as-is because changing app behaviour is out of
 *   scope for this phase): every read error reads as [] and a corrupt record is overwritten on
 *   the next remember.
 *
 * There is no default store and no default mode. The store never logs.
 */
import type { KvStorage } from '../platform/storage.js'

/** Persisted on-device key: renaming or reformatting it orphans every install's stored list; tests pin it. */
export const AUTHORITY_JOINED_NETWORKS_KEY = '@votetorrent/authorityJoinedNetworks'
/** Persisted on-device key: renaming or reformatting it orphans every install's stored list; tests pin it. */
export const VOTER_JOINED_NETWORKS_KEY = '@votetorrent/voterJoinedNetworks'

/**
 * `reject` is the D-30 fail-closed reader (Authority); `unreadableError` must build a FRESH
 * strand-group `JoinedNetworksUnreadableError` per call. `empty` is the Voter's lenient reader.
 */
export type JoinedNetworksStoreOptions =
  | { unreadable: 'reject'; unreadableError: () => Error }
  | { unreadable: 'empty' }

export interface JoinedNetworksStore {
  /** `reject`: [] when absent, rejects when unreadable/corrupt/non-array. `empty`: [] when none or unreadable. */
  readJoinedNetworkHashes(): Promise<string[]>
  /** `(await readJoinedNetworkHashes()).includes(hash)`; in `reject` mode it rejects when unreadable. */
  isJoinedNetwork(hash: string): Promise<boolean>
  /** Idempotent. `reject`: TypeError on a bad hash, never writes over an unreadable list. */
  rememberJoinedNetwork(hash: string): Promise<void>
}

function isHash(hash: unknown): hash is string {
  return typeof hash === 'string' && hash.length > 0
}

/**
 * Build a joined-networks store over `kv` under `key` in the given mode. Every argument is required
 * and creation throws a TypeError before any store call otherwise. `kv.getItem` / `kv.setItem` are looked
 * up on every call (callers may replace them after creation). The closures carry no `this`.
 */
export function createJoinedNetworksStore(kv: KvStorage, key: string, options: JoinedNetworksStoreOptions): JoinedNetworksStore {
  if (!kv || typeof kv.getItem !== 'function' || typeof kv.setItem !== 'function') {
    throw new TypeError('createJoinedNetworksStore needs a key-value store')
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('createJoinedNetworksStore needs a storage key')
  }
  const mode = options?.unreadable
  if (mode !== 'reject' && mode !== 'empty') {
    throw new TypeError('createJoinedNetworksStore needs unreadable: reject or empty')
  }
  if (mode === 'reject') {
    if (typeof options.unreadableError !== 'function') {
      throw new TypeError('createJoinedNetworksStore needs an unreadableError factory')
    }
    const unreadable = options.unreadableError

    async function readJoinedNetworkHashes(): Promise<string[]> {
      let raw: string | null
      try {
        raw = await kv.getItem(key)
      } catch {
        throw unreadable()
      }
      if (raw === null || raw === undefined) return []
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw unreadable()
      }
      if (!Array.isArray(parsed)) throw unreadable()
      const seen = new Set<string>()
      for (const item of parsed) {
        if (isHash(item)) seen.add(item)
      }
      return [...seen]
    }

    async function isJoinedNetwork(hash: string): Promise<boolean> {
      return (await readJoinedNetworkHashes()).includes(hash)
    }

    async function rememberJoinedNetwork(hash: string): Promise<void> {
      if (!isHash(hash)) {
        throw new TypeError('rememberJoinedNetwork needs a network hash')
      }
      const hashes = await readJoinedNetworkHashes()
      if (hashes.includes(hash)) return
      await kv.setItem(key, JSON.stringify([...hashes, hash]))
    }

    return { readJoinedNetworkHashes, isJoinedNetwork, rememberJoinedNetwork }
  }

  async function readJoinedNetworkHashes(): Promise<string[]> {
    try {
      const raw = await kv.getItem(key)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string' && h.length > 0) : []
    } catch {
      return []
    }
  }

  async function isJoinedNetwork(hash: string): Promise<boolean> {
    return (await readJoinedNetworkHashes()).includes(hash)
  }

  async function rememberJoinedNetwork(hash: string): Promise<void> {
    const hashes = await readJoinedNetworkHashes()
    if (!hashes.includes(hash)) {
      await kv.setItem(key, JSON.stringify([...hashes, hash]))
    }
  }

  return { readJoinedNetworkHashes, isJoinedNetwork, rememberJoinedNetwork }
}
