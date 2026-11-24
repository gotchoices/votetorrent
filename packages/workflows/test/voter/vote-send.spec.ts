// vote-send.spec.ts: plain-Node proof of the shared Voter vote sending, the strand sending port and
// the send steps (phase 67 plan 22). In-file fakes only: a recording debug sink, a recording strand
// port, a Map-backed sent store, a fake Quereus `Database` whose `eval` records (sql, params), and a
// control node whose dial never settles. The record fixture's signature and nonces are generated.
// Pins: the debug sink and the send seams are REQUIRED and refused before any port read or dial; the
// pre-pool refusals read nothing from the sent store; a ballot that cannot be encrypted reports failed
// and no secret reaches the sink; the port's SQL binds only `e r b reg`; and the record opens only after
// the reachability probe answered.
import { expect } from 'chai'
import { bytesToHex } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import {
  createVoteSendingPort,
  runVoteSend,
  sendSavedVote,
  type RunVoteSendDeps,
  type SendSavedVoteDeps,
  type VoteRecord,
  type VoteSendDebug,
  type VoteSendingPort,
  type VoteSentStore,
} from '../../src/voter/reads.js'

const ELECTION = 'election-send-1'
const REVISION = 1
const BALLOTS = ['ballot-a', 'ballot-b']
const HOUR = 3_600_000

function randomHex (bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

function makeRecord (): VoteRecord {
  return {
    v: 1,
    electionId: ELECTION,
    electionRevision: REVISION,
    savedAt: new Date(0).toISOString(),
    votes: BALLOTS.map(ballotId => ({
      v: 1,
      electionId: ELECTION,
      electionRevision: REVISION,
      ballotId,
      templateDigest: `template-${ballotId}`,
      answers: [{ questionCode: 'q1', optionCodes: ['yes'] }],
      nonce: randomHex(32),
    })),
    voter: {
      v: 1,
      electionId: ELECTION,
      electionRevision: REVISION,
      registrantId: 'registrant-1',
      privateCid: 'private-1',
      publicCid: null,
      deviceKey: randomHex(33),
      attestationCid: null,
      ballots: BALLOTS.map(b => ({ ballotId: b, templateDigest: `template-${b}` })),
      signature: randomHex(64),
    },
  }
}

interface SinkCall { tag: string, event: string, detail: Record<string, unknown> | undefined }

function recordingSink (): VoteSendDebug & { calls: SinkCall[], prefixed: unknown[] } {
  const calls: SinkCall[] = []
  const prefixed: unknown[] = []
  return {
    calls,
    prefixed,
    vtDebug: (tag, event, detail) => { calls.push({ tag, event, detail }) },
    idPrefix: (id) => { prefixed.push(id); return typeof id === 'string' ? id.slice(0, 8) : typeof id },
  }
}

function recordingPort (over: { key?: string | null, closesAt?: number | null } = {}): VoteSendingPort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    readElectionKey: async () => { calls.push('readElectionKey'); return over.key === undefined ? 'not-a-key' : over.key },
    readVotingClose: async () => { calls.push('readVotingClose'); return over.closesAt === undefined ? 10_000 + HOUR : over.closesAt },
    commit: async () => { calls.push('commit'); return { ok: true } },
    findRecordedVote: async () => { calls.push('findRecordedVote'); return null },
  }
}

function recordingSentStore (): VoteSentStore & { reads: number, records: number } {
  const store = {
    reads: 0,
    records: 0,
    read: async () => { store.reads++; return {} },
    record: async () => { store.records++ },
  }
  return store
}

function sendDeps (port: VoteSendingPort, sentStore: VoteSentStore, record = makeRecord()): SendSavedVoteDeps {
  return {
    port,
    sentStore,
    record,
    rendezvous: { call: async () => { throw new Error('rendezvous must not be dialed in this spec') } },
    signConsent: async () => { throw new Error('consent must not be signed in this spec') },
    nowMs: () => 10_000,
    minPromptMs: 1,
  }
}

async function rejectsTypeError (p: Promise<unknown>): Promise<void> {
  let caught: unknown = null
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught).to.be.instanceOf(TypeError)
}

