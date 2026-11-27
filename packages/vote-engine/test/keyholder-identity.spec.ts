/**
 * keyholder-identity.spec.ts — phase 62 plan 09.
 *
 * D-21: fresh User per keyholder accept — invite-and-accept never reuses an
 * existing identity (not the inviting officer's, not another keyholder's).
 * D-27: ElectionEngine's revision reads join the real Keyholder table
 * instead of returning only the raw invitee JSON, and revokeKeyholder
 * deletes the resolved TARGET keyholder, never the caller.
 *
 * The D-21 cases pin behavior that already holds TODAY — they exercise
 * `InvitationEngine.respondToInvite`'s keyholder-mint branch (landed by the
 * second-keyholder-invite-unique fix), and are regression pins, not new
 * behavior. The D-27 'engine reads join the Keyholder table' and
 * 'revokeKeyholder deletes the target, not the caller' describe blocks
 * exercise NEW `election-engine.ts` code this plan adds
 * (`readRevisionKeyholders` / the `revokeKeyholder` target-resolution
 * rewrite) and were RED against the pre-this-plan engine — see the SUMMARY
 * for the exact RED run (titles that failed before the fix landed).
 *
 * Fixtures are built ONLY through real engine paths —
 * createTestNetwork/addTestAuthority/addTestElection,
 * `inviteKeyholder` + `InvitationEngine.respondToInvite`, and the
 * keyholder-persistence.spec.ts `createElection`-with-invitees seam. This
 * spec NEVER raw-inserts a `Keyholder` row: 62-02 changes
 * `Keyholder.InsertValid` next wave and must only have to update
 * `respondToInvite` for this spec to keep passing.
 */

import { expect } from 'chai'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback,
  makeElectionInit,
} from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { inviteeContext, invitePrivateForSlot, mintInviteKeyPair } from './fixtures/invite-keys.js'

const ELECTION_ID = 'election-1' // addTestElection's / makeElectionInit's default election id

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeKeyholderInvite (name: string, overrides?: Partial<KeyholderInvite>): KeyholderInvite {
  return {
    name,
    type: 'k',
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: mintInviteKeyPair().inviteKey,
    // Empty inviteSignature hits the documented send-side carve-out (no
    // createKeyholderInvite factory yet) rather than real secp256k1
    // verification against fixture-garbage hex — same as invitation.spec.ts.
    inviteSignature: '',
    ...overrides,
  }
}

/** Read back the Cid of a keyholder InviteSlot by Name (+ InviteKey when names collide). */
async function keyholderSlotCid (ctx: { db: EngineContext['db'] }, name: string, inviteKey?: string): Promise<string> {
  const row = inviteKey
    ? await ctx.db
      .prepare("select Cid from InviteSlot where Type = 'k' and Name = :name and InviteKey = :inviteKey")
      .get({ name, inviteKey })
    : await ctx.db
      .prepare("select Cid from InviteSlot where Type = 'k' and Name = :name")
      .get({ name })
  if (!row) throw new Error(`keyholderSlotCid: no InviteSlot found for name=${name}`)
  return row.Cid as string
}

/** Resolve the minted UserId + User.Name + Keyholder row for an already-accepted keyholder slot. */
async function readAcceptedKeyholder (
  ctx: { db: EngineContext['db'] },
  slotCid: string
): Promise<{ userId: string, userName: string | undefined, keyholderRow: Record<string, unknown> | undefined }> {
  const irRow = await ctx.db.prepare('select InvokedId from InviteResult where SlotCid = :slotCid').get({ slotCid })
  const userId = irRow?.InvokedId as string | undefined
  if (!userId) throw new Error(`readAcceptedKeyholder: no InviteResult.InvokedId for slotCid=${slotCid}`)
  const userRow = await ctx.db.prepare('select Id, Name from User where Id = :id').get({ id: userId })
  const keyholderRow = await ctx.db
    .prepare('select ElectionId, ElectionRevision, UserId from Keyholder where UserId = :id')
    .get({ id: userId })
  return { userId, userName: userRow?.Name as string | undefined, keyholderRow }
}

