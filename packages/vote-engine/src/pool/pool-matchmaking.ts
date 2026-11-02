// pool-matchmaking.ts — vote-pool discovery over Optimystic matchmaking, and the merge with the rendezvous.
//
// Role:
//   - `matchmakingDiscovery` is a second `PoolDiscovery` (pool-discovery.ts). A coordinator registers
//     itself as a matchmaking provider on its topic, then queries that topic's cohort for the other
//     coordinators. The listing it registers is SIGNED BY THE POOL IDENTITY over the topic, the size, the
//     time and the registering peer id, so a cohort member or another peer can neither forge a listing
//     for someone else's pool nor replay one under its own peer id.
//   - `mergedDiscovery` presents on several discoveries at once and returns the union of their listings.
//     The Voter uses it as [rendezvous, matchmaking] (user decision 2026-11-02: both, rendezvous kept).
//
// Rules:
//   - Transport-free. The upstream sessions (`MatchmakingProviderSession` / `MatchmakingSeekerSession` in
//     @optimystic/db-p2p) are reached through `PoolMatchmakingPorts`, which the app binds to a live
//     strand node. vote-engine never imports db-p2p's node code here.
//   - Discovery only. The mailbox (send / poll) stays on the rendezvous client; matchmaking has none.
//   - Privacy cost, accepted by the user on 2026-11-02: a matchmaking registration is signed by the
//     phone's libp2p peer key, so the topic's cohort members see that peer id next to the pool identity.
//     The rendezvous alone exposes it only to the Authority.
//   - A merged present fails only when EVERY discovery fails; one listing source down is not a failure.

import { signPoolRequest, verifyPoolRequest, type PoolIdentity } from './pool-envelope.js'
import type { CoordinatorListing } from './pool-rendezvous.js'
import type { PoolDiscovery } from './pool-discovery.js'

/**
 * Matchmaking topic kind for vote pools. Upstream's kinds are a closed set (db-core MATCH_TOPIC_KINDS: task,
 * capability, quorum, capacity-class; any other throws), and a pool is a quorum being assembled, so 'quorum'.
 */
export const POOL_MATCH_TOPIC_KIND = 'quorum'
/** Namespaces VoteTorrent's pool topics inside the shared 'quorum' kind. */
export const POOL_MATCH_LABEL_PREFIX = 'votetorrent.pool.v1/'

/** The matchmaking topic (kind, label) for a pool topic string. */
export function poolMatchTopic (topic: string): { kind: typeof POOL_MATCH_TOPIC_KIND, label: string } {
  return { kind: POOL_MATCH_TOPIC_KIND, label: POOL_MATCH_LABEL_PREFIX + topic }
}
/** Capability tag carrying the signed listing. */
export const POOL_MATCH_LISTING_TAG = 'vtpool1:'
/** A listing older than this is ignored (mirrors the rendezvous's 30 s coordinator TTL, plus skew). */
export const POOL_MATCH_LISTING_MAX_AGE_MS = 45_000
/** Most pools a coordinator merges with is bounded by the pool cap, so no query needs more entries. */
export const POOL_MATCH_QUERY_LIMIT = 32
/**
 * After a failed present, matchmaking is skipped for this long (an empty listing, no network call). Measured
 * 2026-11-02 on optimystic 1.24: a provider registration needs a cohort threshold signature of DEFAULT_MIN_SIGS
 * (14) of wantK (16) members, so on a network with fewer hosts every registration is refused with
 * CohortBackoffError ("no willing primary"). Without a cool-off, every pool tick would pay that refusal.
 */
export const POOL_MATCH_COOL_OFF_MS = 30_000
/** Upper bound on a pool's size, as in pool-agent.ts (a pool holds at most 16). */
const POOL_MAX = 16

const LISTING_LABEL = 'votetorrent.pool.match-listing.v1'

/** One entry a matchmaking query returned (the fields of db-core's `ProviderEntryV1` this module reads). */
export interface PoolMatchEntry {
  /** libp2p peer id of the registering node (matchmaking's `participantId`). */
  participantId: string
  capabilities: readonly string[]
  contactHint: string
}

/** One live provider registration. */
export interface PoolMatchProvider {
  register (topicLabel: string, reg: { capabilities: string[], capacityBudget: number, contactHint: string }): Promise<void>
  withdraw (): Promise<void>
}

/** What `matchmakingDiscovery` needs from a live node; the app binds these to the upstream sessions. */
export interface PoolMatchmakingPorts {
  /** This node's libp2p peer id: the one the cohort sees as `participantId` on our registrations. */
  selfPeerId: string
  /** A fresh provider session (one per topic: a coordinator can be listed on several rungs at once). */
  openProvider (): PoolMatchProvider
  /** One-shot cohort query for providers on `topicLabel`. */
  query (topicLabel: string, limit: number): Promise<readonly PoolMatchEntry[]>
}

interface ListingBody { as: string, topic: string, size: number, ts: number }

