/**
 * Phase 08 Plan 03 -- ElectionEngine builder tests (BUILD-ELEC-02).
 * 4 builder describe blocks: ElectionProposeBallotBuilder,
 * ElectionProposeRevisionBuilder, ElectionInviteKeyholderBuilder,
 * ElectionRevokeKeyholderBuilder.
 */
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionEvent,
  ElectionType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { ElectionProposeBallotBuilder } from '../src/election/builders/election-propose-ballot-builder.js'
import { ElectionProposeRevisionBuilder } from '../src/election/builders/election-propose-revision-builder.js'
import { ElectionInviteKeyholderBuilder } from '../src/election/builders/election-invite-keyholder-builder.js'
import { ElectionRevokeKeyholderBuilder } from '../src/election/builders/election-revoke-keyholder-builder.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import type { ElectionSubject } from '../src/election/election-engine.js'
import { MockElectionEngine } from '../src/election/mock-election-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection } from './fixtures/test-context.js'
import type {
  Ballot,
  ElectionRevisionInit,
  IElectionEngine,
  KeyholderInvite,
  Question
} from '@votetorrent/vote-core'

// Shared ElectionSubject fixture for real-engine tests
const testElectionSubject: ElectionSubject = { id: 'election-1', authorityId: 'authority-1' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubElectionEngine (): IElectionEngine {
  return {
    proposeBallot: async () => {},
    proposeRevision: async () => {},
    inviteKeyholder: async () => {},
    revokeKeyholder: async () => {},
    getBallotDetails: async () => { throw new Error('stub') },
    getBallots: async () => [],
    getElectionDetails: async () => { throw new Error('stub') },
    buildProposeBallot: () => { throw new Error('stub') },
    buildProposeRevision: () => { throw new Error('stub') },
    buildInviteKeyholder: () => { throw new Error('stub') },
    buildRevokeKeyholder: () => { throw new Error('stub') }
  }
}

function makeQuestion (code = 'q1'): Question {
  return {
    code,
    title: `Question ${code}`,
    instructions: 'Pick one',
    options: [{ code: 'opt1', title: 'Option 1' }],
    type: 'select'
  }
}

function makeBallot (overrides?: Partial<Ballot>): Ballot {
  return {
    id: 'ballot-1',
    electionId: 'election-1',
    authorityId: 'authority-1',
    description: 'Test ballot',
    districts: ['d1'],
    questions: [makeQuestion()],
    ...overrides
  }
}

function makeElectionRevisionInit (overrides?: Partial<ElectionRevisionInit>): ElectionRevisionInit {
  const now = Date.now()
  return {
    electionId: 'election-1',
    revision: 1,
    revisionTimestamp: now,
    tags: ['test'],
    instructions: '# Revision',
    keyholders: [],
    timeline: {
      [ElectionEvent.registrationEnds]: now + 25 * 86_400_000,
      [ElectionEvent.ballotsFinal]: now + 14 * 86_400_000,
      [ElectionEvent.votingStarts]: now + 28 * 86_400_000,
      [ElectionEvent.tallyingStarts]: now + 30 * 86_400_000,
      [ElectionEvent.validation]: now + 31 * 86_400_000,
      [ElectionEvent.certificationStarts]: now + 32 * 86_400_000,
      [ElectionEvent.closed]: now + 33 * 86_400_000
    },
    keyholderThreshold: 0,
    ...overrides
  }
}

function makeKeyholderInvite (overrides?: Partial<KeyholderInvite>): KeyholderInvite {
  return {
    name: 'KH1',
    type: 'au',
    expiration: '0',
    inviteKey: 'k'.repeat(66),
    inviteSignature: 's'.repeat(128),
    ...overrides
  } as KeyholderInvite
}

// ===========================================================================
// ElectionProposeBallotBuilder — BUILD-ELEC-02
// ===========================================================================

describe('ElectionProposeBallotBuilder', () => {
  const stubEngine = makeStubElectionEngine()

  it('empty builder is invalid with expected missingFields', () => {
    const b = new ElectionProposeBallotBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('id')
    expect(paths).to.include('electionId')
    expect(paths).to.include('authorityId')
    expect(paths).to.include('description')
    expect(paths).to.include('questions')
  })

  it('per-setter validation rejects empty id', () => {
    const b = new ElectionProposeBallotBuilder(stubEngine).setId('')
    const errs = b.errors().filter(e => e.path === 'id' && e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
  })

  it('errors/missingFields progression', () => {
    const b = new ElectionProposeBallotBuilder(stubEngine)
      .setId('b1')
      .setElectionId('e1')
    const missing = b.missingFields().map(m => m.path)
    expect(missing).to.not.include('id')
    expect(missing).to.not.include('electionId')
    expect(missing).to.include('authorityId')
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionProposeBallotBuilder(engine).fromPayload(makeBallot({ authorityId: auth.authority.id }))
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization + fromJSON rejection', () => {
    const ballot = makeBallot()
    const b = new ElectionProposeBallotBuilder(stubEngine).fromPayload(ballot)
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionProposeBallotBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
    expect(() => ElectionProposeBallotBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stubEngine))
      .to.throw(/unknown kind/)
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionProposeBallotBuilder(engine).fromPayload(makeBallot({ authorityId: auth.authority.id }))
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape + incomplete rejection', () => {
    const ballot = makeBallot()
    const b = new ElectionProposeBallotBuilder(stubEngine).fromPayload(ballot)
    const input = b.toEngineInput()
    expect(input.id).to.equal('ballot-1')
    expect(input.questions).to.have.length(1)
    expect(() => new ElectionProposeBallotBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit guard', async () => {
    const b = new ElectionProposeBallotBuilder(stubEngine).fromPayload(makeBallot())
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.proposeBallot(ballot) vs builder.fromPayload(ballot).commit()', async () => {
    // Direct path
    const net1 = await createTestNetwork()
    const auth1 = await addTestAuthority(net1)
    const elCtx1 = await addTestElection(auth1)
    const engine1 = new ElectionEngine({ id: 'election-1', authorityId: auth1.authority.id }, elCtx1.ctx)
    const ballot1 = makeBallot({ authorityId: auth1.authority.id })
    let err1: unknown
    try { await engine1.proposeBallot(ballot1) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    // Builder path
    const net2 = await createTestNetwork()
    const auth2 = await addTestAuthority(net2)
    const elCtx2 = await addTestElection(auth2)
    const engine2 = new ElectionEngine({ id: 'election-1', authorityId: auth2.authority.id }, elCtx2.ctx)
    const ballot2 = makeBallot({ authorityId: auth2.authority.id })
    let err2: unknown
    try { await engine2.buildProposeBallot().fromPayload(ballot2).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockElectionEngine returns instanceof ElectionProposeBallotBuilder', () => {
    const mock = new MockElectionEngine()
    expect(mock.buildProposeBallot()).to.be.instanceOf(ElectionProposeBallotBuilder)
  })

  it('cross-field: empty questions array surfaces NO_QUESTIONS error', () => {
    const ballot = makeBallot({ questions: [] })
    const b = new ElectionProposeBallotBuilder(stubEngine).fromPayload(ballot)
    const errs = b.errors().filter(e => e.code === 'NO_QUESTIONS')
    expect(errs.length).to.equal(1)
    expect(errs[0].kind).to.equal('cross-field')
  })
})

// ===========================================================================
// ElectionProposeRevisionBuilder — BUILD-ELEC-02
// ===========================================================================

describe('ElectionProposeRevisionBuilder', () => {
  const stubEngine = makeStubElectionEngine()

  it('empty builder is invalid with expected missingFields', () => {
    const b = new ElectionProposeRevisionBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('electionId')
    expect(paths).to.include('revision')
    expect(paths).to.include('keyholders')
    expect(paths).to.include('timeline')
    expect(paths).to.include('keyholderThreshold')
  })

  it('per-setter validation rejects empty electionId', () => {
    const b = new ElectionProposeRevisionBuilder(stubEngine).setElectionId('')
    const errs = b.errors().filter(e => e.path === 'electionId' && e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
  })

  it('errors/missingFields progression', () => {
    const rev = makeElectionRevisionInit()
    const b = new ElectionProposeRevisionBuilder(stubEngine)
      .setElectionId(rev.electionId)
      .setRevision(rev.revision)
    const missing = b.missingFields().map(m => m.path)
    expect(missing).to.not.include('electionId')
    expect(missing).to.not.include('revision')
    expect(missing).to.include('keyholders')
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionProposeRevisionBuilder(engine).fromPayload(makeElectionRevisionInit())
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization', () => {
    const rev = makeElectionRevisionInit()
    const b = new ElectionProposeRevisionBuilder(stubEngine).fromPayload(rev)
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionProposeRevisionBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionProposeRevisionBuilder(engine).fromPayload(makeElectionRevisionInit())
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape + incomplete rejection', () => {
    const rev = makeElectionRevisionInit()
    const b = new ElectionProposeRevisionBuilder(stubEngine).fromPayload(rev)
    const input = b.toEngineInput()
    expect(input.electionId).to.equal('election-1')
    expect(() => new ElectionProposeRevisionBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit guard', async () => {
    const rev = makeElectionRevisionInit()
    const b = new ElectionProposeRevisionBuilder(stubEngine).fromPayload(rev)
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.proposeRevision(rev) vs builder.fromPayload(rev).commit()', async () => {
    const rev = makeElectionRevisionInit()
    // Direct path
    const net1 = await createTestNetwork()
    const auth1 = await addTestAuthority(net1)
    const elCtx1 = await addTestElection(auth1)
    const engine1 = new ElectionEngine({ id: 'election-1', authorityId: auth1.authority.id }, elCtx1.ctx)
    let err1: unknown
    try { await engine1.proposeRevision(rev) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    // Builder path
    const net2 = await createTestNetwork()
    const auth2 = await addTestAuthority(net2)
    const elCtx2 = await addTestElection(auth2)
    const engine2 = new ElectionEngine({ id: 'election-1', authorityId: auth2.authority.id }, elCtx2.ctx)
    let err2: unknown
    try { await engine2.buildProposeRevision().fromPayload(rev).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockElectionEngine returns instanceof ElectionProposeRevisionBuilder', () => {
    const mock = new MockElectionEngine()
    expect(mock.buildProposeRevision()).to.be.instanceOf(ElectionProposeRevisionBuilder)
  })

  it('cross-field: keyholderThreshold > keyholders.length surfaces error', () => {
    const rev = makeElectionRevisionInit({ keyholderThreshold: 5, keyholders: [] })
    const b = new ElectionProposeRevisionBuilder(stubEngine).fromPayload(rev)
    const errs = b.errors().filter(e => e.code === 'THRESHOLD_EXCEEDS_KEYHOLDERS')
    expect(errs.length).to.equal(1)
    expect(errs[0].kind).to.equal('cross-field')
  })

  it('cross-field: timeline order violation surfaces TIMELINE_ORDER error', () => {
    const now = Date.now()
    const rev = makeElectionRevisionInit({
      timeline: {
        [ElectionEvent.registrationEnds]: now + 1,
        [ElectionEvent.ballotsFinal]: now + 2,
        [ElectionEvent.votingStarts]: now + 30,
        [ElectionEvent.tallyingStarts]: now + 10, // BEFORE votingStarts end — wrong
        [ElectionEvent.validation]: now + 31,
        [ElectionEvent.certificationStarts]: now + 32,
        [ElectionEvent.closed]: now + 33
      }
    })
    const b = new ElectionProposeRevisionBuilder(stubEngine).fromPayload(rev)
    const errs = b.errors().filter(e => e.code === 'TIMELINE_ORDER')
    expect(errs.length).to.be.greaterThan(0)
  })
})

// ===========================================================================
// ElectionInviteKeyholderBuilder — BUILD-ELEC-02
// ===========================================================================

describe('ElectionInviteKeyholderBuilder', () => {
  const stubEngine = makeStubElectionEngine()

  it('empty builder is invalid with missingFields=[keyholder, electionId]', () => {
    const b = new ElectionInviteKeyholderBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.deep.equal(['keyholder', 'electionId'])
  })

  it('per-setter validation rejects empty keyholder.name', () => {
    const kh = makeKeyholderInvite({ name: '' })
    const b = new ElectionInviteKeyholderBuilder(stubEngine).setKeyholder(kh)
    const errs = b.errors().filter(e => e.path === 'keyholder.name' && e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
  })

  it('errors/missingFields progression', () => {
    const b = new ElectionInviteKeyholderBuilder(stubEngine)
      .setKeyholder(makeKeyholderInvite())
    const missing = b.missingFields().map(m => m.path)
    expect(missing).to.deep.equal(['electionId'])
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionInviteKeyholderBuilder(engine).fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'election-1' })
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization', () => {
    const b = new ElectionInviteKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionInviteKeyholderBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elCtx = await addTestElection(auth)
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elCtx.ctx)
    const b = new ElectionInviteKeyholderBuilder(engine).fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'election-1' })
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape + incomplete rejection', () => {
    const b = new ElectionInviteKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    const input = b.toEngineInput()
    expect(input.keyholder.name).to.equal('KH1')
    expect(input.electionId).to.equal('e1')
    expect(() => new ElectionInviteKeyholderBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit guard', async () => {
    const b = new ElectionInviteKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.inviteKeyholder(payload) vs builder.fromPayload(payload).commit()', async () => {
    const payload = { keyholder: makeKeyholderInvite(), electionId: 'election-1' }
    // Direct path
    const net1 = await createTestNetwork()
    const auth1 = await addTestAuthority(net1)
    const elCtx1 = await addTestElection(auth1)
    const engine1 = new ElectionEngine({ id: 'election-1', authorityId: auth1.authority.id }, elCtx1.ctx)
    let err1: unknown
    try { await engine1.inviteKeyholder(payload.keyholder, payload.electionId) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    // Builder path
    const net2 = await createTestNetwork()
    const auth2 = await addTestAuthority(net2)
    const elCtx2 = await addTestElection(auth2)
    const engine2 = new ElectionEngine({ id: 'election-1', authorityId: auth2.authority.id }, elCtx2.ctx)
    let err2: unknown
    try { await engine2.buildInviteKeyholder().fromPayload(payload).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockElectionEngine returns instanceof ElectionInviteKeyholderBuilder', () => {
    const mock = new MockElectionEngine()
    expect(mock.buildInviteKeyholder()).to.be.instanceOf(ElectionInviteKeyholderBuilder)
  })
})

// ===========================================================================
// ElectionRevokeKeyholderBuilder — BUILD-ELEC-02
// ===========================================================================

describe('ElectionRevokeKeyholderBuilder', () => {
  const stubEngine = makeStubElectionEngine()

  it('empty builder is invalid with missingFields=[keyholder, electionId]', () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.deep.equal(['keyholder', 'electionId'])
  })

  it('per-setter validation rejects empty electionId', () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine).setElectionId('')
    const errs = b.errors().filter(e => e.path === 'electionId' && e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
  })

  it('errors/missingFields progression', () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine)
      .setKeyholder(makeKeyholderInvite())
      .setElectionId('e1')
    const missing = b.missingFields()
    expect(missing.length).to.equal(0)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const { ctx } = await createTestNetwork()
    const engine = new ElectionEngine(testElectionSubject, ctx)
    const b = new ElectionRevokeKeyholderBuilder(engine).fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'election-1' })
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization', () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionRevokeKeyholderBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const { ctx } = await createTestNetwork()
    const engine = new ElectionEngine(testElectionSubject, ctx)
    const b = new ElectionRevokeKeyholderBuilder(engine).fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'election-1' })
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape + incomplete rejection', () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    const input = b.toEngineInput()
    expect(input.keyholder.name).to.equal('KH1')
    expect(input.electionId).to.equal('e1')
    expect(() => new ElectionRevokeKeyholderBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit guard', async () => {
    const b = new ElectionRevokeKeyholderBuilder(stubEngine)
      .fromPayload({ keyholder: makeKeyholderInvite(), electionId: 'e1' })
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.revokeKeyholder(payload) vs builder.fromPayload(payload).commit()', async () => {
    const payload = { keyholder: makeKeyholderInvite(), electionId: 'election-1' }
    const { ctx: ctx1 } = await createTestNetwork()
    const engine1 = new ElectionEngine(testElectionSubject, ctx1)
    let err1: unknown
    try { await engine1.revokeKeyholder(payload.keyholder, payload.electionId) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { ctx: ctx2 } = await createTestNetwork()
    const engine2 = new ElectionEngine(testElectionSubject, ctx2)
    let err2: unknown
    try { await engine2.buildRevokeKeyholder().fromPayload(payload).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockElectionEngine returns instanceof ElectionRevokeKeyholderBuilder', () => {
    const mock = new MockElectionEngine()
    expect(mock.buildRevokeKeyholder()).to.be.instanceOf(ElectionRevokeKeyholderBuilder)
  })
})
