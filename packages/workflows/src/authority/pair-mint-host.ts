/**
 * pair-mint-host.ts — the owner side of `/votetorrent/pair-mint/1.0.0` (D-22, D-26, D-28).
 *
 * Moved from `apps/VoteTorrentAuthority/src/engines/pair-mint-host.ts` (phase 67 plan 17); that app path
 * is now a binding. Every platform dependency is a REQUIRED member of {@link PairMintHostInput}: the own
 * open-network reader, the mint switch, the mint log, the revocation store (the app's pairing-owner store,
 * the CLI's own) and cadre-core's invitation encoder. The app binding and the vt CLI each supply their own;
 * cadre-core is never imported here (its import-only `exports` cannot load in the app's jest environment),
 * and `readActiveNetworkHash` takes the caller's key-value store as a parameter. The vote-engine verifiers
 * and the shared strand-change hub are the defaults, read only inside the functions.
 *
 * A current officer whose phone is a cadre member but not an owner asks an owner phone for ONE single-use
 * cadre invitation, so the officer's browser can join the cadre (D-22, D-26). This module binds the
 * vote-engine service's ports (`createPairMintService`, 66-03) to this device's cadre-core node and to the
 * owner's own strand database, and serves it on the control node. It runs on owner devices only
 * ({@link startPairMintHost}), best effort: the provider never awaits it and a failure never fails boot.
 *
 * D-28: the owner approves automatically, records every member request's outcome in its mint log
 * and honours its off switch for MINTS only; a remove request is never gated.
 * The caller's `isEnabled` decides what an unreadable switch means (the app reads it as OFF: fail closed).
 *
 * Own-network rule (T-66-03-12): every statement, remove request and current-officer check is verified
 * against the network this device's app has open (`recentNetworks[0]`, the strand database of that hash),
 * never against the request's `networkHash`. A statement signed for another network therefore fails its
 * signature check here, and an owner of two networks can never be talked into minting for the wrong one.
 * No open network means every check fails closed.
 *
 * R-A: `handleLocal` (the owner pairing its own browser) calls the same service with this device's own
 * identity peer id as the caller, so the statement's `requesterPeerId` must be that id.
 * R-B: the current-officer check is `isCurrentPairingOfficer` on the owner's strand database, at the
 * owner's clock.
 *
 * Nothing here writes a strand row: the strand database is only read through vote-engine's verifiers, and
 * the invitation lives only in the reply frame (never logged, stored or put in an error). The only log
 * line is the revocation sweep's one warn per failed sweep, naming the error class only.
 *
 * R-D (D-27 removal enforced by the minting owner): the host also watches `DashboardPairingRevocation`
 * (on start, on the strand-change signal for that table and on its 60 s backstop). It matches ONLY
 * this owner's own approved mint-log entries, each by a `(UserId, Nonce)` primary-key point lookup on its
 * own strand database, never a scan of other owners' pairings. A forged row cannot act: the schema's
 * insert CHECK requires a signature by a non-expired `UserKey` of that `UserId`, and a row that matches no
 * approved entry of this owner does nothing. A matched pairing whose invitation was redeemed has its
 * machine (the `CadreInviteUsage` identity peer id) removed with `removeMachine`; a never-redeemed one is
 * withdrawn (`withdrawCadreInvitation`) and stops counting as a live mint, and stays watched until its
 * expiry plus a grace, in case a redemption raced the withdrawal. Already-gone, `not-an-owner` and `self`
 * are final; any other failure is retried by the next sweep. Each entry is acted on once (the outcome is
 * marked on its log entry). Not gated by the off switch. At most {@link REVOCATION_SWEEP_MAX_LOOKUPS}
 * lookups and {@link REVOCATION_SWEEP_MAX_ACTIONS} actions per sweep, one sweep at a time. The wire
 * `remove` op stays served (harness and owner-local use).
 */
