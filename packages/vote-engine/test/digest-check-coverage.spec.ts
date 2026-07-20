/**
 * digest-check-coverage.spec.ts — DIG-03-a: targeted live Digest/SignatureValid
 * CHECK discrimination on quereus 4.x (D-05, D-06).
 *
 * PURPOSE: prove that the live `Digest()` SQL scalar evaluates correctly inside
 * the real constraint path — a row with a matching Digest is accepted and a row
 * with a wrong Digest is rejected — on quereus 4.2.1 + crypto-plugin 0.14.x.
 *
 * SCOPE (per D-05):
 *   - `Digest` — registered crypto-plugin scalar (sha256 / base64url). Covered
 *     here by a smoke test + a real Digest-gated Election.InsertValid CHECK
 *     discrimination (accept on match, reject on mismatch).
 *   - `SignatureValid` — already discriminatingly proven in
 *     `signature-valid-encoding.spec.ts` (WR-01 tests: valid→true, tampered→false,
 *     wrong-key→false, empty→false). No duplication here per D-05.
 *
 * D-06: H16 and DigestAll are NOT tested here.
 *   H16 is a TS-layer utility (packages/vote-engine/src/utils.ts:111); it is
 *   NOT a registered SQL UDF — the only schema reference is a commented-out TODO
 *   (`-- TODO: constraint HashValid check on insert (Hash = H16(Id))`).
 *   DigestAll has no live usage in votetorrent.qsql.
 *   Their re-validation is moot until they appear in a real CHECK.
 *
 * BINDING CONVENTION: Quereus bind keys have NO colon prefix.
 *   Correct:  `.get({ a0: value })`  for placeholder `:a0`
 *   Wrong:    .get({ [":a0"]: value }) — silently returns null.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { prepareDb } from '../src/database/initialize.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { toCanonicalDatetime, digestToBytes } from '../src/utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce the live canonical base64url Digest for a single string arg. */
async function liveDigest(db: Database, arg: string): Promise<string> {
  const row = (await db.prepare('select Digest(:a0) as d').get({ a0: arg })) as
    | { d: unknown }
    | undefined
  expect(row?.d, `Digest(${JSON.stringify(arg)}) must return a non-empty string`)
    .to.be.a('string')
    .and.have.length.greaterThan(0)
  return row!.d as string
}

// ---------------------------------------------------------------------------
// Seed constants — fixed datetimes shared between the before() seeding and
// the it() tests. Election.InsertValid's Digest must be computed with the
// exact same arguments in both places; a recomputed Date.now() between the
// before() and it() calls would produce a different Digest and a false failure.
//
// Use canonical datetime format: YYYY-MM-DDTHH:MM:SS (T separator, no Z, no ms)
// which is the form Quereus datetime comparisons expect (toCanonicalDatetime).
// ---------------------------------------------------------------------------