describe('voter vote-sending (shared sendSavedVote, sending port and runVoteSend)', () => {
  it('S1 sendSavedVote refuses a missing debug sink before any port read', async () => {
    const port = recordingPort()
    await rejectsTypeError(sendSavedVote(sendDeps(port, recordingSentStore()), undefined as never))
    expect(port.calls).to.deep.equal([])
  })

  describe('S2 the pre-pool refusals read nothing from the sent store', () => {
    const cases: Array<[string, { key?: string | null, closesAt?: number | null }, string]> = [
      ['a missing election key', { key: null }, 'election-key-missing'],
      ['an unreadable voting window', { closesAt: null }, 'window-unreadable'],
      ['a close time at or before now', { closesAt: 10_000 }, 'voting-closed'],
    ]
    for (const [title, over, reason] of cases) {
      it(`S2 ${title} gives ${reason}`, async () => {
        const port = recordingPort(over)
        const sentStore = recordingSentStore()
        const result = await sendSavedVote(sendDeps(port, sentStore), recordingSink())
        expect(result).to.deep.equal({ ok: false, reason })
        expect(sentStore.reads).to.equal(0)
        expect(port.calls).to.not.include('commit')
      })
    }
  })

  it('S3 a ballot whose contribution cannot be encrypted reports failed, and no secret reaches the sink', async () => {
    const sink = recordingSink()
    const port = recordingPort({ key: 'not-a-key' })
    const record = makeRecord()
    const result = await sendSavedVote(sendDeps(port, recordingSentStore(), record), sink)
    expect(result.ok).to.equal(true)
    if (result.ok) {
      expect(result.ballots.map(b => b.ballotId)).to.deep.equal(BALLOTS)
      for (const b of result.ballots) expect(b.status).to.deep.equal({ phase: 'not-sent', reason: 'failed' })
    }
    for (const ballotId of BALLOTS) expect(sink.prefixed).to.include(ballotId)
    const text = JSON.stringify(sink.calls)
    expect(sink.calls.length).to.be.greaterThan(0)
    expect(text).to.not.include(record.voter.signature)
    for (const vote of record.votes) expect(text).to.not.include(vote.nonce)
  })

  it('S4 createVoteSendingPort reads the key, the close and the recorded vote with the four bind names only', async () => {
    const seen: Array<{ sql: string, params: Record<string, unknown> }> = []
    let rows: Array<Record<string, unknown>> = []
    const db = {
      eval: async function * (sql: string, params: Record<string, unknown>) {
        seen.push({ sql, params })
        for (const row of rows) yield row
      },
    } as unknown as Database
    const port = createVoteSendingPort(db)

    rows = [{ JointPublicKey: 'joint-key' }]
    expect(await port.readElectionKey('e1', 2)).to.equal('joint-key')
    rows = [{ JointPublicKey: '' }]
    expect(await port.readElectionKey('e1', 2)).to.equal(null)
    rows = [{ Timeline: JSON.stringify({ accruingVotes: 123_456 }) }]
    expect(await port.readVotingClose('e1', 2)).to.equal(123_456)
    rows = [{ Timeline: '{not json' }]
    expect(await port.readVotingClose('e1', 2)).to.equal(null)
    rows = [{ BlockCid: 'cid-1' }]
    expect(await port.findRecordedVote('e1', 'b1', 'r1')).to.equal('cid-1')
    rows = []
    expect(await port.findRecordedVote('e1', 'b1', 'r1')).to.equal(null)

    expect(seen).to.have.length(6)
    const names = new Set(seen.flatMap(s => Object.keys(s.params)))
    expect([...names].sort()).to.deep.equal(['b', 'e', 'r', 'reg'])
    expect(seen[0]!.params).to.deep.equal({ e: 'e1', r: 2 })
    expect(seen[4]!.params).to.deep.equal({ e: 'e1', b: 'b1', reg: 'r1' })
  })

  function runDeps (over: Partial<RunVoteSendDeps> = {}): RunVoteSendDeps & { trace: string[] } {
    const trace: string[] = []
    const control = { dialProtocol: () => { trace.push('dial'); return new Promise<never>(() => {}) } }
    return {
      trace,
      node: { getControlNode: () => { trace.push('getControlNode'); return control } },
      readRendezvousAddrs: async () => { trace.push('readRendezvousAddrs'); return ['/dns4/a.example/tcp/1/ws'] },
      toDialTarget: (addr) => `dial:${addr}`,
      openRecord: async () => { trace.push('openRecord'); return { kind: 'ok', record: makeRecord() } },
      getPort: async () => { trace.push('getPort'); return recordingPort() },
      signingProducer: () => { trace.push('signingProducer'); throw new Error('no producer in this spec') },
      consentPrompt: { title: 'c', subtitle: 's', negativeButton: 'n' },
      sentStore: recordingSentStore(),
      send: async () => { trace.push('send'); return { ok: true, ballots: [] } },
      cancelSign: async () => false,
      canPrompt: () => true,
      nowMs: () => Date.now(),
      ...over,
    }
  }

  it('S5 runVoteSend refuses a missing debug sink before touching the node', async () => {
    const deps = runDeps()
    await rejectsTypeError(runVoteSend(deps, undefined as never))
    expect(deps.trace).to.deep.equal([])
  })

  it('S6 runVoteSend refuses a seams object without send before any dial', async () => {
    const deps = runDeps()
    const { send: _send, ...rest } = deps
    await rejectsTypeError(runVoteSend(rest as unknown as RunVoteSendDeps, recordingSink()))
    expect(deps.trace).to.deep.equal([])
  })

  it('S7 a null node is no-network and the rendezvous addresses are never read', async () => {
    const deps = runDeps({ node: null })
    expect(await runVoteSend(deps, recordingSink())).to.deep.equal({ kind: 'no-network' })
    expect(deps.trace).to.deep.equal([])
  })

  it('S8 an unanswered probe within the budget is rendezvous-unreachable, with no record open, port, producer or send', async () => {
    const sink = recordingSink()
    const deps = runDeps({ probeBudgetMs: 300 })
    const startedAt = Date.now()
    expect(await runVoteSend(deps, sink)).to.deep.equal({ kind: 'rendezvous-unreachable' })
    expect(Date.now() - startedAt).to.be.lessThan(5_000)
    expect(deps.trace).to.deep.equal(['getControlNode', 'readRendezvousAddrs', 'dial'])
    expect(sink.calls.map(c => c.event)).to.deep.equal(['flow-start', 'probe', 'flow-end'])
  })
})
