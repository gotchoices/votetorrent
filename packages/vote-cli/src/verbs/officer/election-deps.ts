// The ONE binding from the daemon's verb context (67-23 VerbContext, read through 67-24's
// OfficerVerbContext) to the officer election verbs: the refusal class, the argument allow-list, the
// production-party gate, network access by hash (the hash is always an ARGUMENT), the election and
// signature-task engines over the established network context, the token-gated signer factory and the
// per-context write serialization. Replaces what tools/lean-rig/lean/lean-part2.ts legElection took
// from its process-wide `roles` map (ctx, sign, engine; lines 697-716, 802-804) and what
// tools/vote-cli/src/workflows/authority.mjs took from its device record.
//
// Context members read here (nowhere else in the election verbs): partyId, secretsDir, secrets,
// device.vault, user, engine() (through officerEngine). No console, no process.env, no instanceof.
// No module-global mutable state other than the WeakMap keyed by the daemon context (RESEARCH Pitfall
// 4: colocated peers stay independent).

import { performance } from 'node:perf_hooks'
import type { IElectionEngine, IElectionsEngine, INetworkEngine, ISignatureTasksEngine } from '@votetorrent/vote-core'
import { ElectionsEngine, SignatureTasksEngine } from '@votetorrent/vote-engine/rn'
import type { SignCallback } from '@votetorrent/workflows/platform'
import { assertTokenSigningKeyHeld, createTokenSigner, type ApprovalScopedVault } from '../../approval/signer.js'
import type { ApprovalContext } from '../../approval/token.js'
import { PRODUCTION_PARTY_ID } from '../../attestation/marker.js'
import type { buildCliTimeline } from '../../election/parse-timeline.js'
import { AUTHORITY_SIGNING_ALIAS, loadAuthorityUser } from '../../network/authority-user.js'
import { isAuthorityUserShape } from '../../network/network-init.js'
import { officerEngine, type OfficerVerbContext } from '../../network/network-verb-support.js'
import type { SecretRegistry } from '../../secrecy/redact.js'
import { ensurePrivateDir } from '../../vault/private-file.js'

// ---------------------------------------------------------------------------------------------
// Refusals

export class OfficerVerbRefusal extends Error {
  readonly code: string

  constructor(code: string) {
    super(`officer verb refused (${code})`)
    this.name = 'VerbRefusal'
    this.code = code
  }
}

export function refuse(code: string): never {
  throw new OfficerVerbRefusal(code)
}

// ---------------------------------------------------------------------------------------------
// Arguments and the party gate

/** The colocation label the daemon strips; a direct caller may still pass it. Never copied out. */
const PEER_KEY = 'peer'
/** The per-call token value: `withCallApproval` reads it from the request object, never from the copy. */
const TOKEN_VALUE_KEY = 'approvalToken'

/** Every own key of `args` must be allow-listed (`bad-arg`, the key is never echoed). Returns a shallow copy. */
export function pickArgs(args: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(args)) {
    if (key === PEER_KEY) continue
    if (!allowed.includes(key)) refuse('bad-arg')
    if (key === TOKEN_VALUE_KEY) continue
    out[key] = args[key]
  }
  return out
}

/** A missing or empty party is `party-missing`; the production party (trimmed, any case) is `production-party`. */
export function assertTestParty(partyId: unknown): void {
  if (typeof partyId !== 'string' || partyId.trim().length === 0) refuse('party-missing')
  if (partyId.trim().toLowerCase() === PRODUCTION_PARTY_ID) refuse('production-party')
}

/** Wall time of a verb body, whole milliseconds. */
export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

export const startedNow = (): number => performance.now()

// ---------------------------------------------------------------------------------------------
// Signing

export interface CountingSigner {
  sign: SignCallback
  count(): number
}

/** Counts invocations; stores neither digests nor signatures. */
export function countingSigner(sign: SignCallback): CountingSigner {
  let n = 0
  return {
    sign: async (digest) => {
      n++
      return sign(digest)
    },
    count: () => n
  }
}

const chains = new WeakMap<object, Promise<unknown>>()

/** Approval-class verbs run one at a time per daemon context (a WeakMap chain keyed by `key`). */
export function serializeOfficerWrite<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next.then(() => undefined, () => undefined))
  return next
}

// ---------------------------------------------------------------------------------------------
// The deps

export interface OfficerIdentity {
  userId: string
  signingKeyAlias: string
  /** The compressed secp256k1 public key the signer attributes to; the full key never leaves the daemon. */
  signerKey: string
}

export type ElectionsEngineSlice = Pick<
  IElectionsEngine,
  'buildCreateElection' | 'seedElectionSigning' | 'peekNextTid' | 'seedElectionRevisionSigning' | 'createElection' | 'adjustElection' | 'getElections' | 'getProposedElections'
>

export type TasksEngineSlice = Pick<ISignatureTasksEngine, 'getRequestedSignatures' | 'getSignatureDigest' | 'completeSignature'>

export interface OpenedElectionNetwork {
  electionsEngine: ElectionsEngineSlice
  openElection(electionId: unknown): Promise<IElectionEngine>
  tasksEngine: TasksEngineSlice
  /** The primary authority id: internal; replies carry its last 8 characters only. */
  authorityId: string
  /** The rig's single read: `select count(*) from InviteSlot where Type = 'k' and ElectionId = :e`. */
  countKeyholderInviteSlots(electionId: string): Promise<number>
}

