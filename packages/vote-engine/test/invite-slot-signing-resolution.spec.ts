/**
 * Targeted spec for InviteSlotSigningValid assertion resolution on quereus 4.x
 *
 * Three behaviors:
 *
 * Test 1 (resolution): saveInviteWithSigning commits without throwing
 *   "No row context found for column Digest" — this was the failure mode
 *   before the InviteSlotSigningValid schema rewrite (derived-alias SND.Digest
 *   could not be resolved by the 4.x per-tuple residual executor).
 *
 * Test 2 (batch-level rejection): an AdminSigning whose Digest matches NO
 *   InviteSlot in its SigningNonce-batch is rejected. This is what the assertion
 *   actually guarantees on quereus 4.x: every present AdminSigning must be
 *   satisfiable by at least one slot in its nonce-batch.
 *
 * Test 3 (batch-level boundary — documented, NOT a per-slot guard): when two
 *   slots share a SigningNonce and the AdminSigning.Digest matches ONE of them,
 *   the OTHER slot is accepted even though its own Cid was never signed. This is
 *   the deliberate batch-level semantics that supports resendInvite (a fresh
 *   slot reuses the original nonce/signature). It is NOT a per-slot binding —
 *   see CR-01 follow-up (todo: invite-slot-signing-per-slot-invariant) for the
 *   real per-slot signing-invariant design (needs engine-level changes binding
 *   AdminSigning.Digest to the slot; AdminSigning.Digest is a Digest(Tid,…fields)
 *   payload digest, not Digest(InviteSlot.Cid)).
 *
 * Phase 33 Plan 02 — RED gate (TDD). Tests 1–2 must fail before the
 * votetorrent.qsql rewrite and pass after it; Test 3 documents the accepted
 * boundary on the post-rewrite (batch-level) assertion.
 */

