/**
 * Targeted spec for InviteSlotSigningValid assertion resolution on quereus 4.x
 *
 * Two behaviors:
 *
 * Test 1 (resolution): saveInviteWithSigning commits without throwing
 *   "No row context found for column Digest" — this was the failure mode
 *   before the InviteSlotSigningValid schema rewrite (derived-alias SND.Digest
 *   could not be resolved by the 4.x per-tuple residual executor).
 *
 * Test 2 (invariant preserved): a mismatched AdminSigning Digest is still
 *   rejected by the InviteSlotSigningValid assertion after the rewrite —
 *   the rewrite must NOT weaken the invariant.
 *
 * Phase 33 Plan 02 — RED gate (TDD). These tests must fail before the
 * votetorrent.qsql rewrite and pass after it.
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
  // Test 2: Invariant preserved — a mismatched AdminSigning Digest is still
  // rejected by InviteSlotSigningValid after the rewrite.
  //
  // Strategy: insert an InviteSlot directly with a known SigningNonce, then
  // insert an AdminSigning whose Digest does NOT match Digest(InviteSlot.Cid).
  // The assertion must fire and reject the commit.
  // -------------------------------------------------------------------------

  it('InviteSlotSigningValid rejects a mismatched AdminSigning Digest (invariant preserved)', async () => {
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
                    IsInsertValid = true, IsCidValid = true
       values (
         Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type),
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

    // The assertion must have rejected the commit.
    // (If the assertion is absent or weakened, no error is thrown and this fails.)
    expect(errorThrown).to.exist
    expect(errorThrown!.message).to.match(
      /InviteSlotSigningValid|assertion|constraint/i,
      `Expected InviteSlotSigningValid assertion error, got: ${errorThrown!.message}`
    )
  })
})
