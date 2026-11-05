/**
 * dkg-round-deadline.spec.ts — 62-139 Task 2.
 *
 * The DKG status read flags the awaited keyholders once the current round has been open for DKG_ROUND_DEADLINE_MS
 * (advisory only, no automatic action), over a REAL DKG with an injected clock per engine. Also the roster facts
 * (liveRoster / earlierRevisionUserIds) and the pure earlierRevisionUserIdsOf helper.
 */

import { expect } from 'chai'
import { DKG_ROUND_DEADLINE_MS, type KeyholderDkgStatus } from '@votetorrent/vote-core'
import { KeyholderDkgEngine, earlierRevisionUserIdsOf } from '../src/keyholder/keyholder-dkg-engine.js'
import {
  runDkgToQuiescence,
  seedDkgElection,
  type DkgTestParticipant,
  type SeedDkgElectionResult
} from './fixtures/dkg-keyholders.js'
import { bumpElectionRevision } from './fixtures/test-context.js'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const iso = (ms: number): string => new Date(ms).toISOString()
const ms = (s: string | null | undefined): number => Date.parse(s ?? '')
const sleep = async (n: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, n))

/** A fresh engine for `p` whose injected clock reads `at`. */
function engineAt (seed: SeedDkgElectionResult, p: DkgTestParticipant, at: number): KeyholderDkgEngine {
  return new KeyholderDkgEngine(seed.auth.ctx, { vault: p.vault, now: () => at })
}

async function latestBoundAt (seed: SeedDkgElectionResult): Promise<string> {
  const rows: string[] = []
  for await (const row of seed.auth.ctx.db.eval('select BoundAt from KeyholderDkgBinding where ElectionId = :electionId', { electionId: seed.electionId })) {
    rows.push(row.BoundAt as string)
  }
  expect(rows.length).to.be.greaterThan(0)
  return rows.sort((a, b) => ms(a) - ms(b))[rows.length - 1]!
}

async function tableCount (seed: SeedDkgElectionResult, table: string): Promise<number> {
  const row = await seed.auth.ctx.db.prepare(`select count(*) as c from ${table} where ElectionId = :electionId`).get({ electionId: seed.electionId })
  return row?.c as number
}

async function statusAt (seed: SeedDkgElectionResult, at: number): Promise<KeyholderDkgStatus> {
  const reader = engineAt(seed, seed.participants[0]!, at)
  return await reader.getDkgStatus(seed.electionId)
}

const byName = (seed: SeedDkgElectionResult, name: string): DkgTestParticipant => seed.participants.find((p) => p.name === name)!

