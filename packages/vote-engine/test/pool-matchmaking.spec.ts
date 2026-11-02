/**
 * pool-matchmaking.spec.ts — vote-pool discovery over Optimystic matchmaking (user decision 2026-11-02:
 * matchmaking AND the rendezvous, merged). Proves the signed listing round-trip, every refusal rule of
 * the decoder (forged identity, replay under another peer id, stale, wrong topic, bad size, contact hint
 * mismatch), the provider-per-topic lifecycle, and the merge's union and partial-failure rules. The
 * PoolAgent runs over matchmaking (alone, merged, and with a failing cohort) are pool.spec.ts R2-11..R2-13.
 */

import { expect } from 'chai'
import { createPoolIdentity } from '../src/pool/pool-envelope.js'
import {
  POOL_MATCH_COOL_OFF_MS,
  POOL_MATCH_LISTING_MAX_AGE_MS,
  POOL_MATCH_LISTING_TAG,
  decodePoolListing,
  encodePoolListing,
  matchmakingDiscovery,
  mergedDiscovery,
  type PoolMatchEntry,
  type PoolMatchmakingPorts
} from '../src/pool/pool-matchmaking.js'
import type { PoolDiscovery } from '../src/pool/pool-discovery.js'
import type { CoordinatorListing } from '../src/pool/pool-rendezvous.js'

const TOPIC = 'election-1/ballot-a'
const NOW = 1_800_000_000_000

/** An in-memory stand-in for one matchmaking cohort: providers by (topic, registering peer). */
class FakeCohort {
  readonly registrations = new Map<string, Map<string, PoolMatchEntry>>()
  registerCalls = 0
  withdrawCalls = 0
  ports (selfPeerId: string): PoolMatchmakingPorts {
    return {
      selfPeerId,
      openProvider: () => {
        let topic: string | undefined
        return {
          register: async (label, reg) => {
            this.registerCalls++
            topic = label
            const table = this.registrations.get(label) ?? new Map<string, PoolMatchEntry>()
            table.set(selfPeerId, { participantId: selfPeerId, capabilities: reg.capabilities, contactHint: reg.contactHint })
            this.registrations.set(label, table)
          },
          withdraw: async () => {
            this.withdrawCalls++
            if (topic !== undefined) this.registrations.get(topic)?.delete(selfPeerId)
          }
        }
      },
      query: async (label) => [...(this.registrations.get(label)?.values() ?? [])]
    }
  }
}

function entry (identity = createPoolIdentity(), opts: { topic?: string, size?: number, ts?: number, peer?: string, signedFor?: string, hint?: string } = {}): PoolMatchEntry {
  const peer = opts.peer ?? '12D3KooWpeerA'
  const cap = encodePoolListing(identity, opts.topic ?? TOPIC, opts.size ?? 2, opts.ts ?? NOW, opts.signedFor ?? peer)
  return { participantId: peer, capabilities: [cap], contactHint: opts.hint ?? identity.peerId }
}

