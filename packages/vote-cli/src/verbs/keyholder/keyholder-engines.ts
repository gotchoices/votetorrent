// Per-call keyholder engines over ONE open network, the identity-for-election lookup, the unwrap
// meter and the per-peer busy lock. Port of tools/lean-rig/lean/host-kh.ts `getEngine` (the four
// engines over the established context and the lazily built KeysTasksEngine) and of lean-part2.ts
// legAccept/legDkg/legRelease's `authPromptCount` deltas, onto 67-23's daemon context.
//
// Engines are built for THIS call only, over the approval view this call built from its own token
// (`ctx.device.vault.withApproval(approval)`): a view shares the records dir AND the prompt counter
// with the daemon's base vault, so `measureUnwraps` reads the base counter before and after. Nothing
// is cached across calls except the daemon's own open network (`ctx.openNetwork`).
//
// The identity is never an argument: `resolveIdentityForElection` finds it in the sealed identity
// store by the election its slot belongs to, which is what proves the store survived a restart.

import { createHash } from 'node:crypto'
import type { IInvitationEngine, KeyholderDkgStatus, NetworkReference } from '@votetorrent/vote-core'
import type { EngineContext } from '@votetorrent/vote-engine'
import { InvitationEngine, KeyholderDkgEngine, KeyReleaseEngine, KeysTasksEngine, type IKeyVault } from '@votetorrent/vote-engine/rn'
import { listKeyholderIdentities, type KeyholderIdentityRecord, type SeatFacts } from '@votetorrent/workflows/authority'
import type { KeyVaultStorage } from '@votetorrent/workflows/platform'
import type { SecretRegistry } from '../../secrecy/redact.js'
import { KeyholderVerbError, type KeyholderVerb } from './keyholder-args.js'

/** The slice of the daemon's VerbContext the keyholder verbs read (structural; a spec passes a fake). */
export interface KeyholderVerbContext {
  readonly device: {
    readonly vault: IKeyVault & { readonly authPromptCount: number, withApproval(approval: { token(): Promise<Uint8Array> }): IKeyVault }
    readonly storage: KeyVaultStorage
  }
  readonly secrets: SecretRegistry
  openNetwork(hash: string): Promise<{ est: EngineContext, ref: NetworkReference }>
  /** The daemon's crash recorder (redacted, 0600 `crash.jsonl`); a spec's fake may omit it. */
  record?(where: string, err: unknown): void
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// One in-flight keyholder verb per peer

const inFlight = new WeakMap<object, KeyholderVerb>()

/**
 * A second keyholder verb on the same context while one runs refuses `keyholder-busy`; the lock is
 * freed in a finally. Two concurrent drives on one vault would race delete-then-put round secrets
 * into `alias-exists` (RESEARCH Pitfall 7). Keyed by the ctx OBJECT: colocated peers stay independent.
 */
export async function withKeyholderVerbLock<T>(ctx: object, verb: KeyholderVerb, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(ctx)) throw new KeyholderVerbError(verb, 'keyholder-busy')
  inFlight.set(ctx, verb)
  try {
    return await fn()
  } finally {
    inFlight.delete(ctx)
  }
}

// ---------------------------------------------------------------------------------------------
// The unwrap meter

export interface Measured<T> {
  value: T
  unwraps: number
}

/**
 * Reads `baseVault.authPromptCount` before and after `fn` (in a finally). On a throw the delta is
 * attached to the error as a numeric `unwraps` property (a KeyholderVerbError appends it to its
 * message) and the error is rethrown unchanged otherwise.
 */
