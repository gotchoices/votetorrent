// The CLI side of browser pairing that the Authority app keeps in AsyncStorage modules (67-17 left them
// app-side by design): the owner's pair-mint log and revocation store, the officer's pair-mint client
// port, and the paired-browsers recorder. All three persist through the peer's own kv
// (`node/async-storage.json`, a 0600 file under the peer dir, 67-13 `file-kv`) under the app's keys,
// with the app's rules: approved mint entries are kept for good (a later remove is authorized only
// through them), only non-approved entries are capped, a corrupt document fails closed and is never
// overwritten, and no entry ever holds an invitation, a code or a private key. The reference is
// apps/VoteTorrentAuthority/src/engines/{pairing-owner-store,pair-mint-client,paired-browsers-store}.ts.
// Nothing here logs.

import { multiaddr } from '@multiformats/multiaddr'
import type { PairMintLogEntry, PairMintMintRequest, PairMintReply, PairMintRequest, PairMintLibp2pLike } from '@votetorrent/vote-engine/rn'
import { PAIR_MINT_REFUSAL_CODES, requestPairMint } from '@votetorrent/vote-engine/rn'
import {
  REVOCATION_GRACE_MS,
  REVOCATION_RESULTS,
  inviteExpiryMs,
  type OwnerMintLogEntry,
  type PairMintClientPort,
  type PairMintRevocationStore,
  type PairingClientNode,
  type PairingDialTarget,
  type PairingRecord,
  type RevocationResult
} from '@votetorrent/workflows/authority'
import type { KvStorage } from '@votetorrent/workflows'

/** The app's AsyncStorage keys, reused so the stored documents have one shape across the apps and the CLI. */
export const PAIRING_MINT_LOG_KEY = '@votetorrent/pairingMintLog'
export const PAIRED_BROWSERS_KEY = '@votetorrent/pairedBrowsers'

/** Cap on NON-approved mint-log entries (refusals, unreachable). Approved entries are never pruned. */
export const MINT_LOG_MAX_OTHER = 500
export const PAIRED_BROWSERS_MAX_ENTRIES = 200

/** Outcomes the service records BEFORE its replay check; they never mark a nonce used (the app's `PRE_REPLAY_REFUSALS`). */
export const PRE_REPLAY_REFUSALS: readonly string[] = Object.freeze(['refused:switched-off', 'refused:expired', 'refused:requester-mismatch'])

export const PAIR_MINT_TARGET_TIMEOUT_MS = 20_000
export const PAIR_MINT_TOTAL_BUDGET_MS = 60_000
export const PAIR_MINT_MAX_TARGETS = 8
export const PAIR_MINT_ADDRS_PER_OWNER = 3

export class PairingStoreError extends Error {
  readonly code: 'unreadable' | 'entry-invalid' | 'mark-invalid'

  constructor(code: 'unreadable' | 'entry-invalid' | 'mark-invalid') {
    super(`pairing store refused (${code})`)
    this.name = 'PairingStoreError'
    this.code = code
  }
}

type MintLogPort = {
  hasNonce(nonce: string): Promise<boolean>
  record(entry: PairMintLogEntry): Promise<void>
  findByNonce(nonce: string): Promise<PairMintLogEntry | null>
  liveMintsFor(userId: string, nowMs: number): Promise<ReadonlyArray<PairMintLogEntry>>
}

// ---------------------------------------------------------------------------------------------
// Shape checks (the app's)

const ENTRY_KEYS: readonly string[] = ['nonce', 'userId', 'inviteKey', 'at', 'expiresAt', 'outcome']

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function isOutcome(v: unknown): v is PairMintLogEntry['outcome'] {
  if (v === 'approved' || v === 'unreachable') return true
  if (typeof v !== 'string' || !v.startsWith('refused:')) return false
  return (PAIR_MINT_REFUSAL_CODES as readonly string[]).includes(v.slice('refused:'.length))
}

const isRevocationResult = (v: unknown): v is RevocationResult => typeof v === 'string' && (REVOCATION_RESULTS as readonly string[]).includes(v)