/** A name-only pending invitee for the create-time JSON column (blank invite placeholders — same shape CreateElectionScreen.tsx sends). */
function makePendingInvitee (name: string): KeyholderInvite {
  return { name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }
}

type SeedRevisionSeam = {
  seedElectionRevisionSigning(
    electionId: string,
    authorityId: string,
    revision: {
      revision: number
      revisionTimestamp: number
      tags: string[]
      instructions: string
      timeline: Record<string, number>
      keyholderThreshold: number
    },
    tid: number,
    sign: (digest: Uint8Array) => Promise<Signature>,
  ): Promise<string>
}

/**
 * Create an election through the real `createElection` seam (mirrors
 * keyholder-persistence.spec.ts) with `invitees` persisted into
 * `ElectionRevision.Keyholders`. Returns enough context to further
 * invite/accept real keyholders on top of it via `inviteKeyholder` +
 * `InvitationEngine.respondToInvite`.
 */
async function createElectionWithInvitees (invitees: string[]) {
  // Deliberately NO user override: createTestNetwork()'s default makeTestUser()
  // registers its generated private key under auth.user.id, keyed to the SAME
  // public key that lands in auth.user.activeKeys[0].key — so makeTestSignCallback
  // (used for every signing call below AND for the later inviteKeyholder calls
  // made against the returned electionEngine) always signs with the matching key.
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const electionsEngine = new ElectionsEngine(auth.ctx)

  const init = makeElectionInit({ authorityId: auth.authority.id })
  init.revision.keyholders = invitees.map(makePendingInvitee)
  const { election: e } = init
  const pastRevTimestamp = Date.now() - 1000

  const electionFields = {
    id: e.id,
    authorityId: e.authorityId,
    title: e.title,
    date: e.date,
    revisionDeadline: e.revisionDeadline,
    ballotDeadline: e.ballotDeadline,
    type: e.type,
  }
  const sign = makeTestSignCallback(auth.user)
  const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

  const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as unknown as SeedRevisionSeam).seedElectionRevisionSigning(
    e.id,
    e.authorityId,
    {
      revision: 0,
      revisionTimestamp: pastRevTimestamp,
      tags: init.revision.tags,
      instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>,
      keyholderThreshold: init.revision.keyholderThreshold,
    },
    revTid,
    sign
  )

  const initWithPastTs = {
    ...init,
    revision: { ...init.revision, revisionTimestamp: pastRevTimestamp },
  }
  await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })

  const electionEngine = await electionsEngine.openElection(e.id)
  return { auth, electionsEngine, electionEngine, electionId: e.id }
}

// ===========================================================================
// D-21: fresh User per keyholder accept
// ===========================================================================

