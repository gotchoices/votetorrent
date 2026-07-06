/**
 * cid-check-coverage.spec.ts — Phase 36 Plan 02, Task 2: CID-02 discrimination
 * coverage for the DB-enforced `CidValid` (InviteSlot) and `SlotCidValid`
 * (InviteResult/InviteCancellation) CHECK constraints.
 *
 * PURPOSE: prove the schema CHECKs landed in Task 1 — a TOTAL content
 * re-derivation of `InviteSlot.Cid` via `cid(Digest(...))` (au/of/resend
 * branches keyed on `ResendSalt` null/not-null) and a structural
 * `cid_decode`-based `SlotCidValid` on the two SlotCid reference columns —
 * actually discriminate at the DB tier: a correctly-derived Cid is accepted,
 * a forged one is rejected (by name), and — critically — a forged
 * resend-SHAPED row (same SigningNonce, non-null ResendSalt, wrong content)
 * is ALSO rejected. This closes the D-03 Option-A structural-fallback hole
 * that Option B (persisting ResendSalt) was chosen specifically to avoid
 * (T-36-02).
 *
 * SCOPE: only the 3 InviteSlot mint field-list branches (au 5-field, of/au
 * 6-field, resend 7-field) and the 2 SlotCid reference columns. No full
 * Authority/Admin/Officer bootstrap chain is required — the
 * `InviteSlotSigningValid` batch assertion only fires when a MATCHING
 * `AdminSigning` row exists for a probe's `SigningNonce`; none of these
 * probes insert one, so the assertion's inner join finds nothing and never
 * interferes (mirrors the "InviteSlot INSERT before AdminSigning" no-op
 * branch documented on the assertion itself).
 *
 * BINDING CONVENTION: Quereus bind keys have NO colon prefix (see
 * digest-check-coverage.spec.ts header comment).
 *
 * D-02a: only the canonical `cid()`/`cid_decode()` entry points are used
 * here — `cid_v1()` never appears (grep-locked by this plan's acceptance
 * criteria).
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mint the correctly-derived Cid for a given ordered field-list, mirroring
 * the schema's CidValid branches exactly (au=5, of=6, resend=7 args). */
async function mintCid(db: Database, args: string[]): Promise<string> {
  const placeholders = args.map((_, i) => `:a${i}`).join(', ')
  const binds: Record<string, string> = {}
  args.forEach((a, i) => { binds[`a${i}`] = a })
  const row = (await db.prepare(`select cid(Digest(${placeholders})) as c`).get(binds)) as { c: unknown }
  expect(row.c, 'cid(Digest(...)) must return a non-empty string').to.be.a('string').and.have.length.greaterThan(0)
  return row.c as string
}

interface SlotFields {
  cid: string
  type: string
  name: string
  expiration: string
  inviteKey: string
  inviteSignature: string
  nonce: string
  resendSalt?: string
}