function entryFieldsValid(entry: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(entry.nonce) &&
    isNonEmptyString(entry.userId) &&
    (entry.inviteKey === null || typeof entry.inviteKey === 'string') &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at) &&
    (entry.expiresAt === null || typeof entry.expiresAt === 'string') &&
    isOutcome(entry.outcome)
  )
}

function storedEntryValid(v: unknown): v is OwnerMintLogEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const e = v as Record<string, unknown>
  for (const key of Object.keys(e)) if (key !== 'revocation' && !ENTRY_KEYS.includes(key)) return false
  if (!entryFieldsValid(e)) return false
  if (!('revocation' in e)) return true
  const r = e.revocation as Record<string, unknown> | null
  if (e.outcome !== 'approved' || typeof r !== 'object' || r === null || Array.isArray(r)) return false
  if (Object.keys(r).length !== 2) return false
  return isRevocationResult(r.result) && typeof r.at === 'number' && Number.isFinite(r.at)
}

function copyEntry(e: OwnerMintLogEntry): OwnerMintLogEntry {
  const out: OwnerMintLogEntry = { nonce: e.nonce, userId: e.userId, inviteKey: e.inviteKey, at: e.at, expiresAt: e.expiresAt, outcome: e.outcome }
  if (e.revocation) out.revocation = { result: e.revocation.result, at: e.revocation.at }
  return out
}

function newestFirst(entries: OwnerMintLogEntry[]): OwnerMintLogEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at - a.e.at || b.i - a.i)
    .map(({ e }) => e)
}

function prune(entries: OwnerMintLogEntry[]): OwnerMintLogEntry[] {
  const others = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.outcome !== 'approved')
    .sort((a, b) => b.e.at - a.e.at || b.i - a.i)
  if (others.length <= MINT_LOG_MAX_OTHER) return entries
  const drop = new Set(others.slice(MINT_LOG_MAX_OTHER).map(({ i }) => i))
  return entries.filter((_, i) => !drop.has(i))
}

// ---------------------------------------------------------------------------------------------
// The owner's mint log + revocation store over kv

export interface KvPairMintLog {
  mintLog: MintLogPort
  revocationStore: PairMintRevocationStore
  /** The newest `limit` entries (copies), newest first. */
  readMintLog(limit?: number): Promise<OwnerMintLogEntry[]>
}

/**
 * The owner's pair-mint log and revocation marks over `kv[key]` (`{ v: 1, entries: [...] }`), the app's
 * pairing-owner-store rules: writers run on one chain and re-read before writing; a corrupt document
 * rejects `PairingStoreError('unreadable')` on every read and is never overwritten.
 */
