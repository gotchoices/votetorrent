/**
 * staging-schema.spec.ts — 62-01 Tasks 2 and 3.
 *
 * Schema-level proof of every CHECK on the seven new tables this plan lands:
 * `RegistrationRequestStaging`, `AssociationRequestStaging`, `AssociationAttestationStaging`,
 * `RegistrationDecision`, `AssociationDecision` (Task 2), `UserEncryptionKey` and
 * `AuthorityIntakePolicy` (Task 3). Every rejection case asserts the write THREW (never a zero
 * row count alone — quereus#21's "silent rejection" failure mode); every acceptance case reads
 * the row back. Bind names avoid the reserved `:limit :desc :group :order :type` class.
 *
 * Written TDD-first against the (at Task 2 start) UNCHANGED schema — the first run of this file
 * is expected to fail on every case naming a table that does not exist yet, confirming RED before
 * `votetorrent.qsql` is touched.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Scope, Signature, Proposal, AdminInit, User, UserKeyType } from '@votetorrent/vote-core'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { UserEngine } from '../src/user/user-engine.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import {
  createTestNetwork,
  addTestAuthority,
  addSiblingAuthority,
  makeDistinctTestUser,
  makeTestSignCallback,
  signTestDigest,
  seedUserInvite,
  seedSignedMutation as seedSignedMutationFixture
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ═══════════════════════════════════════════════════════════════════════════
// Generic helpers
// ═══════════════════════════════════════════════════════════════════════════

interface RowSigner {
  publicHex: string
  sign: (digestBase64url: string) => string
}

function makeSecp256k1RowSigner (): RowSigner {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return { publicHex, sign: (d: string) => bytesToHex(secp256k1.sign(digestToBytes(d), privBytes)) }
}

function makeP256RowSigner (): RowSigner {
  const { privBytes, pubHex } = makeP256TestKey()
  return { publicHex: pubHex, sign: (d: string) => signDigestP256(d, privBytes) }
}

/** A signer wrapper over a registered test User's own key (officer decisions). */
function officerSignerFor (user: User): { sign: (digestBase64url: string) => { signature: string; signerKey: string } } {
  return {
    sign: (d: string) => {
      const sig = signTestDigest(user, d)
      return { signature: sig.signature, signerKey: sig.signerKey }
    }
  }
}

let cursorSeq = 0
/** 16-digit zero-padded decimal cursor, per the P2P transport convention. */
function nextCursor (): string {
  cursorSeq += 1
  return String(cursorSeq).padStart(16, '0')
}

async function arbitraryDigest (ctx: EngineContext, salt: string): Promise<string> {
  const row = await ctx.db.prepare('select Digest(:salt, :nonce) as d').get({ salt, nonce: crypto.randomUUID() })
  if (!row || row.d == null) throw new Error('arbitraryDigest: Digest() returned null')
  return row.d as string
}

