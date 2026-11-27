/**
 * harness-workflows.ts — Phase 62 Plan 24 (D-23, D-24): the writer-identity instrument for the
 * two-node workflow legs.
 *
 * WHY THIS EXISTS. Two earlier harness PASSes in this project's history were FALSE — a node read
 * a row it had written to its OWN strand handle and reported that as "cross-peer replication"
 * (project memory: "P2P-11 leg 6b PASS was FALSE (own orphan row)", and an earlier false pass
 * before it). `assertForeignOrigin` below closes that class generically: every cross-peer
 * assertion in `staging-replication.harness.spec.ts`, `keyholder-replication.harness.spec.ts` and
 * `staging-concurrency.harness.spec.ts` routes through it, and it has its own negative control
 * (leg N-0, in `staging-replication.harness.spec.ts`) proving it actually rejects a row the
 * reader wrote itself.
 *
 * TEST-ONLY. This module imports no P2P package — only the 62-06 harness module
 * (`./harness/two-node-strand.js`) does, and only via the dynamic `import()` inside
 * `startTwoNodeHarness`. Everything here produces Node evidence only: code-complete, unverified
 * on devices. Device delivery is P2P-11 proof debt, recorded by 62-30 — not claimed here.
 *
 * The write ledger NEVER prints a whole captured entry (an entry's `values` may hold
 * signatures); a failure message names only a table and the one matched value.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Database } from '@quereus/quereus'
import type {
  AssociationAttestationAnswer,
  AssociationIdentityField,
  AssociationRequestInit,
  DeviceAttestation,
  RegistrationRequestInit,
  Signature
} from '@votetorrent/vote-core'
import {
  computeAssociationAttestationDigest,
  computeAssociationRequestDigest
} from '../../src/association/transport/association-request-digest.js'
import { digestToBytes } from '../../src/utils.js'
import type { EngineContext } from '../../src/types.js'
import { addTestAuthority, createTestNetwork } from './test-context.js'
import type { TestAuthorityContext, TestNetworkContext } from './test-context.js'
import { randomTestKeyPair } from './keys.js'
import {
  HARNESS_TIMEOUTS,
  pollUntil
} from '../harness/two-node-strand.js'
import type { HarnessStrandPort, TwoNodeHarness } from '../harness/two-node-strand.js'

// ---------------------------------------------------------------------------
// Write ledger
// ---------------------------------------------------------------------------

export type HarnessNodeName = 'node-A' | 'node-B'

interface WriteLedgerEntry {
  readonly table: string
  readonly op: 'insert' | 'update' | 'delete'
  readonly values: string[]
}

export interface WriteLedger {
  readonly node: HarnessNodeName
  wrapDb (db: Database): Database
  wrapPort (port: HarnessStrandPort): HarnessStrandPort
  wroteRowWith (table: string, value: string): boolean
  writesTo (table: string): number
  total (): number
}

/** Strips `--` line comments and `/* ... *\/` block comments. */
function stripSqlNoise (sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const IDENT = '(?:(?:main|App)\\.)?["\'`]?([A-Za-z_][A-Za-z0-9_]*)["\'`]?'
const INSERT_RE = new RegExp(`^\\s*(?:insert|replace)\\s+(?:or\\s+\\w+\\s+)?into\\s+${IDENT}`, 'i')
const UPDATE_RE = new RegExp(`^\\s*update\\s+${IDENT}`, 'i')
const DELETE_RE = new RegExp(`^\\s*delete\\s+from\\s+${IDENT}`, 'i')

function classifyWrite (sql: string): { op: 'insert' | 'update' | 'delete', table: string } | null {
  const firstStmt = stripSqlNoise(sql).split(';')[0] ?? sql
  const ins = INSERT_RE.exec(firstStmt)
  if (ins?.[1] !== undefined) return { op: 'insert', table: ins[1] }
  const upd = UPDATE_RE.exec(firstStmt)
  if (upd?.[1] !== undefined) return { op: 'update', table: upd[1] }
  const del = DELETE_RE.exec(firstStmt)
  if (del?.[1] !== undefined) return { op: 'delete', table: del[1] }
  return null
}

function paramValues (params: unknown): string[] {
  if (params === null || params === undefined || typeof params !== 'object') return []
  return Object.values(params as Record<string, unknown>).map((v) => {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v)
    } catch {
      return String(v)
    }
  })
}