export function createKvPairMintLog(kv: KvStorage, key: string = PAIRING_MINT_LOG_KEY): KvPairMintLog {
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  const readEntries = async (): Promise<OwnerMintLogEntry[]> => {
    let raw: string | null
    try {
      raw = await kv.getItem(key)
    } catch {
      throw new PairingStoreError('unreadable')
    }
    if (raw === null) return []
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch {
      throw new PairingStoreError('unreadable')
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new PairingStoreError('unreadable')
    const d = doc as { v?: unknown, entries?: unknown }
    if (d.v !== 1 || !Array.isArray(d.entries) || !d.entries.every(storedEntryValid)) throw new PairingStoreError('unreadable')
    return d.entries as OwnerMintLogEntry[]
  }
  const writeEntries = (entries: OwnerMintLogEntry[]): Promise<void> => kv.setItem(key, JSON.stringify({ v: 1, entries }))

  const mintLog: MintLogPort = {
    hasNonce: (nonce) => serialized(async () => (await readEntries()).some((e) => e.nonce === nonce && !PRE_REPLAY_REFUSALS.includes(e.outcome))),
    record: (entry) => {
      if (typeof entry !== 'object' || entry === null || !entryFieldsValid(entry as unknown as Record<string, unknown>)) {
        return Promise.reject(new PairingStoreError('entry-invalid'))
      }
      const clean: OwnerMintLogEntry = { nonce: entry.nonce, userId: entry.userId, inviteKey: entry.inviteKey, at: entry.at, expiresAt: entry.expiresAt, outcome: entry.outcome }
      return serialized(async () => {
        const entries = await readEntries()
        entries.push(clean)
        await writeEntries(prune(entries))
      })
    },
    findByNonce: (nonce) =>
      serialized(async () => {
        const mine = newestFirst((await readEntries()).filter((e) => e.nonce === nonce))
        const hit = mine.find((e) => e.outcome === 'approved') ?? mine[0] ?? null
        return hit ? copyEntry(hit) : null
      }),
    liveMintsFor: (userId, nowMs) =>
      serialized(async () =>
        (await readEntries())
          .filter((e) => {
            if (e.outcome !== 'approved' || e.userId !== userId || e.revocation !== undefined) return false
            const exp = inviteExpiryMs(e.expiresAt)
            return exp !== null && exp > nowMs
          })
          .map(copyEntry)
      )
  }
  const revocationStore: PairMintRevocationStore = {
    markMintRevocation: (nonce, mark) => {
      if (typeof mark !== 'object' || mark === null || !isRevocationResult(mark.result) || typeof mark.at !== 'number' || !Number.isFinite(mark.at)) {
        return Promise.reject(new PairingStoreError('mark-invalid'))
      }
      const next = { result: mark.result, at: mark.at }
      return serialized(async () => {
        const entries = await readEntries()
        const target = newestFirst(entries.filter((e) => e.nonce === nonce && e.outcome === 'approved'))[0]
        if (!target) return false
        if (target.revocation && (target.revocation.result !== 'withdrawn' || next.result === 'withdrawn')) return false
        target.revocation = next
        await writeEntries(entries)
        return true
      })
    },
    listRevocationCandidates: (nowMs) =>
      serialized(async () =>
        (await readEntries())
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => {
            if (e.outcome !== 'approved' || !isNonEmptyString(e.inviteKey)) return false
            if (e.revocation === undefined) return true
            if (e.revocation.result !== 'withdrawn') return false
            const exp = inviteExpiryMs(e.expiresAt)
            return exp !== null && exp + REVOCATION_GRACE_MS > nowMs
          })
          .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
          .map(({ e }) => copyEntry(e))
      )
  }
  return {
    mintLog,
    revocationStore,
    readMintLog: (limit = 20) => serialized(async () => newestFirst(await readEntries()).slice(0, Math.max(0, Math.floor(limit))).map(copyEntry))
  }
}

// ---------------------------------------------------------------------------------------------
// The paired-browsers recorder over kv

const RECORD_KEYS: readonly string[] = ['nonce', 'userId', 'networkHash', 'inviteKey', 'mintedAt', 'expiresAt', 'label']

function recordValid(v: unknown): v is PairingRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return (
    isNonEmptyString(r.nonce) &&
    isNonEmptyString(r.userId) &&
    isNonEmptyString(r.networkHash) &&
    isNonEmptyString(r.inviteKey) &&
    typeof r.mintedAt === 'number' &&
    Number.isFinite(r.mintedAt) &&
    isNonEmptyString(r.expiresAt) &&
    (r.label === null || typeof r.label === 'string')
  )
}

function copyRecord(r: PairingRecord): PairingRecord {
  return { nonce: r.nonce, userId: r.userId, networkHash: r.networkHash, inviteKey: r.inviteKey, mintedAt: r.mintedAt, expiresAt: r.expiresAt, label: r.label }
}

export interface KvPairedBrowsers {
  /** The `recordPairedBrowser` platform member: idempotent by nonce, the 7 fields only, capped at the oldest. */
  recordPairedBrowser(record: PairingRecord): Promise<void>
  readPairedBrowsers(): Promise<PairingRecord[]>
}

/**
 * The paired-browsers list over `kv[key]` (a JSON array of the 7 record fields). Malformed items are
 * dropped on read; a corrupt document rejects `unreadable` and is never written over. Nothing stored is
 * a code, an invitation or a key.
 */
