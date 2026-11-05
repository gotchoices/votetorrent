/**
 * invite-slot-resolution.spec.ts - InvitationEngine.resolveInviteSlotCid against the real schema.
 * The invitee holds only the share (invitePrivate/inviteKey/type); the slot Cid is resolved by
 * (InviteKey, Type), never recomputed.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { KeyholderInvite } from '@votetorrent/vote-core'
import { nowCanonicalDatetime } from '../src/utils.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { MockInvitationEngine } from '../src/invite/mock-invitation-engine.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { makeChainFixture, sendInvite, insertExpiredSlot, writeRawMarker, resendTime, dayAfter, markerRows, resultRows, insertRawChainRow, countRows } from './fixtures/invite-chain.js'
import { createTestNetwork, addTestAuthority, addTestElection, makeTestSignCallback } from './fixtures/test-context.js'
import { inviteeContext } from './fixtures/invite-keys.js'

function makeKeypair () {
  const priv = secp256k1.utils.randomSecretKey()
  return { invitePrivate: bytesToHex(priv), inviteKey: bytesToHex(secp256k1.getPublicKey(priv)) }
}

async function seed (name: string) {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { electionEngine } = await addTestElection(auth)
  const kp = makeKeypair()
  const invite: KeyholderInvite = {
    name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: kp.inviteKey, inviteSignature: '',
  }
  const electionId = (await electionEngine.getElectionDetails()).election.id
  await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(auth.user))
  const row = await auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  return { auth, kp, cid: row!.Cid as string, engine: new InvitationEngine(auth.ctx), inviteeEngine: new InvitationEngine(inviteeContext(auth.ctx)) }
}

describe('resolveInviteSlotCid', () => {
  it('resolves the real slot Cid by (InviteKey, Type k)', async () => {
    const s = await seed('Resolve Keyholder')
    expect(await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'k')).to.equal(s.cid)
  })

  it('returns undefined for the wrong type', async () => {
    const s = await seed('Wrong Type Keyholder')
    expect(await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'of')).to.equal(undefined)
  })

  it('returns undefined for an unknown key', async () => {
    const s = await seed('Unknown Key Keyholder')
    expect(await s.engine.resolveInviteSlotCid(makeKeypair().inviteKey, 'k')).to.equal(undefined)
  })

  it('end to end: the resolved Cid accepts with the share private key', async () => {
    const s = await seed('E2E Keyholder')
    const cid = await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'k')
    expect(cid).to.equal(s.cid)
    const provisioning = makeKeyholderProvisioning()
    const userId = crypto.randomUUID()
    await s.inviteeEngine.respondToInvite(cid!, true, s.kp.invitePrivate, undefined, userId, provisioning)
    const ir = await s.auth.ctx.db.prepare('select InvokedId from InviteResult where SlotCid = :cid').get({ cid })
    expect(ir?.InvokedId).to.equal(userId)
  })

  it('mock engine seeds no slots and resolves undefined', async () => {
    expect(await new MockInvitationEngine().resolveInviteSlotCid('a'.repeat(66), 'k')).to.equal(undefined)
  })
})

describe('resend chain and liveness (CR-01, CR-02)', () => {
  it('a never-resent officer share resolves live to its only slot (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: s.cid })
    expect(await fx.invitation.resolveInviteSlotCid(s.inviteKey, 'of')).to.equal(s.cid)
  })

  it('after a resend the officer share resolves live to the resend head (CR-01)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: s.cid })
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
    expect(await fx.invitation.resolveInviteSlotCid(s.inviteKey, 'of')).to.equal(head)
  })

  it('after two resends the newest copy is the head', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const r1 = await fx.authority.resendInvite(s.cid)
    const r2 = await fx.authority.resendInvite(r1)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: r2 })
  })

  it('after a resend the authority share resolves live to the resend head', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'au')
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'au')).to.deep.equal({ status: 'live', cid: s.cid })
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'au')).to.deep.equal({ status: 'live', cid: head })
  })

  it('an answered head reports answered and resolveInviteSlotCid is undefined', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'answered', cid: head })
    expect(await fx.invitation.resolveInviteSlotCid(s.inviteKey, 'of')).to.equal(undefined)
  })

  it('a declined original poisons the chain even after a resend', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.invitation.respondToInvite(s.cid, false, s.invitePrivate)
    // resendInvite now refuses an answered chain (CR-01), so the late copy arrives as a raw (replicated) row.
    await insertRawChainRow(fx, s, { resendSalt: `resend|999999020|${nowCanonicalDatetime()}` })
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('answered')
  })

  it('a cancelled single slot is no-longer-valid', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.authority.cancelInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
    expect(await fx.invitation.resolveInviteSlotCid(s.inviteKey, 'of')).to.equal(undefined)
  })

  it('cancel then resend resolves live to the new copy (SURF-03 workflow preserved)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('no-longer-valid')
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
  })

  it('a cancelled head is no-longer-valid; the resolver never falls back to an older row', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.authority.cancelInvite(head)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
  })

  it('backstop: a non-head marker newer than the head closes the share', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
    await writeRawMarker(fx, s.cid, dayAfter(await resendTime(fx, head)))
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
  })

  it('backstop positive control: a non-head marker older than the head stays live', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await writeRawMarker(fx, s.cid, '2000-01-01T00:00:00')
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
  })

  it('an expired slot is no-longer-valid while a live sibling on the same db stays live', async () => {
    const fx = await makeChainFixture()
    const live = await sendInvite(fx, 'of')
    const expired = await insertExpiredSlot(fx)
    expect(await fx.invitation.resolveInviteSlot(live.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: live.cid })
    expect(await fx.invitation.resolveInviteSlot(expired.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
    expect(await fx.invitation.resolveInviteSlotCid(expired.inviteKey, 'of')).to.equal(undefined)
  })

  it('unknown key and wrong type are not-found', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.invitation.resolveInviteSlot(makeKeypair().inviteKey, 'of')).to.deep.equal({ status: 'not-found' })
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'au')).to.deep.equal({ status: 'not-found' })
  })

  it('mock engine resolveInviteSlot is not-found', async () => {
    expect(await new MockInvitationEngine().resolveInviteSlot('a'.repeat(66), 'of')).to.deep.equal({ status: 'not-found' })
  })
})

describe('cancelInvite withdraws the whole resend chain (CR-02)', () => {
  it('send, resend, cancel the ORIGINAL: both rows cancelled and the share is no-longer-valid', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
    await fx.authority.cancelInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
    expect(await markerRows(fx, [s.cid, head])).to.equal(2)
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending).to.not.include(s.cid)
    expect(pending).to.not.include(head)
  })

  it('send, resend, cancel the HEAD: markers on both Cids and no-longer-valid', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.authority.cancelInvite(head)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
    expect(await markerRows(fx, [s.cid, head])).to.equal(2)
  })

  it('send, resend, resend, cancel the MIDDLE: markers on all three Cids', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const r1 = await fx.authority.resendInvite(s.cid)
    const r2 = await fx.authority.resendInvite(r1)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: r2 })
    await fx.authority.cancelInvite(r1)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'no-longer-valid' })
    expect(await markerRows(fx, [s.cid, r1, r2])).to.equal(3)
  })

  it('cancel then resend still resolves live to the new copy (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
  })

  it('re-issue after a whole-chain withdrawal resolves live to the new resend', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.resendInvite(s.cid)
    await fx.authority.cancelInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('no-longer-valid')
    const fresh = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: fresh })
  })

  it('a chain cancel never touches another share of the same authority', async () => {
    const fx = await makeChainFixture()
    const a = await sendInvite(fx, 'of')
    const b = await sendInvite(fx, 'of')
    await fx.authority.resendInvite(a.cid)
    await fx.authority.cancelInvite(a.cid)
    expect((await fx.invitation.resolveInviteSlot(a.inviteKey, 'of')).status).to.equal('no-longer-valid')
    expect(await fx.invitation.resolveInviteSlot(b.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: b.cid })
    expect(await fx.authority.getPendingInviteCids()).to.include(b.cid)
    expect(await markerRows(fx, [b.cid])).to.equal(0)
  })

  it('cancelling an already-cancelled share is an idempotent no-op; an unknown Cid still throws', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    await fx.authority.cancelInvite(s.cid)
    expect(await markerRows(fx, [s.cid])).to.equal(1)
    let threw = false
    try { await fx.authority.cancelInvite('nonexistent-cid') } catch { threw = true }
    expect(threw).to.equal(true)
  })
})

const ANSWERED_CODE = 'invite-already-answered'

async function expectAnsweredRefusal (promise: Promise<unknown>): Promise<void> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  expect((caught as Error).message).to.match(/already been answered/)
  expect((caught as { code?: unknown }).code).to.equal(ANSWERED_CODE)
}

async function slotRowCount (fx: Awaited<ReturnType<typeof makeChainFixture>>, inviteKey: string): Promise<number> {
  return countRows(fx, 'InviteSlot', 'InviteKey', inviteKey)
}

describe('an answered invitation is closed on the officer side (CR-01)', () => {
  it('C1: send, resend, accept the head: not pending, and cancel/resend of either row are refused with no write', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    const before = await fx.authority.getPendingInviteCids()
    expect(before).to.include(head)
    expect(before).to.not.include(s.cid)
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    const after = await fx.authority.getPendingInviteCids()
    expect(after).to.not.include(s.cid)
    expect(after).to.not.include(head)
    await expectAnsweredRefusal(fx.authority.cancelInvite(s.cid))
    await expectAnsweredRefusal(fx.authority.cancelInvite(head))
    await expectAnsweredRefusal(fx.authority.resendInvite(s.cid))
    await expectAnsweredRefusal(fx.authority.resendInvite(head))
    expect(await markerRows(fx, [s.cid, head])).to.equal(0)
    expect(await slotRowCount(fx, s.inviteKey)).to.equal(2)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'answered', cid: head })
  })

  it('C2: a declined invitation is closed the same way', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.authority.getPendingInviteCids()).to.include(s.cid)
    await fx.invitation.respondToInvite(s.cid, false, s.invitePrivate)
    expect(await fx.authority.getPendingInviteCids()).to.not.include(s.cid)
    await expectAnsweredRefusal(fx.authority.cancelInvite(s.cid))
    await expectAnsweredRefusal(fx.authority.resendInvite(s.cid))
    expect(await markerRows(fx, [s.cid])).to.equal(0)
    expect(await slotRowCount(fx, s.inviteKey)).to.equal(1)
  })

  it('C3: an accepted invitation with no resend cannot be cancelled', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.authority.getPendingInviteCids()).to.include(s.cid)
    await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
    expect(await fx.authority.getPendingInviteCids()).to.not.include(s.cid)
    await expectAnsweredRefusal(fx.authority.cancelInvite(s.cid))
    expect(await markerRows(fx, [s.cid])).to.equal(0)
  })

  it('C4: an unanswered chain is still cancellable and re-sendable (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await fx.authority.cancelInvite(s.cid)
    expect(await markerRows(fx, [s.cid, head])).to.equal(2)
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending).to.not.include(s.cid)
    expect(pending).to.not.include(head)

    const t = await sendInvite(fx, 'of')
    const h1 = await fx.authority.resendInvite(t.cid)
    const h2 = await fx.authority.resendInvite(t.cid)
    expect(h2).to.not.equal(h1)
    const list = await fx.authority.getPendingInviteCids()
    expect(list.filter(c => [t.cid, h1, h2].includes(c))).to.deep.equal([h2])
  })

  it('C5: send, cancel, resend yields a listed, acceptable head that closes once answered', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    const head = await fx.authority.resendInvite(s.cid)
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending).to.include(head)
    expect(pending).to.not.include(s.cid)
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid, head])).to.equal(1)
    const after = await fx.authority.getPendingInviteCids()
    expect(after).to.not.include(head)
    await expectAnsweredRefusal(fx.authority.cancelInvite(head))
  })

  it('C6: answering one invitation leaves an unrelated one listed once and cancellable', async () => {
    const fx = await makeChainFixture()
    const a = await sendInvite(fx, 'of')
    const b = await sendInvite(fx, 'of')
    await fx.invitation.respondToInvite(a.cid, true, a.invitePrivate)
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending.filter(c => c === b.cid)).to.have.length(1)
    expect(pending).to.not.include(a.cid)
    await fx.authority.cancelInvite(b.cid)
    expect(await markerRows(fx, [b.cid])).to.equal(1)
    expect(await fx.invitation.resolveInviteSlot(a.inviteKey, 'of')).to.deep.equal({ status: 'answered', cid: a.cid })
  })

  it('C7: the pending list applies the chain rule (a backstop marker closes the listed head)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.authority.getPendingInviteCids()).to.include(head)
    await writeRawMarker(fx, s.cid, dayAfter(await resendTime(fx, head)))
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending).to.not.include(s.cid)
    expect(pending).to.not.include(head)
  })

  it('C8: an expired head is not listed', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect(await fx.authority.getPendingInviteCids()).to.include(s.cid)
    const expiredHead = await insertRawChainRow(fx, s, {
      resendSalt: 'resend|999999010|2000-01-01T00:00:00',
      expiration: '2000-01-02T00:00:00',
      contextNow: '2000-01-01T00:00:00',
    })
    const pending = await fx.authority.getPendingInviteCids()
    expect(pending).to.not.include(s.cid)
    expect(pending).to.not.include(expiredHead)
  })
})
