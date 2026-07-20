import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { allocateTid, peekTid } from '../src/database/tid-allocator.js'
import { prepareDb } from '../src/database/initialize.js'

// D-14 restart + clock-rollback scaffold for the shared allocator (Phase 999.1
// plan 02). Uses the exact `networks.spec.ts:844` fresh-engine-same-handle
// technique: "restart" = fresh module/call state against the SAME persisted
// Database handle, no real process boundary. Authored in the same task that
// implements tid-allocator.ts (not a later task) so this file's existence proves
// the module is genuinely exercised, not vacuously matched.

// D-14/R-01 (plan 10): the full in-scope namespace list — every engine's
// `allocateTid(ctx.db, '<ns>')` call site landed across plans 02-05, plus the
// folded `networks` namespace (R-01's `TidSequence` -> `TidHighWater`
// generalization). Cross-checked against a live grep of every
// `allocateTid(...)` call site in `packages/vote-engine/src` (excluding
// tests/dist): elections, authority, authority-config, registration,
// association, user, election, keys-tasks, onboarding-tasks, signature-tasks,
// networks — 11 namespaces total.
const ALL_NAMESPACES = [
  'elections',
  'authority',
  'authority-config',
  'registration',
  'association',
  'user',
  'election',
  'keys-tasks',
  'onboarding-tasks',
  'signature-tasks',
  'networks',
] as const