export function createKvPairedBrowsers(kv: KvStorage, key: string = PAIRED_BROWSERS_KEY): KvPairedBrowsers {
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  const read = async (): Promise<PairingRecord[]> => {
    let raw: string | null
    try {
      raw = await kv.getItem(key)
    } catch {
      throw new PairingStoreError('unreadable')
    }
    if (raw === null) return []
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch {
      throw new PairingStoreError('unreadable')
    }
    if (!Array.isArray(doc)) throw new PairingStoreError('unreadable')
    return doc.filter(recordValid).map(copyRecord)
  }
  return {
    recordPairedBrowser: (record) => {
      if (!recordValid(record) || Object.keys(record).some((k) => !RECORD_KEYS.includes(k))) return Promise.reject(new PairingStoreError('entry-invalid'))
      const clean = copyRecord(record)
      return serialized(async () => {
        const list = await read()
        if (list.some((r) => r.nonce === clean.nonce)) return
        list.push(clean)
        list.sort((a, b) => a.mintedAt - b.mintedAt)
        while (list.length > PAIRED_BROWSERS_MAX_ENTRIES) list.shift()
        await kv.setItem(key, JSON.stringify(list))
      })
    },
    readPairedBrowsers: () => serialized(read)
  }
}

// ---------------------------------------------------------------------------------------------
// The officer's pair-mint client port

export class PairMintUnreachableError extends Error {
  readonly requestSent = false as const

  constructor() {
    super('pair-mint: no owner answered')
    this.name = 'PairMintUnreachableError'
  }
}

export class PairMintNoReplyError extends Error {
  readonly requestSent = true as const

  constructor() {
    super('pair-mint: the request was sent but no reply arrived')
    this.name = 'PairMintNoReplyError'
  }
}

export class PairMintCancelledError extends Error {
  constructor() {
    super('pair-mint: cancelled')
    this.name = 'PairMintCancelledError'
  }
}

function str(value: unknown): string | null {
  try {
    const s = (value as { toString(): string } | null | undefined)?.toString()
    return typeof s === 'string' && s.length > 0 ? s : null
  } catch {
    return null
  }
}

const trailingPeerId = (addr: string): string | null => /\/p2p\/([^/]+)$/.exec(addr)?.[1] ?? null

function liveConnections(control: unknown): Array<{ peer: string, addr: unknown }> {
  try {
    const get = (control as { getConnections?: () => unknown } | null)?.getConnections
    if (typeof get !== 'function') return []
    const conns = get.call(control)
    if (!Array.isArray(conns)) return []
    const out: Array<{ peer: string, addr: unknown }> = []
    for (const c of conns) {
      const peer = str((c as { remotePeer?: unknown } | null)?.remotePeer)
      if (peer) out.push({ peer, addr: (c as { remoteAddr?: unknown }).remoteAddr })
    }
    return out
  } catch {
    return []
  }
}

/**
 * The owner devices to ask, in order: TRUSTED live owner keys matched to `CadrePeer.publicKey`, this
 * peer excluded, connected owners first, then the most recently seen; addresses from the signed peer
 * record, a live connection, then the join-bootstrap list (each ending in `/p2p/<owner>`). Never throws.
 */
