/**
 * election-results.spec.ts — ElectionResultsEngine: loads the committed rows, rebuilds the key from the released
 * shares, runs buildTallyTree and summarizes per option. The rows are the real-crypto pool-blocks fixtures (real
 * election secret, real block ciphertext, real voter and consent signatures); the database and the key release are
 * stubs, so this spec checks the wiring. The SQL itself runs against a real strand in the host election rehearsal.
 */
import { expect } from 'chai'
import { ElectionResultsEngine, toIsoZ, votingStartsAt } from '../src/results/index.js'
import { buildTallyTree } from '../src/blocks/tally-tree.js'
import { KeyReleaseError } from '../src/key-release/key-release-engine.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  FIXTURE_VOTING_STARTS,
  makeCommittedElection,
  type CommittedFixtureSet
} from './fixtures/pool-blocks.js'

type Row = Record<string, unknown>

// voters 0..5: q1 a,a,b,a,c,b -> a 3, b 2, c 1; q2 x for all, plus y for voter 1 -> x 6, y 1, z 0
const Q1 = ['a', 'a', 'b', 'a', 'c', 'b']
const selections = (i: number): Record<string, string[]> => ({ q1: [Q1[i]!], q2: i === 1 ? ['x', 'y'] : ['x'] })

function fixture (): CommittedFixtureSet {
  return makeCommittedElection({ blocks: [{ size: 3, payloadVersion: 2, selections }, { size: 3, payloadVersion: 2, selections }] })
}

interface StubOptions {
  election?: Row | null
  timeline?: unknown
  registrants?: Row[]
  associations?: Row[]
  extraVoterRows?: Row[]
  failOn?: RegExp
}

function stubCtx (set: CommittedFixtureSet, opts: StubOptions = {}) {
  const queries: string[] = []
  const registrants = opts.registrants ?? set.authorization.registrants
  const associations = opts.associations ?? set.authorization.associations
  const fail = (sql: string): void => {
    queries.push(sql)
    if (opts.failOn?.test(sql) === true) throw new Error('disk on fire')
  }
  const db = {
    prepare (sql: string) {
      return {
        async get (params: Row): Promise<Row | undefined> {
          fail(sql)
          if (/from Election where/.test(sql)) {
            return opts.election === null ? undefined : (opts.election ?? { Id: params.electionId, AuthorityId: 'authority-blocks-1' })
          }
          if (/from ElectionRevision/.test(sql)) {
            return { Timeline: JSON.stringify(opts.timeline ?? { votingStarts: FIXTURE_VOTING_STARTS }) }
          }
          if (/from Registrant where/.test(sql)) return registrants.find(r => r.Id === params.id)
          throw new Error(`unexpected get: ${sql}`)
        }
      }
    },
    async * eval (sql: string, params: Row): AsyncGenerator<Row> {
      fail(sql)
      if (/from VoteBlock where/.test(sql)) {
        for (const r of set.rows) if (r.ElectionId === params.electionId && r.ElectionRevision === params.revision) yield { ...r }
        return
      }
      if (/from VoteBlockVoter where/.test(sql)) {
        for (const r of [...set.voterRows, ...(opts.extraVoterRows ?? [])]) if (r.ElectionId === params.electionId) yield { ...r }
        return
      }
      if (/from Association where/.test(sql)) {
        for (const a of associations) if (a.RegistrantId === params.id) yield { ...a }
        return
      }
      throw new Error(`unexpected eval: ${sql}`)
    }
  }
  return { ctx: { db } as never, queries }
}