import type {
  PairMintLibp2pLike,
  PairMintLogEntry,
  PairMintMintRequest,
  PairMintPorts,
  PairMintRemoveRequest,
  PairMintReply,
  PairMintRequest,
  PairingVerifyResult,
} from '@votetorrent/vote-engine/rn'
import {
  attachPairMint,
  createPairMintService,
  isCurrentPairingOfficer,
  isPairingRevoked,
  verifyPairingRemove,
  verifyPairingStatement,
} from '@votetorrent/vote-engine/rn'
import type { KvStorage } from '../platform/storage.js'
import { strandChanges } from '../common/strand-changes.js'
import { createPairingInvitation, inviteExpiryMs, PairingInviteError, voterInviteCapability } from './voter-invite.js'
import type { InvitationEncoder, PairingInviteNode } from './voter-invite.js'

type OwnDb = Parameters<typeof verifyPairingStatement>[0]

/** NetworksEngine's persisted recent-networks key: read here (through the caller's store), never written. */
export const ACTIVE_NETWORKS_KEY = 'recentNetworks'

/** The revocation table, qualified as the strand-change hub expects it. */
export const REVOCATION_TABLE = 'App.DashboardPairingRevocation'
/** The hub's backstop for the revocation subscription: the periodic tick (no timer of our own). */
export const REVOCATION_BACKSTOP_MS = 60_000
/** Point lookups per sweep; the rest wait for the next sweep (round-robin cursor). */
export const REVOCATION_SWEEP_MAX_LOOKUPS = 200
/** remove / withdraw calls per sweep. */
export const REVOCATION_SWEEP_MAX_ACTIONS = 10

/** What the owner's revocation sweep (R-D) did for an approved entry. Only `withdrawn` is not final. */
export const REVOCATION_RESULTS = Object.freeze(['removed', 'gone', 'not-owner', 'refused', 'withdrawn', 'expired'] as const)
export type RevocationResult = (typeof REVOCATION_RESULTS)[number]

/** A withdrawn code stays a candidate this long past its expiry: a redemption may have raced the withdrawal. */
export const REVOCATION_GRACE_MS = 10 * 60_000

/** The stored mint-log entry: the service's six fields plus the sweep's mark (approved entries only). */
export type OwnerMintLogEntry = PairMintLogEntry & { revocation?: { result: RevocationResult; at: number } }

export type RevocationAction = { kind: 'remove'; nonce: string; peerId: string } | { kind: 'withdraw'; nonce: string; inviteKey: string }

/**
 * The R-D matching rule, pure (no I/O, no clock, no node). Per revocation row: the APPROVED mint-log entry
 * with a key whose nonce AND officer both equal the row's. None, or one already carrying a final mark: no
 * action. A usage row for its invitation key: remove that machine (for an unmarked entry, and for a
 * withdrawn one until its expiry plus the grace). No usage row: withdraw an unmarked entry; nothing for a
 * withdrawn one. One action per entry, at most `maxActions`, in row order.
 */
export function planRevocationActions(
  rows: ReadonlyArray<{ userId: string; nonce: string }>,
  mintLog: ReadonlyArray<OwnerMintLogEntry>,
  usage: ReadonlyArray<{ inviteKey: string; peerId: string }>,
  opts: { nowMs: number; maxActions: number },
): RevocationAction[] {
  const actions: RevocationAction[] = []
  const planned = new Set<OwnerMintLogEntry>()
  for (const row of rows) {
    if (actions.length >= opts.maxActions) break
    const entry = mintLog.find(
      (e) => e.outcome === 'approved' && typeof e.inviteKey === 'string' && e.inviteKey.length > 0 && e.nonce === row.nonce && e.userId === row.userId,
    )
    if (!entry || planned.has(entry)) continue
    const inviteKey = entry.inviteKey as string
    const mark = entry.revocation?.result
    if (mark !== undefined && mark !== 'withdrawn') continue
    const redeemed = usage.find((u) => u.inviteKey === inviteKey)
    if (mark === 'withdrawn') {
      const expiry = inviteExpiryMs(entry.expiresAt)
      if (!redeemed || expiry === null || expiry + REVOCATION_GRACE_MS <= opts.nowMs) continue
      planned.add(entry)
      actions.push({ kind: 'remove', nonce: entry.nonce, peerId: redeemed.peerId })
      continue
    }
    planned.add(entry)
    actions.push(redeemed ? { kind: 'remove', nonce: entry.nonce, peerId: redeemed.peerId } : { kind: 'withdraw', nonce: entry.nonce, inviteKey })
  }
  return actions
}

