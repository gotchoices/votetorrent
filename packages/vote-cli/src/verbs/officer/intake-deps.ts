// The officer INTAKE verbs' context adapter (67-27): the ONLY file of the intake group that names
// daemon-context members (67-23 `VerbContext` through 67-24's `OfficerVerbContext`). It gives the five
// verbs their engines by name (`intake`, `registration`, `signatureTasksEngine`, `association`), the
// staging transports over the shared strand-port adapter, the at-rest intake vault, the token preflight
// and signer over 67-26's per-call approval, the refusal class, the party gate and the argument parsers.
//
// The network hash and the primary authority id (8 hex, as `vt officer authority-id` reports it) are
// verb ARGUMENTS (`network`, `authority`), as every officer verb takes them since 67-24; nothing is
// memoized across networks except the per-context engine map below, keyed by the context object so
// colocated peers never share an engine (RESEARCH Pitfall 4). The map holds no secret.
//
// The one AssociationEngine construction of this package is here, built over the 67-20 composer through
// `buildOfficerAssociationVerifier(posture)`: posture `token` only on a non-production party with the
// start flag, posture `production` otherwise. No console, no process.env, no instanceof.

import { AssociationEngine, IntakeEngine, RegistrationEngine, SignatureTasksEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext, StagingDecisionSigner, StagingOpener } from '@votetorrent/vote-engine/rn'
import type { VerbHandler } from '../../ctl/protocol.js'
import { canonicalizeVerificationChecklist, type RegistrationVerificationChecklistItem } from '@votetorrent/vote-core'
import type { NetworkReference } from '@votetorrent/vote-core'
import { createPeerStagingTransports, createStrandPort, type PeerStagingTransports, type StrandSqlDatabase } from '@votetorrent/workflows/authority'
import type { SignCallback } from '@votetorrent/workflows/platform'
import { assertTokenSigningKeyHeld, createTokenSigner, type ApprovalScopedVault } from '../../approval/signer.js'
import type { ApprovalContext } from '../../approval/token.js'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import { PRODUCTION_PARTY_ID } from '../../attestation/marker.js'
import {
  buildOfficerAssociationVerifier,
  officerAttestationPosture,
  type AttestationPolicyDb,
  type AttestationVerdictCounts,
  type OfficerAttestationPosture
} from '../../attestation/policy.js'
import { AUTHORITY_SIGNING_ALIAS, loadAuthorityUser } from '../../network/authority-user.js'
import {
  officerEngine,
  parseAuthorityId8,
  parseNetworkHash,
  resolvePrimaryAuthority,
  type OfficerVerbContext
} from '../../network/network-verb-support.js'

// ---------------------------------------------------------------------------------------------
// The refusal

export type IntakeRefusalCode =
  | 'bad-arg'
  | 'party-missing'
  | 'production-party'
  | 'authority-required'
  | 'network-required'
  | 'request-required'
  | 'status-invalid'
  | 'checklist-required'
  | 'checklist-invalid'
  | 'checklist-incomplete'
  | 'reason-required'
  | 'token-refused'
  | 'request-not-found'
  | 'blocked'
  | 'policy-skips-verification'
  | 'intake-not-enabled'
  | 'unknown-engine'
  | 'network-unavailable'
  | 'identity-absent'

/**
 * The token-presence codes (`token-absent`, `token-ambiguous`, `token-file-not-absolute`) are 67-26's
 * `ApprovalRefusal` and pass through unchanged; they are not in this list.
 */
export const INTAKE_REFUSAL_CODES: readonly IntakeRefusalCode[] = Object.freeze([
  'bad-arg',
  'party-missing',
  'production-party',
  'authority-required',
  'network-required',
  'request-required',
  'status-invalid',
  'checklist-required',
  'checklist-invalid',
  'checklist-incomplete',
  'reason-required',
  'token-refused',
  'request-not-found',
  'blocked',
  'policy-skips-verification',
  'intake-not-enabled',
  'unknown-engine',
  'network-unavailable',
  'identity-absent'
])

const BLOCKER_RE = /^[a-z][a-z0-9-]{0,40}$/

export interface IntakeVerbRefusalOptions {
  /** Fixed 67-18 blocker codes; anything that is not a closed-set token is dropped. */
  blockers?: readonly string[]
  cause?: unknown
}

/** `name` is 67-26's `VerbRefusal`, so the ctl error view and the client treat both groups' refusals alike. */
export class IntakeVerbRefusal extends Error {
  readonly code: IntakeRefusalCode
  readonly blockers: string[] | undefined