async function insertInviteSlot(db: Database, f: SlotFields): Promise<void> {
  if (f.resendSalt != null) {
    await db.exec(
      `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ResendSalt)
       with context Tid = 1, now = :now, IsSignatureValid = true, IsInsertValid = true
       values (:cid, :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce, :resendSalt)`,
      {
        cid: f.cid,
        type: f.type,
        name: f.name,
        expiration: f.expiration,
        inviteKey: f.inviteKey,
        inviteSignature: f.inviteSignature,
        nonce: f.nonce,
        resendSalt: f.resendSalt,
        now: SEED_NOW_PAST,
      },
    )
  } else {
    await db.exec(
      `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
       with context Tid = 1, now = :now, IsSignatureValid = true, IsInsertValid = true
       values (:cid, :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce)`,
      {
        cid: f.cid,
        type: f.type,
        name: f.name,
        expiration: f.expiration,
        inviteKey: f.inviteKey,
        inviteSignature: f.inviteSignature,
        nonce: f.nonce,
        now: SEED_NOW_PAST,
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const now = Date.now()
const SEED_EXPIRATION = toCanonicalDatetime(now + 365 * 86_400_000) // future — ExpirationValid
const SEED_NOW_PAST = toCanonicalDatetime(now - 1_000) // past — ExpirationValid (Expiration > context.now)

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CidValid / SlotCidValid live CHECK coverage (CID-02, T-36-02, T-36-03)', function () {
  this.timeout(30_000)

  let db: Database
  let inviteKey: string

  before(async () => {
    db = new Database()
    await prepareDb(db)
    inviteKey = randomTestKeyPair().publicHex
  })

  // -------------------------------------------------------------------------
  // (a) accept-normal: correctly-derived au-branch (5-field) Cid, ResendSalt null
  // -------------------------------------------------------------------------
  it('(a) accept-normal: a correctly-derived 5-field (au) Cid is ACCEPTED', async () => {
    const name = 'Coverage Normal Au'
    const nonce = 'cid-cov-nonce-a'
    const inviteSignature = 'a'.repeat(128)
    const cid = await mintCid(db, [SEED_EXPIRATION, inviteKey, inviteSignature, name, nonce])

    let threw = false
    try {
      await insertInviteSlot(db, { cid, type: 'au', name, expiration: SEED_EXPIRATION, inviteKey, inviteSignature, nonce })
    } catch {
      threw = true
    }
    expect(threw, 'a Cid correctly derived from the row\'s own au-branch fields must be ACCEPTED').to.equal(false)
  })

  // -------------------------------------------------------------------------
  // (b) reject-forged: same fields, mismatched Cid, ResendSalt null
  // -------------------------------------------------------------------------
  it('(b) reject-forged: a forged/mismatched Cid (ResendSalt null) is REJECTED by CidValid', async () => {
    const name = 'Coverage Forged'
    const nonce = 'cid-cov-nonce-b'
    const inviteSignature = 'b'.repeat(128)

    let caught: unknown
    try {
      await insertInviteSlot(db, {
        cid: 'forged-cid-does-not-match-any-derivation',
        type: 'au',
        name,
        expiration: SEED_EXPIRATION,
        inviteKey,
        inviteSignature,
        nonce,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a forged Cid must be REJECTED').to.be.instanceOf(Error)
    expect((caught as Error).message, 'expected the CidValid constraint, not a setup/other-constraint error').to.include('CidValid')
  })

  // -------------------------------------------------------------------------
  // (c) accept-resend: a genuine resend chain — original slot + legitimate resend
  // -------------------------------------------------------------------------
  it('(c) accept-resend: a legitimate resend row (ResendSalt non-null, correctly-derived 7-field Cid) is ACCEPTED', async () => {
    const name = 'Coverage Resend Officer'
    const nonce = 'cid-cov-nonce-c'
    const inviteSignature = 'c'.repeat(128)
    const type = 'of'

    // Original slot (au/of branch — 6-field, no ResendSalt).
    const origCid = await mintCid(db, [SEED_EXPIRATION, inviteKey, inviteSignature, name, nonce, type])
    await insertInviteSlot(db, { cid: origCid, type, name, expiration: SEED_EXPIRATION, inviteKey, inviteSignature, nonce })

    // Legitimate resend: same nonce/signature/type, a persisted ResendSalt,
    // Cid correctly re-derived over the FULL 7-field form.
    const resendSalt = 'resend|1|' + nowCanonicalDatetime()
    const resendCid = await mintCid(db, [SEED_EXPIRATION, inviteKey, inviteSignature, name, nonce, type, resendSalt])

    let threw = false
    try {
      await insertInviteSlot(db, {
        cid: resendCid,
        type,
        name,
        expiration: SEED_EXPIRATION,
        inviteKey,
        inviteSignature,
        nonce,
        resendSalt,
      })
    } catch {
      threw = true
    }
    expect(threw, 'a genuine resend row whose Cid fully re-derives (7-field, incl. ResendSalt) must be ACCEPTED').to.equal(false)
  })

  // -------------------------------------------------------------------------
  // (d) reject-forged-resend-shaped: resend SHAPE (same nonce, non-null
  // ResendSalt) but WRONG content — proves Option B's total re-derivation
  // closes the Option-A structural-only acceptance hole.
  // -------------------------------------------------------------------------
  it('(d) reject-forged-resend-shaped: a resend-SHAPED row (same SigningNonce, non-null ResendSalt) with WRONG content is REJECTED by CidValid', async () => {
    const name = 'Coverage Resend Forge Target'
    const nonce = 'cid-cov-nonce-d'
    const inviteSignature = 'd'.repeat(128)
    const type = 'of'

    // Original slot establishing the SigningNonce (so the forged row below is
    // genuinely "resend-shaped": it reuses a real prior nonce, exactly like a
    // legitimate resend would).
    const origCid = await mintCid(db, [SEED_EXPIRATION, inviteKey, inviteSignature, name, nonce, type])
    await insertInviteSlot(db, { cid: origCid, type, name, expiration: SEED_EXPIRATION, inviteKey, inviteSignature, nonce })

    // Forged resend-shaped row: non-null ResendSalt (resend shape), same
    // SigningNonce — but its Cid does NOT equal the 7-field re-derivation for
    // ITS OWN fields. Under the rejected Option A (structural-only fallback),
    // any structurally-valid-looking Cid on a resend row would have passed;
    // Option B's total re-derivation must reject it here.
    const resendSalt = 'resend|2|' + nowCanonicalDatetime()

    let caught: unknown
    try {
      await insertInviteSlot(db, {
        cid: 'forged-resend-shaped-cid-wrong-content',
        type,
        name,
        expiration: SEED_EXPIRATION,
        inviteKey,
        inviteSignature,
        nonce,
        resendSalt,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a resend-shaped row (non-null ResendSalt, reused SigningNonce) with wrong content must be REJECTED — resend shape alone must not grant acceptance').to.be.instanceOf(Error)
    expect(
      (caught as Error).message,
      'expected the CidValid constraint, not a setup/other-constraint error',
    ).to.include('CidValid')
  })

  // -------------------------------------------------------------------------
  // (e) reject-malformed-ref: InviteResult.SlotCid structural CHECK
  // -------------------------------------------------------------------------
  it('(e) reject-malformed-ref: a non-CIDv1 InviteResult.SlotCid is REJECTED by SlotCidValid', async () => {
    let caught: unknown
    try {
      await db.exec(
        `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
         with context IsSigningValid = true, IsSignatureValid = true
         values (:slotCid, false, null, :inviteSignature, null)`,
        {
          slotCid: 'not-a-real-cid-string',
          inviteSignature: 'e'.repeat(128),
        },
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'a malformed (non-CIDv1) SlotCid must be REJECTED').to.be.instanceOf(Error)
    expect(
      (caught as Error).message,
      'expected the SlotCidValid constraint (or its underlying cid_decode failure) to be named/evident in the thrown message',
    ).to.match(/SlotCidValid|cid_decode/)
  })
})