describe('D-21: fresh User per keyholder accept', () => {
  it('two accepted keyholder invites mint distinct, non-officer Users with matching InvokedId', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Bob Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))

    const aliceCid = await keyholderSlotCid(elec.ctx, 'Alice Keyholder')
    const bobCid = await keyholderSlotCid(elec.ctx, 'Bob Keyholder')

    const invitationEngine = new InvitationEngine(inviteeContext(elec.ctx))
    await invitationEngine.respondToInvite(aliceCid, true, await invitePrivateForSlot(elec.ctx, aliceCid), undefined, undefined, makeKeyholderProvisioning())
    await invitationEngine.respondToInvite(bobCid, true, await invitePrivateForSlot(elec.ctx, bobCid), undefined, undefined, makeKeyholderProvisioning())

    const alice = await readAcceptedKeyholder(elec.ctx, aliceCid)
    const bob = await readAcceptedKeyholder(elec.ctx, bobCid)

    expect(alice.userId, 'Alice and Bob get distinct minted ids').to.not.equal(bob.userId)
    expect(alice.userId, "Alice's id is never the inviting officer's").to.not.equal(auth.user.id)
    expect(bob.userId, "Bob's id is never the inviting officer's").to.not.equal(auth.user.id)
    expect(alice.userName).to.equal('Alice Keyholder')
    expect(bob.userName).to.equal('Bob Keyholder')
    expect(alice.keyholderRow, 'Alice has a Keyholder row').to.not.be.undefined
    expect(bob.keyholderRow, 'Bob has a Keyholder row').to.not.be.undefined
    expect(alice.keyholderRow!.UserId, "InviteResult.InvokedId equals Alice's Keyholder.UserId").to.equal(alice.userId)
    expect(bob.keyholderRow!.UserId, "InviteResult.InvokedId equals Bob's Keyholder.UserId").to.equal(bob.userId)
  })

  it('passing the inviting officer id as invokedId rejects, and mints no Keyholder row for the officer id', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Eve Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const eveCid = await keyholderSlotCid(elec.ctx, 'Eve Keyholder')

    const invitationEngine = new InvitationEngine(inviteeContext(elec.ctx))
    // WR-R2-03: the fixture lookup runs OUTSIDE the try, so its own failure is never counted as the refusal.
    const invitePrivate = await invitePrivateForSlot(elec.ctx, eveCid)
    let caught: unknown
    try {
      // Reuse-attempt: pass the officer's own id as the accept-time invokedId.
      await invitationEngine.respondToInvite(eveCid, true, invitePrivate, undefined, auth.user.id, makeKeyholderProvisioning())
    } catch (err) {
      caught = err
    }
    expect(caught, 'reusing the officer id as invokedId must reject').to.not.be.undefined
    expect(String((caught as Error)?.message), 'refused by the User primary key, not an earlier refusal').to.match(/UNIQUE constraint failed: User PK/)

    const row = await elec.ctx.db
      .prepare('select count(*) as c from Keyholder where UserId = :officerId')
      .get({ officerId: auth.user.id })
    expect(row!.c, 'identity reuse is impossible: no Keyholder row for the officer id').to.equal(0)
  })
})

// ===========================================================================
// D-27: engine reads join the Keyholder table
// ===========================================================================