export interface OfficerElectionDeps {
  readonly partyId: string
  /** Absolute, 0700; the seat shares and ballot needles are created once in here. */
  readonly secretsDir: string
  readonly secrets: SecretRegistry
  readonly vault: ApprovalScopedVault
  /** Refuses `identity-absent` / `identity-corrupt` until `found`/`join` provisioned the officer. */
  readonly officer: OfficerIdentity
  now(): number
  /** The object the write chain is keyed by: the daemon context. */
  readonly writeKey: object
  openNetwork(hash: unknown): Promise<OpenedElectionNetwork>
  /** Spec seam only: a replacement for `buildCliTimeline` (plants a bad timeline). The daemon never sets it. */
  buildTimeline?: typeof buildCliTimeline
}

const NETWORK_HASH_RE = /^[0-9a-f]{32}$/
const ELECTION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const INVITE_SLOT_COUNT_SQL = "select count(*) as n from InviteSlot where Type = 'k' and ElectionId = :e"

function officerIdentityOf(ctx: Pick<OfficerVerbContext, 'user'>): OfficerIdentity {
  const user = ctx.user
  if (user === null || user === undefined) refuse('identity-absent')
  if (!isAuthorityUserShape(user)) refuse('identity-corrupt')
  return { userId: user.id, signingKeyAlias: AUTHORITY_SIGNING_ALIAS, signerKey: user.activeKeys[0]!.key }
}

async function openElectionNetwork(ctx: OfficerVerbContext, hash: unknown): Promise<OpenedElectionNetwork> {
  if (typeof hash !== 'string' || !NETWORK_HASH_RE.test(hash)) refuse('bad-network-hash')
  const engine = officerEngine(ctx)
  const recents = await engine.getRecentNetworks()
  const ref = recents.find((r) => r.hash === hash)
  if (ref === undefined) refuse('network-unknown')
  const user = await loadAuthorityUser(ctx)
  if (user === null) refuse('identity-absent')
  const network = (await engine.open(ref, user)) as INetworkEngine
  const est = engine.getEstablishedContext(hash)
  if (est === undefined || est === null) refuse('network-not-open')
  let authorityId: string
  try {
    authorityId = String((await network.getDetails()).network.primaryAuthorityId)
  } catch {
    refuse('authority-unreadable')
  }
  const electionsEngine = new ElectionsEngine(est)
  const tasksEngine = new SignatureTasksEngine(ref, est)
  return {
    electionsEngine,
    tasksEngine,
    authorityId,
    async openElection(electionId: unknown) {
      if (typeof electionId !== 'string' || !ELECTION_ID_RE.test(electionId)) refuse('election-unknown')
      const known = await electionsEngine.getElections()
      if (!known.some((e) => e.id === electionId)) refuse('election-unknown')
      return electionsEngine.openElection(electionId)
    },
    async countKeyholderInviteSlots(electionId: string) {
      for await (const row of est.db.eval(INVITE_SLOT_COUNT_SQL, { e: electionId })) return Number((row as { n?: unknown }).n)
      return 0
    }
  }
}

/** Map the landed context onto the election deps. The verbs call this and nothing else of the context. */
export function officerElectionDeps(ctx: OfficerVerbContext): OfficerElectionDeps {
  ensurePrivateDir(ctx.secretsDir)
  return {
    partyId: ctx.partyId,
    secretsDir: ctx.secretsDir,
    secrets: ctx.secrets,
    vault: ctx.device.vault,
    get officer() {
      return officerIdentityOf(ctx)
    },
    now: () => Date.now(),
    writeKey: ctx,
    openNetwork: (hash) => openElectionNetwork(ctx, hash)
  }
}

// ---------------------------------------------------------------------------------------------
// The token-gated signer over the officer key

export interface OfficerSignerFactory {
  /** Proves the token against the held key with no signature: `token-refused`, else `signer-<code>`. */
  preflight(): Promise<void>
  /** The `createSigner` the shared workflows take; every signature is counted. */
  createSigner(): Promise<SignCallback>
  /** Signatures produced through every signer this factory handed out. */
  signatures(): number
}

const CURVE = 'secp256k1' as const

function mapSignerError(e: unknown): never {
  const err = e as { name?: unknown, code?: unknown } | undefined
  if (err?.name === 'TokenSignerError' && typeof err.code === 'string') {
    refuse(err.code === 'token-refused' ? 'token-refused' : `signer-${err.code}`)
  }
  throw e
}

export function officerSignerFactory(deps: Pick<OfficerElectionDeps, 'vault' | 'officer'>, approval: ApprovalContext): OfficerSignerFactory {
  const counters: CountingSigner[] = []
  return {
    async preflight() {
      const officer = deps.officer
      try {
        await assertTokenSigningKeyHeld({ vault: deps.vault, token: approval, curve: CURVE, alias: officer.signingKeyAlias, signerKey: officer.signerKey })
      } catch (e) {
        mapSignerError(e)
      }
    },
    async createSigner() {
      const officer = deps.officer
      const raw = createTokenSigner({
        vault: deps.vault,
        token: approval,
        curve: CURVE,
        alias: officer.signingKeyAlias,
        signerUserId: officer.userId,
        signerKey: officer.signerKey
      })
      const counted = countingSigner(async (digest) => {
        try {
          return await raw(digest)
        } catch (e) {
          return mapSignerError(e)
        }
      })
      counters.push(counted)
      return counted.sign
    },
    signatures: () => counters.reduce((n, c) => n + c.count(), 0)
  }
}
