// pool-discovery.ts — how a pool coordinator finds the OTHER coordinators of its ballot (phase 65, R2).
//
// A `PoolDiscovery` announces this coordinator on a topic with its pool size and returns the others
// listed on that exact topic. `rendezvousDiscovery` is the first implementation: it speaks the
// Authority rendezvous's existing `present` / `withdraw` requests, byte for byte what the agent sent
// before this module existed. The mailbox (send / poll) is NOT discovery and stays on the rendezvous
// client. This file is transport-free.
//
// The topic ladder (doc/election.md "Pool Merging"): a coordinator starts on a topic built from a
// hash of its pool and moves to a more general one. That is client-side only. The Authority's
// rendezvous keys an opaque topic string, so a rung topic needs no server change and an old Voter
// (plain topic only) keeps interoperating with a new one.
//
// The pool hash (D-22): sha256 over the SMALLEST member hold, where a hold is
// hex(sha256(utf8(voteCiphertext))), the value members already present to prove possession. It is
// stable until a member with a smaller hold joins, needs no ordering rule, and the rendezvous sees
// only the first 1 or 2 bits of it.
//
// The ladder parameters (rungs of 2 then 1 bits, 3 presents per rung, a 15 s cap) are a starting
// point, ASSUMED (D-23): they have not been tuned on a real ballot.

import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { poolRequests, type CoordinatorListing, type PoolRendezvousClient } from './pool-rendezvous.js'
import type { PoolIdentity } from './pool-envelope.js'

/** Pool-hash bits per rung, most specific first. The plain topic follows the last rung. */
export const POOL_LADDER_RUNG_BITS: readonly number[] = [2, 1]
/** Successful presents on a rung before widening is considered. */
export const POOL_LADDER_DWELL_PRESENTS = 3
/** The plain topic is reached at most this long after a run starts. */
export const POOL_LADDER_MAX_MS = 15_000
/** Mirrors the server's present check in pool-rendezvous.ts: a topic longer than this is refused. */
export const POOL_TOPIC_MAX_CHARS = 512

/**
 * Finds other coordinators. The mailbox (send / poll) is not part of discovery and stays on the
 * rendezvous client.
 */
export interface PoolDiscovery {
  /** Announce this coordinator on `topic` with its pool size; returns the OTHER coordinators on that exact topic. Throws on failure. */
  present (topic: string, size: number, now: number): Promise<CoordinatorListing[]>
  /** Remove this coordinator from `topic`. Best effort for callers. */
  withdraw (topic: string, now: number): Promise<void>
}

/** Discovery over the Authority rendezvous: the same signed requests the agent always sent. */
export function rendezvousDiscovery (client: PoolRendezvousClient, identity: PoolIdentity): PoolDiscovery {
  return {
    async present (topic, size, now) {
      const reply = await client.call(poolRequests.present(identity, topic, size, now))
      if (reply.t !== 'coordinators') throw new Error(reply.t === 'error' ? reply.reason : 'unexpected reply')
      return reply.list
    },
    async withdraw (topic, now) {
      const reply = await client.call(poolRequests.withdraw(identity, topic, now))
      if (reply.t === 'error') throw new Error(reply.reason)
    }
  }
}

/** The first `bits` bits of sha256(utf8(smallest hold)) as one lowercase hex digit. */
export function ladderBucket (holds: readonly string[], bits: number): string {
  if (!Number.isInteger(bits) || bits < 1 || bits > 4) throw new RangeError('ladder bits must be an integer from 1 to 4')
  let min = holds[0]
  for (const h of holds) if (min === undefined || h < min) min = h
  if (min === undefined) throw new RangeError('ladder bucket needs at least one hold')
  const first = sha256(utf8ToBytes(min))[0]!
  return (first >> (8 - bits)).toString(16)
}

/** `${base}/h/${bits}:${bucket}`, or `base` for 0 bits, no holds, or a topic past the server's length limit. */
export function ladderTopic (base: string, bits: number, holds: readonly string[]): string {
  if (bits === 0 || holds.length === 0) return base
  const topic = `${base}/h/${bits}:${ladderBucket(holds, bits)}`
  return topic.length > POOL_TOPIC_MAX_CHARS ? base : topic
}
