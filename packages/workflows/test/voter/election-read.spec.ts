// election-read.spec.ts: plain-Node proof of the shared Voter election read and timeline (phase 67 plan 19).
// Pins that the D-19 stage list is the ui-web object itself (never a copy) and that the exact ten-member
// `TimelineStageId` union survives the JSDoc-typed module boundary, then drives `pickElectionId`,
// `readVoteContext`, `readVoterElection` and `toVoterBallot` over an in-file fake engine chain shaped like
// the Voter's own `election-read.test.ts` fixture. No clock is read except where `pickElectionId` reads it,
// and that read is stubbed and restored in `finally`.
import { expect } from 'chai'
import type { Ballot, ElectionSummary, Question } from '@votetorrent/vote-core'
import { ELECTION_EVENT_ORDER } from '@votetorrent/ui-web/lifecycle-core'
import {
  NoElectionError,
  TIMELINE_STAGE_IDS,
  pickElectionId,
  readVoteContext,
  readVoterElection,
  toVoterBallot,
  type ElectionReadDeps,
  type TimelineStageId,
} from '../../src/voter/reads.js'

/** Strict type equality: `true` only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

type ExpectedStageId =
  | 'registrationEnds'
  | 'ballotsFinal'
  | 'votingStarts'
  | 'accruingVotes'
  | 'hashingVotes'
  | 'releasingKeys'
  | 'tallyingStarts'
  | 'validation'
  | 'certificationStarts'
  | 'closed'

// Compile-time pin (E2): a drift of the shared union to `any`, `string` or a different member set makes this
// assignment a TS2322 under `tsc --noEmit -p tsconfig.test.json --module ESNext --moduleResolution Bundler`.
const STAGE_ID_UNION_IS_EXACT: Equal<TimelineStageId, ExpectedStageId> = true

const HOUR = 3_600_000
const DAY = 24 * HOUR
const D = Date.UTC(2031, 0, 15, 12)
const TIMELINE = {
  registrationEnds: D - 52 * DAY,
  ballotsFinal: D - 40 * DAY,
  votingStarts: D - 31 * DAY,
  accruingVotes: D - 20 * HOUR,
  hashingVotes: D - 16 * HOUR,
  releasingKeys: D - 12 * HOUR,
  tallyingStarts: D,
  validation: D + DAY,
  certificationStarts: D + 2 * DAY,
  closed: D + 3 * DAY,
}

interface FakeOptions {
  summaries?: Array<{ id: string, date: number }>
  timeline?: unknown
  keyholders?: unknown[]
  ballots?: Array<{ ballot: Ballot, confirmed: boolean }>
}

function summary (s: { id: string, date: number }): ElectionSummary {
  return { ...s, title: 't', authorityName: 'a', type: 'a' } as unknown as ElectionSummary
}

function fakeDeps (options: FakeOptions = {}, fallbackElectionId?: string): { deps: ElectionReadDeps, opened: string[], detailsCalls: string[], engineNames: string[] } {
  const ballots = options.ballots ?? []
  const opened: string[] = []
  const detailsCalls: string[] = []
  const engineNames: string[] = []
  const electionEngine = {
    getElectionDetails: async () => ({
      election: { id: 'e-1', authorityId: 'a-1', title: 'Real Election', date: D, revisionDeadline: D - 30 * DAY, ballotDeadline: D - 7 * DAY, type: 'a' },
      current: { revision: 3, timeline: options.timeline ?? TIMELINE, keyholders: options.keyholders ?? [] },
    }),
    getBallots: async () => ballots.map(({ ballot }) => ({ id: ballot.id, electionId: ballot.electionId, authorityId: ballot.authorityId })),
    getBallotConfirmationState: async (id: string) => ({ locked: false, confirmed: ballots.find(b => b.ballot.id === id)!.confirmed }),
    getBallotDetails: async (id: string) => {
      detailsCalls.push(id)
      return { ballot: ballots.find(b => b.ballot.id === id)!.ballot }
    },
  }
  const electionsEngine = {
    getElections: async () => (options.summaries ?? [{ id: 'e-1', date: D }]).map(summary),
    openElection: async (id: string) => {
      opened.push(id)
      return electionEngine
    },
  }
  const getEngine = async <T>(name: string): Promise<T> => {
    engineNames.push(name)
    if (name !== 'elections') throw new Error(`unexpected engine ${name}`)
    return electionsEngine as unknown as T
  }
  return { deps: { getEngine, fallbackElectionId }, opened, detailsCalls, engineNames }
}

function question (code: string, overrides: Partial<Question> = {}): Question {
  return {
    code,
    title: `Title ${code}`,
    instructions: '',
    type: 'select',
    options: [
      { code: 'x', title: `${code} X`, details: 'Party X' },
      { code: 'y', title: `${code} Y` },
    ],
    ...overrides,
  } as Question
}

function ballot (id: string, questions: Question[]): Ballot {
  return { id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions } as unknown as Ballot
}

describe('voter election-read: the shared timeline and election read (67-19)', () => {
  it('E1: TIMELINE_STAGE_IDS is ELECTION_EVENT_ORDER itself (D-19: imported, never copied)', () => {
    expect(TIMELINE_STAGE_IDS).to.equal(ELECTION_EVENT_ORDER)
    expect(TIMELINE_STAGE_IDS).to.have.length(10)
  })

  it('E2: TimelineStageId is the exact ten-member union (compile-time pin asserted at runtime)', () => {
    expect(STAGE_ID_UNION_IS_EXACT).to.equal(true)
    expect([...TIMELINE_STAGE_IDS]).to.deep.equal([
      'registrationEnds', 'ballotsFinal', 'votingStarts', 'accruingVotes', 'hashingVotes',
      'releasingKeys', 'tallyingStarts', 'validation', 'certificationStarts', 'closed',
    ])
  })

  it('E3: pickElectionId falls back only on an empty list, returns a lone id, and breaks a tie by the lower id', () => {
    expect(pickElectionId([], 'seed')).to.equal('seed')
    expect(pickElectionId([], undefined)).to.equal(undefined)
    expect(pickElectionId([summary({ id: 'only', date: D + 5 * DAY })], 'seed')).to.equal('only')
    const realNow = Date.now
    try {
      Date.now = () => D
      expect(pickElectionId([summary({ id: 'b', date: D + DAY }), summary({ id: 'a', date: D - DAY })], undefined)).to.equal('a')
      expect(pickElectionId([summary({ id: 'far', date: D + 10 * DAY }), summary({ id: 'near', date: D + DAY })], undefined)).to.equal('near')
    } finally {
      Date.now = realNow
    }
  })

  it('E4: readVoteContext derives the window from the timeline and partitions confirmed ballots', async () => {
    const ballots = [
      { ballot: ballot('b-3', [question('q1')]), confirmed: true },
      { ballot: ballot('b-1', [question('q2'), question('free', { type: 'text' })]), confirmed: true },
      { ballot: ballot('b-9', [question('q3')]), confirmed: false },
      { ballot: ballot('b-2', [question('q4')]), confirmed: false },
    ]
    const open = fakeDeps({ ballots })
    const inside = await readVoteContext(open.deps, D - 10 * DAY)
    expect(inside.open).to.equal(true)
    expect(inside.lifecycleState).to.equal('Open')
    expect(inside.electionId).to.equal('e-1')
    expect(inside.revision).to.equal(3)
    expect(inside.authorityId).to.equal('a-1')
    expect(inside.ballots.map(b => b.id)).to.deep.equal(['b-1', 'b-3'])
    expect(inside.unconfirmedBallotIds).to.deep.equal(['b-2', 'b-9'])
    expect(inside.unsupportedQuestionCount).to.equal(1)
    expect(open.detailsCalls.sort()).to.deep.equal(['b-1', 'b-3'])

    const before = await readVoteContext(fakeDeps({ ballots }).deps, D - 60 * DAY)
    expect(before.open).to.equal(false)
    expect(before.lifecycleState).to.equal('Upcoming')

    const nan = await readVoteContext(fakeDeps({ ballots }).deps, Number.NaN)
    expect(nan.open).to.equal(false)
    expect(nan.lifecycleState).to.equal(null)
  })

  it('E5: readVoterElection rejects with NoElectionError on an empty list with no fallback', async () => {
    let caught: unknown
    try {
      await readVoterElection(fakeDeps({ summaries: [] }).deps, D)
    } catch (e) {
      caught = e
    }
    expect(caught).to.be.instanceOf(NoElectionError)
    expect((caught as Error).name).to.equal('NoElectionError')

    const election = await readVoterElection(fakeDeps({ keyholders: [{}, {}, {}] }).deps, D - 10 * DAY)
    expect(election).to.include({ id: 'e-1', title: 'Real Election', lifecycleState: 'Open', keysTotal: 3 })
    expect(election.countdownTarget).to.equal(new Date(TIMELINE.accruingVotes).toISOString())
  })

  it('E6: toVoterBallot orders offices by group first appearance then sequence, and counts non-select questions', () => {
    const result = toVoterBallot('e-1', [
      ballot('b-2', [
        question('late', { group: 'Federal', sequence: 9 }),
        question('ranked', { type: 'rank' }),
      ]),
      ballot('b-1', [
        question('second', { group: 'State', sequence: 2 }),
        question('first', { group: 'State', sequence: 1 }),
        question('loose'),
        question('scored', { type: 'score' }),
      ]),
    ])
    expect(result.electionId).to.equal('e-1')
    expect(result.unsupportedQuestionCount).to.equal(2)
    expect(result.offices.map(o => o.questionCode)).to.deep.equal(['first', 'second', 'loose', 'late'])
    expect(result.offices.map(o => o.id)).to.deep.equal(['b-1:first', 'b-1:second', 'b-1:loose', 'b-2:late'])
    const first = result.offices[0]!
    expect(first).to.include({ ballotId: 'b-1', required: true, hasDependsOn: false, voteFor: 1, group: 'State' })
    expect(first.candidates.map(c => c.optionCode)).to.deep.equal(['x', 'y'])
    expect(first.candidates[0]).to.deep.equal({ id: 'b-1:first:x', optionCode: 'x', name: 'first X', party: 'Party X' })
    expect(first.candidates[1]).to.not.have.property('party')
    expect(result.offices[2]).to.not.have.property('group')
  })
})