describe('dkg-round-deadline.spec: the status read flags keyholders silent past the round deadline (62-139)', function () {
  this.timeout(240000)

  describe('D1 D3 D2 D6: one DKG, A and B answer, C is silent', () => {
    let seed: SeedDkgElectionResult
    let T0: number
    let O: number

    before(async () => {
      seed = await seedDkgElection({ keyholders: ['A', 'B', 'C'], threshold: 2 })
      await sleep(5)
      T0 = Date.now()
      O = ms(await latestBoundAt(seed))
      expect(O).to.be.lessThan(T0)
      await engineAt(seed, byName(seed, 'A'), T0).advanceDkg(seed.electionId, byName(seed, 'A').signer)
      await engineAt(seed, byName(seed, 'B'), T0 + MIN).advanceDkg(seed.electionId, byName(seed, 'B').signer)
    })

    it('D1: roundOpenedAt is the latest binding; C is flagged exactly at the deadline and not a millisecond earlier', async () => {
      const early = await statusAt(seed, O + DKG_ROUND_DEADLINE_MS - 1)
      const idC = byName(seed, 'C').userId
      expect(early.awaitingUserIds).to.deep.equal([idC])
      expect(ms(early.roundOpenedAt)).to.equal(O)
      expect(early.overdueUserIds).to.deep.equal([])
      const at = await statusAt(seed, O + DKG_ROUND_DEADLINE_MS)
      expect(at.overdueUserIds).to.deep.equal([idC])
    })

    it('D3: at the deadline nothing is written, nobody is disqualified and advanceDkg plans the same as before it', async () => {
      const tables = ['KeyholderDkgMessage', 'Keyholder', 'KeyholderDkgBinding']
      const before = await Promise.all(tables.map(async (t) => await tableCount(seed, t)))
      const overdue = await statusAt(seed, O + DKG_ROUND_DEADLINE_MS)
      expect(overdue.disqualified).to.deep.equal([])
      expect(overdue.overdueUserIds).to.have.length(1)
      const A = byName(seed, 'A')
      const late = await engineAt(seed, A, O + DKG_ROUND_DEADLINE_MS + HOUR).advanceDkg(seed.electionId, A.signer)
      const early = await engineAt(seed, A, O + HOUR).advanceDkg(seed.electionId, A.signer)
      expect(late.actions).to.deep.equal(early.actions)
      expect(late.actions).to.not.include('removed-disqualified')
      expect(late.actions).to.deep.equal([])
      expect(await Promise.all(tables.map(async (t) => await tableCount(seed, t)))).to.deep.equal(before)
    })

    it('D2: once C posts round 0 (and round 1) the round re-opens; the deadline is per round', async () => {
      const C = byName(seed, 'C')
      const cAt = T0 + 2 * HOUR
      await engineAt(seed, C, cAt).advanceDkg(seed.electionId, C.signer)
      const status = await statusAt(seed, O + DKG_ROUND_DEADLINE_MS)
      expect(status.currentRound, 'recorded: C advanced into round 1').to.equal(1)
      expect(ms(status.roundOpenedAt)).to.equal(cAt)
      expect(status.overdueUserIds).to.deep.equal([])
      expect(status.awaitingUserIds).to.not.include(C.userId)
    })

    it('D6: complete status carries roundOpenedAt null and overdueUserIds []', async () => {
      await runDkgToQuiescence(seed.participants, seed.electionId)
      const status = await statusAt(seed, Date.now())
      expect(status.phase).to.equal('complete')
      expect(status.roundOpenedAt).to.equal(null)
      expect(status.overdueUserIds).to.deep.equal([])
    })
  })

  describe('D4 D5 D6 D8: wall clock default, roster facts, blocked and unread statuses', () => {
    it('D4: an engine without now uses the wall clock; a just-opened round is not overdue', async () => {
      const seed = await seedDkgElection({ keyholders: ['A', 'B', 'C'], threshold: 2 })
      const A = byName(seed, 'A')
      await A.engine.advanceDkg(seed.electionId, A.signer)
      const status = await A.engine.getDkgStatus(seed.electionId)
      expect(status.roundOpenedAt).to.not.equal(null)
      expect(status.overdueUserIds).to.deep.equal([])

      // D5: roster facts before and after a revision bump.
      const ids = seed.participants.map((p) => p.userId).sort()
      expect(status.liveRoster).to.deep.equal(ids)
      expect(status.earlierRevisionUserIds).to.deep.equal([])
      await bumpElectionRevision({ ...seed.auth, electionsEngine: seed.electionsEngine, electionEngine: seed.electionEngine })
      const bumped = await A.engine.getDkgStatus(seed.electionId)
      expect(bumped.phase).to.equal('blocked')
      expect(bumped.blockedReason).to.equal('no-keyholders')
      expect(bumped.liveRoster).to.deep.equal([])
      expect(bumped.earlierRevisionUserIds).to.deep.equal(ids)
      // D6: blocked.
      expect(bumped.roundOpenedAt).to.equal(null)
      expect(bumped.overdueUserIds).to.deep.equal([])
    })

    it('D8: an election id with no ElectionRevision row reports the roster facts as unknown, never []', async () => {
      const seed = await seedDkgElection({ keyholders: ['A', 'B'], threshold: 2 })
      const status = await seed.participants[0]!.engine.getDkgStatus('no-such-election')
      expect(status.revision).to.equal(null)
      expect(status.liveRoster).to.equal(undefined)
      expect(status.earlierRevisionUserIds).to.equal(undefined)
      expect(status.overdueUserIds).to.deep.equal([])
      expect(status.roundOpenedAt).to.equal(null)
    })
  })

  it('D7: the silent keyholder future-dating its own row cannot push the flag out', async () => {
    const seed = await seedDkgElection({ keyholders: ['A', 'B', 'C'], threshold: 2 })
    await sleep(5)
    const T0 = Date.now()
    const O = ms(await latestBoundAt(seed))
    const [A, B, C] = [byName(seed, 'A'), byName(seed, 'B'), byName(seed, 'C')]
    await engineAt(seed, C, T0 + 30 * DAY).advanceDkg(seed.electionId, C.signer)
    await engineAt(seed, A, T0).advanceDkg(seed.electionId, A.signer)
    const mid = await statusAt(seed, T0 + 10 * MIN)
    expect(ms(mid.roundOpenedAt), 'C answer dropped beyond the skew, A answer caps the bindings').to.equal(O)
    await engineAt(seed, B, T0 + MIN).advanceDkg(seed.electionId, B.signer)
    await engineAt(seed, A, T0 + HOUR).advanceDkg(seed.electionId, A.signer)
    const H = T0 + MIN
    const early = await statusAt(seed, H + DKG_ROUND_DEADLINE_MS - 1)
    expect(early.currentRound).to.equal(1)
    expect(early.awaitingUserIds).to.deep.equal([C.userId])
    expect(early.overdueUserIds).to.deep.equal([])
    const at = await statusAt(seed, H + DKG_ROUND_DEADLINE_MS)
    expect(at.overdueUserIds).to.deep.equal([C.userId])
    expect(ms(at.roundOpenedAt)).to.equal(H)
    const far = await statusAt(seed, T0 + 30 * DAY)
    expect(far.overdueUserIds).to.deep.equal([C.userId])
    expect(ms(far.roundOpenedAt)).to.be.lessThan(T0 + HOUR + 1)
    expect(ms(far.roundOpenedAt)).to.be.lessThan(T0 + 30 * DAY)
  })

  it('D9: the first answer does not un-flag the silent keyholders', async () => {
    const seed = await seedDkgElection({ keyholders: ['A', 'B', 'C'], threshold: 2 })
    await sleep(5)
    const T = ms(await latestBoundAt(seed))
    const [A, B, C] = [byName(seed, 'A'), byName(seed, 'B'), byName(seed, 'C')]
    await engineAt(seed, A, T + 25 * HOUR).advanceDkg(seed.electionId, A.signer)
    const status = await statusAt(seed, T + 25 * HOUR + MIN)
    expect(ms(status.roundOpenedAt)).to.equal(T)
    expect(status.awaitingUserIds).to.deep.equal([B.userId, C.userId].sort())
    expect(status.overdueUserIds).to.deep.equal([B.userId, C.userId].sort())
    void iso
  })

  it('D10: earlierRevisionUserIdsOf lists only users whose every Keyholder row is before the current revision', () => {
    const rows = [
      { userId: 'u1', electionRevision: 1 }, { userId: 'u1', electionRevision: 3 },
      { userId: 'u2', electionRevision: 1 },
      { userId: 'u3', electionRevision: 2 },
      { userId: 'u4', electionRevision: 1 }, { userId: 'u4', electionRevision: 2 },
      { userId: 'u5', electionRevision: '1' }
    ]
    expect(earlierRevisionUserIdsOf(rows, 2)).to.deep.equal(['u2', 'u5'])
    expect(earlierRevisionUserIdsOf(rows, '2')).to.deep.equal(['u2', 'u5'])
    expect(earlierRevisionUserIdsOf([], 2)).to.deep.equal([])
  })
})
