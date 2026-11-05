/**
 * invite-respond-liveness.spec.ts - InvitationEngine.respondToInvite refuses a slot that is not the live
 * head of its share's chain (cancelled, expired, superseded, answered) BEFORE keyholder.sign and BEFORE
 * any write (CR-02 engine backstop). Every refusal has a positive control on the same kind of fixture.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { makeChainFixture, sendInvite, insertRawChainRow, insertExpiredSlot, writeRawMarker, resendTime, dayAfter, resultRows, countRows } from './fixtures/invite-chain.js'
import { addTestElection, makeTestSignCallback } from './fixtures/test-context.js'
import type { ChainFixture } from './fixtures/invite-chain.js'

async function expectRefusal (promise: Promise<unknown>, message: RegExp): Promise<void> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  expect((caught as Error).message).to.match(message)
}

async function seedKeyholder (fx: ChainFixture, name: string) {
  const { electionEngine } = await addTestElection(fx.auth)
  const priv = secp256k1.utils.randomSecretKey()
  const inviteKey = bytesToHex(secp256k1.getPublicKey(priv))
  const invite: KeyholderInvite = {
    name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey, inviteSignature: '',
  }
  const electionId = (await electionEngine.getElectionDetails()).election.id
  await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(fx.auth.user))
  const row = await fx.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  return { cid: row!.Cid as string, inviteKey, invitePrivate: bytesToHex(priv) }
}

function countingProvisioning () {
  const base = makeKeyholderProvisioning()
  const counter = { calls: 0 }
  const provisioning = {
    ...base,
    sign: async (digest: Uint8Array): Promise<Signature> => { counter.calls += 1; return base.sign(digest) },
  }
  return { provisioning, counter }
}

const WITHDRAWN = /withdrawn or has expired/

describe('respondToInvite liveness (CR-02)', () => {
  it('live officer slot with no resend accepts (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid])).to.equal(1)
  })

  it('cancelled officer slot: accept throws and writes no InviteResult', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.authority.cancelInvite(s.cid)
    await expectRefusal(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [s.cid])).to.equal(0)
  })

  it('cancelled officer slot: decline also throws and writes no InviteResult', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    await expectRefusal(fx.invitation.respondToInvite(s.cid, false, s.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [s.cid])).to.equal(0)
  })

  it('expired officer slot: accept throws with no InviteResult; a live sibling still accepts', async () => {
    const fx = await makeChainFixture()
    const live = await sendInvite(fx, 'of')
    const expired = await insertExpiredSlot(fx)
    await expectRefusal(fx.invitation.respondToInvite(expired.cid, true, expired.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [expired.cid])).to.equal(0)
    await fx.invitation.respondToInvite(live.cid, true, live.invitePrivate)
    expect(await resultRows(fx, [live.cid])).to.equal(1)
  })

  it('cancelled keyholder slot: sign never called, no InviteResult / User / UserKey / Keyholder / binding rows', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Cancelled Keyholder')
    await fx.authority.cancelInvite(s.cid)
    const { provisioning, counter } = countingProvisioning()
    const userId = crypto.randomUUID()
    await expectRefusal(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning), WITHDRAWN)
    expect(counter.calls).to.equal(0)
    expect(await countRows(fx, 'InviteResult', 'SlotCid', s.cid)).to.equal(0)
    expect(await countRows(fx, 'User', 'Id', userId)).to.equal(0)
    expect(await countRows(fx, 'UserKey', 'UserId', userId)).to.equal(0)
    expect(await countRows(fx, 'Keyholder', 'UserId', userId)).to.equal(0)
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(0)
  })

  it('live keyholder slot accepts and signs exactly once (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Live Keyholder')
    const { provisioning, counter } = countingProvisioning()
    const userId = crypto.randomUUID()
    await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning)
    expect(counter.calls).to.equal(1)
    expect(await countRows(fx, 'User', 'Id', userId)).to.equal(1)
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(1)
  })

  it('send, resend, cancel the ORIGINAL: accepting the head throws and nothing is written', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect(await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).to.deep.equal({ status: 'live', cid: head })
    await fx.authority.cancelInvite(s.cid)
    await expectRefusal(fx.invitation.respondToInvite(head, true, s.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [s.cid, head])).to.equal(0)
  })

  it('send, resend, cancel the HEAD: accepting the original throws and nothing is written', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await fx.authority.cancelInvite(head)
    await expectRefusal(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [s.cid, head])).to.equal(0)
  })

  it('cancel then resend: accepting the new head succeeds (re-issue after withdrawal)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    const head = await fx.authority.resendInvite(s.cid)
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid, head])).to.equal(1)
  })

  it('backstop: a partial marker newer than the head refuses the head', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    await writeRawMarker(fx, s.cid, dayAfter(await resendTime(fx, head)))
    await expectRefusal(fx.invitation.respondToInvite(head, true, s.invitePrivate), WITHDRAWN)
    expect(await resultRows(fx, [s.cid, head])).to.equal(0)
  })

  it('a superseded original is refused; the head on the same chain accepts', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await expectRefusal(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), /replaced by a newer copy/)
    expect(await resultRows(fx, [s.cid, head])).to.equal(0)
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid, head])).to.equal(1)
  })

  it('after the head is answered, the original is refused: one InviteResult across the chain', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await fx.invitation.respondToInvite(head, true, s.invitePrivate)
    await expectRefusal(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), /already been answered/)
    await expectRefusal(fx.invitation.respondToInvite(head, true, s.invitePrivate), /already been answered/)
    expect(await resultRows(fx, [s.cid, head])).to.equal(1)
  })

  it('a cancellation landing while the keyholder signing prompt is open is refused inside the transaction (WR-08)', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Race Keyholder')
    const base = makeKeyholderProvisioning()
    const counter = { calls: 0 }
    // keyholder.sign is caller-supplied and awaited before BEGIN: this is the real window (a cancel
    // replicated or tapped while the biometric prompt is open).
    const provisioning = {
      ...base,
      sign: async (digest: Uint8Array): Promise<Signature> => {
        counter.calls += 1
        await fx.authority.cancelInvite(s.cid)
        return base.sign(digest)
      },
    }
    const userId = crypto.randomUUID()
    await expectRefusal(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning), WITHDRAWN)
    expect(counter.calls).to.equal(1)
    expect(await countRows(fx, 'InviteCancellation', 'SlotCid', s.cid)).to.equal(1)
    expect(await countRows(fx, 'InviteResult', 'SlotCid', s.cid)).to.equal(0)
    expect(await countRows(fx, 'User', 'Id', userId)).to.equal(0)
    expect(await countRows(fx, 'UserKey', 'UserId', userId)).to.equal(0)
    expect(await countRows(fx, 'Keyholder', 'UserId', userId)).to.equal(0)
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(0)
  })

  it('the same signing wrapper without a cancellation accepts (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Race Control Keyholder')
    const base = makeKeyholderProvisioning()
    const provisioning = {
      ...base,
      sign: async (digest: Uint8Array): Promise<Signature> => {
        await Promise.resolve()
        return base.sign(digest)
      },
    }
    const userId = crypto.randomUUID()
    await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, userId, provisioning)
    expect(await countRows(fx, 'User', 'Id', userId)).to.equal(1)
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(1)
  })
})

async function expectCode (promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  expect((caught as { code?: string }).code).to.equal(code)
}

describe('respondToInvite requires the invite key (WR-05) and refusals carry codes (WR-01)', () => {
  it('no key: refused invite-key-required, nothing written (officer slot)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const keyless = fx.invitation.respondToInvite as unknown as (cid: string, accept: boolean) => Promise<void>
    await expectCode(keyless.call(fx.invitation, s.cid, true), 'invite-key-required')
    expect(await resultRows(fx, [s.cid])).to.equal(0)
  })

  it('no key on a keyholder slot: refused, sign never called, no rows', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Keyless Keyholder')
    const { provisioning, counter } = countingProvisioning()
    const userId = crypto.randomUUID()
    const keyless = fx.inviteeInvitation.respondToInvite as unknown as (...a: unknown[]) => Promise<void>
    await expectCode(keyless.call(fx.inviteeInvitation, s.cid, true, undefined, undefined, userId, provisioning), 'invite-key-required')
    expect(counter.calls).to.equal(0)
    expect(await countRows(fx, 'InviteResult', 'SlotCid', s.cid)).to.equal(0)
    expect(await countRows(fx, 'User', 'Id', userId)).to.equal(0)
    expect(await countRows(fx, 'Keyholder', 'UserId', userId)).to.equal(0)
    expect(await countRows(fx, 'KeyholderDkgBinding', 'UserId', userId)).to.equal(0)
  })

  it('malformed key: refused invite-key-required', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await expectCode(fx.invitation.respondToInvite(s.cid, true, 'zz'), 'invite-key-required')
    expect(await resultRows(fx, [s.cid])).to.equal(0)
  })

  it('a valid key that is not the slot key: invite-signature-invalid for accept and decline, no row', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const other = bytesToHex(secp256k1.utils.randomSecretKey())
    await expectCode(fx.invitation.respondToInvite(s.cid, true, other), 'invite-signature-invalid')
    await expectCode(fx.invitation.respondToInvite(s.cid, false, other), 'invite-signature-invalid')
    expect(await resultRows(fx, [s.cid])).to.equal(0)
    await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
    expect(await resultRows(fx, [s.cid])).to.equal(1)
  })

  it('wrong key on a keyholder slot: refused before the binding signature', async () => {
    const fx = await makeChainFixture()
    const s = await seedKeyholder(fx, 'Wrong Key Keyholder')
    const { provisioning, counter } = countingProvisioning()
    const other = bytesToHex(secp256k1.utils.randomSecretKey())
    await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, other, undefined, crypto.randomUUID(), provisioning), 'invite-signature-invalid')
    expect(counter.calls).to.equal(0)
    expect(await countRows(fx, 'InviteResult', 'SlotCid', s.cid)).to.equal(0)
  })

  it('answered -> invite-already-answered', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.invitation.respondToInvite(s.cid, true, s.invitePrivate)
    await expectCode(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), 'invite-already-answered')
  })

  it('withdrawn -> invite-no-longer-valid', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.cancelInvite(s.cid)
    await expectCode(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), 'invite-no-longer-valid')
  })

  it('superseded -> invite-superseded', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    await fx.authority.resendInvite(s.cid)
    await expectCode(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), 'invite-superseded')
  })

  it('ambiguous chain -> invite-unverifiable', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const salt = `resend|999999104|2030-01-01T00:00:00`
    const a = await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin one' })
    await insertRawChainRow(fx, s, { resendSalt: salt, name: 'Twin two' })
    await expectCode(fx.invitation.respondToInvite(a, true, s.invitePrivate), 'invite-unverifiable')
  })
})