export async function measureUnwraps<T>(baseVault: { readonly authPromptCount: number }, fn: () => Promise<T>): Promise<Measured<T>> {
  const before = baseVault.authPromptCount
  try {
    const value = await fn()
    return { value, unwraps: baseVault.authPromptCount - before }
  } catch (err) {
    const unwraps = baseVault.authPromptCount - before
    if (typeof err === 'object' && err !== null) {
      if ((err as { name?: unknown }).name === 'KeyholderVerbError') {
        ;(err as KeyholderVerbError).unwraps = unwraps
      } else if (!Object.hasOwn(err, 'unwraps')) {
        try {
          Object.defineProperty(err, 'unwraps', { value: unwraps, enumerable: false, writable: true, configurable: true })
        } catch {
          // a frozen error keeps its shape; the count is lost, the error is not
        }
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Identity by election

type InvitationsSlice = Pick<IInvitationEngine, 'getKeyholderSlotSeat' | 'getKeyholderInvite'>

/**
 * The identity whose seat belongs to `electionId`: `listKeyholderIdentities(storage)` (an empty store
 * returns undefined with NO engine call), then for each record the slot's seat and its invite status;
 * a record counts only when the slot's result is an acceptance invoking that record (the 67-14 accept
 * rule). Several matches -> `identity-ambiguous`.
 */
export async function resolveIdentityForElection(
  storage: KeyVaultStorage,
  invitations: InvitationsSlice,
  electionId: string,
  verb: KeyholderVerb = 'dkg'
): Promise<KeyholderIdentityRecord | undefined> {
  const identities = await listKeyholderIdentities(storage)
  if (identities.length === 0) return undefined
  const matches: KeyholderIdentityRecord[] = []
  for (const identity of identities) {
    const seat = await invitations.getKeyholderSlotSeat(identity.inviteSlotCid)
    if (seat === undefined || seat.electionId !== electionId) continue
    const status = await invitations.getKeyholderInvite(identity.inviteSlotCid)
    const committed = status?.result?.isAccepted === true && status.result.invokedId === identity.userId
    if (committed) matches.push(identity)
  }
  if (matches.length > 1) throw new KeyholderVerbError(verb, 'identity-ambiguous')
  return matches[0]
}

// ---------------------------------------------------------------------------------------------
// The engines of one call

export interface KeyholderEngines {
  est: EngineContext
  ref: NetworkReference
  invitations: InvitationEngine
  dkg: KeyholderDkgEngine
  keyRelease: KeyReleaseEngine
  /** Lazily built (host-kh.ts `getEngine('keysTasksEngine')`). */
  keysTasks(): KeysTasksEngine
  /** The shared drivers' engine lookup: `keyholderDkg`, `invitations`, `keysTasksEngine`. */
  getEngine<T>(name: string): Promise<T>
  /** The accept driver's seat facts (host-kh.ts): the DKG status, or undefined on a throw. */
  readKeyholderSeatFacts(electionId: string): Promise<SeatFacts | undefined>
}

/**
 * Open the network named by the ARGUMENT through the daemon (`ctx.openNetwork`; a missing recent
 * network is `network-not-open`) and build this call's engines over the established context and
 * the call's approval view. Never cached: each call has its own view.
 */
export async function openKeyholderEngines(ctx: KeyholderVerbContext, networkHash: string, vaultView: IKeyVault, verb: KeyholderVerb): Promise<KeyholderEngines> {
  let opened: { est: EngineContext, ref: NetworkReference }
  try {
    opened = await ctx.openNetwork(networkHash)
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
    throw new KeyholderVerbError(verb, code === 'user-missing' ? 'identity-absent' : 'network-not-open')
  }
  const { est, ref } = opened
  const invitations = new InvitationEngine(est)
  const dkg = recordingAdvance(new KeyholderDkgEngine(est, { vault: vaultView }), ctx, verb)
  const keyRelease = new KeyReleaseEngine(est)
  let keysTasks: KeysTasksEngine | undefined
  const engines: KeyholderEngines = {
    est,
    ref,
    invitations,
    dkg,
    keyRelease,
    keysTasks() {
      keysTasks ??= new KeysTasksEngine(ref, est, { vault: vaultView, now: () => Date.now() })
      return keysTasks
    },
    async getEngine<T>(name: string): Promise<T> {
      if (name === 'keyholderDkg') return dkg as unknown as T
      if (name === 'invitations') return invitations as unknown as T
      if (name === 'keysTasksEngine') return engines.keysTasks() as unknown as T
      throw new KeyholderVerbError(verb, 'unknown-engine')
    },
    async readKeyholderSeatFacts(electionId: string) {
      try {
        const s: KeyholderDkgStatus = await dkg.getDkgStatus(electionId)
        return { revision: s.revision, liveRoster: s.liveRoster, earlierRevisionUserIds: s.earlierRevisionUserIds }
      } catch {
        return undefined
      }
    }
  }
  return engines
}

/**
 * The shared DKG driver reports a drive failure as a code only (`unknown` for a code-less engine
 * error), so the engine error itself is recorded here, redacted, in the daemon's crash.jsonl before
 * the driver sees it: diagnosable without a message ever reaching a reply.
 */
function recordingAdvance(dkg: KeyholderDkgEngine, ctx: KeyholderVerbContext, verb: KeyholderVerb): KeyholderDkgEngine {
  if (ctx.record === undefined) return dkg
  const record = ctx.record.bind(ctx)
  return new Proxy(dkg, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'advanceDkg' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          } catch (e) {
            record(`verb.${verb}.advanceDkg`, e)
            throw e
          }
        }
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
}

/** The first 16 hex chars of sha256 over the utf8 joint public key: comparable, never the 64-hex key itself. */
export function jointKeyTag(jointPublicKey: string): string {
  return createHash('sha256').update(jointPublicKey, 'utf8').digest('hex').slice(0, 16)
}

/** The timeline column of the election's latest revision, parsed, or null. Bind names: `:electionId` only. */
export async function readElectionTimeline(est: EngineContext, electionId: string): Promise<unknown> {
  for await (const row of est.db.eval('select Timeline as tl from ElectionRevision where ElectionId = :electionId order by Revision desc', { electionId })) {
    const tl = (row as { tl?: unknown }).tl
    if (typeof tl === 'string') {
      try {
        return JSON.parse(tl)
      } catch {
        return null
      }
    }
    return tl ?? null
  }
  return null
}

/** This keyholder's DKG message count. Bind names: `:electionId`, `:userId`. */
export async function countOwnDkgMessages(est: EngineContext, electionId: string, userId: string): Promise<number> {
  for await (const row of est.db.eval('select count(*) as n from KeyholderDkgMessage where ElectionId = :electionId and SenderUserId = :userId', { electionId, userId })) {
    return Number((row as { n?: unknown }).n ?? 0)
  }
  return 0
}