describe('pool matchmaking discovery (optimystic matchmaking, merged with the rendezvous)', () => {
  describe('signed listing', () => {
    it('round-trips: the decoder returns the pool identity and size', () => {
      const id = createPoolIdentity()
      expect(decodePoolListing(entry(id, { size: 3 }), TOPIC, NOW)).to.deep.equal({ peerId: id.peerId, size: 3 })
    })

    it('refuses a listing replayed under another registering peer id', () => {
      expect(decodePoolListing(entry(undefined, { peer: '12D3KooWthief', signedFor: '12D3KooWpeerA' }), TOPIC, NOW)).to.equal(undefined)
    })

    it('refuses a listing that names a pool identity it was not signed by', () => {
      const real = createPoolIdentity()
      const forged = entry(createPoolIdentity())
      const cap = forged.capabilities[0]!.replace(/"as":"[^"]+"/, `"as":"${real.peerId}"`)
      expect(decodePoolListing({ ...forged, capabilities: [cap], contactHint: real.peerId }, TOPIC, NOW)).to.equal(undefined)
    })

    it('refuses stale, future, wrong-topic, out-of-range and hint-mismatched listings', () => {
      const id = createPoolIdentity()
      expect(decodePoolListing(entry(id, { ts: NOW - POOL_MATCH_LISTING_MAX_AGE_MS - 1 }), TOPIC, NOW), 'stale').to.equal(undefined)
      expect(decodePoolListing(entry(id, { ts: NOW + POOL_MATCH_LISTING_MAX_AGE_MS + 1 }), TOPIC, NOW), 'future').to.equal(undefined)
      expect(decodePoolListing(entry(id, { topic: 'other' }), TOPIC, NOW), 'topic').to.equal(undefined)
      expect(decodePoolListing(entry(id, { size: 0 }), TOPIC, NOW), 'size 0').to.equal(undefined)
      expect(decodePoolListing(entry(id, { size: 17 }), TOPIC, NOW), 'size 17').to.equal(undefined)
      expect(decodePoolListing(entry(id, { hint: 'someone-else' }), TOPIC, NOW), 'hint').to.equal(undefined)
    })

    it('ignores other capabilities and malformed listing JSON, never throwing', () => {
      const good = entry()
      const e: PoolMatchEntry = { ...good, capabilities: ['eligible:abc', POOL_MATCH_LISTING_TAG + '{not json', ...good.capabilities] }
      expect(decodePoolListing(e, TOPIC, NOW)).to.not.equal(undefined)
      expect(decodePoolListing({ ...good, capabilities: [POOL_MATCH_LISTING_TAG + 'null'] }, TOPIC, NOW)).to.equal(undefined)
    })
  })

  describe('matchmakingDiscovery', () => {
    it('two coordinators see each other and never themselves', async () => {
      const cohort = new FakeCohort()
      const a = createPoolIdentity()
      const b = createPoolIdentity()
      const da = matchmakingDiscovery(cohort.ports('12D3KooWa'), a)
      const db = matchmakingDiscovery(cohort.ports('12D3KooWb'), b)
      expect(await da.present(TOPIC, 1, NOW)).to.deep.equal([])
      expect(await db.present(TOPIC, 2, NOW)).to.deep.equal([{ peerId: a.peerId, size: 1 }])
      expect(await da.present(TOPIC, 1, NOW)).to.deep.equal([{ peerId: b.peerId, size: 2 }])
    })

    it('re-registers on every present (the size can change) and withdraws per topic', async () => {
      const cohort = new FakeCohort()
      const d = matchmakingDiscovery(cohort.ports('12D3KooWa'), createPoolIdentity())
      await d.present(TOPIC, 1, NOW)
      await d.present(TOPIC, 2, NOW)
      await d.present('rung/h/1:0', 2, NOW)
      expect(cohort.registerCalls).to.equal(3)
      await d.withdraw(TOPIC, NOW)
      await d.withdraw(TOPIC, NOW) // second withdraw of a topic is a no-op
      expect(cohort.withdrawCalls).to.equal(1)
      expect(cohort.registrations.get(TOPIC)?.size ?? 0).to.equal(0)
      expect(cohort.registrations.get('rung/h/1:0')?.size).to.equal(1)
    })

    it('after a failure it cools off: presents in the window list nobody and make no call, then it tries again', async () => {
      let calls = 0
      const ports: PoolMatchmakingPorts = {
        selfPeerId: 'p',
        openProvider: () => ({ register: async () => { calls++; throw new Error('cohort-topic: no willing primary right now') }, withdraw: async () => undefined }),
        query: async () => []
      }
      const d = matchmakingDiscovery(ports, createPoolIdentity(), { coolOffMs: 1_000 })
      let thrown: unknown
      try { await d.present(TOPIC, 1, NOW) } catch (e) { thrown = e }
      expect(String(thrown)).to.contain('no willing primary')
      expect(await d.present(TOPIC, 1, NOW + 500)).to.deep.equal([])
      expect(await d.present(TOPIC, 1, NOW + 999)).to.deep.equal([])
      expect(calls, 'no registration during the cool-off').to.equal(1)
      thrown = undefined
      try { await d.present(TOPIC, 1, NOW + 1_000) } catch (e) { thrown = e }
      expect(thrown, 'tries again once the cool-off ends').to.not.equal(undefined)
      expect(calls).to.equal(2)
      expect(POOL_MATCH_COOL_OFF_MS).to.equal(30_000)
    })

    it('throws when the cohort query fails', async () => {
      const ports: PoolMatchmakingPorts = {
        selfPeerId: 'p',
        openProvider: () => ({ register: async () => undefined, withdraw: async () => undefined }),
        query: async () => { throw new Error('cohort unreachable') }
      }
      let thrown: unknown
      try { await matchmakingDiscovery(ports, createPoolIdentity()).present(TOPIC, 1, NOW) } catch (e) { thrown = e }
      expect(String(thrown)).to.contain('cohort unreachable')
    })
  })

  describe('mergedDiscovery', () => {
    const fixed = (list: CoordinatorListing[]): PoolDiscovery => ({ present: async () => list, withdraw: async () => undefined })
    const failing = (msg: string): PoolDiscovery => ({ present: async () => { throw new Error(msg) }, withdraw: async () => { throw new Error(msg) } })

    it('returns the union, one per pool identity, the first source winning on a size conflict', async () => {
      const merged = mergedDiscovery([fixed([{ peerId: 'x', size: 2 }, { peerId: 'y', size: 1 }]), fixed([{ peerId: 'x', size: 5 }, { peerId: 'z', size: 3 }])])
      expect(await merged.present(TOPIC, 1, NOW)).to.deep.equal([{ peerId: 'x', size: 2 }, { peerId: 'y', size: 1 }, { peerId: 'z', size: 3 }])
    })

    it('one source down is not a failure, and is reported', async () => {
      const failures: number[] = []
      const merged = mergedDiscovery([failing('rendezvous down'), fixed([{ peerId: 'z', size: 3 }])], (i) => failures.push(i))
      expect(await merged.present(TOPIC, 1, NOW)).to.deep.equal([{ peerId: 'z', size: 3 }])
      expect(failures).to.deep.equal([0])
    })

    it('throws the first error only when every source fails', async () => {
      const merged = mergedDiscovery([failing('first'), failing('second')])
      let thrown: unknown
      try { await merged.present(TOPIC, 1, NOW) } catch (e) { thrown = e }
      expect(String(thrown)).to.contain('first')
      thrown = undefined
      try { await merged.withdraw(TOPIC, NOW) } catch (e) { thrown = e }
      expect(String(thrown)).to.contain('first')
    })

    it('refuses an empty list', () => {
      expect(() => mergedDiscovery([])).to.throw(RangeError)
    })
  })
})