/**
 * The hash of the network this device's app has open: `recentNetworks[0].hash` in the caller's key-value
 * store. `NetworksEngine.open()` moves the opened network to index 0 and AppProvider re-attaches index 0
 * at boot, so the first entry is the active network. Null when absent, malformed, empty or longer than
 * 128 chars; never throws.
 */
export async function readActiveNetworkHash(kv: KvStorage): Promise<string | null> {
  try {
    const raw = await kv.getItem(ACTIVE_NETWORKS_KEY)
    if (raw === null) return null
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list) || list.length === 0) return null
    const first = list[0] as { hash?: unknown } | null
    const hash = first?.hash
    return typeof hash === 'string' && hash.length > 0 && hash.length <= 128 ? hash : null
  } catch {
    return null
  }
}

/** The slice of a cadre-core `CadreNode` the host needs (the real class satisfies it). */
export interface PairMintHostNode extends PairingInviteNode {
  getControlNode(): unknown
  /** cadre-core resolves this asynchronously. */
  isAuthorizedMember(peerId: string): boolean | Promise<boolean>
  removeMachine(peerId: string): Promise<unknown>
  withdrawCadreInvitation(key: string): Promise<boolean>
  getStrand(strandId: string): { database?: { getDatabase(): unknown } } | undefined
  getControlDatabase():
    | (NonNullable<ReturnType<PairingInviteNode['getControlDatabase']>> & {
        queryCadreInviteUsages(retry?: boolean): Promise<ReadonlyArray<{ inviteKey: string; peerId: string }>>
      })
    | null
}

/** The owner's mint-log side of revocation (the app's pairing-owner store, or the CLI's own), structural. */
export interface PairMintRevocationStore {
  listRevocationCandidates(nowMs: number): Promise<OwnerMintLogEntry[]>
  markMintRevocation(nonce: string, mark: { result: RevocationResult; at: number }): Promise<boolean>
}

export interface PairMintHostDeps {
  readOwnNetworkHash(): Promise<string | null>
  isEnabled(): Promise<boolean>
  now(): number
  mintLog: PairMintPorts['mintLog']
  verifiers: {
    verifyPairingStatement: typeof verifyPairingStatement
    verifyPairingRemove: typeof verifyPairingRemove
    isCurrentPairingOfficer: typeof isCurrentPairingOfficer
    isPairingRevoked: typeof isPairingRevoked
  }
  /** Call `listener` when the revocation table may have changed; returns the unsubscribe. */
  subscribeRevocations(listener: () => Promise<void>): () => void
  revocationStore: PairMintRevocationStore
  /** cadre-core's `encodeCadreInvitation`, used when a minted invitation drops an edge reader. */
  encodeInvitation: InvitationEncoder
}

/** What an app caller may override over its platform defaults; nested groups merge over the defaults. */
export type PairMintHostOverrides = Partial<Omit<PairMintHostDeps, 'verifiers' | 'revocationStore' | 'encodeInvitation'>> & {
  verifiers?: Partial<PairMintHostDeps['verifiers']>
  revocationStore?: Partial<PairMintHostDeps['revocationStore']>
}

/**
 * What a caller passes to {@link hostPairMint} / {@link startPairMintHost}: the platform members are
 * required (no default), the clock, the verifiers and the revocation subscription are optional.
 */
export type PairMintHostInput = Pick<PairMintHostDeps, 'readOwnNetworkHash' | 'isEnabled' | 'mintLog' | 'revocationStore' | 'encodeInvitation'> & {
  now?: PairMintHostDeps['now']
  verifiers?: Partial<PairMintHostDeps['verifiers']>
  subscribeRevocations?: PairMintHostDeps['subscribeRevocations']
}

export interface PairMintHost {
  /** Idempotent: stops the revocation watch, removes the protocol handler and closes the service. */
  detach(): Promise<void>
  /** The owner's own request (its browser), with this device's identity peer id as the caller. */
  handleLocal(request: PairMintRequest): Promise<PairMintReply>
  /** One revocation sweep (single flight; a call during a sweep queues one more). Never rejects. */
  sweepRevocations(): Promise<void>
}

