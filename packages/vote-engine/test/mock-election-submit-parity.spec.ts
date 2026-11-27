// mock-election-submit-parity.spec.ts — UAT 62 test 13 (62-55)
//
// MockElectionEngine.submitBallotForConfirmation must refuse a ballot id that was
// never proposed, exactly as the real ElectionEngine does (election-engine.ts
// `ProposedBallot not found: <id>`). Before 62-55 the mock skipped that check, which
// let jest pass a Submit button that fails on device.

import { expect } from 'chai'
import type { Ballot } from '@votetorrent/vote-core'
import { MockElectionEngine, MockBallotConfirmationState } from '../src/election/mock-election-engine.js'

function ballot (id: string): Ballot {
  return { id, electionId: 'e1', authorityId: 'a1', description: 'd', districts: [], questions: [] }
}

// The mock's ballot list is private; specs read it to prove a refusal wrote nothing.
function ballotsOf (engine: MockElectionEngine): Ballot[] {
  return (engine as unknown as { ballots: Ballot[] }).ballots
}

describe('MockElectionEngine submit parity (62-55)', () => {
  it('rejects a never-proposed id with the real engine message', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    let thrown: unknown
    try {
      await engine.submitBallotForConfirmation('never-proposed')
    } catch (e) {
      thrown = e
    }
    expect(thrown, 'submit of a never-proposed id must reject').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.equal('ProposedBallot not found: never-proposed')
    const state = await engine.getBallotConfirmationState('never-proposed')
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(state).to.deep.equal({ locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false })
  })

  it('accepts a proposed ballot and locks it; refuses a second submit', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b1'))
    await engine.submitBallotForConfirmation('b1')
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await engine.getBallotConfirmationState('b1')).to.deep.equal({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true })
    let msg = ''
    try {
      await engine.submitBallotForConfirmation('b1')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).to.match(/already submitted/)
  })

  it('withdraw returns a submitted ballot to unlocked; confirmed ballot refuses submit', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b2'))
    await engine.submitBallotForConfirmation('b2')
    await engine.withdrawBallotConfirmation('b2')
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await engine.getBallotConfirmationState('b2')).to.deep.equal({ locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false })
    engine.markBallotConfirmed('b2')
    let msg = ''
    try {
      await engine.submitBallotForConfirmation('b2')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).to.match(/already confirmed/)
  })

  it('refuses to re-propose a submitted ballot, leaving the entry unchanged', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b3'))
    await engine.submitBallotForConfirmation('b3')
    const before = JSON.stringify(ballotsOf(engine))
    let msg = ''
    try {
      await engine.proposeBallot({ ...ballot('b3'), description: 'changed' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).to.match(/out for confirmation/)
    expect(JSON.stringify(ballotsOf(engine))).to.equal(before)
  })

  it('refuses to re-propose a confirmed ballot', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b4'))
    await engine.submitBallotForConfirmation('b4')
    engine.markBallotConfirmed('b4')
    const before = JSON.stringify(ballotsOf(engine))
    let msg = ''
    try {
      await engine.proposeBallot({ ...ballot('b4'), description: 'changed' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).to.match(/already confirmed/)
    expect(JSON.stringify(ballotsOf(engine))).to.equal(before)
  })

  it('accepts a re-proposal after withdraw', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b5'))
    await engine.submitBallotForConfirmation('b5')
    await engine.withdrawBallotConfirmation('b5')
    await engine.proposeBallot({ ...ballot('b5'), description: 'after withdraw' })
    expect(ballotsOf(engine).find((b) => b.id === 'b5')?.description).to.equal('after withdraw')
  })
  it('P1: refuses submit with the real engine\'s fixed, id-free messages (WR-04)', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState())
    await engine.proposeBallot(ballot('b6'))
    await engine.submitBallotForConfirmation('b6')
    let submitted = ''
    try { await engine.submitBallotForConfirmation('b6') } catch (e) { submitted = (e as Error).message }
    expect(submitted).to.equal('This ballot is already submitted for confirmation.')
    engine.markBallotConfirmed('b6')
    let confirmed = ''
    try { await engine.submitBallotForConfirmation('b6') } catch (e) { confirmed = (e as Error).message }
    expect(confirmed).to.equal('This ballot is already confirmed.')
  })

  it('M-1: a withdraw by anyone but the submitter is refused with the real engine message (gap8/WR-03)', async () => {
    const engine = new MockElectionEngine(new MockBallotConfirmationState(), 'u1')
    await engine.proposeBallot(ballot('b7'))
    await engine.submitBallotForConfirmation('b7')
    engine.setCurrentUser('u2')
    expect(await engine.getBallotConfirmationState('b7')).to.deep.equal({
      locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: false,
    })
    let msg = ''
    try { await engine.withdrawBallotConfirmation('b7') } catch (e) { msg = (e as Error).message }
    expect(msg).to.equal('withdrawBallotConfirmation: Only the officer who submitted this ballot can withdraw it.')
    engine.setCurrentUser('u1')
    await engine.withdrawBallotConfirmation('b7')
    expect((await engine.getBallotConfirmationState('b7')).locked).to.equal(false)
  })

  it('M-2: a mock built with no user submits and withdraws as the default officer', async () => {
    const engine = new MockElectionEngine()
    await engine.proposeBallot(ballot('b8'))
    await engine.submitBallotForConfirmation('b8')
    expect((await engine.getBallotConfirmationState('b8')).canWithdraw).to.equal(true)
    await engine.withdrawBallotConfirmation('b8')
  })
})