import { expect } from 'chai'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import { makeTestSignature } from './fixtures/test-context.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import type { Scope } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up a fresh TestAuthorityContext for each test */
async function setup (): Promise<TestAuthorityContext> {
  const net = await createTestNetwork()
  return addTestAuthority(net)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('InviteSlotSigningValid assertion resolution (Phase 33 — 4.x fix)', function () {
  this.timeout(30_000)

  // -------------------------------------------------------------------------
  // Test 1: saveInviteWithSigning resolves without "No row context found for
  // column Digest" error — the core regression guard for the 4.x rewrite.
  // -------------------------------------------------------------------------

  it('saveInviteWithSigning commits without No-row-context-for-Digest error (officer invite)', async () => {
    const auth = await setup()

    // createOfficerInvite + saveInviteWithSigning is the path that fires the
    // InviteSlotSigningValid global assertion.
    const officerInvite = auth.authorityEngine.createOfficerInvite({
      name: 'Test Officer',
      title: 'Member',
      scopes: ['rad'] as Scope[],
    })

    const sig = makeTestSignature(auth.user)

    // Before the schema fix this throws:
    //   QuereusError: No row context found for column Digest
    // After the fix it must resolve cleanly.
    let errorThrown: Error | undefined
    try {
      await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, sig)
    } catch (e) {
      errorThrown = e as Error
    }

    expect(errorThrown, `saveInviteWithSigning threw unexpectedly: ${errorThrown?.message}`).to.be.undefined
  })

  it('saveInviteWithSigning commits without No-row-context-for-Digest error (authority invite)', async () => {
    const auth = await setup()

    const authorityInvite = auth.authorityEngine.createAuthorityInvite('Second Authority')

    const sig = makeTestSignature(auth.user)

    // Both authority invite and officer invite paths call saveInviteWithSigning
    // and both fire InviteSlotSigningValid.
    let errorThrown: Error | undefined
    try {
      await auth.authorityEngine.saveInviteWithSigning(authorityInvite, 'iad' as Scope, sig)
    } catch (e) {
      errorThrown = e as Error
    }

    expect(errorThrown, `saveInviteWithSigning threw unexpectedly: ${errorThrown?.message}`).to.be.undefined
  })

  // -------------------------------------------------------------------------
  // Test 2: Batch-level rejection — an AdminSigning whose Digest matches NO
  // slot in its SigningNonce-batch is rejected by InviteSlotSigningValid.
  //
  // Strategy: insert a single InviteSlot with a known SigningNonce, then insert
  // an AdminSigning whose Digest does NOT match Digest(InviteSlot.Cid). With
  // only one slot in the batch and no match, the assertion must fire.
  // (This is the guarantee the batch-level assertion DOES enforce. It is NOT a
  // per-slot binding — see Test 3 for the accepted boundary, and the CR-01
  // follow-up for the real per-slot invariant.)
  // -------------------------------------------------------------------------

  it('InviteSlotSigningValid rejects an AdminSigning Digest that matches no slot in its nonce-batch', async () => {
    const auth = await setup()

    // Step 1: create a fresh signing nonce
    const signing = new SigningEngine(auth.ctx)
    const nonce = signing.generateSigningNonce()
    const sig = makeTestSignature(auth.user)

    // Step 2: create a real OfficerInvite share so we have valid key material
    const officerInvite = auth.authorityEngine.createOfficerInvite({
      name: 'Invariant Test Officer',
      title: 'Member',
      scopes: ['rad'] as Scope[],
    })

    // Step 3: insert InviteSlot directly (mirrors saveOfficerInvite) — use
    // the known nonce so we control the AdminSigning in the next step.
    await auth.ctx.db.exec(
      `insert into InviteSlot (
         Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
       )
       with context Tid = :tid, now = :now, IsSignatureValid = true,
                    IsInsertValid = true
       values (
         cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
         :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce
       )`,
      {
        type: 'of',
        name: 'Invariant Test Officer',
        expiration: officerInvite.expiration,
        inviteKey: officerInvite.inviteKey,
        inviteSignature: officerInvite.inviteSignature,
        nonce,
        tid: Date.now(),
        now: nowCanonicalDatetime(),
      }
    )

    // Step 4: resolve the CurrentAdmin EffectiveAt
    const adminRow = await auth.ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: auth.authority.id })
    if (!adminRow) throw new Error('CurrentAdmin not found')
    const adminEffectiveAt = adminRow.EffectiveAt as string

    // Step 5: insert an AdminSigning whose Digest is WRONG (does not match
    // Digest(InviteSlot.Cid)). This must violate InviteSlotSigningValid.
    const wrongDigest = 'a'.repeat(64) // 64-char hex that is not the real Digest

    let errorThrown: Error | undefined
    try {
      await auth.ctx.db.exec(
        `insert into AdminSigning (
           Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
         )
         with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt,
          digest: wrongDigest,
          userId: auth.user.id,
          signerKey: sig.signerKey,
          signature: sig.signature,
          now: nowCanonicalDatetime(),
        }
      )
    } catch (e) {
      errorThrown = e as Error
    }

    // The assertion must have rejected the commit. WR-02: match the assertion
    // by name specifically — a bare /assertion|constraint/ would also pass if an
    // unrelated constraint (UserIdValid, ScopeValid, …) fired instead.
    expect(errorThrown).to.exist
    expect(errorThrown!.message).to.match(
      /InviteSlotSigningValid/,
      `Expected InviteSlotSigningValid assertion error, got: ${errorThrown!.message}`
    )
  })

  // -------------------------------------------------------------------------
  // Test 3: Batch-level boundary (DOCUMENTED, not a per-slot guard).
  //
  // Two slots A and B share one SigningNonce. The AdminSigning.Digest matches
  // Digest(A.Cid) but NOT Digest(B.Cid). The commit is ACCEPTED — slot B is
  // "covered" by its matching sibling A even though B's own Cid was never
  // signed. This is the deliberate batch-level semantics that supports
  // resendInvite. It is the accepted weakening flagged by CR-01; a true
  // per-slot signing invariant is tracked as a follow-up (it requires
  // engine-level changes, since AdminSigning.Digest is a Digest(Tid,…fields)
  // payload digest, not Digest(InviteSlot.Cid)).
  // -------------------------------------------------------------------------

  it('InviteSlotSigningValid accepts a sibling slot covered by a matching batch-mate (documented boundary)', async () => {
    const auth = await setup()

    const signing = new SigningEngine(auth.ctx)
    const nonce = signing.generateSigningNonce()

    const inviteA = auth.authorityEngine.createOfficerInvite({
      name: 'Batch Officer A', title: 'Member', scopes: ['rad'] as Scope[],
    })
    const inviteB = auth.authorityEngine.createOfficerInvite({
      name: 'Batch Officer B', title: 'Member', scopes: ['rad'] as Scope[],
    })

    // Insert two InviteSlots sharing the same nonce (A then B). Both fire the
    // deferred assertion at their own commit, but with no AdminSigning yet the
    // inner join finds nothing → no violation.
    const insertSlot = async (invite: typeof inviteA, name: string): Promise<void> => {
      await auth.ctx.db.exec(
        `insert into InviteSlot (
           Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
         )
         with context Tid = :tid, now = :now, IsSignatureValid = true,
                      IsInsertValid = true
         values (
           cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
           :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce
         )`,
        {
          type: 'of', name,
          expiration: invite.expiration,
          inviteKey: invite.inviteKey,
          inviteSignature: invite.inviteSignature,
          nonce, tid: Date.now(), now: nowCanonicalDatetime(),
        }
      )
    }
    await insertSlot(inviteA, 'Batch Officer A')
    await insertSlot(inviteB, 'Batch Officer B')

    // Read back slot A's Cid so the AdminSigning.Digest can be made to match A.
    const slotA = await auth.ctx.db
      .prepare('select Cid from InviteSlot where SigningNonce = :nonce and Name = :name')
      .get({ nonce, name: 'Batch Officer A' })
    if (!slotA) throw new Error('slot A not found')

    const adminRow = await auth.ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: auth.authority.id })
    if (!adminRow) throw new Error('CurrentAdmin not found')

    const sig = makeTestSignature(auth.user)

    // AdminSigning.Digest = Digest(A.Cid) — matches A, not B.
    let errorThrown: Error | undefined
    try {
      await auth.ctx.db.exec(
        `insert into AdminSigning (
           Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
         )
         with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', Digest(:cidA), :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          cidA: slotA.Cid as string,
          userId: auth.user.id,
          signerKey: sig.signerKey,
          signature: sig.signature,
          now: nowCanonicalDatetime(),
        }
      )
    } catch (e) {
      errorThrown = e as Error
    }

    // Slot B passes despite its own Cid being unsigned — documents the accepted
    // batch-level boundary (CR-01). If a future per-slot invariant lands, this
    // test should flip to expecting a rejection.
    expect(
      errorThrown,
      `Expected the batch-mate-covered commit to be accepted, but it threw: ${errorThrown?.message}`
    ).to.be.undefined
  })
})
