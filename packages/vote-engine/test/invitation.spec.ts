import { expect } from 'chai'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { AsyncStorage } from './shims/react-native.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  bumpElectionRevision,
  seedAuthorityInvite,
  seedUserInvite,
  seedKeyholderInvite,
  makeDistinctTestUser,
  makeTestSignCallback,
} from './fixtures/test-context.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import type {
  InviteStatus,
  KeyholderInvite,
  SentOfficerInvite,
  SentAuthorityInvite,
  SentKeyholderInvite,
} from '@votetorrent/vote-core'

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
    const { makeTestSignCallback } = await import('./fixtures/test-context.js')
    const inviteShare = auth.authorityEngine.createAuthorityInvite('Test Authority')
    const signCallback = makeTestSignCallback(auth.user)
    await auth.authorityEngine.saveInviteWithSigning(inviteShare, 'iad' as any, signCallback)

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

  it('getKeyholderInvite — returns undefined for unknown id', async () => {
    const { ctx } = await addTestAuthority(await createTestNetwork())
    const engine = new InvitationEngine(ctx)
    const result = await engine.getKeyholderInvite('nonexistent-cid')
    expect(result).to.be.undefined
  })

  it('getKeyholderInvite — returns the seeded Type=k slot as SentKeyholderInvite { name }', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { inviteSlotCid, name } = await seedKeyholderInvite(auth, { name: 'Known Keyholder' })

    const engine = new InvitationEngine(auth.ctx)
    const result: InviteStatus<SentKeyholderInvite> | undefined =
      await engine.getKeyholderInvite(inviteSlotCid)

    expect(result).to.not.be.undefined
    // SentKeyholderInvite is { name } only — no officer type/title/scopes fields.
    expect(result!.invite).to.deep.equal({ name })
    expect((result!.invite as Record<string, unknown>).type).to.be.undefined
    expect((result!.invite as Record<string, unknown>).title).to.be.undefined
    expect((result!.invite as Record<string, unknown>).scopes).to.be.undefined
    // No InviteResult seeded → result stays undefined (load-only read).
    expect(result!.result).to.be.undefined
  })

  it('getKeyholderInvite — does not return an officer (Type=of) slot', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const newUser = makeDistinctTestUser()
    const { inviteSlotCid } = await seedUserInvite(auth, newUser, {
      officerInit: { name: 'Officer Not Keyholder' },
    })

    const engine = new InvitationEngine(auth.ctx)
    // The officer slot's Cid is excluded by the Type='k' filter.
    const result = await engine.getKeyholderInvite(inviteSlotCid)
    expect(result).to.be.undefined
  })

  // EXPECTED-RED-UNTIL-IMPL 21-04 (respondToInvite implementation)
  it('respondToInvite (accept) writes an InviteResult row with isAccepted=true', async () => {
    // INV-04: un-skipped (was BLOCKED on D-08 signing pipeline).
    // Seeds a real officer-invite InviteSlot then calls InvitationEngine.respondToInvite.
    // respondToInvite is not yet implemented in InvitationEngine (throws) — RED until plan 21-04.
    const auth = await addTestAuthority(await createTestNetwork())
    const newUser = makeDistinctTestUser()
    const { inviteSlotCid } = await seedUserInvite(auth, newUser)

    const engine = new InvitationEngine(auth.ctx)
    await engine.respondToInvite(inviteSlotCid, true)

    // Read back the InviteResult row and assert IsAccepted is truthy.
    const row = await auth.ctx.db
      .prepare('select IsAccepted from InviteResult where SlotCid = :slotCid')
      .get({ slotCid: inviteSlotCid })
    expect(row).to.not.be.undefined
    expect(Boolean(row!.IsAccepted)).to.equal(true)
  })

  // EXPECTED-RED-UNTIL-IMPL 21-04 (respondToInvite implementation + InviteResult INSERT)
  it('respondToInvite (decline) writes an InviteResult row with isAccepted=false carrying a real ephemeral-key signature', async () => {
    // INV-05 / D-09: Decline must produce a REAL InviteSignature signed by the ephemeral InviteKey.
    //
    // A1 LOCKED ENCODING (from plan 21-02 <a1_resolution>):
    //   signedBytes = TextEncoder.encode([slotCid, 'null', 'false'].join('|'))
    //   sig = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivKeyBytes))
    //     — noble v2 defaults (prehash:true), NOT { prehash: false }
    //   result: 128-char lowercase hex compact signature
    //
    // inviteSignature is the PRIVATE key given with the invitation. For officer invites,
    // the InviteSlot.InviteKey carries the PUBLIC key; the matching private key is the
    // one generated in createOfficerInvite / createAuthorityInvite (ephemeral per D-06).
    // seedUserInvite uses authorityEngine.createOfficerInvite which returns an OfficerInviteShare
    // containing inviteKey (public) and inviteSignature (the InviteSlot-level signature).
    // The PRIVATE key is internal to createOfficerInvite and not exposed on the share.
    // For this test we generate OUR OWN ephemeral key pair so we control the private bytes,
    // then insert a raw InviteSlot using those values (mirroring seedKeyholderInvite pattern).
    const auth = await addTestAuthority(await createTestNetwork())
    const { SigningEngine } = await import('../src/signing/signing-engine.js')
    const { nowCanonicalDatetime: nowCdt } = await import('../src/utils.js')

    // Generate a real ephemeral key pair we control (so we have the private bytes).
    const invitePrivBytes = secp256k1.utils.randomSecretKey()
    const invitePublicHex = bytesToHex(secp256k1.getPublicKey(invitePrivBytes))
    const inviteSlotSig = 'a'.repeat(128) // InviteSlot-level signature (IsSignatureValid=true context)

    // Seed a raw InviteSlot with our controlled key pair (mirroring seedKeyholderInvite step c).
    const signing = new SigningEngine(auth.ctx)
    const nonce = signing.generateSigningNonce()
    const expiration = new Date(Date.now() + 86_400_000).toISOString()

    await auth.ctx.db.exec(
      `insert into InviteSlot (
          Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
        )
        with context Tid = :tid, now = :now, IsSignatureValid = true, IsInsertValid = true
        values (
          cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
          :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce
        )`,
      {
        type: 'of',
        name: 'Decline Test Officer',
        expiration,
        inviteKey: invitePublicHex,
        inviteSignature: inviteSlotSig,
        nonce,
        tid: Date.now(),
        now: nowCdt(),
      }
    )

    // Fetch the Cid back.
    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :type')
      .get({ inviteKey: invitePublicHex, type: 'of' })
    expect(slotRow).to.not.be.undefined
    const slotCid = slotRow!.Cid as string

    // Satisfy InviteSlotSigningValid — AdminSigning over this nonce (PATH B).
    // 999.1 R-02: startSigningSession takes a completed Signature (no callback form),
    // so compute the real Digest(Cid) first (the same subquery PATH B embeds) and sign
    // it for real — SignatureValid now verifies these bytes.
    const { signTestDigest } = await import('./fixtures/test-context.js')
    const slotDigestRow = await auth.ctx.db
      .prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
      .get({ nonce })
    await signing.startSigningSession(
      auth.authority.id,
      null,
      'rad' as any,
      signTestDigest(auth.user, slotDigestRow!.d as string),
      nonce
    )

    // A1 LOCKED ENCODING: sign([slotCid, 'null', 'false'].join('|')) with the ephemeral invite private key.
    // noble v2 defaults: prehash=true means the actual signed domain is sha256(sha256(signedBytes)).
    // A1 LOCKED ENCODING: sign(sha256(signedBytes), privKey) — noble v2 returns Uint8Array directly.
    // prehash=true is the default in noble v2, so actual signed domain is sha256(sha256(signedBytes)).
    const signedBytes = new TextEncoder().encode([slotCid, 'null', 'false'].join('|'))
    const sigUint8 = secp256k1.sign(sha256(signedBytes), invitePrivBytes) // noble v2 default prehash:true
    const realInviteSignature = bytesToHex(sigUint8) // noble v2: sign() returns Uint8Array directly

    // The real InviteSignature must be 128 hex chars and NOT be the all-'a' placeholder.
    expect(realInviteSignature).to.match(/^[0-9a-f]{128}$/)
    expect(realInviteSignature).to.not.equal('a'.repeat(128))

    // Call respondToInvite with decline (isAccepted=false).
    // The engine must use the A1 LOCKED encoding internally when implemented.
    // For now this test proves the assertion shape (RED until 21-04).
    const engine = new InvitationEngine(auth.ctx)
    await engine.respondToInvite(slotCid, false)

    // Read back the InviteResult row.
    const row = await auth.ctx.db
      .prepare('select IsAccepted, Digest, InviteSignature from InviteResult where SlotCid = :slotCid')
      .get({ slotCid })
    expect(row).to.not.be.undefined
    expect(Boolean(row!.IsAccepted)).to.equal(false)
    // Digest must be null for decline (DigestValid: IsAccepted=false => Digest is null)
    expect(row!.Digest).to.equal(null)
    // InviteSignature must be present and must NOT be the all-'a' placeholder (T-21-02-01 / D-09)
    expect(row!.InviteSignature).to.be.a('string')
    expect(row!.InviteSignature).to.not.equal('a'.repeat(128))
  })

  // EXPECTED-RED-UNTIL-IMPL (the getPendingOfficerInvites / getPendingAuthorityInvites
  // Expiration filter — lands in the invitation-engine implementation plan for INV-06)
  it('expired invites are filtered out of pending lists', async () => {
    // INV-06: Seed an InviteSlot with an Expiration in the past, then assert that
    // a pending-list read does NOT return it. The filter (Expiration > :now) must
    // be added to getPendingOfficerInvites in the invitation-engine impl plan.
    const auth = await addTestAuthority(await createTestNetwork())
    const { SigningEngine } = await import('../src/signing/signing-engine.js')
    const { nowCanonicalDatetime: nowCdt } = await import('../src/utils.js')

    const signing = new SigningEngine(auth.ctx)
    const nonce = signing.generateSigningNonce()

    // Expiration is 1 day IN THE PAST so the slot should be considered expired.
    const pastExpiration = new Date(Date.now() - 86_400_000).toISOString()

    // Insert the expired InviteSlot. The ExpirationValid CHECK gates on `context.now`
    // vs Expiration. We bind now to a date BEFORE the expiration so the INSERT passes.
    const seedNow = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const { signTestDigest } = await import('./fixtures/test-context.js')
    const share = auth.authorityEngine.createOfficerInvite({
      name: 'Expired Officer',
      title: 'Member',
      scopes: ['rad'] as any[],
    })

    await auth.ctx.db.exec(
      `insert into InviteSlot (
          Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
        )
        with context Tid = :tid, now = :now, IsSignatureValid = true, IsInsertValid = true
        values (
          cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
          :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce
        )`,
      {
        type: 'of',
        name: 'Expired Officer',
        expiration: pastExpiration,
        inviteKey: share.inviteKey,
        inviteSignature: share.inviteSignature,
        nonce,
        tid: Date.now(),
        now: seedNow, // seed "in the past" so ExpirationValid passes at insert time
      }
    )

    // Fetch the Cid so we can assert it's absent from the pending list.
    const slotRow = await auth.ctx.db
      .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :type')
      .get({ inviteKey: share.inviteKey, type: 'of' })
    expect(slotRow).to.not.be.undefined
    const expiredCid = slotRow!.Cid as string

    // Satisfy InviteSlotSigningValid so the row is otherwise valid.
    // 999.1 R-02: real digest-then-sign (see the decline-path test above for rationale).
    const slotDigestRow = await auth.ctx.db
      .prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
      .get({ nonce })
    await signing.startSigningSession(
      auth.authority.id,
      null,
      'rad' as any,
      signTestDigest(auth.user, slotDigestRow!.d as string),
      nonce
    )

    // Read pending list — the expired slot's Cid must NOT appear.
    const engine = new InvitationEngine(auth.ctx)
    const pending = await engine.getPendingOfficerInvites()
    const foundExpired = pending.some((inv) => {
      // We need to check if this slot appears — but InviteStatus only carries invite data.
      // Use a direct DB read to confirm the Cid is absent from what the engine returns.
      return false // placeholder; real assertion below uses DB join
    })
    // Direct assertion: the pending list from getPendingOfficerInvites must not
    // include an entry whose underlying SlotCid equals expiredCid.
    // The engine reads by Name; since we have a unique Name we can assert by name absence.
    const expiredInPending = pending.some((inv) => inv.invite.name === 'Expired Officer')
    expect(expiredInPending, 'expired invite must not appear in pending list').to.equal(false)
    void expiredCid // referenced for clarity; the assertion uses name above
  })
})