const now = Date.now()
const SEED_NONCE = 'signing-nonce-dig03'
const SEED_TID = 42                                                    // must be integer
const SEED_AUTHORITY_ID = 'authority-dig03'
const SEED_ELECTION_ID = 'election-dig03'
const SEED_ELECTION_TITLE = 'DIG-03 Election'
const SEED_ADMIN_EFFECTIVE_AT = '2026-01-01T00:00:00'
const SEED_ELECTION_DATE = toCanonicalDatetime(now + 30 * 86_400_000)
const SEED_REV_DEADLINE = toCanonicalDatetime(now + 7 * 86_400_000)
const SEED_BALLOT_DEADLINE = toCanonicalDatetime(now + 14 * 86_400_000)
const SEED_NOW_FUTURE = toCanonicalDatetime(now + 5_000)              // for seeding context.now
const SEED_NOW_PAST = toCanonicalDatetime(now - 1_000)                // for election context.now (DateValid: Date >= now)
const SEED_EXPIRATION = toCanonicalDatetime(now + 365 * 86_400_000)
const SEED_ELECTION_TYPE = 'a'                                        // ElectionType.adhoc

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Digest/SignatureValid live CHECK coverage (DIG-03-a / D-05)', function () {
  this.timeout(30_000)

  let db: Database
  let publicHex: string
  let privateHex: string

  before(async () => {
    db = new Database()
    await prepareDb(db)
    const kp = randomTestKeyPair()
    publicHex = kp.publicHex
    privateHex = kp.privateHex
  })

  // -------------------------------------------------------------------------
  // Seed a minimal bootstrap chain for the Election.InsertValid discrimination
  // test. Chain: User → UserKey → Authority → Admin → Officer → AdminSigning →
  // AdminSignature. All CHECK gates are satisfied via context flags (no real
  // crypto needed for seeding) except Election.InsertValid which requires
  // the Digest to match exactly (that is the function under test).
  //
  // Seeding order must respect FK/CHECK dependencies:
  //   User → UserKey → Authority → Admin → Officer → AdminSigning → AdminSignature
  // -------------------------------------------------------------------------

  before(async () => {
    // 1. First User (shoe-in: first user, no invite/signing required)
    await db.exec(
      `insert into User (Id, Name)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${SEED_TID}
       values ('user-dig03', 'DIG-03 User')`,
    )

    // 2. First UserKey for user-dig03 (first key: UserKey = null context accepted)
    await db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = null, Signature = null, Tid = ${SEED_TID}, now = :now, IsSignatureValid = true
       values ('user-dig03', 'M', :pubKey, :expiration)`,
      { now: SEED_NOW_FUTURE, pubKey: publicHex, expiration: SEED_EXPIRATION },
    )

    // 3. First Authority (shoe-in: first authority, no invite/signing required)
    await db.exec(
      `insert into Authority (Id, Name, DomainName)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${SEED_TID}
       values (:authorityId, 'DIG-03 Authority', 'dig03.example.com')`,
      { authorityId: SEED_AUTHORITY_ID },
    )

    // 4. First Admin for first authority (shoe-in: initial admin for first authority;
    //    MutationValid arm 1: SigningNonce=null, InviteSlotCid=null, InviteSignature=null,
    //    old.AuthorityId is null [INSERT], not exists Authority where Id != authorityId)
    await db.exec(
      `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${SEED_TID}
       values (:authorityId, :effectiveAt, '[]')`,
      { authorityId: SEED_AUTHORITY_ID, effectiveAt: SEED_ADMIN_EFFECTIVE_AT },
    )

    // 5. First Officer (part of first authority + first admin; shoe-in arm:
    //    SigningNonce=null, InviteSlotCid=null, InviteSignature=null, count(Authority)=1)
    await db.exec(
      `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${SEED_TID}
       values (:authorityId, :effectiveAt, 'user-dig03', 'Chair', '["mel"]')`,
      { authorityId: SEED_AUTHORITY_ID, effectiveAt: SEED_ADMIN_EFFECTIVE_AT },
    )

    // 6. AdminSigning — Digest matches Election.InsertValid formula exactly:
    //    Digest(context.Tid, new.Id, new.AuthorityId, new.Title, new.Date,
    //           new.RevisionDeadline, new.BallotDeadline, new.Type)
    //
    //    CRITICAL: Tid passed as a SQL integer LITERAL (${SEED_TID}), not a bind
    //    parameter, so Quereus encodes it as TAG_INT (0x01). If Tid were passed as a
    //    string it would be TAG_TEXT (0x03) — Digest('42',…) ≠ Digest(42,…).
    //    This mirrors what createElection() does (`Tid = ${tid}` in the SQL template).
    // 999.1 R-02: compute the real AdminSigning Digest first, then sign it for real —
    // the schema's SignatureValid UDF now verifies these bytes (same seam as
    // Election.InsertValid's own Digest, which is what this suite is really testing).
    const adminSigningDigestParams = {
      authorityId: SEED_AUTHORITY_ID,
      electionId: SEED_ELECTION_ID,
      title: SEED_ELECTION_TITLE,
      electionDate: SEED_ELECTION_DATE,
      revDeadline: SEED_REV_DEADLINE,
      ballotDeadline: SEED_BALLOT_DEADLINE,
      type: SEED_ELECTION_TYPE,
    }
    const adminSigningDigestRow = await db
      .prepare(
        `select Digest(${SEED_TID}, :electionId, :authorityId, :title, :electionDate, :revDeadline, :ballotDeadline, :type) as d`,
      )
      .get(adminSigningDigestParams)
    const adminSigningDigest = adminSigningDigestRow!.d as string
    const adminSigningSig = bytesToHex(
      secp256k1.sign(digestToBytes(adminSigningDigest), hexToBytes(privateHex)),
    )

    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
       values (
         :nonce, :authorityId, :effectiveAt, 'mel',
         Digest(${SEED_TID}, :electionId, :authorityId, :title, :electionDate, :revDeadline, :ballotDeadline, :type),
         'user-dig03', :pubKey, :signature
       )`,
      {
        ...adminSigningDigestParams,
        nonce: SEED_NONCE,
        now: SEED_NOW_FUTURE,
        effectiveAt: SEED_ADMIN_EFFECTIVE_AT,
        pubKey: publicHex,
        signature: adminSigningSig,
      },
    )

    // 7. AdminSignature — threshold met (context flag only; threshold=1 from Admin seed)
    await db.exec(
      `insert into AdminSignature (SigningNonce)
       with context IsSignatureValid = true
       values (:nonce)`,
      { nonce: SEED_NONCE },
    )
  })

  // -------------------------------------------------------------------------
  // Test 1: Digest() smoke — returns a non-empty base64url string on 4.x
  // -------------------------------------------------------------------------

  it('DIG-03-a: Digest() scalar returns a non-empty base64url string on quereus 4.x', async () => {
    const d = await liveDigest(db, 'dig03-smoke')
    // base64url characters: A-Z a-z 0-9 - _  (no padding =)
    expect(d, 'Digest output must be a non-empty base64url string').to.match(/^[A-Za-z0-9_-]+$/)
  })

  // -------------------------------------------------------------------------
  // Test 2: Digest CHECK discrimination — Election.InsertValid (real CHECK path)
  //
  // Election.InsertValid requires:
  //   A.Digest = Digest(context.Tid, new.Id, new.AuthorityId, new.Title, new.Date,
  //                     new.RevisionDeadline, new.BallotDeadline, new.Type)
  //
  // DIG-03-a core assertion: the scalar evaluates correctly INSIDE the constraint
  // path — a row with a matching AdminSigning.Digest is accepted; a row whose
  // Digest was computed with a different argument (wrong title) is rejected.
  //
  // The seed values are module-level constants shared with the before() hook so
  // the AdminSigning.Digest and the re-computed CHECK Digest are identical.
  // -------------------------------------------------------------------------

  it('DIG-03-a: Election.InsertValid CHECK accepts a row whose Digest matches the AdminSigning', async () => {
    // SEED_NOW_PAST is in the past relative to SEED_ELECTION_DATE, satisfying
    // DateValid: Date >= context.now.
    let threw = false
    try {
      await db.exec(
        `insert into Election (Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type)
         with context SigningNonce = :nonce, Tid = ${SEED_TID}, now = :now
         values (:electionId, :authorityId, :title, :date, :revDeadline, :ballotDeadline, :type)`,
        {
          nonce: SEED_NONCE,
          now: SEED_NOW_PAST,
          electionId: SEED_ELECTION_ID,
          authorityId: SEED_AUTHORITY_ID,
          title: SEED_ELECTION_TITLE,
          date: SEED_ELECTION_DATE,
          revDeadline: SEED_REV_DEADLINE,
          ballotDeadline: SEED_BALLOT_DEADLINE,
          type: SEED_ELECTION_TYPE,
        },
      )
    } catch {
      threw = true
    }
    expect(threw, 'Election.InsertValid CHECK must ACCEPT a row whose Digest matches AdminSigning.Digest').to.equal(false)
  })

  it('DIG-03-a: Election.InsertValid CHECK rejects a row whose Digest does NOT match the AdminSigning', async () => {
    // 'WRONG TITLE' produces a different Digest than 'DIG-03 Election'.
    // Election.InsertValid's Digest mismatch triggers the constraint violation —
    // proving the scalar evaluates correctly inside the CHECK path on quereus 4.x.
    //
    // WR-01 (35-REVIEW): assert the THROWN MESSAGE names the InsertValid
    // constraint — a bare `threw === true` passes on ANY error (setup failure,
    // a different constraint, a column-resolution error) and would not prove the
    // Digest CHECK actually fired. This matches the suite's discriminating
    // convention (authority.spec.ts:1333, Phase 34 f50b50d WR-03).
    let caught: unknown
    try {
      await db.exec(
        `insert into Election (Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type)
         with context SigningNonce = :nonce, Tid = ${SEED_TID}, now = :now
         values ('election-dig03-bad', :authorityId, 'WRONG TITLE', :date, :revDeadline, :ballotDeadline, :type)`,
        {
          nonce: SEED_NONCE,
          now: SEED_NOW_PAST,
          authorityId: SEED_AUTHORITY_ID,
          date: SEED_ELECTION_DATE,
          revDeadline: SEED_REV_DEADLINE,
          ballotDeadline: SEED_BALLOT_DEADLINE,
          type: SEED_ELECTION_TYPE,
        },
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'Election.InsertValid CHECK must REJECT a row whose Digest does NOT match AdminSigning.Digest').to.be.instanceOf(Error)
    expect(
      (caught as Error).message,
      'expected the InsertValid Digest mismatch, not a setup/other-constraint error',
    ).to.include('InsertValid')
  })

  // -------------------------------------------------------------------------
  // SignatureValid coverage note (per D-05 — no duplication)
  // -------------------------------------------------------------------------
  //
  // `SignatureValid()` is already discriminatingly proven in
  // `signature-valid-encoding.spec.ts` (WR-01 tests):
  //   - valid hex signature over a base64url digest → true
  //   - tampered signature → false
  //   - wrong key → false
  //   - any empty argument → false (short-circuit guard)
  // Those four cases cover the live SQL scalar's encoding contract and
  // are sufficient for DIG-03-a. No assertions are duplicated here.
})
