/**
 * keyholder-self-accept.spec.ts - the inviting officer's device cannot accept its own keyholder
 * invitation (gap6/WR-09, user decision 8b: no override), refused before the binding signature and
 * again inside the transaction; getKeyholderSlotSeat reports the seat facts the app checks before
 * any biometric prompt.
 */
import { expect } from 'chai'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import type { EngineContext } from '../src/types.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { makeChainFixture, sendInvite, countRows } from './fixtures/invite-chain.js'
import { inviteeContext } from './fixtures/invite-keys.js'
import { addTestElection, makeTestSignCallback } from './fixtures/test-context.js'
import type { ChainFixture } from './fixtures/invite-chain.js'

const elections = new WeakMap<ChainFixture, Awaited<ReturnType<typeof addTestElection>>>()

async function seedKeyholder (fx: ChainFixture, name: string) {
  let election = elections.get(fx)
  if (!election) { election = await addTestElection(fx.auth); elections.set(fx, election) }
  const { electionEngine } = election
  const priv = secp256k1.utils.randomSecretKey()
  const inviteKey = bytesToHex(secp256k1.getPublicKey(priv))
  const invite: KeyholderInvite = {
    name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey, inviteSignature: '',
  }
  const electionId = (await electionEngine.getElectionDetails()).election.id
  await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(fx.auth.user))
  const row = await fx.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  return { cid: row!.Cid as string, electionId, invitePrivate: bytesToHex(priv) }
}

function countingProvisioning (onSign?: () => void) {
  const base = makeKeyholderProvisioning()
  const counter = { calls: 0 }
  const provisioning = {
    ...base,
    sign: async (digest: Uint8Array): Promise<Signature> => { counter.calls += 1; onSign?.(); return base.sign(digest) },
  }
  return { provisioning, counter }
}

async function expectCode (promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  expect((caught as { code?: string }).code).to.equal(code)
}

async function expectNoRows (fx: ChainFixture, cid: string, userId: string): Promise<void> {
  expect(await countRows(fx, 'InviteResult', 'SlotCid', cid)).to.equal(0)
  expect(await countRows(fx, 'User', 'Id', userId)).to.equal(0)
  expect(await countRows(fx, 'UserKey', 'UserId', userId)).to.equal(0)
  expect(await countRows(fx, 'Keyholder', 'UserId', userId)).to.equal(0)
  expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(0)
}

describe('the inviting officer cannot accept their own keyholder seat (gap6/WR-09)', () => {
  it('C1: the inviter context is refused self-invite before the binding signature; zero rows', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Self Keyholder')
    expect(fx.auth.ctx.user, 'fixture inviter context must carry the officer').to.not.equal(undefined)
    const { provisioning, counter } = countingProvisioning()
    const userId = crypto.randomUUID()
    await expectCode(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning), 'self-invite')
    expect(counter.calls).to.equal(0)
    await expectNoRows(fx, s.cid, userId)
  })

  it('C2: the in-transaction re-check refuses an identity that changed during the signing prompt', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Drift Keyholder')
    const ictx = inviteeContext(fx.auth.ctx) as EngineContext
    const engine = new InvitationEngine(ictx)
    const { provisioning, counter } = countingProvisioning(() => { ictx.user = fx.auth.user })
    const userId = crypto.randomUUID()
    await expectCode(engine.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning), 'self-invite')
    expect(counter.calls).to.equal(1)
    await expectNoRows(fx, s.cid, userId)
  })

  it('C3: positive controls - an invitee context and a different officer both accept', async () => {
    const fx = await makeChainFixture()
    const a = await seedKeyholder(fx, 'Invitee Keyholder')
    const userA = crypto.randomUUID()
    await fx.inviteeInvitation.respondToInvite(a.cid, true, a.invitePrivate, undefined, userA, makeKeyholderProvisioning())
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userA)).to.equal(1)

    const b = await seedKeyholder(fx, 'Other Officer Keyholder')
    const other = new InvitationEngine({ db: fx.auth.ctx.db, user: { ...fx.auth.user, id: crypto.randomUUID() } } as EngineContext)
    const userB = crypto.randomUUID()
    await other.respondToInvite(b.cid, true, b.invitePrivate, undefined, userB, makeKeyholderProvisioning())
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userB)).to.equal(1)
  })

  it('C4: a decline from the inviter context still succeeds (a decline takes no seat)', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Declined Keyholder')
    await fx.invitation.respondToInvite(s.cid, false, s.invitePrivate)
    expect(await countRows(fx, 'InviteResult', 'SlotCid', s.cid)).to.equal(1)
  })
})

describe('getKeyholderSlotSeat', () => {
  it('K1: reports the election and whether the caller sent the seat', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Seat Keyholder')
    expect(await fx.invitation.getKeyholderSlotSeat(s.cid)).to.deep.equal({ electionId: s.electionId, selfInvite: true })
    expect(await fx.inviteeInvitation.getKeyholderSlotSeat(s.cid)).to.deep.equal({ electionId: s.electionId, selfInvite: false })
  })

  it('K2: an officer slot or an unknown cid has no seat', async () => {
    const fx = await makeChainFixture()
    const of = await sendInvite(fx, 'of')
    expect(await fx.invitation.getKeyholderSlotSeat(of.cid)).to.equal(undefined)
    expect(await fx.invitation.getKeyholderSlotSeat('bafy-no-such-cid')).to.equal(undefined)
  })
})