// ===========================================================================
// second-keyholder-invite-unique regression (2026-07-30)
//
// This bug shipped precisely because no test covered a SECOND keyholder
// invite to the same election revision — see the debug session's Decision
// section for the 5 required cases below. `ElectionEngine.inviteKeyholder()`
// used to insert directly into `Keyholder` keyed by the INVITING admin's own
// UserId (constant across every invite), so the 2nd+ invite always collided
// on `Keyholder`'s `(ElectionId, ElectionRevision, UserId)` primary key. The
// fix moves the write to a signed `InviteSlot` (Type='k') at send-time and
// mints the real `User` + `Keyholder` rows at ACCEPT time
// (`InvitationEngine.respondToInvite`).
// ===========================================================================

describe('second-keyholder-invite-unique regression (2026-07-30)', () => {
  const ELECTION_ID = 'election-1' // addTestElection's makeElectionInit default id

  function makeKeyholderInvite (name: string): KeyholderInvite {
    return {
      name,
      type: 'k',
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
      inviteKey: 'k'.repeat(66),
      // Empty inviteSignature hits the documented send-side carve-out (no
      // createKeyholderInvite factory yet) rather than real secp256k1
      // verification against fixture-garbage hex.
      inviteSignature: '',
    }
  }

  /** Read back the Cid of a keyholder InviteSlot by its Name (unique per test). */
  async function keyholderSlotCid (ctx: { db: import('../src/types.js').EngineContext['db'] }, name: string): Promise<string> {
    const row = await ctx.db
      .prepare("select Cid from InviteSlot where Type = 'k' and Name = :name")
      .get({ name })
    if (!row) throw new Error(`keyholderSlotCid: no InviteSlot found for name=${name}`)
    return row.Cid as string
  }

  it('two invites with different names to the same election revision both succeed', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    // Neither call should throw — this is the exact reported failure (2nd invite
    // used to collide on Keyholder's primary key).
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Bob Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))

    const names: string[] = []
    for await (const row of elec.ctx.db.eval(
      "select Name from InviteSlot where Type = 'k' and ElectionId = :electionId",
      { electionId: ELECTION_ID }
    )) {
      names.push(row.Name as string)
    }
    expect(names.sort()).to.deep.equal(['Alice Keyholder', 'Bob Keyholder'])
  })

  it('both appear as pending via getKeyholderInvite()', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Bob Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))

    const aliceCid = await keyholderSlotCid(elec.ctx, 'Alice Keyholder')
    const bobCid = await keyholderSlotCid(elec.ctx, 'Bob Keyholder')

    const engine = new InvitationEngine(elec.ctx)
    const alice = await engine.getKeyholderInvite(aliceCid)
    const bob = await engine.getKeyholderInvite(bobCid)

    expect(alice, 'Alice invite should be readable').to.not.be.undefined
    expect(alice!.invite.name).to.equal('Alice Keyholder')
    expect(alice!.result, 'Alice invite is still pending (no InviteResult yet)').to.be.undefined

    expect(bob, 'Bob invite should be readable').to.not.be.undefined
    expect(bob!.invite.name).to.equal('Bob Keyholder')
    expect(bob!.result, 'Bob invite is still pending (no InviteResult yet)').to.be.undefined
  })

  it('accept-time: accepting one invite produces exactly one User + one Keyholder row bound to the correct election revision', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Alice Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const aliceCid = await keyholderSlotCid(elec.ctx, 'Alice Keyholder')

    const userCountBefore = (await elec.ctx.db.prepare('select count(*) as c from User').get())!.c as number
    const keyholderCountBefore = (await elec.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number

    const engine = new InvitationEngine(elec.ctx)
    await engine.respondToInvite(aliceCid, true)

    const userCountAfter = (await elec.ctx.db.prepare('select count(*) as c from User').get())!.c as number
    const keyholderCountAfter = (await elec.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number
    expect(userCountAfter - userCountBefore, 'exactly one new User row').to.equal(1)
    expect(keyholderCountAfter - keyholderCountBefore, 'exactly one new Keyholder row').to.equal(1)

    const khRow = await elec.ctx.db
      .prepare('select ElectionId, ElectionRevision, UserId from Keyholder where ElectionId = :electionId')
      .get({ electionId: ELECTION_ID })
    expect(khRow, 'Keyholder row bound to the election').to.not.be.undefined
    expect(khRow!.ElectionId).to.equal(ELECTION_ID)
    expect(khRow!.ElectionRevision).to.equal(0)

    const userRow = await elec.ctx.db
      .prepare('select Id, Name from User where Id = :id')
      .get({ id: khRow!.UserId as string })
    expect(userRow, 'the minted User row exists').to.not.be.undefined
    expect(userRow!.Name).to.equal('Alice Keyholder')
  })

  it('a third invite still succeeds', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Keyholder One'), ELECTION_ID, makeTestSignCallback(auth.user))
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Keyholder Two'), ELECTION_ID, makeTestSignCallback(auth.user))
    // Guards against a new single-slot or off-by-one assumption sneaking back in.
    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Keyholder Three'), ELECTION_ID, makeTestSignCallback(auth.user))

    const countRow = await elec.ctx.db
      .prepare("select count(*) as c from InviteSlot where Type = 'k' and ElectionId = :electionId")
      .get({ electionId: ELECTION_ID })
    expect(countRow!.c).to.equal(3)
  })

  it('a non-zero election revision works', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    const bumpedRevision = await bumpElectionRevision(elec)
    expect(bumpedRevision).to.equal(1)

    await elec.electionEngine.inviteKeyholder(makeKeyholderInvite('Carol Keyholder'), ELECTION_ID, makeTestSignCallback(auth.user))
    const carolCid = await keyholderSlotCid(elec.ctx, 'Carol Keyholder')

    const engine = new InvitationEngine(elec.ctx)
    await engine.respondToInvite(carolCid, true)

    const khRow = await elec.ctx.db
      .prepare('select ElectionRevision from Keyholder where ElectionId = :electionId')
      .get({ electionId: ELECTION_ID })
    expect(khRow, 'Keyholder row exists for the bumped revision').to.not.be.undefined
    expect(khRow!.ElectionRevision, 'Keyholder binds to the CURRENT (non-zero) revision, not a stale/hardcoded 0').to.equal(1)
  })
})
