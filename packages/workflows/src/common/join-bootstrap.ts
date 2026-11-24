/**
 * join-bootstrap.ts — the dial targets a network join leaves behind for the next launch.
 *
 * A joined install may ship with no relay config (`bootstrap.config.json` ships EMPTY for the Voter,
 * and a keyholder Authority install, D-18, or a D-09 re-invite may have none either). A join code's cadre
 * invitation names the member machines; once the invitation is redeemed those addresses are this
 * install's bootstrap, so they are kept under a persisted key and merged into
 * `controlNetwork.bootstrapNodes` at the next boot. They are dial hints only: every address is
 * re-bound to its peer id before a dial, and trust comes from the pinned owner keys, never from this
 * list.
 *
 * Moved here (phase 67 plan 08) from `apps/VoteTorrentAuthority/src/engines/join-bootstrap.ts` and
 * `apps/VoteTorrentVoter/src/engines/join-bootstrap.ts`. The store is a factory over the platform
 * `KvStorage` seam: the app passes its key-value store, the CLI passes its file-backed kv. There is
 * no default store and no default sanitizer. Each app keeps its own sanitizer (the Authority keeps
 * relay-circuit addresses only; the Voter keeps any peer-bound address) and its own key.
 *
 * Every address is bounded with the limits `./bootstrap-config.ts` puts on the shipped document.
 * The store never logs.
 */
import type { KvStorage } from '../platform/storage.js'
import { BOOTSTRAP_ADDR_MAX_LENGTH, BOOTSTRAP_CONFIG_MAX_ADDRS, isBootstrapAddr } from './bootstrap-config.js'

/** Persisted on-device key: renaming or reformatting it orphans every install's stored list; tests pin it. */
export const AUTHORITY_JOIN_BOOTSTRAP_KEY = '@votetorrent/authorityJoinBootstrap'
/** Persisted on-device key: renaming or reformatting it orphans every install's stored list; tests pin it. */
export const VOTER_JOIN_BOOTSTRAP_KEY = '@votetorrent/voterJoinBootstrap'

export type JoinBootstrapSanitizer = (addrs: unknown) => string[]

/**
 * The Authority join-bootstrap store holds relay-circuit addresses only (the outline's threat model).
 * Phones and Authority installs advertise relay-circuit addresses only, so an invitation's members are
 * circuit addresses (RESEARCH-DEVICE-PROOF l.182): relay peer id, the circuit marker, then the
 * target's peer id at the end. Every address is peer-id-pinned (`isBootstrapAddr`, T-56-10-01).
 */
function isRelayCircuitAddr(value: unknown): value is string {
  return isBootstrapAddr(value) && !/\s/.test(value) && /\/p2p\/[^/]+\/p2p-circuit\/p2p\/[^/]+$/.test(value)
}

/** Authority: keep only plausible relay-circuit multiaddr strings, deduplicated, within the config limits. */
export function sanitizeAuthorityJoinBootstrap(addrs: unknown): string[] {
  if (!Array.isArray(addrs)) {
    return []
  }
  const out: string[] = []
  for (const addr of addrs) {
    if (typeof addr !== 'string') continue
    const trimmed = addr.trim()
    if (!isRelayCircuitAddr(trimmed)) continue
    if (!out.includes(trimmed)) out.push(trimmed)
    if (out.length >= BOOTSTRAP_CONFIG_MAX_ADDRS) break
  }
  return out
}

/** Voter: keep only plausible peer-bound multiaddr strings, deduplicated, within the config limits. */
export function sanitizeVoterJoinBootstrap(addrs: unknown): string[] {
  if (!Array.isArray(addrs)) {
    return []
  }
  const out: string[] = []
  for (const addr of addrs) {
    if (typeof addr !== 'string') continue
    const trimmed = addr.trim()
    if (!trimmed.startsWith('/') || trimmed.length > BOOTSTRAP_ADDR_MAX_LENGTH || !trimmed.includes('/p2p/')) continue
    if (!out.includes(trimmed)) out.push(trimmed)
    if (out.length >= BOOTSTRAP_CONFIG_MAX_ADDRS) break
  }
  return out
}

export interface JoinBootstrapStore {
  /** The addresses a previous join stored; [] when there are none or the record is unreadable. Never rejects, never logs. */
  readJoinBootstrap(): Promise<string[]>
  /** Replace the stored addresses with the ones a join just used. A storage rejection propagates. */
  rememberJoinBootstrap(addrs: readonly string[]): Promise<void>
}

/**
 * Build a join-bootstrap store over `kv` under `key`, sanitizing with `sanitize` on read AND on write.
 * All three arguments are required; creation throws a TypeError before any store call otherwise.
 * `kv.getItem` / `kv.setItem` are looked up on every call (callers may replace them after creation).
 * The two returned closures carry no `this` and may be called detached.
 */
export function createJoinBootstrapStore(kv: KvStorage, key: string, sanitize: JoinBootstrapSanitizer): JoinBootstrapStore {
  if (!kv || typeof kv.getItem !== 'function' || typeof kv.setItem !== 'function') {
    throw new TypeError('createJoinBootstrapStore needs a key-value store')
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('createJoinBootstrapStore needs a storage key')
  }
  if (typeof sanitize !== 'function') {
    throw new TypeError('createJoinBootstrapStore needs a sanitizer')
  }

  async function readJoinBootstrap(): Promise<string[]> {
    try {
      const raw = await kv.getItem(key)
      return raw ? sanitize(JSON.parse(raw)) : []
    } catch {
      return []
    }
  }

  async function rememberJoinBootstrap(addrs: readonly string[]): Promise<void> {
    await kv.setItem(key, JSON.stringify(sanitize([...addrs])))
  }

  return { readJoinBootstrap, rememberJoinBootstrap }
}