/**
 * `createWriteLedger(node)` — records every WRITE issued through a `wrapDb`/`wrapPort` handle.
 * Entries live in memory only and are never printed; a thrown message names only a table and the
 * one matched value, never a whole entry.
 */
export function createWriteLedger (node: HarnessNodeName): WriteLedger {
  const entries: WriteLedgerEntry[] = []
  const dbCache = new WeakMap<object, Database>()

  function record (sql: string, params: unknown): void {
    const classified = classifyWrite(sql)
    if (classified === null) return
    entries.push({ table: classified.table, op: classified.op, values: paramValues(params) })
  }

  function wrapStatement (sql: string, stmt: any): any {
    return new Proxy(stmt, {
      get (target: any, prop: string | symbol, _receiver: unknown) {
        if (prop === 'run' || prop === 'get' || prop === 'all' || prop === 'iterateRows') {
          const fn = target[prop]
          if (typeof fn === 'function') {
            return (...args: any[]) => {
              record(sql, args[0])
              return fn.apply(target, args)
            }
          }
        }
        const value = target[prop as keyof typeof target]
        if (typeof value === 'function') return value.bind(target)
        return value
      }
    })
  }

  function wrapDb (db: Database): Database {
    const cached = dbCache.get(db)
    if (cached !== undefined) return cached
    const proxy = new Proxy(db as unknown as Record<string, any>, {
      get (target: Record<string, any>, prop: string | symbol, _receiver: unknown) {
        if (prop === 'exec') {
          return async (sql: string, params?: unknown, options?: unknown) => {
            record(sql, params)
            return target.exec(sql, params, options)
          }
        }
        if (prop === 'eval') {
          return (sql: string, params?: unknown, options?: unknown) => {
            record(sql, params)
            return target.eval(sql, params, options)
          }
        }
        if (prop === 'prepare') {
          return (sql: string, paramsOrTypes?: unknown) => {
            const stmt = target.prepare(sql, paramsOrTypes)
            return wrapStatement(sql, stmt)
          }
        }
        const value = target[prop as string]
        if (typeof value === 'function') return value.bind(target)
        return value
      }
    }) as unknown as Database
    dbCache.set(db, proxy)
    return proxy
  }

  function wrapPort (port: HarnessStrandPort): HarnessStrandPort {
    return {
      async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        return port.query<T>(sql, params)
      },
      async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
        record(sql, params)
        return port.mutate(sql, params)
      },
      async close (): Promise<void> {
        return port.close()
      }
    }
  }

  return {
    node,
    wrapDb,
    wrapPort,
    wroteRowWith (table: string, value: string): boolean {
      return entries.some((e) => e.table === table && e.values.includes(value))
    },
    writesTo (table: string): number {
      return entries.filter((e) => e.table === table).length
    },
    total (): number {
      return entries.length
    }
  }
}

// ---------------------------------------------------------------------------
// HarnessWorkflowNetwork / bootHarnessNetwork
// ---------------------------------------------------------------------------

export interface HarnessWorkflowNetwork {
  readonly harness: TwoNodeHarness
  readonly hash: string
  readonly net: TestNetworkContext
  readonly auth: TestAuthorityContext
  readonly dbA: Database
  readonly dbB: Database
  readonly ctxA: EngineContext
  readonly ctxB: EngineContext
  readonly ledgerA: WriteLedger
  readonly ledgerB: WriteLedger
  portA (): Promise<HarnessStrandPort>
  portB (): Promise<HarnessStrandPort>
}

