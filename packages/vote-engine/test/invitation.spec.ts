import { expect } from 'chai'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { AsyncStorage } from './shims/react-native.js'
import {
  createTestNetwork,
  addTestAuthority,
  seedAuthorityInvite,
  seedUserInvite,
  makeDistinctTestUser,
} from './fixtures/test-context.js'
import type { InviteStatus, SentOfficerInvite, SentAuthorityInvite } from '@votetorrent/vote-core'

describe('InvitationEngine', () => {
  it('getPendingOfficerInvites — returns seeded officer invites', async () => {
    // createTestNetwork() calls AsyncStorage.clear() internally (D-03)
    const auth = await addTestAuthority(await createTestNetwork())
    const newUser = makeDistinctTestUser()
    await seedUserInvite(auth, newUser)

    const engine = new InvitationEngine(auth.ctx)
    const invites: Array<InviteStatus<SentOfficerInvite>> = await engine.getPendingOfficerInvites()
    expect(invites).to.be.an('array')
    expect(invites.length).to.be.greaterThan(0)
    const first = invites[0]
    expect(first).to.have.property('invite')
    expect(first!.invite.type).to.equal('of')
    expect(first!.invite.name).to.be.a('string')
  })

  it('getPendingAuthorityInvites — returns seeded authority invites', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    // seedAuthorityInvite seeds Type='au' InviteSlot and then calls respondToInvite
    // (inserting InviteResult). We need an InviteSlot WITHOUT an InviteResult to
    // appear in pending results. seedAuthorityInvite's full chain inserts InviteResult,
    // so we need a raw InviteSlot without the respondToInvite step.
    //
    // The authorityEngine exposes createAuthorityInvite + saveInviteWithSigning to
    // insert InviteSlot only — omitting respondToInvite keeps it pending.
    const { makeTestSignature } = await import('./fixtures/test-context.js')
    const inviteShare = auth.authorityEngine.createAuthorityInvite('Test Authority')
    const sig = makeTestSignature(auth.user)
    await auth.authorityEngine.saveInviteWithSigning(inviteShare, 'iad' as any, sig)

    const engine = new InvitationEngine(auth.ctx)
    const invites: Array<InviteStatus<SentAuthorityInvite>> = await engine.getPendingAuthorityInvites()
    expect(invites).to.be.an('array')
    expect(invites.length).to.be.greaterThan(0)
    const first = invites[0]
    expect(first).to.have.property('invite')
    expect(first!.invite.type).to.equal('au')
    expect(first!.invite.name).to.be.a('string')
  })

  it('getOfficerInvite — returns undefined for unknown id', async () => {
    const { ctx } = await addTestAuthority(await createTestNetwork())
    const engine = new InvitationEngine(ctx)
    const result = await engine.getOfficerInvite('nonexistent-cid')
    expect(result).to.be.undefined
  })

  it('getOfficerInvite — returns the seeded slot for a known cid', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const newUser = makeDistinctTestUser()
    const { inviteSlotCid } = await seedUserInvite(auth, newUser, {
      officerInit: { name: 'Known Officer' },
    })

    const engine = new InvitationEngine(auth.ctx)
    const result: InviteStatus<SentOfficerInvite> | undefined = await engine.getOfficerInvite(inviteSlotCid)
    expect(result).to.not.be.undefined
    expect(result!.invite.name).to.equal('Known Officer')
    expect(result!.invite.type).to.equal('of')
  })

  it.skip('respondToInvite — BLOCKED: InviteResult INSERT requires full secp256k1 invite signing pipeline (InviteSignature over H(SlotCid, Digest, IsAccepted)); implement after the invite signing pipeline is wired (D-08)', async () => {
    // BLOCKED: InviteResult INSERT requires full secp256k1 signing pipeline:
    //   - Generate InviteSignature = sign(H(SlotCid, Digest, IsAccepted)) using the ephemeral InviteKey private key
    //   - Bind context.IsSigningValid = true (requires AdminSigning row matching InviteSlot.SigningNonce + Digest(SlotCid))
    //   - Bind context.IsSignatureValid = true (requires verifying InviteSignature against InviteSlot.InviteKey)
    //   These constraints in InviteResult (SigningValid, SignatureValid) gate on the full secp256k1 invite-key pipeline
    //   which is deferred to a future phase per D-08.
    //   See packages/vote-core/schema/votetorrent.qsql InviteResult table (lines 419-433).
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new InvitationEngine(auth.ctx)
    await engine.respondToInvite('some-slot-cid', true)
  })
})