function listingFields (b: ListingBody, peerId: string): unknown[] {
  return [LISTING_LABEL, b.topic, b.size, b.ts, peerId]
}

/** The capability string for this coordinator's listing on `topic`. */
export function encodePoolListing (identity: PoolIdentity, topic: string, size: number, ts: number, selfPeerId: string): string {
  const body: ListingBody = { as: identity.peerId, topic, size, ts }
  const sig = signPoolRequest(identity, listingFields(body, selfPeerId))
  return POOL_MATCH_LISTING_TAG + JSON.stringify({ ...body, sig })
}

/**
 * The listing an entry carries, or undefined when it has none, it is for another topic, it is stale or from
 * the future, its size is out of range, or the pool identity did not sign it for THIS registering peer.
 */
export function decodePoolListing (entry: PoolMatchEntry, topic: string, now: number): CoordinatorListing | undefined {
  for (const cap of entry.capabilities) {
    if (typeof cap !== 'string' || !cap.startsWith(POOL_MATCH_LISTING_TAG)) continue
    let parsed: unknown
    try { parsed = JSON.parse(cap.slice(POOL_MATCH_LISTING_TAG.length)) } catch { continue }
    if (parsed === null || typeof parsed !== 'object') continue
    const { as, topic: t, size, ts, sig } = parsed as Record<string, unknown>
    if (typeof as !== 'string' || t !== topic || typeof size !== 'number' || typeof ts !== 'number') continue
    if (!Number.isInteger(size) || size < 1 || size > POOL_MAX) continue
    if (ts > now + POOL_MATCH_LISTING_MAX_AGE_MS || now - ts > POOL_MATCH_LISTING_MAX_AGE_MS) continue
    if (entry.contactHint !== as) continue
    if (!verifyPoolRequest(as, listingFields({ as, topic, size, ts }, entry.participantId), sig)) continue
    return { peerId: as, size }
  }
  return undefined
}

/** Discovery over Optimystic matchmaking. Throws when the registration or the query fails. */
export function matchmakingDiscovery (ports: PoolMatchmakingPorts, identity: PoolIdentity, options: { coolOffMs?: number } = {}): PoolDiscovery {
  const providers = new Map<string, PoolMatchProvider>()
  const coolOffMs = options.coolOffMs ?? POOL_MATCH_COOL_OFF_MS
  let skipUntil = Number.NEGATIVE_INFINITY
  return {
    async present (topic, size, now) {
      // Cooling off after a failure: list nobody rather than pay another refused registration.
      if (now < skipUntil) return []
      try {
        return await presentOnce(topic, size, now)
      } catch (err) {
        skipUntil = now + coolOffMs
        throw err
      }
    },
    async withdraw (topic) {
      const provider = providers.get(topic)
      if (provider === undefined) return
      providers.delete(topic)
      await provider.withdraw()
    }
  }

  async function presentOnce (topic: string, size: number, now: number): Promise<CoordinatorListing[]> {
    let provider = providers.get(topic)
    if (provider === undefined) {
      provider = ports.openProvider()
      providers.set(topic, provider)
    }
    // Re-registering is how a provider's payload changes (a renewal cannot carry one), and the size changes.
    await provider.register(topic, {
      capabilities: [encodePoolListing(identity, topic, size, now, ports.selfPeerId)],
      capacityBudget: Math.max(0, POOL_MAX - size),
      contactHint: identity.peerId
    })
    const entries = await ports.query(topic, POOL_MATCH_QUERY_LIMIT)
    const seen = new Set<string>()
    const list: CoordinatorListing[] = []
    for (const entry of entries) {
      const listing = decodePoolListing(entry, topic, now)
      if (listing === undefined || listing.peerId === identity.peerId || seen.has(listing.peerId)) continue
      seen.add(listing.peerId)
      list.push(listing)
    }
    return list
  }
}

/**
 * Presents on every discovery in parallel and returns the union of their listings, one per pool identity
 * (the first discovery's size wins when two disagree, so pass the rendezvous first). Throws only when
 * every discovery threw; the message is the first discovery's.
 */
export function mergedDiscovery (discoveries: readonly PoolDiscovery[], onPartialFailure?: (index: number, err: unknown) => void): PoolDiscovery {
  if (discoveries.length === 0) throw new RangeError('mergedDiscovery needs at least one discovery')
  return {
    async present (topic, size, now) {
      const results = await Promise.allSettled(discoveries.map(async (d) => await d.present(topic, size, now)))
      if (results.every((r) => r.status === 'rejected')) {
        throw (results[0] as PromiseRejectedResult).reason
      }
      const byId = new Map<string, CoordinatorListing>()
      results.forEach((r, i) => {
        if (r.status === 'rejected') { onPartialFailure?.(i, r.reason); return }
        for (const l of r.value) if (!byId.has(l.peerId)) byId.set(l.peerId, l)
      })
      return [...byId.values()]
    },
    async withdraw (topic, now) {
      const results = await Promise.allSettled(discoveries.map(async (d) => await d.withdraw(topic, now)))
      if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason
    }
  }
}