export async function bootHarnessNetwork (harness: TwoNodeHarness): Promise<HarnessWorkflowNetwork> {
  const ledgerA = createWriteLedger('node-A')
  const ledgerB = createWriteLedger('node-B')

  const net = await createTestNetwork({
    dbFactory: async (strandId: string) => ledgerA.wrapDb(await harness.nodeA.dbFactory(strandId))
  })
  const auth = await addTestAuthority(net)
  const hash = net.ref.hash

  const dbA = net.ctx.db
  const dbB = ledgerB.wrapDb(await harness.nodeB.openStrand(hash))

  const ctxA: EngineContext = net.ctx
  const ctxB: EngineContext = { db: dbB, user: net.user }

  async function portA (): Promise<HarnessStrandPort> {
    return ledgerA.wrapPort(await harness.nodeA.strandPort(hash))
  }
  async function portB (): Promise<HarnessStrandPort> {
    return ledgerB.wrapPort(await harness.nodeB.strandPort(hash))
  }

  await pollUntil(
    async () => {
      const networkRow = await dbB.prepare('select Hash from Network where Hash = :hash').get({ hash })
      const authorityRow = await dbB.prepare('select Id from Authority where Id = :id').get({ id: auth.authority.id })
      const officerRow = await dbB.prepare('select UserId from Officer where UserId = :userId').get({ userId: net.user.id })
      return { networkRow, authorityRow, officerRow }
    },
    (v) => v.networkRow != null && v.authorityRow != null && v.officerRow != null,
    { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'bootHarnessNetwork: founding rows reach node-B' }
  )

  return { harness, hash, net, auth, dbA, dbB, ctxA, ctxB, ledgerA, ledgerB, portA, portB }
}

// ---------------------------------------------------------------------------
// legMark / assertReaderSilent / assertForeignOrigin
// ---------------------------------------------------------------------------

export interface LegMark {
  a: { mutateCount: number, ledger: number }
  b: { mutateCount: number, ledger: number }
}

export function legMark (net: HarnessWorkflowNetwork): LegMark {
  return {
    a: { mutateCount: net.harness.nodeA.stats.mutateCount, ledger: net.ledgerA.total() },
    b: { mutateCount: net.harness.nodeB.stats.mutateCount, ledger: net.ledgerB.total() }
  }
}

/** Throws unless the reader's harness `mutateCount` AND ledger total both equal the mark —
 * a leg-scoped delta of 0, proving the reading side performed no write during the leg. */
export function assertReaderSilent (net: HarnessWorkflowNetwork, mark: LegMark, reader: HarnessNodeName): void {
  const node = reader === 'node-A' ? net.harness.nodeA : net.harness.nodeB
  const ledger = reader === 'node-A' ? net.ledgerA : net.ledgerB
  const before = reader === 'node-A' ? mark.a : mark.b
  if (node.stats.mutateCount !== before.mutateCount) {
    throw new Error(
      `assertReaderSilent: ${reader} harness mutateCount changed from ${before.mutateCount} to ${node.stats.mutateCount}`
    )
  }
  if (ledger.total() !== before.ledger) {
    throw new Error(`assertReaderSilent: ${reader} ledger total changed from ${before.ledger} to ${ledger.total()}`)
  }
}

/** A closed allow-list of the tables `assertForeignOrigin` may target — never taken from input.
 * N-0 (`staging-replication.harness.spec.ts`) adds `TidHighWater` to this set at runtime by being
 * the first table this module ships with; every other table used by this plan's three specs is
 * listed here up front. */
const ALLOWED_TABLES = new Set<string>([
  'TidHighWater',
  'UserEncryptionKey',
  'AuthorityIntakePolicy',
  'RegistrationRequestStaging',
  'RegistrationDecision',
  'AssociationRequestStaging',
  'AssociationAttestationStaging',
  'AssociationDecision',
  'Keyholder',
  'KeyholderDkgBinding',
  'KeyholderDkgMessage',
  'ElectionKey',
  'KeyholderShareRelease'
])