/** The shared strand-change hub's revocation-table subscription (the default `subscribeRevocations`). */
function subscribeToRevocationTable(listener: () => Promise<void>): () => void {
  return strandChanges.subscribe([REVOCATION_TABLE], listener, { label: 'pair-revocation', backstopMs: REVOCATION_BACKSTOP_MS })
}

/** The 19-char canonical UTC form vote-engine's `toCanonicalDatetime` gives for a number. */
function canonicalAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

function requirePlatform(input: unknown): asserts input is PairMintHostInput {
  const i = input as Partial<PairMintHostInput> | null | undefined
  if (
    i === null ||
    i === undefined ||
    typeof i.readOwnNetworkHash !== 'function' ||
    typeof i.isEnabled !== 'function' ||
    typeof i.encodeInvitation !== 'function' ||
    typeof i.mintLog !== 'object' ||
    i.mintLog === null ||
    typeof i.revocationStore?.listRevocationCandidates !== 'function' ||
    typeof i.revocationStore?.markMintRevocation !== 'function'
  ) {
    throw new TypeError('pair-mint-host: platform dependencies are required')
  }
}

function resolveDeps(input: PairMintHostInput): PairMintHostDeps {
  return {
    readOwnNetworkHash: input.readOwnNetworkHash,
    isEnabled: input.isEnabled,
    now: input.now ?? (() => Date.now()),
    mintLog: input.mintLog,
    verifiers: {
      verifyPairingStatement: input.verifiers?.verifyPairingStatement ?? verifyPairingStatement,
      verifyPairingRemove: input.verifiers?.verifyPairingRemove ?? verifyPairingRemove,
      isCurrentPairingOfficer: input.verifiers?.isCurrentPairingOfficer ?? isCurrentPairingOfficer,
      isPairingRevoked: input.verifiers?.isPairingRevoked ?? isPairingRevoked,
    },
    subscribeRevocations: input.subscribeRevocations ?? subscribeToRevocationTable,
    revocationStore: {
      listRevocationCandidates: input.revocationStore.listRevocationCandidates,
      markMintRevocation: input.revocationStore.markMintRevocation,
    },
    encodeInvitation: input.encodeInvitation,
  }
}

/**
 * Serve the pair-mint service on `node`'s control node. Rejects with a TypeError when `input` lacks a
 * platform member (before any node read), and otherwise when the node has no peer id or control node.
 */