export async function findOwnerTargets(node: PairingClientNode, deps: { readJoinBootstrap(): Promise<string[]> }): Promise<PairingDialTarget[]> {
  try {
    const self = str(node.peerId)
    const ownerKeys = new Set((await node.listOwnerKeys()).filter((k) => k.trusted === true).map((k) => k.key))
    if (ownerKeys.size === 0) return []
    const db = node.getControlDatabase()
    if (!db) return []
    const rows = await db.queryCadrePeers()
    const owners = rows.filter((r) => typeof r.peerId === 'string' && r.peerId.length > 0 && r.publicKey !== null && ownerKeys.has(r.publicKey) && r.peerId !== self)
    if (owners.length === 0) return []
    let control: unknown = null
    try {
      control = node.getControlNode()
    } catch {
      control = null
    }
    const conns = liveConnections(control)
    const connected = new Set(conns.map((c) => c.peer))
    const ordered = [...owners].sort((a, b) => {
      const ca = connected.has(a.peerId) ? 1 : 0
      const cb = connected.has(b.peerId) ? 1 : 0
      if (ca !== cb) return cb - ca
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    })
    let bootstrap: string[] | null = null
    const targets: PairingDialTarget[] = []
    const seen = new Set<string>()
    const push = (peerId: string, addr: unknown, source: PairingDialTarget['source']): void => {
      if (targets.length >= PAIR_MINT_MAX_TARGETS) return
      const k = String(addr)
      if (seen.has(k)) return
      seen.add(k)
      targets.push({ peerId, addr, source })
    }
    for (const owner of ordered) {
      if (targets.length >= PAIR_MINT_MAX_TARGETS) break
      let record: ReadonlyArray<unknown> = []
      try {
        record = await node.resolvePeerAddrs(owner.peerId)
        if (!Array.isArray(record)) record = []
      } catch {
        record = []
      }
      if (record.length > 0) {
        for (const addr of record.slice(0, PAIR_MINT_ADDRS_PER_OWNER)) push(owner.peerId, addr, 'record')
        continue
      }
      const live = conns.find((c) => c.peer === owner.peerId && str(c.addr)?.endsWith(`/p2p/${owner.peerId}`) === true)
      if (live) {
        push(owner.peerId, live.addr, 'connection')
        continue
      }
      if (bootstrap === null) {
        try {
          bootstrap = await deps.readJoinBootstrap()
          if (!Array.isArray(bootstrap)) bootstrap = []
        } catch {
          bootstrap = []
        }
      }
      for (const text of bootstrap) {
        if (typeof text !== 'string' || trailingPeerId(text) !== owner.peerId) continue
        let addr: unknown
        try {
          addr = multiaddr(text)
        } catch {
          continue
        }
        push(owner.peerId, addr, 'join-bootstrap')
      }
    }
    return targets
  } catch {
    return []
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(new PairMintCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        reject(err)
      }
    )
  })
}

/** The one-owner-at-a-time failover client with the no-resend rule (a request that went out is never resent elsewhere). */
export function createPairMintFailoverClient(
  control: unknown,
  targets: readonly PairingDialTarget[],
  options: { targetTimeoutMs?: number, totalBudgetMs?: number, nowMs?: () => number, request?: typeof requestPairMint } = {}
): { call(request: PairMintRequest, opts?: { signal?: AbortSignal }): Promise<PairMintReply> } {
  const targetTimeoutMs = options.targetTimeoutMs ?? PAIR_MINT_TARGET_TIMEOUT_MS
  const totalBudgetMs = options.totalBudgetMs ?? PAIR_MINT_TOTAL_BUDGET_MS
  const nowMs = options.nowMs ?? Date.now
  const send = options.request ?? requestPairMint
  const list = [...targets]
  return {
    async call(request, opts) {
      const signal = opts?.signal
      const start = nowMs()
      for (const target of list) {
        if (signal?.aborted) throw new PairMintCancelledError()
        if (nowMs() - start >= totalBudgetMs) break
        let reply: PairMintReply
        try {
          reply = await raceAbort(send(control as PairMintLibp2pLike, target.addr, request, { timeoutMs: targetTimeoutMs }), signal)
        } catch (err) {
          if (err instanceof PairMintCancelledError) throw err
          if ((err as { requestSent?: unknown } | null)?.requestSent === true) throw new PairMintNoReplyError()
          continue
        }
        return reply
      }
      if (signal?.aborted) throw new PairMintCancelledError()
      throw new PairMintUnreachableError()
    }
  }
}

export function classifyPairMintError(err: unknown): 'cancelled' | 'no-reply' | 'unreachable' | 'other' {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'PairMintCancelledError') return 'cancelled'
  if (name === 'PairMintNoReplyError' || (err as { requestSent?: unknown } | null)?.requestSent === true) return 'no-reply'
  if (name === 'PairMintUnreachableError') return 'unreachable'
  return 'other'
}

/** The `PairMintClientPort` of `requestPairingCode` for a vt daemon: owner lookup over the peer's join-bootstrap store. */
export function createPairMintClientPort(deps: { readJoinBootstrap(): Promise<string[]> }): PairMintClientPort {
  return {
    findOwnerTargets: (node) => findOwnerTargets(node, deps),
    createFailoverClient: (control, targets, options) => createPairMintFailoverClient(control, targets, options),
    classifyError: classifyPairMintError
  }
}

/** Re-exported so a verb can type its `localMint` without a second vote-engine import. */
export type { PairMintMintRequest, PairMintReply }