const ALLOWED_KEY_COLUMNS = new Set<string>([
  'Namespace', 'PubKey', 'AuthorityId', 'RequestId', 'UserId', 'SenderUserId', 'ElectionId'
])

/**
 * `assertForeignOrigin(net, { table, keyColumn, keyValue, reader, writer })` — the single
 * writer-identity instrument every cross-peer leg in this plan's three specs routes through.
 * Selects `select * from <table> where <keyColumn> = :keyValue` on the READER's db (table/column
 * from the closed allow-lists above, never from a caller-supplied string outside them), then:
 *   1. asserts at least 1 row exists;
 *   2. asserts the READER's own ledger never wrote that row — `own-orphan` on failure;
 *   3. asserts the WRITER's ledger DID write that row — `writer-unproven` on failure (guards
 *      against a vacuous instrument that would pass on an unwritten/untracked row).
 * Returns the reader's row.
 */
export async function assertForeignOrigin (net: HarnessWorkflowNetwork, args: {
  table: string
  keyColumn: string
  keyValue: string
  reader: HarnessNodeName
  writer: HarnessNodeName
}): Promise<Record<string, unknown>> {
  const { table, keyColumn, keyValue, reader, writer } = args
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`assertForeignOrigin: table ${JSON.stringify(table)} is not on the allow-list`)
  }
  if (!ALLOWED_KEY_COLUMNS.has(keyColumn)) {
    throw new Error(`assertForeignOrigin: keyColumn ${JSON.stringify(keyColumn)} is not on the allow-list`)
  }
  const readerDb = reader === 'node-A' ? net.dbA : net.dbB
  const readerLedger = reader === 'node-A' ? net.ledgerA : net.ledgerB
  const writerLedger = writer === 'node-A' ? net.ledgerA : net.ledgerB

  const rows: Array<Record<string, unknown>> = []
  for await (const row of readerDb.eval(`select * from ${table} where ${keyColumn} = :keyValue`, { keyValue } as any)) {
    rows.push(row as unknown as Record<string, unknown>)
  }
  if (rows.length < 1) {
    throw new Error(`assertForeignOrigin: no ${table} row with ${keyColumn}=${keyValue} found on ${reader}`)
  }
  if (readerLedger.wroteRowWith(table, keyValue)) {
    throw new Error(`own-orphan: ${reader} wrote ${table} row ${keyValue} itself`)
  }
  if (!writerLedger.wroteRowWith(table, keyValue)) {
    throw new Error(`writer-unproven: ${writer} never wrote ${table} row ${keyValue} — vacuous instrument`)
  }
  return rows[0]!
}

// ---------------------------------------------------------------------------
// createBarrierPort — the cross-peer cursor-race rendezvous (62-24 Task 3)
// ---------------------------------------------------------------------------

interface SharedBarrierState {
  count: number
  readonly parties: number
  readonly promise: Promise<void>
  readonly resolve: () => void
}

/** Keyed by `table` — the FIRST `createBarrierPort` call for a given table lazily creates the
 * shared barrier on its first matching insert; the table's SECOND call (the other port) joins
 * the SAME barrier object and, once `parties` have arrived, the entry is removed so a LATER leg
 * reusing the same table name starts fresh. This is how "the barrier object is created once and
 * passed to both ports" holds without either caller needing to construct and thread a separate
 * object by hand — the table name IS the shared handle for the lifetime of one rendezvous. */
const barrierRegistry = new Map<string, SharedBarrierState>()

function getOrCreateBarrier (table: string, parties: number): SharedBarrierState {
  let state = barrierRegistry.get(table)
  if (state === undefined) {
    let resolve!: () => void
    const promise = new Promise<void>((res) => { resolve = res })
    state = { count: 0, parties, promise, resolve }
    barrierRegistry.set(table, state)
  }
  return state
}