async function rowCount (ctx: EngineContext, sql: string, params: Record<string, unknown>): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, string | number | null>)
  return Number(row?.c ?? 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Staging tables (RegistrationRequestStaging, AssociationRequestStaging,
// AssociationAttestationStaging) — shared behavior suite
// ═══════════════════════════════════════════════════════════════════════════

type StagingTable = 'RegistrationRequestStaging' | 'AssociationRequestStaging' | 'AssociationAttestationStaging'

interface StagingRowArgs {
  strandId: string
  cursor?: string
  requestId: string
  digest: string
  payload: string
  requesterKey: string
  signatureJson: string
  stagedAt?: string
}

async function insertStagingRow (ctx: EngineContext, table: StagingTable, payloadColumn: 'InitJson' | 'AnswerJson', args: StagingRowArgs): Promise<void> {
  const cursor = args.cursor ?? nextCursor()
  const stagedAt = args.stagedAt ?? toIsoZDatetime(Date.now())
  await ctx.db.exec(
    `insert into ${table} (StrandId, Cursor, RequestId, Digest, ${payloadColumn}, RequesterKey, SignatureJson, StagedAt)
     values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
    {
      strandId: args.strandId,
      cursor,
      requestId: args.requestId,
      digest: args.digest,
      payload: args.payload,
      requesterKey: args.requesterKey,
      signatureJson: args.signatureJson,
      stagedAt
    }
  )
}

async function signedStagingInsert (
  ctx: EngineContext,
  table: StagingTable,
  payloadColumn: 'InitJson' | 'AnswerJson',
  signer: RowSigner,
  overrides?: Partial<StagingRowArgs> & { signDifferentDigest?: boolean; signerKeyOverride?: string }
): Promise<{ strandId: string; requestId: string; digest: string }> {
  const strandId = overrides?.strandId ?? `strand-${crypto.randomUUID()}`
  const requestId = overrides?.requestId ?? crypto.randomUUID()
  const digest = overrides?.digest ?? (await arbitraryDigest(ctx, table))
  const digestToSign = overrides?.signDifferentDigest ? await arbitraryDigest(ctx, `${table}-other`) : digest
  const signatureJson =
    overrides?.signatureJson ??
    JSON.stringify({ signature: signer.sign(digestToSign), signerKey: overrides?.signerKeyOverride ?? signer.publicHex })
  await insertStagingRow(ctx, table, payloadColumn, {
    strandId,
    cursor: overrides?.cursor,
    requestId,
    digest,
    payload: overrides?.payload ?? JSON.stringify({ version: 1, sealed: 'placeholder' }),
    requesterKey: overrides?.signerKeyOverride ?? signer.publicHex,
    signatureJson,
    stagedAt: overrides?.stagedAt
  })
  return { strandId, requestId, digest }
}

/**
 * Runs the full shared `<behavior>` suite for one staging table — DRY across the three
 * identically-shaped tables (RegistrationRequestStaging, AssociationRequestStaging,
 * AssociationAttestationStaging). `includeP256` is true for the two association staging tables
 * (the `<behavior>` bullet is explicit: "on the two association staging tables a P-256 signer
 * also inserts").
 */
function describeStagingTableBehaviors (table: StagingTable, payloadColumn: 'InitJson' | 'AnswerJson', includeP256: boolean): void {
  describe(`${table} (D-03, D-05, D-07)`, () => {
    let net: Awaited<ReturnType<typeof createTestNetwork>>

    beforeEach(async () => {
      net = await createTestNetwork()
    })

    it('a row signed (secp256k1) by RequesterKey over the stored Digest inserts', async () => {
      const signer = makeSecp256k1RowSigner()
      const { strandId, requestId } = await signedStagingInsert(net.ctx, table, payloadColumn, signer)
      expect(await rowCount(net.ctx, `select count(*) as c from ${table} where StrandId = :strandId and RequestId = :requestId`, { strandId, requestId })).to.equal(1)
    })

    if (includeP256) {
      it('a row signed (P-256) by RequesterKey over the stored Digest inserts', async () => {
        const signer = makeP256RowSigner()
        const { strandId, requestId } = await signedStagingInsert(net.ctx, table, payloadColumn, signer)
        expect(await rowCount(net.ctx, `select count(*) as c from ${table} where StrandId = :strandId and RequestId = :requestId`, { strandId, requestId })).to.equal(1)
      })
    }

    it('a signature over a different digest throws', async () => {
      const signer = makeSecp256k1RowSigner()
      let caught: unknown
      try {
        await signedStagingInsert(net.ctx, table, payloadColumn, signer, { signDifferentDigest: true })
      } catch (err) {
        caught = err
      }
      expect(caught, 'a signature over a different digest must be rejected').to.be.instanceOf(Error)
    })

    it('a duplicate RequestId (same StrandId) throws — primary key', async () => {
      const signer = makeSecp256k1RowSigner()
      const strandId = `strand-${crypto.randomUUID()}`
      const requestId = crypto.randomUUID()
      await signedStagingInsert(net.ctx, table, payloadColumn, signer, { strandId, requestId })
      let caught: unknown
      try {
        await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner(), { strandId, requestId })
      } catch (err) {
        caught = err
      }
      expect(caught, 'a duplicate (StrandId, RequestId) must be rejected by the primary key').to.be.instanceOf(Error)
      expect(await rowCount(net.ctx, `select count(*) as c from ${table} where StrandId = :strandId and RequestId = :requestId`, { strandId, requestId })).to.equal(1)
    })

    it('a duplicate Cursor in the same StrandId throws — unique index', async () => {
      const strandId = `strand-${crypto.randomUUID()}`
      const cursor = nextCursor()
      await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner(), { strandId, cursor })
      let caught: unknown
      try {
        await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner(), { strandId, cursor })
      } catch (err) {
        caught = err
      }
      expect(caught, 'a duplicate (StrandId, Cursor) must be rejected by the unique index').to.be.instanceOf(Error)
    })

    it('a non-Z StagedAt throws', async () => {
      let caught: unknown
      try {
        await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner(), { stagedAt: '2026-01-01T00:00:00.000' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'a non-Z-suffixed StagedAt must be rejected').to.be.instanceOf(Error)
    })

    it('a 15-character Cursor throws', async () => {
      let caught: unknown
      try {
        await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner(), { cursor: '123456789012345' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'a 15-character Cursor must be rejected — CursorWellFormed requires exactly 16').to.be.instanceOf(Error)
    })

    it('UPDATE throws — NoUpdate', async () => {
      const { strandId, requestId } = await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner())
      let caught: unknown
      try {
        await net.ctx.db.exec(`update ${table} set StagedAt = :stagedAt where StrandId = :strandId and RequestId = :requestId`, {
          stagedAt: toIsoZDatetime(Date.now()),
          strandId,
          requestId
        })
      } catch (err) {
        caught = err
      }
      expect(caught, 'UPDATE must be rejected').to.be.instanceOf(Error)
    })

    it('DELETE throws — NoDelete', async () => {
      const { strandId, requestId } = await signedStagingInsert(net.ctx, table, payloadColumn, makeSecp256k1RowSigner())
      let caught: unknown
      try {
        await net.ctx.db.exec(`delete from ${table} where StrandId = :strandId and RequestId = :requestId`, { strandId, requestId })
      } catch (err) {
        caught = err
      }
      expect(caught, 'DELETE must be rejected').to.be.instanceOf(Error)
      expect(await rowCount(net.ctx, `select count(*) as c from ${table} where StrandId = :strandId and RequestId = :requestId`, { strandId, requestId })).to.equal(1)
    })
  })
}

describeStagingTableBehaviors('RegistrationRequestStaging', 'InitJson', false)
describeStagingTableBehaviors('AssociationRequestStaging', 'InitJson', true)
describeStagingTableBehaviors('AssociationAttestationStaging', 'AnswerJson', true)

// ═══════════════════════════════════════════════════════════════════════════
// RegistrationDecision (D-06, D-44)
// ═══════════════════════════════════════════════════════════════════════════

interface RegistrationDecisionFields {
  strandId: string
  requestId: string
  authorityId: string
  status: string
  reason?: string | null
  closesRequestId?: string | null
  decidedAt?: string
}

async function registrationDecisionDigest (ctx: EngineContext, f: RegistrationDecisionFields): Promise<string> {
  const row = await ctx.db
    .prepare("select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d")
    .get({
      strandId: f.strandId,
      requestId: f.requestId,
      authorityId: f.authorityId,
      status: f.status,
      reason: f.reason ?? null,
      closesRequestId: f.closesRequestId ?? null,
      decidedAt: f.decidedAt ?? null
    })
  if (!row || row.d == null) throw new Error('registrationDecisionDigest: Digest() returned null')
  return row.d as string
}

async function insertRegistrationDecisionRaw (
  ctx: EngineContext,
  f: RegistrationDecisionFields & { deciderKey: string; deciderSignature: string; cursor?: string }
): Promise<void> {
  await ctx.db.exec(
    `insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature)
     with context now = :now
     values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)`,
    {
      strandId: f.strandId,
      cursor: f.cursor ?? nextCursor(),
      requestId: f.requestId,
      authorityId: f.authorityId,
      status: f.status,
      reason: f.reason ?? null,
      closesRequestId: f.closesRequestId ?? null,
      decidedAt: f.decidedAt ?? toIsoZDatetime(Date.now()),
      deciderKey: f.deciderKey,
      deciderSignature: f.deciderSignature,
      now: nowCanonicalDatetime()
    }
  )
}

async function signAndInsertRegistrationDecision (
  ctx: EngineContext,
  f: RegistrationDecisionFields & { cursor?: string },
  signer: { sign: (d: string) => { signature: string; signerKey: string } }
): Promise<RegistrationDecisionFields> {
  const decidedAt = f.decidedAt ?? toIsoZDatetime(Date.now())
  const reason = f.reason ?? null
  const closesRequestId = f.closesRequestId ?? null
  const resolved = { ...f, decidedAt, reason, closesRequestId }
  const digest = await registrationDecisionDigest(ctx, resolved)
  const sig = signer.sign(digest)
  await insertRegistrationDecisionRaw(ctx, { ...resolved, cursor: f.cursor, deciderKey: sig.signerKey, deciderSignature: sig.signature })
  return resolved
}

/**
 * proposeAdmin, signed via callback (engine computes the digest), per the plan's note that this
 * survives 62-03's D-33b digest change. EMPIRICAL FINDING: `AuthorityEngine.proposeAdmin`, when
 * given a sign CALLBACK (not a pre-computed Signature) and threshold=1 (always true here — every
 * fixture officer is the sole signer), auto-applies the promotion ITSELF internally
 * (authority-engine.ts ~:758-770, `this.applyAdminProposal(nonce, signatureOrCallback, { ownsTransaction: true })`)
 * — a separate manual `applyAdminProposal` call (primeUserForRename's shape, which pre-computes
 * the roster digest and passes a bare Signature) is not just redundant here, it is WRONG: a
 * second lookup keyed on `AdminSigning.AdminEffectiveAt = <the PROPOSED new effectiveAt>` never
 * matches, because `SigningEngine.startSigningSession` (signing-engine.ts ~:401-416) binds
 * `AdminEffectiveAt` to the CURRENT admin's effectiveAt (the roster AUTHORIZING this signing
 * session), not the proposed one. This helper instead reads `lastPromotionOutcome` (public on
 * `AuthorityEngine`, 57-08) to confirm the auto-apply actually promoted.
 */
async function promoteAdminRoster (
  auth: TestAuthorityContext,
  officers: Array<{ userId: string; title: string; scopes: Scope[] }>,
  effectiveAt: number
): Promise<void> {
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers: officers.map((o) => ({ existing: { userId: o.userId, authorityId: auth.authority.id, title: o.title, scopes: o.scopes } })),
      effectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    signers: [auth.user.id]
  }
  await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))
  const engine = auth.authorityEngine as unknown as { lastPromotionOutcome?: { status: string; reason?: string } }
  if (engine.lastPromotionOutcome?.status !== 'promoted') {
    throw new Error(`promoteAdminRoster: proposeAdmin did not auto-promote (outcome: ${JSON.stringify(engine.lastPromotionOutcome)})`)
  }
}

describe('RegistrationDecision (D-06, D-44)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  let auth: TestAuthorityContext

  beforeEach(async () => {
    net = await createTestNetwork()
    auth = await addTestAuthority(net)
  })

  it('the founding officer (holds vrg) signing for the primary authority inserts', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a' }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from RegistrationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(1)
  })

  it('the same officer signing for a sibling authority where they hold only "rad" throws', async () => {
    const siblingAuthorityId = await addSiblingAuthority(auth, { scopes: ['rad'] as Scope[] })
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: siblingAuthorityId, status: 'a' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'an officer without vrg at the target authority must be rejected').to.be.instanceOf(Error)
  })

  it('a key with no UserKey row throws', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    const unregistered = makeSecp256k1RowSigner()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a' }, { sign: (d) => ({ signature: unregistered.sign(d), signerKey: unregistered.publicHex }) })
    } catch (err) {
      caught = err
    }
    expect(caught, 'an unregistered key must be rejected').to.be.instanceOf(Error)
  })

  it('a row whose Status was changed after signing throws', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    const decidedAt = toIsoZDatetime(Date.now())
    // Sign over Status='r', but insert the row with Status='a' — SignatureValid's recomputed
    // digest (over the ACTUAL stored Status) must not match the signature produced for 'r'.
    const digest = await registrationDecisionDigest(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'r', decidedAt })
    const sig = signTestDigest(auth.user, digest)
    let caught: unknown
    try {
      await insertRegistrationDecisionRaw(auth.ctx, {
        strandId,
        requestId,
        authorityId: auth.authority.id,
        status: 'a',
        decidedAt,
        deciderKey: sig.signerKey,
        deciderSignature: sig.signature
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a row whose Status disagrees with the signed digest must be rejected').to.be.instanceOf(Error)
  })

  it("Status 'x' throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'x' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "Status 'x' must be rejected by StatusValid").to.be.instanceOf(Error)
  })

  it("a P-256 officer key (second UserKey of Type 'P') inserts", async () => {
    const p256Key = makeP256TestKey()
    await new UserEngine(auth.user, auth.ctx).addKey(
      { key: p256Key.pubHex, type: 'P' as UserKeyType, expiration: Date.now() + 86_400_000 },
      makeTestSignCallback(auth.user)
    )
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    const p256Signer = { sign: (d: string) => ({ signature: signDigestP256(d, p256Key.privBytes), signerKey: p256Key.pubHex }) }
    await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a' }, p256Signer)
    expect(await rowCount(auth.ctx, 'select count(*) as c from RegistrationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(1)
  })

  it('a former officer: decides successfully while current, then throws once a later admin drops them', async function () {
    // Two real (not merely data-level) >=1.1s delays below need headroom beyond mocha's 2000ms
    // default — see those delays' own comment for why they are real, not simulated.
    this.timeout(10_000)
    const formerOfficer = makeDistinctTestUser()
    // A User row must exist before UserEngine.addKey (UserIdValid) -- mirror authority.spec.ts's
    // seedExtraUser: a real InviteSlot via seedUserInvite, then a raw User insert under it.
    const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, formerOfficer)
    const userTid = Date.now() + Math.floor(Math.random() * 100_000)
    await auth.ctx.db.exec(
      `insert into User (Id, Name, ImageRef)
       with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${userTid}
       values (:userId, :userName, :userImageRef)`,
      {
        userId: formerOfficer.id,
        userName: formerOfficer.name,
        userImageRef: formerOfficer.imageRef ? JSON.stringify(formerOfficer.imageRef) : null,
        inviteSlotCid,
        inviteSignature
      }
    )
    await new UserEngine({ ...formerOfficer, activeKeys: [] }, auth.ctx).addKey(formerOfficer.activeKeys[0]!)

    // Two EMPIRICAL findings shape the spacing below:
    // (1) effectiveAt must be STRICTLY LATER than the FOUNDING roster's own effectiveAt (queried,
    //     not guessed) so CurrentAdmin's max(EffectiveAt) resolution actually supersedes it -- a
    //     negative-offset-from-"now" value silently stayed BEFORE the founding roster, so roster 1
    //     never became current and the "while current" decision itself failed
    //     DeciderIsOfficerWithScope.
    // (2) `toCanonicalDatetime` truncates to WHOLE SECONDS (`.toISOString().slice(0,19)`, no
    //     fractional digits) -- a "few milliseconds apart" pair collapses to the SAME
    //     AdminSigning (AuthorityId, AdminEffectiveAt, Scope='rad') tuple, so the nonce lookup in
    //     `promoteAdminRoster` can return the WRONG session's nonce (whichever UUID sorts later)
    //     and `applyAdminProposal` throws `AdminPromotionError: ... roster-mismatch`. A real
    //     (not merely data-level) delay of >1s between roster captures is what actually guarantees
    //     distinct canonical seconds, and capturing each effectiveAt via a FRESH `Date.now()`
    //     immediately before its own promotion (rather than a fixed offset from a single captured
    //     "t0") guarantees it is already <= real wall-clock by the time anything queries it.
    const foundingRow = await auth.ctx.db.prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :id').get({ id: auth.authority.id })
    if (!foundingRow) throw new Error('former-officer test: CurrentAdmin not found for the founding roster')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const effectiveAt1 = Date.now()
    await promoteAdminRoster(
      auth,
      [
        { userId: auth.user.id, title: 'Chair', scopes: ['rad'] as Scope[] },
        { userId: formerOfficer.id, title: 'Temp', scopes: ['vrg'] as Scope[] }
      ],
      effectiveAt1
    )

    const strandId = `strand-${crypto.randomUUID()}`
    const requestIdWhileCurrent = crypto.randomUUID()
    await signAndInsertRegistrationDecision(
      auth.ctx,
      { strandId, requestId: requestIdWhileCurrent, authorityId: auth.authority.id, status: 'a' },
      officerSignerFor(formerOfficer)
    )
    expect(
      await rowCount(auth.ctx, 'select count(*) as c from RegistrationDecision where StrandId = :strandId and RequestId = :requestId', {
        strandId,
        requestId: requestIdWhileCurrent
      })
    ).to.equal(1)

    // Roster 2 drops formerOfficer. A fresh real delay + Date.now() capture, same reasoning as
    // effectiveAt1 above (both findings (1) and (2) apply symmetrically to this second promotion).
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const effectiveAt2 = Date.now()
    await promoteAdminRoster(auth, [{ userId: auth.user.id, title: 'Chair', scopes: ['rad'] as Scope[] }], effectiveAt2)

    const requestIdAfterDrop = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(
        auth.ctx,
        { strandId, requestId: requestIdAfterDrop, authorityId: auth.authority.id, status: 'a' },
        officerSignerFor(formerOfficer)
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'a decision signed by a now-former officer must be rejected').to.be.instanceOf(Error)
  })

  // ── D-44: duplicate-close protocol ──────────────────────────────────────

  it('ClosesRequestId equal to its own RequestId throws', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', closesRequestId: requestId }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'ClosesRequestId equal to its own RequestId must be rejected').to.be.instanceOf(Error)
  })

  it("Status 'd' with no other decision naming it throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'd' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "an orphan 'd' decision (no surviving decision names it) must be rejected").to.be.instanceOf(Error)
  })

  it("after A ('a', ClosesRequestId = B) commits, B ('d', ClosesRequestId null) inserts in a separate transaction", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestIdA = crypto.randomUUID()
    const requestIdB = crypto.randomUUID()
    await signAndInsertRegistrationDecision(
      auth.ctx,
      { strandId, requestId: requestIdA, authorityId: auth.authority.id, status: 'a', closesRequestId: requestIdB },
      officerSignerFor(auth.user)
    )
    await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId: requestIdB, authorityId: auth.authority.id, status: 'd' }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from RegistrationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId: requestIdB })).to.equal(1)
  })

  it("'d' with a non-null ClosesRequestId throws (also covers: ClosesRequestId on a 'd' row throws)", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestIdA = crypto.randomUUID()
    const requestIdB = crypto.randomUUID()
    await signAndInsertRegistrationDecision(
      auth.ctx,
      { strandId, requestId: requestIdA, authorityId: auth.authority.id, status: 'a', closesRequestId: requestIdB },
      officerSignerFor(auth.user)
    )
    let caught: unknown
    try {
      await signAndInsertRegistrationDecision(
        auth.ctx,
        { strandId, requestId: requestIdB, authorityId: auth.authority.id, status: 'd', closesRequestId: requestIdA },
        officerSignerFor(auth.user)
      )
    } catch (err) {
      caught = err
    }
    expect(caught, "a 'd' row carrying a non-null ClosesRequestId must be rejected").to.be.instanceOf(Error)
  })

  it('UPDATE throws — NoUpdate', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a' }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec('update RegistrationDecision set Reason = :reason where StrandId = :strandId and RequestId = :requestId', {
        reason: 'changed',
        strandId,
        requestId
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'UPDATE must be rejected').to.be.instanceOf(Error)
  })

  it('DELETE throws — NoDelete', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertRegistrationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a' }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec('delete from RegistrationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must be rejected').to.be.instanceOf(Error)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AssociationDecision (D-06, D-41, D-45)
// ═══════════════════════════════════════════════════════════════════════════

interface AssociationDecisionFields {
  strandId: string
  requestId: string
  authorityId: string
  status: string
  challengeNonce?: string | null
  reason?: string | null
  revokesDeviceKey?: string | null
  matchMethod?: string | null
  decidedAt?: string
}

async function associationDecisionDigest (ctx: EngineContext, f: AssociationDecisionFields): Promise<string> {
  const row = await ctx.db
    .prepare(
      "select Digest('AssociationDecision', :strandId, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt) as d"
    )
    .get({
      strandId: f.strandId,
      requestId: f.requestId,
      authorityId: f.authorityId,
      status: f.status,
      challengeNonce: f.challengeNonce ?? null,
      reason: f.reason ?? null,
      revokesDeviceKey: f.revokesDeviceKey ?? null,
      matchMethod: f.matchMethod ?? null,
      decidedAt: f.decidedAt ?? null
    })
  if (!row || row.d == null) throw new Error('associationDecisionDigest: Digest() returned null')
  return row.d as string
}

async function insertAssociationDecisionRaw (
  ctx: EngineContext,
  f: AssociationDecisionFields & { deciderKey: string; deciderSignature: string; cursor?: string }
): Promise<void> {
  await ctx.db.exec(
    `insert into AssociationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature)
     with context now = :now
     values (:strandId, :cursor, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt, :deciderKey, :deciderSignature)`,
    {
      strandId: f.strandId,
      cursor: f.cursor ?? nextCursor(),
      requestId: f.requestId,
      authorityId: f.authorityId,
      status: f.status,
      challengeNonce: f.challengeNonce ?? null,
      reason: f.reason ?? null,
      revokesDeviceKey: f.revokesDeviceKey ?? null,
      matchMethod: f.matchMethod ?? null,
      decidedAt: f.decidedAt ?? toIsoZDatetime(Date.now()),
      deciderKey: f.deciderKey,
      deciderSignature: f.deciderSignature,
      now: nowCanonicalDatetime()
    }
  )
}

async function signAndInsertAssociationDecision (
  ctx: EngineContext,
  f: AssociationDecisionFields & { cursor?: string },
  signer: { sign: (d: string) => { signature: string; signerKey: string } }
): Promise<AssociationDecisionFields> {
  const decidedAt = f.decidedAt ?? toIsoZDatetime(Date.now())
  const resolved: AssociationDecisionFields = {
    ...f,
    decidedAt,
    challengeNonce: f.challengeNonce ?? null,
    reason: f.reason ?? null,
    revokesDeviceKey: f.revokesDeviceKey ?? null,
    matchMethod: f.matchMethod ?? null
  }
  const digest = await associationDecisionDigest(ctx, resolved)
  const sig = signer.sign(digest)
  await insertAssociationDecisionRaw(ctx, { ...resolved, cursor: f.cursor, deciderKey: sig.signerKey, deciderSignature: sig.signature })
  return resolved
}

describe('AssociationDecision (D-06, D-41, D-45)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  let auth: TestAuthorityContext

  beforeEach(async () => {
    net = await createTestNetwork()
    auth = await addTestAuthority(net)
  })

  it("'c' with a ChallengeNonce inserts, and 'a' for the SAME RequestId then inserts", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'c', challengeNonce: crypto.randomUUID() }, officerSignerFor(auth.user))
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'code' }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from AssociationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(2)
  })

  it('a second "a" for that RequestId throws — primary key (StrandId, RequestId, Status)', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'code' }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'identity' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'a second row for the same (StrandId, RequestId, Status) must be rejected').to.be.instanceOf(Error)
  })

  it("'c' without a nonce throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'c' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "'c' with no ChallengeNonce must be rejected").to.be.instanceOf(Error)
  })

  it("'a' with a nonce throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', challengeNonce: crypto.randomUUID(), matchMethod: 'code' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "'a' carrying a ChallengeNonce must be rejected").to.be.instanceOf(Error)
  })

  it("Status 'x' signed by a valid officer INSERTS (documents the conformance contract; the read side rejects it, not the write side — association-request-transport-conformance.spec.ts:706-722)", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'x' }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from AssociationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(1)
  })

  it("'a' with RevokesDeviceKey and MatchMethod 'code' inserts", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(
      auth.ctx,
      { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'code', revokesDeviceKey: 'old-device-key' },
      officerSignerFor(auth.user)
    )
    expect(await rowCount(auth.ctx, 'select count(*) as c from AssociationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(1)
  })

  it("'a' with MatchMethod 'identity' and no RevokesDeviceKey inserts", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'identity' }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from AssociationDecision where StrandId = :strandId and RequestId = :requestId', { strandId, requestId })).to.equal(1)
  })

  it("RevokesDeviceKey on an 'r' row throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'r', revokesDeviceKey: 'old-device-key' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "RevokesDeviceKey on a non-'a' row must be rejected").to.be.instanceOf(Error)
  })

  it('RevokesDeviceKey without MatchMethod throws', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', revokesDeviceKey: 'old-device-key' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'RevokesDeviceKey with no MatchMethod must be rejected').to.be.instanceOf(Error)
  })

  it("MatchMethod 'bogus' throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'bogus' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "MatchMethod 'bogus' must be rejected").to.be.instanceOf(Error)
  })

  it("MatchMethod on an 'r' row throws", async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    let caught: unknown
    try {
      await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'r', matchMethod: 'code' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "MatchMethod on a non-'a' row must be rejected").to.be.instanceOf(Error)
  })

  it('UPDATE throws — NoUpdate', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'code' }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec("update AssociationDecision set Reason = :reason where StrandId = :strandId and RequestId = :requestId and Status = 'a'", {
        reason: 'changed',
        strandId,
        requestId
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'UPDATE must be rejected').to.be.instanceOf(Error)
  })

  it('DELETE throws — NoDelete', async () => {
    const strandId = `strand-${crypto.randomUUID()}`
    const requestId = crypto.randomUUID()
    await signAndInsertAssociationDecision(auth.ctx, { strandId, requestId, authorityId: auth.authority.id, status: 'a', matchMethod: 'code' }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec("delete from AssociationDecision where StrandId = :strandId and RequestId = :requestId and Status = 'a'", { strandId, requestId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must be rejected').to.be.instanceOf(Error)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UserEncryptionKey (D-04) — 62-01 Task 3
// ═══════════════════════════════════════════════════════════════════════════

const ENCRYPTION_KEY_ALG = 'secp256k1-ecdh-hkdf-sha256-aes256gcm'

/** Registers a brand-new User (invite + UserKey bootstrap), mirroring the former-officer helper above. */
async function seedRegisteredUser (auth: TestAuthorityContext): Promise<User> {
  const user = makeDistinctTestUser()
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const userTid = Date.now() + Math.floor(Math.random() * 100_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${userTid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
  await new UserEngine({ ...user, activeKeys: [] }, auth.ctx).addKey(user.activeKeys[0]!)
  return user
}

interface UserEncryptionKeyArgs {
  userId: string
  alg?: string
  pubKey?: string
  registeredAt?: string
}

async function insertUserEncryptionKeyRaw (
  ctx: EngineContext,
  f: UserEncryptionKeyArgs & { signerKey: string; signature: string }
): Promise<void> {
  await ctx.db.exec(
    'insert into UserEncryptionKey (UserId, Alg, PubKey, RegisteredAt, SignerKey, Signature) values (:userId, :alg, :pubKey, :registeredAt, :signerKey, :signature)',
    {
      userId: f.userId,
      alg: f.alg ?? ENCRYPTION_KEY_ALG,
      pubKey: f.pubKey ?? randomTestKeyPair().publicHex,
      registeredAt: f.registeredAt ?? toIsoZDatetime(Date.now()),
      signerKey: f.signerKey,
      signature: f.signature
    }
  )
}

async function signAndInsertUserEncryptionKey (
  ctx: EngineContext,
  f: UserEncryptionKeyArgs,
  signer: { sign: (d: string) => { signature: string; signerKey: string } }
): Promise<UserEncryptionKeyArgs & { pubKey: string }> {
  const alg = f.alg ?? ENCRYPTION_KEY_ALG
  const pubKey = f.pubKey ?? randomTestKeyPair().publicHex
  const registeredAt = f.registeredAt ?? toIsoZDatetime(Date.now())
  const digestRow = await ctx.db
    .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :registeredAt) as d")
    .get({ userId: f.userId, alg, pubKey, registeredAt })
  if (!digestRow || digestRow.d == null) throw new Error('signAndInsertUserEncryptionKey: Digest() returned null')
  const sig = signer.sign(digestRow.d as string)
  await insertUserEncryptionKeyRaw(ctx, { userId: f.userId, alg, pubKey, registeredAt, signerKey: sig.signerKey, signature: sig.signature })
  return { userId: f.userId, alg, pubKey, registeredAt }
}

describe('UserEncryptionKey (D-04)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  let auth: TestAuthorityContext

  beforeEach(async () => {
    net = await createTestNetwork()
    auth = await addTestAuthority(net)
  })

  it("a row self-signed by a key in the same user's UserKey inserts", async () => {
    const { pubKey } = await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(auth.user))
    expect(await rowCount(auth.ctx, 'select count(*) as c from UserEncryptionKey where UserId = :userId and PubKey = :pubKey', { userId: auth.user.id, pubKey })).to.equal(1)
  })

  it("signed by a DIFFERENT user's key throws", async () => {
    const otherUser = await seedRegisteredUser(auth)
    let caught: unknown
    try {
      await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(otherUser))
    } catch (err) {
      caught = err
    }
    expect(caught, "a different user's key must be rejected by SignerIsUser").to.be.instanceOf(Error)
  })

  it('signature over a different digest throws', async () => {
    const pubKey = randomTestKeyPair().publicHex
    const registeredAt = toIsoZDatetime(Date.now())
    const otherDigestRow = await auth.ctx.db
      .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :otherRegisteredAt) as d")
      .get({ userId: auth.user.id, alg: ENCRYPTION_KEY_ALG, pubKey, otherRegisteredAt: toIsoZDatetime(Date.now() + 1000) })
    if (!otherDigestRow?.d) throw new Error('Digest() returned null')
    const sig = signTestDigest(auth.user, otherDigestRow.d as string)
    let caught: unknown
    try {
      await insertUserEncryptionKeyRaw(auth.ctx, { userId: auth.user.id, pubKey, registeredAt, signerKey: sig.signerKey, signature: sig.signature })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a signature over a different digest must be rejected').to.be.instanceOf(Error)
  })

  it("Alg other than 'secp256k1-ecdh-hkdf-sha256-aes256gcm' throws", async () => {
    let caught: unknown
    try {
      await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id, alg: 'bogus-alg' }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'an unrecognized Alg must be rejected').to.be.instanceOf(Error)
  })

  it('a 64-character PubKey throws', async () => {
    let caught: unknown
    try {
      await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id, pubKey: '02'.concat('a'.repeat(62)) }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, 'a 64-character (not 66-character) PubKey must be rejected').to.be.instanceOf(Error)
  })

  it("a PubKey starting '04' throws", async () => {
    let caught: unknown
    try {
      await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id, pubKey: '04'.concat('a'.repeat(64)) }, officerSignerFor(auth.user))
    } catch (err) {
      caught = err
    }
    expect(caught, "a '04'-prefixed (uncompressed) PubKey must be rejected").to.be.instanceOf(Error)
  })

  it('a second key for the same user (different PubKey) inserts', async () => {
    const first = await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(auth.user))
    const second = await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(auth.user))
    expect(first.pubKey).to.not.equal(second.pubKey)
    expect(await rowCount(auth.ctx, 'select count(*) as c from UserEncryptionKey where UserId = :userId', { userId: auth.user.id })).to.equal(2)
  })

  it('UPDATE throws — NoUpdate', async () => {
    const { pubKey } = await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec('update UserEncryptionKey set RegisteredAt = :registeredAt where UserId = :userId and PubKey = :pubKey', {
        registeredAt: toIsoZDatetime(Date.now() + 1000),
        userId: auth.user.id,
        pubKey
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'UPDATE must be rejected').to.be.instanceOf(Error)
  })

  it('DELETE throws — NoDelete', async () => {
    const { pubKey } = await signAndInsertUserEncryptionKey(auth.ctx, { userId: auth.user.id }, officerSignerFor(auth.user))
    let caught: unknown
    try {
      await auth.ctx.db.exec('delete from UserEncryptionKey where UserId = :userId and PubKey = :pubKey', { userId: auth.user.id, pubKey })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must be rejected').to.be.instanceOf(Error)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AuthorityIntakePolicy (D-29, D-46) — 62-01 Task 3
// ═══════════════════════════════════════════════════════════════════════════

interface AuthorityIntakePolicyArgs {
  revision: number
  restBridgeUrl: string | null
  reassociationMode: string
  setAt?: string
}

async function seedAndInsertAuthorityIntakePolicy (
  auth: TestAuthorityContext,
  scope: Scope,
  args: AuthorityIntakePolicyArgs,
  digestOverride?: { reassociationMode?: string }
): Promise<void> {
  const setAt = args.setAt ?? toIsoZDatetime(Date.now())
  const tid = Date.now() + Math.floor(Math.random() * 100_000)
  const digestExpr = "select Digest(:tid, 'AuthorityIntakePolicy', :authorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt) as d"
  const digestParams = {
    tid,
    authorityId: auth.authority.id,
    revision: args.revision,
    restBridgeUrl: args.restBridgeUrl,
    reassociationMode: digestOverride?.reassociationMode ?? args.reassociationMode,
    setAt
  }
  const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, scope, tid, digestExpr, digestParams, auth.user)
  await auth.ctx.db.exec(
    `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
     with context SigningNonce = :nonce, Tid = ${tid}
     values (:authorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt)`,
    {
      authorityId: auth.authority.id,
      revision: args.revision,
      restBridgeUrl: args.restBridgeUrl,
      reassociationMode: args.reassociationMode,
      setAt,
      nonce
    }
  )
}

describe('AuthorityIntakePolicy (D-29, D-46)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  let auth: TestAuthorityContext
  let revisionSeq = 0

  beforeEach(async () => {
    net = await createTestNetwork()
    auth = await addTestAuthority(net)
    revisionSeq = 0
  })

  function nextRevision (): number {
    revisionSeq += 1
    return revisionSeq
  }

  it("an insert under a seeded 'vrg' ceremony with the matching digest inserts", async () => {
    const revision = nextRevision()
    await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'manual' })
    expect(await rowCount(auth.ctx, 'select count(*) as c from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision = :revision', { authorityId: auth.authority.id, revision })).to.equal(1)
  })

  it("the same insert under a 'mel' ceremony throws", async () => {
    const revision = nextRevision()
    let caught: unknown
    try {
      await seedAndInsertAuthorityIntakePolicy(auth, 'mel' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'manual' })
    } catch (err) {
      caught = err
    }
    expect(caught, "a 'mel'-scoped ceremony must be rejected by MutationValid (requires 'vrg')").to.be.instanceOf(Error)
  })

  it('a digest over a different ReassociationMode throws', async () => {
    const revision = nextRevision()
    let caught: unknown
    try {
      await seedAndInsertAuthorityIntakePolicy(
        auth,
        'vrg' as Scope,
        { revision, restBridgeUrl: null, reassociationMode: 'manual' },
        { reassociationMode: 'automatic' }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'a digest computed over a different ReassociationMode must be rejected').to.be.instanceOf(Error)
  })

  it("ReassociationMode 'auto' throws", async () => {
    const revision = nextRevision()
    let caught: unknown
    try {
      await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'auto' })
    } catch (err) {
      caught = err
    }
    expect(caught, "'auto' (not 'automatic') must be rejected by ReassociationModeValid").to.be.instanceOf(Error)
  })

  it("RestBridgeUrl 'http://bridge.example' throws", async () => {
    const revision = nextRevision()
    let caught: unknown
    try {
      await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: 'http://bridge.example', reassociationMode: 'manual' })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a non-https RestBridgeUrl must be rejected (D-29 https-only)').to.be.instanceOf(Error)
  })

  it("RestBridgeUrl null and 'https://bridge.example/intake' both insert", async () => {
    const revisionNull = nextRevision()
    await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision: revisionNull, restBridgeUrl: null, reassociationMode: 'manual' })
    const revisionHttps = nextRevision()
    await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision: revisionHttps, restBridgeUrl: 'https://bridge.example/intake', reassociationMode: 'automatic' })
    expect(await rowCount(auth.ctx, 'select count(*) as c from AuthorityIntakePolicy where AuthorityId = :authorityId', { authorityId: auth.authority.id })).to.equal(2)
  })

  it('a non-Z SetAt throws', async () => {
    const revision = nextRevision()
    let caught: unknown
    try {
      await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'manual', setAt: '2026-01-01T00:00:00.000' })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a non-Z-suffixed SetAt must be rejected').to.be.instanceOf(Error)
  })

  it('UPDATE throws — NoUpdate', async () => {
    const revision = nextRevision()
    await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'manual' })
    let caught: unknown
    try {
      await auth.ctx.db.exec('update AuthorityIntakePolicy set ReassociationMode = :mode where AuthorityId = :authorityId and Revision = :revision', {
        mode: 'automatic',
        authorityId: auth.authority.id,
        revision
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'UPDATE must be rejected').to.be.instanceOf(Error)
  })

  it('DELETE throws — NoDelete', async () => {
    const revision = nextRevision()
    await seedAndInsertAuthorityIntakePolicy(auth, 'vrg' as Scope, { revision, restBridgeUrl: null, reassociationMode: 'manual' })
    let caught: unknown
    try {
      await auth.ctx.db.exec('delete from AuthorityIntakePolicy where AuthorityId = :authorityId and Revision = :revision', { authorityId: auth.authority.id, revision })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must be rejected').to.be.instanceOf(Error)
  })
})
