// The voter verbs' context adapter (67-29): the ONLY file of the voter group that names daemon-context
// members (67-23 `VerbContext`). It gives the five verbs their refusal class, the argument allow-list, the
// party gate, the token-gated voter identity (secp256k1, signs the registration request) and K_vote (P-256,
// 67-20's token-attestation producer), the at-rest device id, the engines of an open network by name, the
// two kv stores, the per-peer verb lock and the per-call approval seam over 67-26's `withCallApproval`.
//
// The voter never verifies an attestation: its AssociationEngine takes ONE argument. No console, no
// process.env, no instanceof. Nothing here caches a token or a key across calls; the engine map is keyed
// by the context object so colocated peers never share an engine, and it holds no secret.

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission } from '@serfab/cadre-core'
import { UserKeyType, type INetworksEngine, type NetworkReference, type User } from '@votetorrent/vote-core'
import { AssociationEngine, ElectionsEngine, NetworkEngine, RegistrationEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import type { SignCallback, VoteSigningProducer } from '@votetorrent/workflows/platform'
import {
  createVoterStrandPort,
  type RegistrationCeremonyAttemptStore,
  type VoterJoinBootstrapWriter,
  type VoterJoinCadre,
  type VoterJoinNode,
  type VoterStrandPort
} from '@votetorrent/workflows/voter'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import type { SecretRegistry } from '../../secrecy/redact.js'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import {
  assertTokenSigningKeyHeld,
  createTokenSigner,
  provisionTokenSigningKey,
  readTokenSigningPublicKey,
  type ApprovalScopedVault
} from '../../approval/signer.js'
import { NO_APPROVAL, type ApprovalContext } from '../../approval/token.js'
import { createTokenAttestationProducer } from '../../attestation/token-attestation-producer.js'
import { PRODUCTION_PARTY_ID } from '../../attestation/marker.js'
import {
  createLastAttemptStore,
  createVoterAttemptStore,
  type VoterKv,
  type VoterLastAttemptStore
} from './voter-attempt-store.js'
import type { CliVoterRequestStrand, CliVoterRequestTransports } from './voter-transports.js'

// ---------------------------------------------------------------------------------------------
// The refusal

/** The fixed voter codes. `join-<reason>` carries the shared join's closed reason token. */
export const VOTER_REFUSAL_CODES = Object.freeze([
  'bad-arg',
  'party-missing',
  'production-party',
  'network-required',
  'network-not-open',
  'code-file-required',
  'code-file-missing',
  'code-file-mode',
  'code-file-owner',
  'code-file-not-file',
  'code-file-size',
  'code-malformed',
  'preview-mismatch',
  'join-timeout',
  'join-failed',
  'registrant-file-required',
  'registrant-file-missing',
  'registrant-file-mode',
  'registrant-invalid',
  'identity-absent',
  'no-attempt',
  'rest-bridge-configured',
  'voter-busy',
  'unknown-engine',
  'wait-invalid',
  'wait-timeout',
  'token-refused'
] as const)

export type VoterFixedRefusalCode = (typeof VOTER_REFUSAL_CODES)[number]

/** The ceremony's named failures (the map lives in ceremony-step.ts, `CEREMONY_ERROR_CODES`). */
export type CeremonyRefusalCode =
  | 'no-election'
  | 'registration-closed'
  | 'authority-unreachable'
  | 'association-rejected'
  | 'challenge-without-nonce'
  | 'ceremony-failed'

export type VoterRefusalCode = VoterFixedRefusalCode | CeremonyRefusalCode | `join-${string}`

const FAILED_NAME_RE = /^[A-Za-z]{1,60}$/

export interface VoterVerbRefusalOptions {
  /** For `ceremony-failed` only: the failing error's class name when it is a plain word; nothing else. */
  failedName?: string
  cause?: unknown
}

/** `name` is 67-26's `VerbRefusal`, so the ctl error view and the client treat every group's refusals alike. */
export class VoterVerbRefusal extends Error {
  readonly code: VoterRefusalCode
  readonly failedName: string | undefined

  constructor(code: VoterRefusalCode, opts: VoterVerbRefusalOptions = {}) {
    super(`voter verb refused (${code})`)
    this.name = 'VerbRefusal'
    this.code = code
    this.failedName = typeof opts.failedName === 'string' && FAILED_NAME_RE.test(opts.failedName) ? opts.failedName : undefined
    if (opts.cause !== undefined) Object.defineProperty(this, 'cause', { value: opts.cause, enumerable: false, writable: true, configurable: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments and the party gate

/** The colocation label 67-21 adds; the daemon strips it, a direct caller may still pass it. */
const PEER_KEY = 'peer'

const APPROVAL_KEYS: ReadonlySet<string> = new Set<string>(CALL_APPROVAL_ARG_KEYS)

/**
 * Allow-list the verb's arguments: every own key must be in `allowed` (or be `peer`), else `bad-arg`; a
 * value that is neither a string nor a boolean is `bad-arg` too. Returns a shallow copy without `peer`
 * and without the approval keys (those stay on the ORIGINAL args object, which `withCallApproval` reads
 * and deletes the forwarded token from). Nothing here echoes a key or a value.
 */
export function pickVoterArgs(args: Record<string, unknown>, allowed: readonly string[]): Record<string, string | boolean> {
  const set = new Set<string>(allowed)
  const out: Record<string, string | boolean> = {}
  for (const key of Object.keys(args)) {
    if (key === PEER_KEY) continue
    if (!set.has(key)) throw new VoterVerbRefusal('bad-arg')
    const v = args[key]
    if (typeof v !== 'string' && typeof v !== 'boolean') throw new VoterVerbRefusal('bad-arg')
    if (APPROVAL_KEYS.has(key)) continue
    out[key] = v
  }
  return out
}

/** Empty is `party-missing`; `votetorrent` (trimmed, any case) is `production-party`: no token attestation there. */
export function assertVoterTestParty(partyId: unknown): void {
  if (typeof partyId !== 'string' || partyId.trim().length === 0) throw new VoterVerbRefusal('party-missing')
  if (partyId.trim().toLowerCase() === PRODUCTION_PARTY_ID) throw new VoterVerbRefusal('production-party')
}

/** A 32-hex network hash argument; absent or empty is `network-required`, any other shape `bad-arg`. */
export function requireVoterNetworkArg(args: Record<string, unknown>): string {
  const v = args.network
  if (typeof v !== 'string' || v.length === 0) throw new VoterVerbRefusal('network-required')
  if (!/^[0-9a-f]{32}$/.test(v)) throw new VoterVerbRefusal('bad-arg')
  return v
}

/** `performance.now()` based elapsed milliseconds, rounded. */
export function startedNow(): number {
  return performance.now()
}

export function elapsedMs(t0: number): number {
  return Math.round(performance.now() - t0)
}

// ---------------------------------------------------------------------------------------------
// Identity, K_vote, the device id

/** The voter's secp256k1 identity key (signs the registration request); the public half under `.pub`. */
export const VOTER_IDENTITY_ALIAS = 'vt.voter.identity'
/** K_vote: the P-256 key the association request names (67-20's producer, load-or-create, never rotated). */
export const VOTER_KVOTE_ALIAS = 'vt.voter.kvote'
/** The device id, an at-rest secret (`requireUserAuth: false`), created once as `vt-voter-<uuid>`. */
export const VOTER_DEVICE_ID_ALIAS = 'vt.voter.device-id'

const VOTER_USER_NAME = 'vt voter'
/** The app's `getOrCreateDeviceUser` key lifetime. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000
const DEVICE_ID_PREFIX = 'vt-voter-'
const AT_REST_POLICY = Object.freeze({ requireUserAuth: false })
const IDENTITY_CURVE = 'secp256k1' as const

/** The first 16 hex of sha256 over the utf8 key: equality across calls and restarts without returning the key. */
export function deviceKeyTag(publicKeyHex: string): string {
  return createHash('sha256').update(publicKeyHex, 'utf8').digest('hex').slice(0, 16)
}

export interface VoterIdentity {
  /** The compressed secp256k1 public key (= `user.activeKeys[0].key`). */
  readonly key: string
  readonly userId: string
  readonly user: User
}

function isTokenRefused(e: unknown): boolean {
  const err = e as { name?: unknown, code?: unknown } | null | undefined
  return err?.name === 'TokenSignerError' && err.code === 'token-refused'
}

function rethrowTokenRefused(e: unknown): never {
  if (isTokenRefused(e)) throw new VoterVerbRefusal('token-refused', { cause: e })
  throw e
}

/**
 * The stored identity, or null when neither the public user nor the key exists. A user whose key is not
 * the vault's, or one half without the other, is `identity-absent`. Reads no token.
 */
export async function readVoterIdentity(deps: Pick<VoterDeps, 'vault' | 'user'>): Promise<VoterIdentity | null> {
  const user = deps.user()
  const key = await readTokenSigningPublicKey({ vault: deps.vault, alias: VOTER_IDENTITY_ALIAS })
  if (user === null && key === null) return null
  const stored = user?.activeKeys[0]?.key
  if (user === null || key === null || typeof stored !== 'string' || stored !== key) throw new VoterVerbRefusal('identity-absent')
  return { key, userId: user.id, user }
}

/**
 * The identity, provisioned once under the token: a secp256k1 key sealed in the vault and the PUBLIC
 * `User` (random id, one `mobile` key, ten-year expiry: the app's `getOrCreateDeviceUser` shape) saved
 * through the context. With a matching stored pair it returns at once and reads no token.
 */
export async function ensureVoterIdentity(deps: Pick<VoterDeps, 'vault' | 'user' | 'saveUser' | 'now'>, approval: ApprovalContext): Promise<VoterIdentity> {
  const existing = await readVoterIdentity(deps)
  if (existing !== null) return existing
  let publicKey: string
  try {
    publicKey = (await provisionTokenSigningKey({ vault: deps.vault, token: approval, curve: IDENTITY_CURVE, alias: VOTER_IDENTITY_ALIAS })).publicKey
  } catch (e) {
    return rethrowTokenRefused(e)
  }
  const user: User = {
    id: randomUUID(),
    name: VOTER_USER_NAME,
    activeKeys: [{ key: publicKey, type: UserKeyType.mobile, expiration: deps.now() + TEN_YEARS_MS }]
  }
  await deps.saveUser(user)
  return { key: publicKey, userId: user.id, user }
}

/** The at-rest device id, created once; registered windowed in the secret registry on every read. */
export async function ensureVoterDeviceId(deps: Pick<VoterDeps, 'vault' | 'secrets'>): Promise<string> {
  const raw = await deps.vault.getSecret(VOTER_DEVICE_ID_ALIAS)
  if (raw !== null) {
    try {
      return deps.secrets.add(Buffer.from(raw).toString('utf8'), { windows: true })
    } finally {
      raw.fill(0)
    }
  }
  const id = `${DEVICE_ID_PREFIX}${randomUUID()}`
  const bytes = Buffer.from(id, 'utf8')
  try {
    await deps.vault.putSecret(VOTER_DEVICE_ID_ALIAS, bytes, AT_REST_POLICY)
  } catch (e) {
    const code = (e as { name?: unknown, code?: unknown } | null | undefined)?.code
    // a concurrent first read already created it
    if ((e as { name?: unknown } | null | undefined)?.name !== 'KeyVaultError' || code !== 'alias-exists') throw e
    const again = await deps.vault.getSecret(VOTER_DEVICE_ID_ALIAS)
    if (again === null) throw e
    try {
      return deps.secrets.add(Buffer.from(again).toString('utf8'), { windows: true })
    } finally {
      again.fill(0)
    }
  } finally {
    bytes.fill(0)
  }
  return deps.secrets.add(id, { windows: true })
}

// ---------------------------------------------------------------------------------------------
// The deps

/** Engine lookup by name: `network`, `elections`, `association`, `registration`; anything else is `unknown-engine`. */
export type VoterGetEngine = <T>(engineName: string, initParams?: unknown) => Promise<T>

export interface OpenedVoterNetwork {
  readonly getEngine: VoterGetEngine
  /** The shared strand port over the network's database. */
  readonly port: VoterStrandPort
  /** The network hash, which is the staging rows' StrandId. */
  readonly strandId: string
}

export interface VoterDeps {
  readonly partyId: string
  readonly secrets: SecretRegistry
  readonly kv: VoterKv
  readonly attemptStore: RegistrationCeremonyAttemptStore
  readonly lastAttemptStore: VoterLastAttemptStore
  /** The daemon's CadreNode; a verb hands it to the shared join only and reads nothing from it. */
  readonly node: VoterJoinNode
  readonly networksEngine: Pick<INetworksEngine, 'joinFromStrand'>
  readonly joinBootstrapStore: VoterJoinBootstrapWriter
  rememberJoinedNetwork(hash: string): Promise<void>
  /** The three cadre-core functions the shared join requires. */
  readonly cadre: VoterJoinCadre
  /** The per-peer lock key (the context object). */
  readonly lockKey: object
  /** The at-rest device vault; approval-class work goes through 67-20's helpers with the call's token. */
  readonly vault: ApprovalScopedVault
  user(): User | null
  saveUser(user: User): Promise<void>
  now(): number
  /** A read-only producer (NO_APPROVAL): only `getCurrentDeviceKey` is ever called on it. */
  producerForRead(): Promise<VoteSigningProducer>
  openVoterNetwork(hash: string): Promise<OpenedVoterNetwork>
  /** Test seam: the transports over an open network; the daemon leaves it undefined (the peer mirror is used). */
  readonly createTransports?: (strand: CliVoterRequestStrand) => Promise<CliVoterRequestTransports>
}

const ENGINE_NAMES: ReadonlySet<string> = new Set(['network', 'elections', 'association', 'registration'])

interface PerNetwork {
  getEngine: VoterGetEngine
  port: VoterStrandPort
}

/** Per daemon context: the per-network engine sets. The context object is the key; nothing secret is held. */
const perContext = new WeakMap<object, Map<string, PerNetwork>>()

function buildPerNetwork(ctx: VerbContext, est: EngineContext, ref: NetworkReference): PerNetwork {
  const engines = new Map<string, unknown>()
  const getEngine: VoterGetEngine = async <T>(name: string): Promise<T> => {
    if (!ENGINE_NAMES.has(name)) throw new VoterVerbRefusal('unknown-engine')
    let engine = engines.get(name)
    if (engine === undefined) {
      if (name === 'network') engine = new NetworkEngine(ref, ctx.localStorage, est)
      else if (name === 'elections') engine = new ElectionsEngine(est)
      else if (name === 'association') engine = new AssociationEngine(est)
      else engine = new RegistrationEngine(est)
      engines.set(name, engine)
    }
    return engine as T
  }
  return { getEngine, port: createVoterStrandPort(est.db as unknown as Parameters<typeof createVoterStrandPort>[0]) }
}

function isNetworkOpenError(e: unknown): string | undefined {
  const err = e as { name?: unknown, code?: unknown } | null | undefined
  return err?.name === 'NetworkOpenError' && typeof err.code === 'string' ? err.code : undefined
}

/**
 * The deps for one verb call. Everything that touches the node, the engine or the vault is lazy, so a
 * refusal before step 4 of a verb touches nothing.
 */
export function voterDepsFor(ctx: VerbContext, _args: Record<string, unknown>): VoterDeps {
  const stores = ctx.built.stores
  const deps: VoterDeps = {
    partyId: ctx.partyId,
    secrets: ctx.secrets,
    kv: ctx.kv,
    attemptStore: createVoterAttemptStore(ctx.kv),
    lastAttemptStore: createLastAttemptStore(ctx.kv),
    node: ctx.node as unknown as VoterJoinNode,
    // 67-23's RoleNetworksEngineLike declares only open/getEstablishedContext; the engine IS a NetworksEngine.
    networksEngine: ctx.engine() as unknown as Pick<INetworksEngine, 'joinFromStrand'>,
    joinBootstrapStore: stores.joinBootstrap,
    rememberJoinedNetwork: (hash) => stores.joinedNetworks.rememberJoinedNetwork(hash),
    cadre: { decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission },
    lockKey: ctx,
    vault: ctx.device.vault,
    user: () => ctx.user,
    saveUser: (user) => ctx.saveUser(user),
    now: () => Date.now(),
    producerForRead: async () => {
      const deviceId = await ensureVoterDeviceId(deps)
      return createTokenAttestationProducer({ vault: ctx.device.vault, token: NO_APPROVAL, alias: VOTER_KVOTE_ALIAS, deviceId })
    },
    openVoterNetwork: async (hash) => {
      let nets = perContext.get(ctx)
      if (nets === undefined) {
        nets = new Map<string, PerNetwork>()
        perContext.set(ctx, nets)
      }
      let per = nets.get(hash)
      if (per === undefined) {
        let opened
        try {
          opened = await ctx.openNetwork(hash)
        } catch (e) {
          const code = isNetworkOpenError(e)
          if (code === 'user-missing') throw new VoterVerbRefusal('identity-absent', { cause: e })
          if (code !== undefined) throw new VoterVerbRefusal('network-not-open', { cause: e })
          throw e
        }
        per = buildPerNetwork(ctx, opened.est, opened.ref)
        nets.set(hash, per)
      }
      return { getEngine: per.getEngine, port: per.port, strandId: hash }
    }
  }
  return deps
}

/** A verb body over its deps: the unit specs call these directly with fakes. */
export type VoterVerbRun = (deps: VoterDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>

/** The ctl handler over a verb body. */
export function bindVoterVerb(run: VoterVerbRun): VerbHandler<VerbContext> {
  return async (ctx, args) => run(voterDepsFor(ctx, args), args)
}

/**
 * D-45: the registration code, minted by the identity-key signer on the peer route. The Voter's one call
 * (`apps/VoteTorrentVoter/src/engines/continuity.ts` `mintRegistrationCodeForSubmit`, pinned by
 * test/voter-mirror-drift.spec.ts): the association engine derives it; no catch, a rejection propagates.
 */
export async function mintVoterRegistrationCode(getEngine: VoterGetEngine, registrantId: string, sign: SignCallback): Promise<string> {
  const association = await getEngine<RegistrationCodeMinter>('association')
  return association.deriveRegistrationCode(registrantId, sign)
}

/** The association engine's code-derivation slice (`IReassociationEngine.deriveRegistrationCode`). */
export interface RegistrationCodeMinter {
  deriveRegistrationCode(registrantId: string, sign: SignCallback): Promise<string>
}

// ---------------------------------------------------------------------------------------------
// One in-flight voter verb per peer

const inFlight = new WeakMap<object, string>()

/** One voter verb at a time per peer (the attempt store is one record); a second call is `voter-busy`. */
export async function withVoterVerbLock<T>(lockKey: object, verb: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(lockKey)) throw new VoterVerbRefusal('voter-busy')
  inFlight.set(lockKey, verb)
  try {
    return await fn()
  } finally {
    inFlight.delete(lockKey)
  }
}

// ---------------------------------------------------------------------------------------------
// Approval per call

export interface VoterApproval {
  readonly approval: ApprovalContext
  readonly identity: VoterIdentity
  /** The identity signer (secp256k1) for the registration request and the registration code. */
  readonly deviceSign: SignCallback
  /** K_vote's producer under this call's token: `provisionDeviceKey` load-or-create, `produce`, `signDeviceKeyDigest`. */
  readonly producer: VoteSigningProducer
}

export interface WithVoterApprovalOptions {
  /** `join`: provision the identity when there is none (a call with an identity needs this never). */
  provisionIdentity?: boolean
}

/**
 * The approval-class seam: 67-26's `withCallApproval` owns token presence (`token-absent`,
 * `token-ambiguous`, `token-file-not-absolute`, a malformed forwarded token) and disposal. Then the
 * identity (`identity-absent` unless `provisionIdentity`), the preflight `assertTokenSigningKeyHeld` once
 * BEFORE any transport call (`token-refused`), and the signer and producer for this call only. A
 * `TokenSignerError` `token-refused` from inside `fn` becomes `token-refused` too; other codes propagate.
 */
export async function withVoterApproval<T>(
  deps: VoterDeps,
  args: Record<string, unknown>,
  fn: (a: VoterApproval) => Promise<T>,
  opts: WithVoterApprovalOptions = {}
): Promise<T> {
  return withCallApproval(args, async (approval: ApprovalContext) => {
    const vault = deps.vault
    let identity = await readVoterIdentity(deps)
    if (identity === null) {
      if (opts.provisionIdentity !== true) throw new VoterVerbRefusal('identity-absent')
      identity = await ensureVoterIdentity(deps, approval)
    } else {
      try {
        await assertTokenSigningKeyHeld({ vault, token: approval, curve: IDENTITY_CURVE, alias: VOTER_IDENTITY_ALIAS, signerKey: identity.key })
      } catch (e) {
        rethrowTokenRefused(e)
      }
    }
    const deviceId = await ensureVoterDeviceId(deps)
    const deviceSign = createTokenSigner({ vault, token: approval, curve: IDENTITY_CURVE, alias: VOTER_IDENTITY_ALIAS, signerUserId: identity.userId, signerKey: identity.key })
    const producer = createTokenAttestationProducer({ vault, token: approval, alias: VOTER_KVOTE_ALIAS, deviceId })
    try {
      return await fn({ approval, identity, deviceSign, producer })
    } catch (e) {
      return rethrowTokenRefused(e)
    }
  })
}