/**
 * `createBarrierPort(port, { table, parties, timeoutMs, onInsert })` — wraps a port so its FIRST
 * insert whose SQL starts with `insert into <table>` reports `params.cursor` through `onInsert`,
 * then waits on the shared two-party barrier for `table` before forwarding. Retries (the SAME
 * port's later inserts) pass straight through unmodified. A barrier not reached within
 * `timeoutMs` rejects `Error('barrier-not-reached')`.
 */
export function createBarrierPort (port: HarnessStrandPort, options: {
  table: string
  parties: number
  timeoutMs: number
  onInsert: (cursor: string) => void
}): HarnessStrandPort {
  const { table, parties, timeoutMs, onInsert } = options
  const insertPattern = new RegExp(`^\\s*insert\\s+into\\s+(?:(?:main|App)\\.)?["'\`]?${table}["'\`]?`, 'i')
  let waited = false

  return {
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      return port.query<T>(sql, params)
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
      if (!waited && insertPattern.test(sql)) {
        waited = true
        const cursor = (params as { cursor?: unknown }).cursor
        if (typeof cursor === 'string') onInsert(cursor)

        const state = getOrCreateBarrier(table, parties)
        state.count++
        if (state.count >= state.parties) {
          barrierRegistry.delete(table)
          state.resolve()
        } else {
          let timer: ReturnType<typeof setTimeout>
          try {
            await Promise.race([
              state.promise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('barrier-not-reached')), timeoutMs)
              })
            ])
          } catch (err) {
            barrierRegistry.delete(table)
            throw err
          } finally {
            clearTimeout(timer!)
          }
        }
      }
      return port.mutate(sql, params)
    },
    async close (): Promise<void> {
      return port.close()
    }
  }
}

// ---------------------------------------------------------------------------
// Copied builders — registration (reg*) and association (assoc*)
//
// Copied from `registration-request-transport-conformance.spec.ts` (:156-235) and
// `association-request-transport-conformance.spec.ts` (:182-340) per
// <facts_verified_at_plan_time>. Never imports either `*.spec.ts` file. Every `authorityId`
// default becomes a required parameter here — the sealer refuses an authority mismatch.
// ---------------------------------------------------------------------------

const DG1_FIELD_ORDER = Object.freeze([
  'id', 'authorityId', 'requesterKey', 'issuerType', 'bridgeId', 'payloadCid', 'submittedAt'
] as const)

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

let regRequestIdSeq = 0
function nextRegRequestId (): string {
  regRequestIdSeq += 1
  return `harness-reg-req-${Date.now()}-${regRequestIdSeq}`
}

/** A valid `RegistrationRequestInit`, authorityId REQUIRED (not defaulted — see header). */
export function regMakeInit (authorityId: string, overrides: Partial<RegistrationRequestInit> = {}): RegistrationRequestInit {
  const id = overrides.id ?? nextRegRequestId()
  return {
    id,
    authorityId,
    payload: overrides.payload ?? {
      registrant: { id: `registrant-${id}`, authorityId, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'note', value: 'harness-fixture' }] }
    },
    submittedAt: overrides.submittedAt ?? new Date().toISOString(),
    issuerType: overrides.issuerType,
    bridgeId: overrides.bridgeId
  }
}

/** The pure DG1_FIELD_ORDER tuple-building + hashing computation (copied verbatim, see header).
 * The staging tables' `SignatureValid` CHECK only requires a genuine signature over WHATEVER
 * `Digest` a row stores (the row's own `Digest` column is trusted; the check never recomputes
 * one) — this does not need to reproduce any "real" schema-side digest tuple. */