  constructor(code: IntakeRefusalCode, opts: IntakeVerbRefusalOptions = {}) {
    const blockers = opts.blockers?.filter((b) => typeof b === 'string' && BLOCKER_RE.test(b))
    const tail = code === 'blocked' && blockers !== undefined && blockers.length > 0 ? `blocked: ${blockers.join(',')}` : code
    super(`intake verb refused (${tail})`)
    this.name = 'VerbRefusal'
    this.code = code
    this.blockers = blockers === undefined ? undefined : [...blockers]
    if (opts.cause !== undefined) Object.defineProperty(this, 'cause', { value: opts.cause, enumerable: false, writable: true, configurable: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments and the party gate

/** The colocation label 67-21 adds; the daemon strips it, a direct caller may still pass it. */
const PEER_KEY = 'peer'

const APPROVAL_KEYS: ReadonlySet<string> = new Set<string>(CALL_APPROVAL_ARG_KEYS)

/**
 * Allow-list the verb's arguments: every own key must be in `allowed` (or be `peer`), else `bad-arg`;
 * a value that is neither a string nor a boolean is `bad-arg` too. Returns a shallow copy without
 * `peer` and without the approval keys (those stay on the ORIGINAL args object, which is what
 * `withCallApproval` reads and deletes the forwarded token from). Nothing here echoes a key or a value.
 */
export function pickIntakeArgs(args: Record<string, unknown>, allowed: readonly string[]): Record<string, string | boolean> {
  const set = new Set<string>(allowed)
  const out: Record<string, string | boolean> = {}
  for (const key of Object.keys(args)) {
    if (key === PEER_KEY) continue
    if (!set.has(key)) throw new IntakeVerbRefusal('bad-arg')
    const v = args[key]
    if (typeof v !== 'string' && typeof v !== 'boolean') throw new IntakeVerbRefusal('bad-arg')
    if (APPROVAL_KEYS.has(key)) continue
    out[key] = v
  }
  return out
}

/** `select count(*) as n ...` coerced with Number (Quereus integer columns read back as bigint or number). */
export async function countRows(db: EngineContext['db'], sql: string): Promise<number> {
  const row = await db.prepare(sql).get()
  return Number((row as { n?: unknown } | undefined)?.n ?? 0)
}

/** This plan's own copy of the rule (coordinator decision): empty is `party-missing`, `votetorrent` (trimmed, any case) is `production-party`. */
export function assertIntakeTestParty(partyId: unknown): void {
  if (typeof partyId !== 'string' || partyId.trim().length === 0) throw new IntakeVerbRefusal('party-missing')
  if (partyId.trim().toLowerCase() === PRODUCTION_PARTY_ID) throw new IntakeVerbRefusal('production-party')
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** The 8-hex primary authority id (what `vt officer authority-id` reports); its shape is 67-24's `bad-authority-id8`. */
export function requireAuthorityArg(args: Record<string, unknown>): string {
  const v = args.authority
  if (!nonEmptyString(v)) throw new IntakeVerbRefusal('authority-required')
  return parseAuthorityId8(v)
}

/** The 32-hex network hash; its shape is 67-24's `bad-network-hash`. */
export function requireNetworkArg(args: Record<string, unknown>): string {
  const v = args.network
  if (!nonEmptyString(v)) throw new IntakeVerbRefusal('network-required')
  return parseNetworkHash(v)
}

export function requireRequestArg(args: Record<string, unknown>): string {
  const v = args.request
  if (!nonEmptyString(v)) throw new IntakeVerbRefusal('request-required')
  return v
}

/**
 * `checklist` is a comma list of D-07 items (`id`, `roll`, `eligibility`, `none`): split, trimmed,
 * empties dropped; nothing left is `checklist-required`, an unknown item is `checklist-invalid`
 * (vote-core's canonicalizer throws). The canonical array is what the verbs gate and sign.
 */
export function parseChecklistArg(args: Record<string, unknown>): RegistrationVerificationChecklistItem[] {
  const v = args.checklist
  if (typeof v !== 'string') throw new IntakeVerbRefusal('checklist-required')
  const items = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (items.length === 0) throw new IntakeVerbRefusal('checklist-required')
  try {
    return canonicalizeVerificationChecklist(items)
  } catch (e) {
    throw new IntakeVerbRefusal('checklist-invalid', { cause: e })
  }
}

// ---------------------------------------------------------------------------------------------
// The deps

/** Engine lookup by name, the shape 67-09 and 67-18 take. */
export type IntakeGetEngine = <T>(engineName: string) => Promise<T>

/** The opened network the verbs read and write through. */
export interface IntakeNetwork {
  /** The strand database (the engine context's `db`); it satisfies `AttestationPolicyDb` structurally. */
  readonly db: EngineContext['db']
  /** The FULL primary authority id: internal to the daemon, never put in a reply. */
  readonly authorityId: string
  /** The network hash, which is the staging transports' `strandId`. */
  readonly strandId: string
}

export interface IntakeOfficer {
  readonly userId: string
  /** The compressed secp256k1 public key the officer signs with. */
  readonly signerKey: string
}

export interface IntakeDeps {
  readonly partyId: string
  /** Derived lazily from the context's flag and party; `production-party` / `party-missing` throw on first read. */
  readonly posture: OfficerAttestationPosture
  /** Opens (cache-first) the network named by `network`, resolves the authority named by `authority`. */
  open(): Promise<IntakeNetwork>
  /** `intake`, `registration`, `signatureTasksEngine`, `association`; anything else is `unknown-engine`. */
  readonly getEngine: IntakeGetEngine
  /** The association verifier's verdict counters (zero until `association` is built). */
  attestationCounts(): AttestationVerdictCounts
  /** The at-rest device vault: intake keys are non-approval secrets (CONTEXT "Vault keys"). */
  readonly intakeVault: ApprovalScopedVault
  /** 67-09's transport factory over the shared strand port; the strand opens lazily on first use. */
  createTransports(t: { opener: StagingOpener, decisionSigner: StagingDecisionSigner }): PeerStagingTransports
  /** The provisioned officer identity (`identity-absent` before `found`/`join`). */
  officer(): Promise<IntakeOfficer>
}

interface EngineSet {
  ec: EngineContext
  ref: NetworkReference
  engines: Map<string, unknown>
}

interface PerNetwork {
  getEngine: IntakeGetEngine
  attestationCounts(): AttestationVerdictCounts
  open(): Promise<IntakeNetwork>
}

const ENGINE_NAMES: ReadonlySet<string> = new Set(['intake', 'registration', 'signatureTasksEngine', 'association'])

/** Per daemon context: the per-network engine sets. The context object is the key; nothing secret is held. */
const perContext = new WeakMap<object, Map<string, PerNetwork>>()

function networkKey(args: Record<string, unknown>): string {
  const n = args.network
  const a = args.authority
  return `${typeof n === 'string' ? n : ''}/${typeof a === 'string' ? a : ''}`
}

function buildPerNetwork(ctx: OfficerVerbContext, args: Record<string, unknown>, postureOf: () => OfficerAttestationPosture): PerNetwork {
  let opened: Promise<IntakeNetwork & EngineSet> | undefined
  let built: ReturnType<typeof buildOfficerAssociationVerifier> | undefined
  const zero = Object.freeze({ token: Object.freeze({ accepted: 0, refused: 0 }), platform: Object.freeze({ accepted: 0, refused: 0 }) })

  const openOnce = (): Promise<IntakeNetwork & EngineSet> => {
    if (opened !== undefined) return opened
    const pending = (async (): Promise<IntakeNetwork & EngineSet> => {
      const networkHash = requireNetworkArg(args)
      const authorityId8 = requireAuthorityArg(args)
      const resolved = await resolvePrimaryAuthority(ctx, { networkHash, authorityId8 })
      const engine = officerEngine(ctx)
      const ec = engine.getEstablishedContext(networkHash)
      const ref = (await engine.getRecentNetworks()).find((r) => r.hash === networkHash)
      if (ec === undefined || ref === undefined) throw new IntakeVerbRefusal('network-unavailable')
      // The apps' factory and the rig set the officer's opener on the SHARED established context, so
      // sealed registration content reads as `opened` once the officer holds an intake key.
      if (ec.intakeOpener === undefined && ec.user !== undefined) {
        ec.intakeOpener = new IntakeEngine(ec).createOpener(ctx.device.vault)
      }
      return { db: ec.db, authorityId: resolved.authorityId, strandId: networkHash, ec, ref, engines: new Map<string, unknown>() }
    })()
    opened = pending
    pending.catch(() => {
      if (opened === pending) opened = undefined
    })
    return pending
  }

  const getEngine: IntakeGetEngine = async <T>(name: string): Promise<T> => {
    if (!ENGINE_NAMES.has(name)) throw new IntakeVerbRefusal('unknown-engine')
    // The posture is read before the network opens, so a composition that may not exist (`token` on the
    // production party) throws here and never constructs an engine.
    const posture = postureOf()
    const net = await openOnce()
    let engine = net.engines.get(name)
    if (engine === undefined) {
      if (name === 'intake') engine = new IntakeEngine(net.ec)
      else if (name === 'registration') engine = new RegistrationEngine(net.ec)
      else if (name === 'signatureTasksEngine') engine = new SignatureTasksEngine(net.ref, net.ec)
      else {
        built ??= buildOfficerAssociationVerifier({ posture })
        engine = new AssociationEngine(net.ec, built.verifier)
      }
      net.engines.set(name, engine)
    }
    return engine as T
  }

  return {
    getEngine,
    attestationCounts: () => (built === undefined ? zero : built.counts()),
    open: async () => {
      const net = await openOnce()
      return { db: net.db, authorityId: net.authorityId, strandId: net.strandId }
    }
  }
}

/**
 * The deps for one verb call. The engine set is built once per (context, network, authority) and kept
 * in a module-level WeakMap keyed by the context object; everything that touches the node or the
 * engine is lazy, so a refusal before step 4 of a verb touches nothing.
 */
export function intakeDepsFor(ctx: OfficerVerbContext, args: Record<string, unknown>): IntakeDeps {
  let nets = perContext.get(ctx)
  if (nets === undefined) {
    nets = new Map<string, PerNetwork>()
    perContext.set(ctx, nets)
  }
  let posture: OfficerAttestationPosture | undefined
  const postureOf = (): OfficerAttestationPosture => {
    posture ??= officerAttestationPosture({ acceptTokenAttestations: ctx.acceptTokenAttestations, partyId: ctx.partyId })
    return posture
  }
  const key = networkKey(args)
  let per = nets.get(key)
  if (per === undefined) {
    per = buildPerNetwork(ctx, args, postureOf)
    nets.set(key, per)
  }
  const perNet = per
  const strandId = typeof args.network === 'string' ? args.network : ''
  return {
    partyId: ctx.partyId,
    get posture() {
      return postureOf()
    },
    open: perNet.open,
    getEngine: perNet.getEngine,
    attestationCounts: perNet.attestationCounts,
    intakeVault: ctx.device.vault,
    createTransports: (t) =>
      createPeerStagingTransports({
        strandId,
        // The Quereus Database satisfies the adapter's `{ eval, exec }` slice at runtime (the apps and the rig
        // hand it the same handle); the cast bridges its wider parameter unions under strictFunctionTypes.
        openStrand: async () => createStrandPort((await perNet.open()).db as unknown as StrandSqlDatabase),
        opener: t.opener,
        decisionSigner: t.decisionSigner
      }),
    officer: async () => {
      const user = await loadAuthorityUser(ctx)
      const key = user?.activeKeys[0]?.key
      if (user === null || typeof key !== 'string') throw new IntakeVerbRefusal('identity-absent')
      return { userId: user.id, signerKey: key }
    }
  }
}

/** A verb body over its deps: the unit specs call these directly with fakes. */
export type IntakeVerbRun = (deps: IntakeDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>

export type IntakeDepsFor = (ctx: OfficerVerbContext, args: Record<string, unknown>) => IntakeDeps

/** The ctl handler over a verb body; `depsFor` is the test seam (defaults to `intakeDepsFor`). */
export function bindIntakeVerb(run: IntakeVerbRun, depsFor: IntakeDepsFor = intakeDepsFor): VerbHandler<OfficerVerbContext> {
  return async (ctx, args) => run(depsFor(ctx, args), args)
}

// ---------------------------------------------------------------------------------------------
// Approval per call

export interface IntakeApproval {
  readonly approval: ApprovalContext
  readonly sign: SignCallback
}

const CURVE = 'secp256k1' as const

function isTokenRefused(e: unknown): boolean {
  const err = e as { name?: unknown, code?: unknown } | null | undefined
  return err?.name === 'TokenSignerError' && err.code === 'token-refused'
}

/**
 * The approval-class seam: 67-26's `withCallApproval` owns token presence (`token-absent`,
 * `token-ambiguous`, `token-file-not-absolute`, a malformed forwarded token) and disposal; this adds the
 * officer preflight (`assertTokenSigningKeyHeld` once, BEFORE any engine call, so a bad token never
 * leaves a partial write) and the 67-20 token signer. A `TokenSignerError` `token-refused` from the
 * preflight or from inside `fn` becomes `IntakeVerbRefusal('token-refused')`; every other code propagates.
 */
export async function withIntakeApproval<T>(deps: IntakeDeps, args: Record<string, unknown>, fn: (a: IntakeApproval) => Promise<T>): Promise<T> {
  return withCallApproval(args, async (approval: ApprovalContext) => {
    const officer = await deps.officer()
    const vault = deps.intakeVault
    try {
      await assertTokenSigningKeyHeld({ vault, token: approval, curve: CURVE, alias: AUTHORITY_SIGNING_ALIAS, signerKey: officer.signerKey })
    } catch (e) {
      if (isTokenRefused(e)) throw new IntakeVerbRefusal('token-refused', { cause: e })
      throw e
    }
    const sign = createTokenSigner({ vault, token: approval, curve: CURVE, alias: AUTHORITY_SIGNING_ALIAS, signerUserId: officer.userId, signerKey: officer.signerKey })
    try {
      return await fn({ approval, sign })
    } catch (e) {
      if (isTokenRefused(e)) throw new IntakeVerbRefusal('token-refused', { cause: e })
      throw e
    }
  })
}
