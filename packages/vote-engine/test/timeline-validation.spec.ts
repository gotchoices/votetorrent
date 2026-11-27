/**
 * timeline-validation.spec.ts -- the engine refuses, before any write, an election timeline the
 * Voter would refuse (todo 2026-10-29-engine-timeline-validation), and revokeKeyholder refuses a
 * caller who does not hold 'ik' (todo 2026-10-02-keyholder-delete-has-no-check-and-revoke-checks-no-permission).
 *
 * The rules themselves are pinned against the Voter's copy in
 * packages/ui-web/test/timeline-rules-parity.test.mjs; this file pins the write paths.
 */
import { expect } from 'chai'
import { BuilderValidationError } from '@votetorrent/vote-core'
import type { ElectionInit, KeyholderInvite } from '@votetorrent/vote-core'
import { ElectionEngine } from '../src/election/election-engine.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { ElectionsCreateElectionBuilder } from '../src/elections/builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from '../src/elections/builders/elections-adjust-election-builder.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { TimelineInvalidError, findBlockingTimelineConflicts } from '../src/election/timeline-rules.js'
import {
  addTestAuthority,
  addTestElection,
  createTestNetwork,
  makeDistinctTestUser,
  makeElectionInit,
  makeTestSignCallback,
  seedElectionSigning
} from './fixtures/test-context.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { inviteeContext, invitePrivateForSlot, mintInviteKeyPair } from './fixtures/invite-keys.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The shape that cost the 2026-10-29 phone run: preparation events weeks after voting starts. */
function phone4Timeline (init: ElectionInit): ElectionInit['revision']['timeline'] {
  const t = { ...init.revision.timeline }
  const votingStarts = Date.now() + 90 * 60_000
  t.registrationEnds = Date.now() + 25 * DAY
  t.ballotsFinal = init.election.ballotDeadline as number // equal to the deadline, so only the order is wrong
  t.votingStarts = votingStarts
  t.accruingVotes = votingStarts + HOUR
  t.hashingVotes = votingStarts + 2 * HOUR
  t.releasingKeys = votingStarts + 3 * HOUR
  t.tallyingStarts = votingStarts + 4 * HOUR
  t.validation = votingStarts + 5 * HOUR
  t.certificationStarts = votingStarts + 6 * HOUR
  t.closed = votingStarts + 7 * HOUR
  return t
}

async function caught (p: Promise<unknown>): Promise<unknown> {
  try { await p } catch (err) { return err }
  return undefined
}