describe('tid-allocator', () => {
  describe('allocateTid — first allocation on a fresh namespace', () => {
    it('returns a value >= Date.now()+1 and upserts TidHighWater[ns] to that value (reserve-before-use)', async () => {
      const db = new Database()
      await prepareDb(db)
      const before = Date.now()
      const tid = await allocateTid(db, 'tid-allocator-fresh-1')
      expect(tid, 'first allocation must be >= Date.now()+1 at call time').to.be.a('number').greaterThanOrEqual(before + 1)

      const row = await db
        .prepare('select HighWater from TidHighWater where Namespace = :ns')
        .get({ ns: 'tid-allocator-fresh-1' })
      expect(row?.['HighWater'], 'HighWater must be upserted to the returned tid (reserve-before-use)').to.equal(tid)
    })
  })

  describe('allocateTid — count=2 block adjacency (elections T/T+1 pair, D-03 dependency)', () => {
    it('returns block start T and reserves T and T+1 in a single mutex hold', async () => {
      const db = new Database()
      await prepareDb(db)
      const t = await allocateTid(db, 'tid-allocator-pair', 2)

      const row = await db
        .prepare('select HighWater from TidHighWater where Namespace = :ns')
        .get({ ns: 'tid-allocator-pair' })
      expect(row?.['HighWater'], 'HighWater must advance to T+1 after a count=2 allocation').to.equal(t + 1)

      // The very next allocation on this namespace must not overlap the reserved pair.
      const next = await allocateTid(db, 'tid-allocator-pair')
      expect(next, 'next allocation must start above the reserved [T, T+1] block').to.be.greaterThan(t + 1)
    })
  })

  describe('allocateTid — D-10 concurrency: overlapping calls never collide', () => {
    it('two overlapping allocateTid(db, ns) promises resolve to strictly different values', async () => {
      const db = new Database()
      await prepareDb(db)
      const [a, b] = await Promise.all([
        allocateTid(db, 'tid-allocator-concurrent'),
        allocateTid(db, 'tid-allocator-concurrent'),
      ])
      expect(a, 'concurrent allocations for the same namespace must never duplicate').to.not.equal(b)

      const row = await db
        .prepare('select HighWater from TidHighWater where Namespace = :ns')
        .get({ ns: 'tid-allocator-concurrent' })
      expect(row?.['HighWater'], 'HighWater reflects the larger of the two serialized allocations').to.equal(Math.max(a, b))
    })
  })

  describe('allocateTid — per-namespace independence', () => {
    it('different namespaces allocate independently (each has its own stream)', async () => {
      const db = new Database()
      await prepareDb(db)
      const a = await allocateTid(db, 'tid-allocator-ns-a')
      const b = await allocateTid(db, 'tid-allocator-ns-b')

      const rowA = await db.prepare('select HighWater from TidHighWater where Namespace = :ns').get({ ns: 'tid-allocator-ns-a' })
      const rowB = await db.prepare('select HighWater from TidHighWater where Namespace = :ns').get({ ns: 'tid-allocator-ns-b' })
      expect(rowA?.['HighWater']).to.equal(a)
      expect(rowB?.['HighWater']).to.equal(b)
    })
  })

  // D-14/R-01 acceptance matrix: every in-scope namespace must prove BOTH
  // restart no-reissue AND backward-clock-rollback no-reissue (D-07: the
  // persisted table beats the wall clock). Table-driven so adding a namespace
  // to the allocator's caller set is a one-line addition here.
  for (const ns of ALL_NAMESPACES) {
    describe(`allocateTid — D-14 restart: never reissues a consumed Tid [ns=${ns}]`, () => {
      it('after a "restart" (fresh call state, same persisted Database handle) the next allocateTid resumes above the persisted HighWater', async () => {
        const db = new Database()
        await prepareDb(db)
        const namespace = `tid-allocator-restart-${ns}`
        // Persist a HighWater far beyond the current wall clock so "resumes above it"
        // is meaningfully proven by the persisted table, not incidentally true because
        // Date.now() alone would already exceed it.
        const futureHighWater = Date.now() + 10_000_000
        await db.exec(
          'insert into TidHighWater (Namespace, HighWater) values (:ns, :hw) on conflict (Namespace) do update set HighWater = :hw;',
          { ns: namespace, hw: futureHighWater },
        )

        // "Restart" = fresh module/call state against the SAME persisted Database
        // handle (networks.spec.ts:844 technique). The allocator holds no cross-call
        // TS-side cache — every allocateTid call reads HighWater fresh from `db` —
        // so calling allocateTid here on the SAME handle already exercises the exact
        // restart contract: it must never reissue anything <= futureHighWater.
        const next = await allocateTid(db, namespace)
        expect(next, `[ns=${ns}] restart must resume strictly above the persisted HighWater`).to.be.greaterThan(futureHighWater)
      })

      if (ns === 'elections') {
        it('[ns=elections] restart also holds for the count=2 T/T+1 adjacency reservation', async () => {
          const db = new Database()
          await prepareDb(db)
          const namespace = `tid-allocator-restart-${ns}-pair`
          const futureHighWater = Date.now() + 10_000_000
          await db.exec(
            'insert into TidHighWater (Namespace, HighWater) values (:ns, :hw) on conflict (Namespace) do update set HighWater = :hw;',
            { ns: namespace, hw: futureHighWater },
          )

          const t = await allocateTid(db, namespace, 2)
          expect(t, '[ns=elections] restart count=2 block start must be strictly above the persisted HighWater').to.be.greaterThan(futureHighWater)

          const row = await db
            .prepare('select HighWater from TidHighWater where Namespace = :ns')
            .get({ ns: namespace })
          expect(row?.['HighWater'], '[ns=elections] restart count=2 must reserve the adjacent pair [t, t+1]').to.equal(t + 1)
        })
      }
    })

    describe(`allocateTid — D-14 clock-rollback: the table wins over the wall clock (D-07) [ns=${ns}]`, () => {
      it('a mocked Date.now below the persisted HighWater still advances past it', async () => {
        const db = new Database()
        await prepareDb(db)
        const namespace = `tid-allocator-clock-rollback-${ns}`
        const persistedHighWater = Date.now() + 5_000_000
        await db.exec(
          'insert into TidHighWater (Namespace, HighWater) values (:ns, :hw) on conflict (Namespace) do update set HighWater = :hw;',
          { ns: namespace, hw: persistedHighWater },
        )

        const realNow = Date.now
        Date.now = () => persistedHighWater - 1_000_000 // clock rolled back well below the persisted high-water
        try {
          const next = await allocateTid(db, namespace)
          expect(next, `[ns=${ns}] clock rollback must not let allocateTid reissue a value <= the persisted HighWater`).to.be.greaterThan(persistedHighWater)
        } finally {
          Date.now = realNow
        }
      })
    })
  }

  describe('peekTid', () => {
    it('reads the next Tid without consuming it (no persist)', async () => {
      const db = new Database()
      await prepareDb(db)
      const ns = 'tid-allocator-peek'

      const peeked = await peekTid(db, ns)
      const rowBefore = await db.prepare('select HighWater from TidHighWater where Namespace = :ns').get({ ns })
      expect(rowBefore, 'peekTid must not persist a TidHighWater row').to.equal(undefined)

      const allocated = await allocateTid(db, ns)
      expect(allocated, 'the real allocation must be >= what was peeked').to.be.greaterThanOrEqual(peeked)
    })
  })
})