describe('D-27: engine reads join the Keyholder table', () => {
  it('read a: accepting a keyholder on a null-Keyholders-JSON election shows it with a result (and getRevisions agrees)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth) // addTestElection seeds ElectionRevision.Keyholders = null

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Carol Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const carolCid = await keyholderSlotCid(elec.ctx, 'Carol Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(elec.ctx))
    await invitationEngine.respondToInvite(carolCid, true, await invitePrivateForSlot(elec.ctx, carolCid), undefined, undefined, makeKeyholderProvisioning())

    const carol = await readAcceptedKeyholder(elec.ctx, carolCid)
    const irRow = await elec.ctx.db.prepare('select InviteSignature from InviteResult where SlotCid = :cid').get({ cid: carolCid })
    const slotRow = await elec.ctx.db.prepare('select Expiration from InviteSlot where Cid = :cid').get({ cid: carolCid })

    const details = await elec.electionEngine.getElectionDetails()
    expect(details.current.keyholders).to.deep.equal([
      {
        invite: { name: 'Carol Keyholder' },
        result: { isAccepted: true, invitationSignature: irRow!.InviteSignature as string, invokedId: carol.userId },
        sent: { state: 'answered', expiration: String(slotRow!.Expiration) },
      },
    ])

    // getRevisions() is a class-only helper (not on IElectionEngine) — construct
    // the concrete ElectionEngine directly, mirroring keyholder-persistence.spec.ts.
    const revisionsEngine = new ElectionEngine({ id: ELECTION_ID, authorityId: auth.authority.id }, elec.ctx)
    const revisions = await revisionsEngine.getRevisions()
    expect(revisions).to.have.length(1)
    expect(revisions[0]!.keyholders).to.deep.equal(details.current.keyholders)
  })

  it('read b: invitee JSON order is preserved; the accepted invitee carries a result, the pending one does not, no duplicate', async () => {
    const { auth, electionEngine, electionId } = await createElectionWithInvitees(['Alice Keyholder', 'Bob Keyholder'])

    await electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), electionId, makeTestSignCallback(auth.user))
    const aliceCid = await keyholderSlotCid(auth.ctx, 'Alice Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(auth.ctx))
    await invitationEngine.respondToInvite(aliceCid, true, await invitePrivateForSlot(auth.ctx, aliceCid), undefined, undefined, makeKeyholderProvisioning())

    const alice = await readAcceptedKeyholder(auth.ctx, aliceCid)
    const irRow = await auth.ctx.db.prepare('select InviteSignature from InviteResult where SlotCid = :cid').get({ cid: aliceCid })
    const slotRow = await auth.ctx.db.prepare('select Expiration from InviteSlot where Cid = :cid').get({ cid: aliceCid })

    const details = await electionEngine.getElectionDetails()
    expect(details.current.keyholders, 'invitee-JSON order preserved, no duplicate Alice entry').to.have.length(2)
    expect(details.current.keyholders[0]).to.deep.equal({
      invite: { name: 'Alice Keyholder' },
      result: { isAccepted: true, invitationSignature: irRow!.InviteSignature as string, invokedId: alice.userId },
      sent: { state: 'answered', expiration: String(slotRow!.Expiration) },
    })
    expect(details.current.keyholders[1], 'Bob is still pending — no result').to.deep.equal({
      invite: { name: 'Bob Keyholder' },
    })
  })

  it('read c: an accepted keyholder NOT in the invitee JSON is appended as an extra entry', async () => {
    const { auth, electionEngine, electionId } = await createElectionWithInvitees(['Alice Keyholder', 'Bob Keyholder'])

    await electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), electionId, makeTestSignCallback(auth.user))
    const aliceCid = await keyholderSlotCid(auth.ctx, 'Alice Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(auth.ctx))
    await invitationEngine.respondToInvite(aliceCid, true, await invitePrivateForSlot(auth.ctx, aliceCid), undefined, undefined, makeKeyholderProvisioning())

    await electionEngine.inviteKeyholder(makeKeyholderInvite('Dave Keyholder'), electionId, makeTestSignCallback(auth.user))
    const daveCid = await keyholderSlotCid(auth.ctx, 'Dave Keyholder')
    await invitationEngine.respondToInvite(daveCid, true, await invitePrivateForSlot(auth.ctx, daveCid), undefined, undefined, makeKeyholderProvisioning())
    const dave = await readAcceptedKeyholder(auth.ctx, daveCid)

    const details = await electionEngine.getElectionDetails()
    expect(details.current.keyholders, 'Alice, Bob (still pending) and Dave appended').to.have.length(3)
    expect(details.current.keyholders[2]!.invite.name).to.equal('Dave Keyholder')
    expect(details.current.keyholders[2]!.result, "Dave's entry carries a result even though he was never in the invitee JSON").to.not.be.undefined
    expect(details.current.keyholders[2]!.result!.invokedId).to.equal(dave.userId)
  })
})

// ===========================================================================
// revokeKeyholder deletes the target, not the caller
// ===========================================================================