export async function regDigest (init: RegistrationRequestInit, requesterKey: string): Promise<Uint8Array> {
  if (typeof init.submittedAt !== 'string' || init.submittedAt.length === 0 || !init.submittedAt.endsWith('Z')) {
    throw new Error(`regDigest: init.submittedAt must be a non-empty Z-suffixed string, got ${JSON.stringify(init.submittedAt)}`)
  }
  const payloadCid = bytesToHex(sha256(utf8ToBytes(JSON.stringify(init.payload))))
  const input: Record<string, string> = {}
  for (const field of DG1_FIELD_ORDER) {
    let value: string
    switch (field) {
      case 'id': value = init.id; break
      case 'authorityId': value = init.authorityId; break
      case 'requesterKey': value = requesterKey; break
      case 'issuerType': value = init.issuerType ?? 'registrant'; break
      case 'bridgeId': value = init.bridgeId ?? ''; break
      case 'payloadCid': value = payloadCid; break
      case 'submittedAt': value = init.submittedAt; break
    }
    input[field] = value
  }
  const line = DG1_FIELD_ORDER.map((field) => `${field}=${input[field]}`).join('\n')
  return sha256(utf8ToBytes(line))
}

let assocRequestIdSeq = 0
function nextAssocRequestId (): string {
  assocRequestIdSeq += 1
  return `harness-assoc-req-${Date.now()}-${assocRequestIdSeq}`
}

/** A valid `AssociationRequestInit`, authorityId REQUIRED. `deviceKey` defaults to the caller's
 * own public key (`requesterKeyHex`), mirroring the real ceremony's self-signature. */
export function assocMakeInit (
  requesterKeyHex: string,
  authorityId: string,
  overrides: Partial<AssociationRequestInit> = {}
): AssociationRequestInit {
  const id = overrides.id ?? nextAssocRequestId()
  return {
    id,
    authorityId,
    registrantId: overrides.registrantId ?? `registrant-${id}`,
    deviceKey: overrides.deviceKey ?? requesterKeyHex,
    electionId: overrides.electionId,
    submittedAt: overrides.submittedAt ?? new Date().toISOString()
  }
}

/** Leg 1 — the REAL production tuple (`src/association/transport/association-request-digest.ts`),
 * not a test-local stand-in: `requesterKey` occupies the `DeviceKey` position, matching the engine. */
export async function assocRequestDigest (init: AssociationRequestInit, requesterKey: string): Promise<Uint8Array> {
  return digestToBytes(computeAssociationRequestDigest(init, requesterKey))
}

/** Leg 2 — the REAL production tuple. `requesterKey` is accepted (unused) only to match the
 * `AttestationDigestFn` shape every P2P transport expects. */
export async function assocAttestationDigest (answer: AssociationAttestationAnswer, _requesterKey: string): Promise<Uint8Array> {
  return digestToBytes(computeAssociationAttestationDigest(answer))
}

function makeAssocAttestation (overrides: Partial<DeviceAttestation> = {}): DeviceAttestation {
  return {
    publicKey: overrides.publicKey ?? 'harness-device-pubkey',
    deviceId: overrides.deviceId ?? `harness-device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    attestationTime: overrides.attestationTime ?? Date.now(),
    certificateChain: overrides.certificateChain ?? ['harness-leaf-cert']
  }
}

/** D-18's distinct second message — never carries `registrantId`/`deviceKey` (read back from the
 * persisted request row, not accepted from the wire). */
export function assocMakeAttestationAnswer (overrides: Partial<AssociationAttestationAnswer> = {}): AssociationAttestationAnswer {
  return {
    requestId: overrides.requestId ?? nextAssocRequestId(),
    nonce: overrides.nonce ?? `harness-nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    attestation: overrides.attestation ?? makeAssocAttestation(),
    deviceHash: overrides.deviceHash
  }
}

/** Re-exported type for a caller that wants to build an `AssociationIdentityField` literal
 * without importing `@votetorrent/vote-core` directly in a spec file. */
export type { AssociationIdentityField }

/** `makeRealSigner` body (both conformance files' copy) — a fresh real secp256k1 requester
 * signer. `signerUserId` is deliberately empty: a prospective registrant/device has no `User` row. */
export function makeRequesterSigner (): { publicHex: string, privateHex: string, sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
  return { publicHex, privateHex, sign }
}