function stubKeyRelease (set: CommittedFixtureSet, opts: { phase?: string, releasedCount?: number, reconstructError?: Error } = {}) {
  const handedOut: Uint8Array[] = []
  let reconstructCalls = 0
  return {
    handedOut,
    get reconstructCalls () { return reconstructCalls },
    engine: {
      async getKeyReleaseStatus (electionId: string) {
        return {
          electionId, revision: FIXTURE_REVISION, phase: opts.phase ?? 'reconstructable', releasingKeysAt: 1, hasEnteredReleasingKeys: true,
          threshold: 2, participants: 2, releasedCount: opts.releasedCount ?? 2, releasedUserIds: [], awaitingUserIds: [], rejectedReleases: [], electionKey: null
        } as never
      },
      async reconstructElectionKey (electionId: string) {
        reconstructCalls++
        if (opts.reconstructError !== undefined) throw opts.reconstructError
        const secretKey = new Uint8Array(set.election.electionSecret)
        handedOut.push(secretKey)
        return {
          electionId, revision: FIXTURE_REVISION, jointPublicKey: set.election.electionKey.jointPublicKey, secretKey,
          threshold: 2, participants: 2, usedUserIds: ['kh-a', 'kh-b'], rejectedReleases: []
        }
      }
    }
  }
}

const templatesOf = (set: CommittedFixtureSet) => async () => set.election.ballots.map(b => b.template) as never