export async function hostPairMint(node: PairMintHostNode, input: PairMintHostInput): Promise<PairMintHost> {
  requirePlatform(input)
  const self = node.peerId?.toString()
  if (!self) throw new Error('pair-mint: this device has no peer id yet')
  const control = node.getControlNode() as PairMintLibp2pLike | null | undefined
  if (control === null || control === undefined) throw new Error('pair-mint: the control node is not running')
  const deps = resolveDeps(input)

  /** The owner's own open network and its strand database, or null (every check then fails closed). */
  async function ownNetwork(): Promise<{ networkHash: string; db: OwnDb } | null> {
    try {
      const networkHash = await deps.readOwnNetworkHash()
      if (!networkHash) return null
      const db = node.getStrand(networkHash)?.database?.getDatabase()
      if (db === null || db === undefined) return null
      return { networkHash, db: db as OwnDb }
    } catch {
      return null
    }
  }

  /** This cadre's redemption rows, or null when they cannot be read. */
  async function usageRows(): Promise<ReadonlyArray<{ inviteKey: string; peerId: string }> | null> {
    try {
      const db = node.getControlDatabase()
      if (!db) return null
      return await db.queryCadreInviteUsages()
    } catch {
      return null
    }
  }

  const ports: PairMintPorts = {
    isAllowed: async (peer) => {
      if (peer === self) return true
      try {
        return (await node.isAuthorizedMember(peer)) === true
      } catch {
        return false
      }
    },
    isEnabled: () => deps.isEnabled(),
    now: () => deps.now(),
    createInvitation: ({ expiresInMs }) => createPairingInvitation(node, { expiresInMs, encodeInvitation: deps.encodeInvitation }),
    isCurrentOfficer: async (userId, nowCanonical) => {
      const own = await ownNetwork()
      if (!own) return false
      try {
        return (await deps.verifiers.isCurrentPairingOfficer(own.db, { userId, nowCanonical })) === true
      } catch {
        return false
      }
    },
    verifyStatement: async (req: PairMintMintRequest): Promise<PairingVerifyResult> => {
      const own = await ownNetwork()
      if (!own) return { ok: false, reason: 'not-officer' }
      try {
        return await deps.verifiers.verifyPairingStatement(own.db, {
          networkHash: own.networkHash,
          statement: {
            userId: req.userId,
            nonce: req.nonce,
            expiresAt: req.expiresAt,
            requesterPeerId: req.requesterPeerId,
            keyPub: req.keyPub,
            sig: req.sig,
          },
          nowCanonical: canonicalAt(deps.now()),
          checkExpiry: true,
        })
      } catch {
        return { ok: false, reason: 'not-officer' }
      }
    },
    verifyRemove: async (req: PairMintRemoveRequest): Promise<boolean> => {
      const own = await ownNetwork()
      if (!own) return false
      try {
        const verdict = await deps.verifiers.verifyPairingRemove(own.db, {
          networkHash: own.networkHash,
          request: {
            userId: req.userId,
            nonce: req.nonce,
            peerId: req.peerId,
            expiresAt: req.expiresAt,
            keyPub: req.keyPub,
            sig: req.sig,
          },
          nowCanonical: canonicalAt(deps.now()),
        })
        return verdict.ok === true
      } catch {
        return false
      }
    },
    inviteUsagePeer: async (inviteKey) => {
      const rows = await usageRows()
      return rows?.find((row) => row.inviteKey === inviteKey)?.peerId ?? null
    },
    removeMachine: async (peerId) => {
      try {
        await node.removeMachine(peerId)
      } catch (err) {
        // cadre-core's MachineRemovalRefusedError names the rule in `code`; its message is never passed on.
        if ((err as { code?: unknown } | null)?.code === 'not-an-owner') throw new PairingInviteError('not-owner')
        throw new Error('pair-mint: remove failed')
      }
    },
    mintLog: deps.mintLog,
  }

  const service = createPairMintService(ports)
  const detachWire = await attachPairMint(control, service)

  // ---- R-D revocation sweep -------------------------------------------------------------------
  let closed = false
  let running: Promise<void> | null = null
  let rerun = false
  /** The last nonce looked up: the next sweep starts after it (round robin over the candidates). */
  let cursor: string | null = null

  /** Up to the lookup bound of unmarked candidates, starting after the cursor and wrapping. */
  function selectForLookup(unmarked: OwnerMintLogEntry[]): OwnerMintLogEntry[] {
    const byNonce = [...unmarked].sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0))
    if (byNonce.length <= REVOCATION_SWEEP_MAX_LOOKUPS) {
      cursor = null
      return byNonce
    }
    const after = cursor
    const start = after === null ? 0 : Math.max(0, byNonce.findIndex((e) => e.nonce > after))
    const picked: OwnerMintLogEntry[] = []
    for (let i = 0; i < REVOCATION_SWEEP_MAX_LOOKUPS; i++) picked.push(byNonce[(start + i) % byNonce.length]!)
    cursor = picked[picked.length - 1]!.nonce
    return picked
  }

  async function sweepOnce(): Promise<void> {
    let failure: unknown = undefined
    let failed = false
    const note = (err: unknown) => {
      if (!failed) failure = err
      failed = true
    }
    try {
      const own = await ownNetwork()
      if (!own || closed) return
      const candidates = await deps.revocationStore.listRevocationCandidates(deps.now())
      // A withdrawn candidate's row was already found: it needs no new lookup.
      const rows = candidates.filter((e) => e.revocation?.result === 'withdrawn').map((e) => ({ userId: e.userId, nonce: e.nonce }))
      for (const entry of selectForLookup(candidates.filter((e) => e.revocation === undefined))) {
        if (closed) return
        try {
          if ((await deps.verifiers.isPairingRevoked(own.db, { userId: entry.userId, nonce: entry.nonce })) === true) {
            rows.push({ userId: entry.userId, nonce: entry.nonce })
          }
        } catch (err) {
          note(err)
        }
      }
      if (rows.length === 0 || closed) return
      const usage = await usageRows()
      if (usage === null) return
      const actions = planRevocationActions(rows, candidates, usage, { nowMs: deps.now(), maxActions: REVOCATION_SWEEP_MAX_ACTIONS })
      for (const action of actions) {
        if (closed) return
        try {
          const result = action.kind === 'remove' ? await removeRevoked(action.peerId, note) : await withdrawRevoked(action, candidates, note)
          if (result !== null) await deps.revocationStore.markMintRevocation(action.nonce, { result, at: deps.now() })
        } catch (err) {
          note(err)
        }
      }
    } catch (err) {
      note(err)
    } finally {
      // One line per sweep, the error class only: never a row value or an error message.
      if (failed) console.warn('[pair-mint] revocation sweep:', failure instanceof Error ? failure.name : 'unknown')
    }
  }

  /** Remove a revoked browser's machine; the final mark, or null to retry next sweep. */
  async function removeRevoked(peerId: string, note: (err: unknown) => void): Promise<RevocationResult | null> {
    try {
      const result = await node.removeMachine(peerId)
      // cadre-core reports all false when no live row names the machine any more.
      return (result as { removedPeer?: unknown } | null)?.removedPeer === false ? 'gone' : 'removed'
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      if (code === 'not-an-owner') return 'not-owner'
      if (code === 'self') return 'refused'
      note(err)
      return null
    }
  }

  /** Withdraw a never-redeemed invitation; `withdrawn`, `expired` once it can no longer be redeemed, or null. */
  async function withdrawRevoked(
    action: { nonce: string; inviteKey: string },
    candidates: OwnerMintLogEntry[],
    note: (err: unknown) => void,
  ): Promise<RevocationResult | null> {
    try {
      // true (filed now) and false (not held here, or already withdrawn) both leave no live invitation here.
      await node.withdrawCadreInvitation(action.inviteKey)
      return 'withdrawn'
    } catch (err) {
      const entry = candidates.find((e) => e.nonce === action.nonce && e.outcome === 'approved')
      const expiry = inviteExpiryMs(entry?.expiresAt ?? null)
      if (expiry !== null && expiry <= deps.now()) return 'expired'
      note(err)
      return null
    }
  }

  const sweepRevocations = (): Promise<void> => {
    if (closed) return Promise.resolve()
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      try {
        do {
          rerun = false
          await sweepOnce()
        } while (rerun && !closed)
      } finally {
        running = null
      }
    })()
    return running
  }

  let unsubscribe: () => void
  try {
    unsubscribe = deps.subscribeRevocations(() => sweepRevocations())
  } catch (err) {
    // No half-attached host: without the watch, take the wire down again.
    closed = true
    await detachWire()
    throw err
  }
  void sweepRevocations()

  let detached: Promise<void> | null = null
  const detach = (): Promise<void> => {
    if (!detached) {
      closed = true
      detached = (async () => {
        try {
          unsubscribe()
        } catch {
          // the hub is going away with the node
        }
        await detachWire()
        await service.close()
      })()
    }
    return detached
  }
  const handleLocal = (request: PairMintRequest): Promise<PairMintReply> => service.handle(self, request)
  return { detach, handleLocal, sweepRevocations }
}

/** Can this node author owner writes (an invitation is one)? A read that throws counts as no. */
function canAuthorOwnerWrites(node: PairMintHostNode): boolean {
  try {
    return node.getSeedBootstrapService()?.canAuthorize() === true
  } catch {
    return false
  }
}

/**
 * Host the service only on a device whose own identity owner key is a live owner key of its cadre
 * (`voterInviteCapability === 'ready'`); null otherwise. It never runs owner setup and reads no storage.
 * The platform check runs first: a missing member rejects with a TypeError before the gate.
 *
 * A cheap gate runs first: the seed bootstrap must be able to author owner writes. The boot re-anchor
 * wires it on every owner device before this is called, and a device whose seed bootstrap cannot authorize
 * could not sign an invitation anyway, so it hosts nothing. On any other device this returns null without
 * reading the control database's owner rows.
 */
export async function startPairMintHost(node: PairMintHostNode, input: PairMintHostInput): Promise<PairMintHost | null> {
  requirePlatform(input)
  if (!canAuthorOwnerWrites(node)) return null
  return (await voterInviteCapability(node)) === 'ready' ? hostPairMint(node, input) : null
}