describe('engine timeline validation (the rules the Voter applies)', () => {
  it('control: the fixture default timeline has no blocking conflict', () => {
    const init = makeElectionInit()
    expect(findBlockingTimelineConflicts(init.revision.timeline, init.election)).to.deep.equal([])
  })

  it('control: the fixture still produces a valid timeline when the election date is overridden', () => {
    const init = makeElectionInit({ date: Date.now() + 60 * DAY, ballotDeadline: Date.now() + 20 * DAY })
    expect(findBlockingTimelineConflicts(init.revision.timeline, init.election)).to.deep.equal([])
  })

  it('createElection refuses the phone4 timeline before writing anything, naming both events', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.timeline = phone4Timeline(init)
    const tid = await peekNextElectionTid(auth.ctx.db)
    const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)

    const err = await caught(new ElectionsEngine(auth.ctx).createElection(init, { signingNonce: nonce }))
    expect(err).to.be.instanceOf(TimelineInvalidError)
    expect((err as TimelineInvalidError).code).to.equal('timeline-invalid')
    expect((err as TimelineInvalidError).conflicts.map(c => `${c.code}(${c.event})`))
      .to.deep.equal(['OUT_OF_ORDER(registrationEnds)', 'OUT_OF_ORDER(ballotsFinal)', 'CLOSED_BEFORE_ELECTION_DATE(closed)'])
    const row = await auth.ctx.db.prepare('select Id from Election where Id = :id').get({ id: init.election.id })
    expect(row, 'no Election row was written').to.equal(undefined)
  })

  it('createElection refuses ballotsFinal after the election ballot deadline (cross-check)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.timeline = { ...init.revision.timeline, ballotsFinal: (init.election.ballotDeadline as number) + DAY }
    const err = await caught(new ElectionsEngine(auth.ctx).createElection(init, {}))
    expect((err as TimelineInvalidError).conflicts?.map(c => c.code)).to.deep.equal(['BALLOTS_FINAL_AFTER_DEADLINE'])
  })

  it('control: createElection still accepts the fixture timeline', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const row = await elec.ctx.db.prepare('select Id from Election where Id = :id').get({ id: 'election-1' })
    expect(row?.Id).to.equal('election-1')
  })

  it('adjustElection refuses a blocking timeline and writes no ProposedElection row', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.timeline = phone4Timeline(init)
    const err = await caught(new ElectionsEngine(elec.ctx).adjustElection(init))
    expect(err).to.be.instanceOf(TimelineInvalidError)
    const row = await elec.ctx.db.prepare('select Id from ProposedElection where Id = :id').get({ id: 'election-1' })
    expect(row, 'no ProposedElection row was written').to.equal(undefined)
  })

  it("proposeRevision cross-checks against the stored Election.Date: voting after election day is refused", async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const t = { ...init.revision.timeline }
    // Shift the whole timeline 10 days later: still in order, but voting now starts after election day.
    for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] = t[k] + 10 * DAY
    const engine = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, elec.ctx)
    const err = await caught(engine.proposeRevision({ ...init.revision, revision: 1, timeline: t }))
    expect(err).to.be.instanceOf(TimelineInvalidError)
    expect((err as TimelineInvalidError).conflicts.map(c => `${c.code}(${c.event})`)).to.include('EVENT_AFTER_ELECTION_DATE(votingStarts)')
    const row = await elec.ctx.db.prepare('select ElectionId from ProposedElectionRevision where ElectionId = :id').get({ id: 'election-1' })
    expect(row, 'no ProposedElectionRevision row was written').to.equal(undefined)
  })

  it('the create builder refuses the phone4 timeline in build(), so a screen can refuse before signing', () => {
    const init = makeElectionInit()
    init.revision.timeline = phone4Timeline(init)
    const builder = new ElectionsCreateElectionBuilder(new ElectionsEngine()).setElection(init.election).setRevision(init.revision)
    let err: unknown
    try { builder.build() } catch (e) { err = e }
    expect(err).to.be.instanceOf(BuilderValidationError)
    const codes = (err as BuilderValidationError).errors.map(e => `${e.code}@${e.path}`).filter(c => c.startsWith('TIMELINE_'))
    expect(codes).to.deep.equal([
      'TIMELINE_PREPARATION_AFTER_VOTING@revision.timeline.registrationEnds',
      'TIMELINE_PREPARATION_AFTER_VOTING@revision.timeline.ballotsFinal',
      'TIMELINE_CLOSED_BEFORE_ELECTION_DATE@revision.timeline.closed'
    ])
  })

  it('the adjust builder reports a ballots-final-after-deadline timeline', () => {
    const init = makeElectionInit()
    init.revision.timeline = { ...init.revision.timeline, ballotsFinal: (init.election.ballotDeadline as number) + DAY }
    const builder = new ElectionsAdjustElectionBuilder(new ElectionsEngine()).setElection(init.election).setRevision(init.revision)
    expect(builder.errors().map(e => e.code).filter(c => c.startsWith('TIMELINE_'))).to.deep.equal(['TIMELINE_BALLOTS_FINAL_AFTER_DEADLINE'])
  })

  it('a strict-chain order problem is reported once (as TIMELINE_ORDER), not twice', () => {
    const init = makeElectionInit()
    init.revision.timeline = { ...init.revision.timeline, closed: init.revision.timeline.certificationStarts - HOUR }
    const builder = new ElectionsCreateElectionBuilder(new ElectionsEngine()).setElection(init.election).setRevision(init.revision)
    expect(builder.errors().map(e => `${e.code}@${e.path}`).filter(c => c.startsWith('TIMELINE_'))).to.deep.equal(['TIMELINE_ORDER@revision.timeline.closed'])
  })
})

describe("revokeKeyholder requires a current officer holding 'ik'", () => {
  async function electionWithAcceptedKeyholder () {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const kh: KeyholderInvite = {
      name: 'KH1',
      type: 'k',
      expiration: new Date(Date.now() + HOUR).toISOString(),
      inviteKey: mintInviteKeyPair().inviteKey,
      inviteSignature: ''
    }
    await elec.electionEngine.inviteKeyholder(kh, 'election-1', makeTestSignCallback(auth.user))
    const slot = await elec.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = 'KH1'").get({})
    const cid = slot!.Cid as string
    await new InvitationEngine(inviteeContext(elec.ctx)).respondToInvite(cid, true, await invitePrivateForSlot(elec.ctx, cid), undefined, undefined, makeKeyholderProvisioning())
    return { auth, elec }
  }
  const revokeKH1 = { name: 'KH1', type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' } as KeyholderInvite

  it('a caller who is not an officer is refused with not-authorized and the Keyholder row stays', async () => {
    const { auth, elec } = await electionWithAcceptedKeyholder()
    const outsider = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, { ...elec.ctx, user: makeDistinctTestUser() })
    const err = await caught(outsider.revokeKeyholder(revokeKH1, 'election-1'))
    expect((err as { code?: string })?.code).to.equal('not-authorized')
    const row = await elec.ctx.db.prepare('select UserId from Keyholder where ElectionId = :id').get({ id: 'election-1' })
    expect(row, 'the Keyholder row is untouched').to.not.equal(undefined)
  })

  it('a caller with no bound user is refused with not-authorized', async () => {
    const { auth, elec } = await electionWithAcceptedKeyholder()
    const anonymous = new ElectionEngine({ id: 'election-1', authorityId: auth.authority.id }, { ...elec.ctx, user: undefined })
    const err = await caught(anonymous.revokeKeyholder(revokeKH1, 'election-1'))
    expect((err as { code?: string })?.code).to.equal('not-authorized')
  })

  it("control: the authority's 'ik' officer revokes, and the row is gone", async () => {
    const { elec } = await electionWithAcceptedKeyholder()
    await elec.electionEngine.revokeKeyholder(revokeKH1, 'election-1')
    const row = await elec.ctx.db.prepare('select UserId from Keyholder where ElectionId = :id').get({ id: 'election-1' })
    expect(row).to.equal(undefined)
  })
})