describe('revokeKeyholder deletes the target, not the caller', () => {
  it('revoke a: revoking Alice by name deletes only her Keyholder row, leaving Bob', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Bob Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const aliceCid = await keyholderSlotCid(elec.ctx, 'Alice Keyholder')
    const bobCid = await keyholderSlotCid(elec.ctx, 'Bob Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(elec.ctx))
    await invitationEngine.respondToInvite(aliceCid, true, await invitePrivateForSlot(elec.ctx, aliceCid), undefined, undefined, makeKeyholderProvisioning())
    await invitationEngine.respondToInvite(bobCid, true, await invitePrivateForSlot(elec.ctx, bobCid), undefined, undefined, makeKeyholderProvisioning())

    const alice = await readAcceptedKeyholder(elec.ctx, aliceCid)
    const bob = await readAcceptedKeyholder(elec.ctx, bobCid)

    await elec.electionEngine.revokeKeyholder(
      { name: 'Alice Keyholder', type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' },
      ELECTION_ID
    )

    const aliceRow = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: alice.userId })
    const bobRow = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: bob.userId })
    expect(aliceRow, "Alice's Keyholder row is gone").to.be.undefined
    expect(bobRow, "Bob's Keyholder row remains").to.not.be.undefined
  })

  it('revoke b: an empty inviteKey rejects as ambiguous when two accepted invitees share a name; a non-empty one disambiguates', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    const keyA = mintInviteKeyPair().inviteKey
    const keyB = mintInviteKeyPair().inviteKey
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Dup Keyholder', { inviteKey: keyA }), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Dup Keyholder', { inviteKey: keyB }), ELECTION_ID, makeTestSignCallback(auth.user))
    const cidA = await keyholderSlotCid(elec.ctx, 'Dup Keyholder', keyA)
    const cidB = await keyholderSlotCid(elec.ctx, 'Dup Keyholder', keyB)
    const invitationEngine = new InvitationEngine(inviteeContext(elec.ctx))
    await invitationEngine.respondToInvite(cidA, true, await invitePrivateForSlot(elec.ctx, cidA), undefined, undefined, makeKeyholderProvisioning())
    await invitationEngine.respondToInvite(cidB, true, await invitePrivateForSlot(elec.ctx, cidB), undefined, undefined, makeKeyholderProvisioning())

    const dupA = await readAcceptedKeyholder(elec.ctx, cidA)
    const dupB = await readAcceptedKeyholder(elec.ctx, cidB)

    let ambiguousErr: unknown
    try {
      await elec.electionEngine.revokeKeyholder(
        { name: 'Dup Keyholder', type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' },
        ELECTION_ID
      )
    } catch (err) {
      ambiguousErr = err
    }
    expect((ambiguousErr as Error)?.message, 'an empty inviteKey cannot disambiguate two same-named accepted keyholders').to.include('ambiguous')

    const rowAStillThere = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: dupA.userId })
    const rowBStillThere = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: dupB.userId })
    expect(rowAStillThere, 'both rows remain after the ambiguous rejection').to.not.be.undefined
    expect(rowBStillThere, 'both rows remain after the ambiguous rejection').to.not.be.undefined

    await elec.electionEngine.revokeKeyholder(
      { name: 'Dup Keyholder', type: 'k', expiration: '0', inviteKey: keyA, inviteSignature: '' },
      ELECTION_ID
    )
    const rowAGone = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: dupA.userId })
    const rowBRemains = await elec.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: dupB.userId })
    expect(rowAGone, "the 'a' keyholder is gone").to.be.undefined
    expect(rowBRemains, "the 'b' keyholder remains untouched").to.not.be.undefined
  })

  it('revoke c: revoking a name with no accepted keyholder rejects, without deleting anything', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const aliceCid = await keyholderSlotCid(elec.ctx, 'Alice Keyholder')
    await new InvitationEngine(inviteeContext(elec.ctx)).respondToInvite(aliceCid, true, await invitePrivateForSlot(elec.ctx, aliceCid), undefined, undefined, makeKeyholderProvisioning())

    const countBefore = (await elec.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number

    let caught: unknown
    try {
      await elec.electionEngine.revokeKeyholder(
        { name: 'Nobody', type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' },
        ELECTION_ID
      )
    } catch (err) {
      caught = err
    }
    expect((caught as Error)?.message).to.include('no accepted keyholder')

    const countAfter = (await elec.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number
    expect(countAfter, 'nothing is deleted on rejection').to.equal(countBefore)
  })
})