describe('ElectionResultsEngine', () => {
  it('decrypts, validates and tallies every committed block, then wipes the rebuilt secret', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set)
    const kr = stubKeyRelease(set)
    const results = await new ElectionResultsEngine(ctx, { keyRelease: kr.engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)

    expect(results.status).to.equal('tallied')
    if (results.status !== 'tallied') return
    expect(results.revision).to.equal(FIXTURE_REVISION)
    expect(results.blockCount).to.equal(2)
    expect(results.keyholdersUsed).to.equal(2)
    expect(results.totals).to.include({ blocks: 2, entries: 6, valid: 6, invalid: 0, excluded: 0, undecryptable: 0 })

    expect(results.ballots).to.have.length(1)
    const ballot = results.ballots[0]!
    expect(ballot).to.include({ ballotId: 'ballot-a', votes: 6, valid: 6, invalid: 0, excluded: 0 })
    expect(ballot.questions.map(q => q.code)).to.deep.equal(['q1', 'q2', 'q3'])
    const [q1, q2, q3] = ballot.questions
    expect(q1).to.deep.include({ title: 'Question one', counted: true, answered: 6, blank: 0 })
    expect(q1!.options).to.deep.equal([
      { code: 'a', title: 'Option A', count: 3 },
      { code: 'b', title: 'Option B', count: 2 },
      { code: 'c', title: 'Option C', count: 1 }
    ])
    expect(q2!.options.map(o => o.count)).to.deep.equal([6, 1, 0])
    expect(q3).to.deep.include({ type: 'rank', counted: false, answered: 0, options: [] })

    // the same root an independent buildTallyTree over the same inputs gives
    const independent = buildTallyTree({
      scope: { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION },
      rows: set.rows,
      voterRows: set.voterRows,
      ballots: set.election.ballots.map(b => b.template) as never,
      ...set.authorization,
      release: { secretKey: new Uint8Array(set.election.electionSecret), jointPublicKey: set.election.electionKey.jointPublicKey }
    })
    expect(independent.ok).to.equal(true)
    if (independent.ok) expect(results.tallyRoot).to.equal(independent.tally.root)
    expect(JSON.parse(JSON.stringify(results.tally)).root).to.equal(results.tallyRoot)

    expect(kr.handedOut).to.have.length(1)
    expect([...kr.handedOut[0]!].every(b => b === 0)).to.equal(true)
  })

  it('reports awaiting-keys with the release count, and never rebuilds the key, before k shares are released', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set)
    const kr = stubKeyRelease(set, { phase: 'releasing', releasedCount: 1 })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: kr.engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results).to.deep.include({ status: 'awaiting-keys', phase: 'releasing', releasedCount: 1, threshold: 2, participants: 2 })
    expect(kr.reconstructCalls).to.equal(0)
  })

  it('reports no-election for an unknown election id', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set, { election: null })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: stubKeyRelease(set).engine, loadBallots: templatesOf(set) }).getElectionResults('nope')
    expect(results).to.deep.equal({ status: 'no-election', electionId: 'nope' })
  })

  it('reports a failed reconstruction by its KeyReleaseError code', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set)
    const kr = stubKeyRelease(set, { reconstructError: new KeyReleaseError('group-key-mismatch', 'nope') })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: kr.engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results).to.deep.include({ status: 'unavailable', reason: 'group-key-mismatch' })
  })

  it('excludes a block whose voter has no readable registrant, and still counts the other block', async () => {
    const set = fixture()
    const missing = set.blocks[0]!.voters[0]!.voterEntry.registrantId
    const { ctx } = stubCtx(set, { registrants: set.authorization.registrants.filter(r => r.Id !== missing) })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: stubKeyRelease(set).engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results.status).to.equal('tallied')
    if (results.status !== 'tallied') return
    const ballot = results.ballots[0]!
    // an excluded block counts its ATTESTED entries (WR-04): 2 of its 3 voters still authenticate
    expect(ballot).to.include({ votes: 5, excluded: 2, valid: 3 })
    expect(results.totals).to.include({ blocks: 2, valid: 3, excluded: 2 })
    expect(ballot.questions[0]!.options.reduce((n, o) => n + o.count, 0)).to.equal(3)
  })

  it('ignores voter rows of another revision', async () => {
    const set = fixture()
    const stray = { ...set.voterRows[0]!, RegistrantId: 'registrant-old', ElectionRevision: 0 }
    const { ctx } = stubCtx(set, { extraVoterRows: [stray] })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: stubKeyRelease(set).engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results.status).to.equal('tallied')
  })

  it('reads zone-less and Date expirations as UTC', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set, {
      registrants: set.authorization.registrants.map(r => ({ ...r, Expiration: '2030-01-01T00:00:00' })),
      associations: set.authorization.associations.map(a => ({ ...a, Expiration: new Date('2030-01-01T00:00:00Z') }))
    })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: stubKeyRelease(set).engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results.status).to.equal('tallied')
    if (results.status === 'tallied') expect(results.totals.excluded).to.equal(0)
  })

  it('turns a database error into unavailable and still wipes the secret', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set, { failOn: /from VoteBlock where/ })
    const kr = stubKeyRelease(set)
    const results = await new ElectionResultsEngine(ctx, { keyRelease: kr.engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results).to.deep.include({ status: 'unavailable', reason: 'read-failed' })
    expect([...kr.handedOut[0]!].every(b => b === 0)).to.equal(true)
  })

  it('refuses a timeline without votingStarts', async () => {
    const set = fixture()
    const { ctx } = stubCtx(set, { timeline: { releasingKeys: 5 } })
    const results = await new ElectionResultsEngine(ctx, { keyRelease: stubKeyRelease(set).engine, loadBallots: templatesOf(set) }).getElectionResults(FIXTURE_ELECTION_ID)
    expect(results).to.deep.include({ status: 'unavailable', reason: 'no-timeline' })
  })
})

describe('election results helpers', () => {
  it('toIsoZ keeps ISO-Z text and converts other datetime shapes to UTC ISO-Z', () => {
    expect(toIsoZ('2030-01-01T00:00:00.000Z')).to.equal('2030-01-01T00:00:00.000Z')
    expect(toIsoZ('2030-01-01T00:00:00')).to.equal('2030-01-01T00:00:00.000Z')
    expect(toIsoZ(Date.UTC(2030, 0, 1))).to.equal('2030-01-01T00:00:00.000Z')
    expect(toIsoZ('garbage')).to.equal('garbage')
  })

  it('votingStartsAt reads epoch ms or ISO-Z from timeline JSON and refuses anything else', () => {
    expect(votingStartsAt(JSON.stringify({ votingStarts: 1000 }))).to.equal(1000)
    expect(votingStartsAt({ votingStarts: '2026-06-01T00:00:00.000Z' })).to.equal(Date.parse('2026-06-01T00:00:00.000Z'))
    expect(votingStartsAt('{not json')).to.equal(null)
    expect(votingStartsAt({ votingStarts: '2026-06-01' })).to.equal(null)
    expect(votingStartsAt({})).to.equal(null)
  })
})
