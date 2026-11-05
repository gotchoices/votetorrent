/**
 * registration-request-read.spec.ts — Phase 48 Plan 08 (D-06/D-09)
 *
 * The registration-request READ surface: `listRegistrationRequests` (the
 * triage queue, keyset-paged, `ReceivedAt`-ordered — T-48-08-11),
 * `getRegistrationRequest` (the point read backing all three approval-screen
 * modes), `getPriorRejections` (D-06 reachability), and
 * `getRegistrationTransparencyStats` (D-09 counts + median).
 *
 * Drives the REAL `RegistrationEngine` against the REAL Quereus schema — no
 * mocks. Every seeded `RegistrationRequest` row carries a REAL requester
 * secp256k1 self-signature (D-02), reusing 48-04/48-07's own DG-1 digest
 * field order (`registration-request.spec.ts`) rather than re-deriving it.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestNetwork, addTestAuthority, seedSignedMutation, seedAuthorityInvite, testKeyPairFor } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { verificationCid } from '@votetorrent/vote-core'
import type { RegisterInit, RegistrationVerificationChecklistItem, Scope, Signature } from '@votetorrent/vote-core'

const SRC_REGISTRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'registration')

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

const FUTURE_EXPIRATION = new Date(Date.now() + 365 * 86_400_000).toISOString()

/**
 * T-42-06 (carried from `registration-request.spec.ts`): a plain SELECT
 * read-back of a Quereus `datetime` column drops the trailing `Z` AND
 * serializes fractional seconds at MINIMAL precision (trailing zero digits
 * stripped) — not just for deferred-CHECK snapshots. A literal
 * byte-identical comparison against the originally-seeded string is
 * therefore flaky whenever the millisecond component happens to end in a
 * `0`. Normalize the EXPECTED value through this before comparing against
 * the engine's own `reZuluDatetime`-normalized read-back.
 */
function stripTrailingZeroMs (isoZ: string): string {
  let s = isoZ.replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return `${s}Z`
}

/** Computes a checklist's VerificationCid the SAME way the D-07 module + engine do — the D-06 module's own canonical serializer, digested through the real `cid(Digest(...))` UDF, never a JS hash. */
async function computeTestVerificationCid (auth: TestAuthority, items: readonly RegistrationVerificationChecklistItem[]): Promise<string> {
  return await verificationCid(items, async (canonical) => {
    const row = await auth.ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
    if (!row || row.c == null) throw new Error('computeTestVerificationCid: cid(Digest(...)) returned null')
    return row.c as string
  })
}

/**
 * A real 'vrg'-ceremony-shaped signer for `RegistrationEngine.register()` —
 * mirrors `field-policy.spec.ts`'s own `makeRegistrantSigner`. `AdminSigning
 * .SignerKeyValid` requires the signer key to be the user's registered,
 * unexpired UserKey, so this signs with the fixture user's registered key.
 */
function makeOfficerSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * WR-10 prehash contract: `secp256k1.sign(bytes, priv)` with NO explicit
 * `prehash` option relies on @noble/curves v2's default (`prehash:true`) —
 * identical shape to `registration-request.spec.ts`'s own
 * `makeRequesterSigner`. Deliberately returns a bare hex signature string,
 * not a `Signature` object — a prospective registrant has no `signerUserId`.
 */
function makeRequesterSigner (): { publicHex: string; signDigest: (digestBase64url: string) => string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const signDigest = (digestBase64url: string): string => {
    const digestBytes = digestToBytes(digestBase64url)
    return bytesToHex(secp256k1.sign(digestBytes, privBytes))
  }
  return { publicHex, signDigest }
}

interface SeedRequestOverrides {
  /** External signer to use instead of a freshly-generated one — e.g. two rows from the SAME requester (D-06 prior-rejection tests). */
  signer?: { publicHex: string; signDigest: (digestBase64url: string) => string }
  /** Row's own AuthorityId — defaults to `auth.authority.id`. Overridable so the D-09 authority-scoping test can seed a row under a DIFFERENT (but still real) Authority row in the same db. */
  authorityId?: string
  issuerType?: 'registrant' | 'bridge'
  bridgeId?: string | null
  requesterKey?: string
  payload?: RegisterInit
  submittedAt?: string
  receivedAt?: string
  status?: 'p' | 'a' | 'r'
  decidedAt?: string | null
  decidingOfficerUserId?: string | null
  rejectionReason?: string | null
  verificationCid?: string | null
}

interface SeedRequestResult {
  id: string
  requesterKey: string
  payload: RegisterInit
  submittedAt: string
  receivedAt: string
}

/**
 * Insert one `RegistrationRequest` row by raw SQL, reusing 48-04/48-07's own
 * `SignatureValid` digest field order verbatim
 * (`registration-request.spec.ts`'s `seedRegistrationRequest`):
 * `Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid,
 * SubmittedAt)` — no `context.Tid`, no `ReceivedAt`. `submittedAt` and
 * `receivedAt` can be set INDEPENDENTLY (DG-1 covers the former, never the
 * latter) — the anti-backdating proof below depends on this.
 *
 * DECLARED BLIND SPOT: `status`/`decidedAt`/`decidingOfficerUserId`/
 * `rejectionReason`/`verificationCid` can all be seeded pre-decided directly
 * on INSERT — `DecisionValid` is a `check on update` ONLY and none of DG-1's
 * seven digest arguments cover any decision column, so a correctly-signed
 * INSERT of an already-decided row is schema-legal. This seeds the READ
 * surface only and proves NOTHING about the decision ceremony's own
 * transition semantics, which the rejection plan (48-12) owns.
 */
async function seedRequest (auth: TestAuthority, overrides?: SeedRequestOverrides): Promise<SeedRequestResult> {
  const authorityId = overrides?.authorityId ?? auth.authority.id
  const id = crypto.randomUUID()
  const signer = overrides?.signer ?? makeRequesterSigner()
  const requesterKey = overrides?.requesterKey ?? signer.publicHex
  const issuerType = overrides?.issuerType ?? 'registrant'
  const bridgeId = overrides?.bridgeId === undefined ? null : overrides.bridgeId
  const payload: RegisterInit = overrides?.payload ?? {
    registrant: { id: crypto.randomUUID(), authorityId, expiration: FUTURE_EXPIRATION },
    private: { expiration: FUTURE_EXPIRATION, details: [] }
  }
  const payloadJson = JSON.stringify(payload)
  // Kept within a few hours of "now" by default so no row trips
  // SubmittedAtSaneValid's absolute bound; callers override explicitly.
  const submittedAt = overrides?.submittedAt ?? toIsoZDatetime(Date.now())
  const receivedAt = overrides?.receivedAt ?? toIsoZDatetime(Date.now())
  const status = overrides?.status ?? 'p'
  const decidedAt = overrides?.decidedAt === undefined ? null : overrides.decidedAt
  const decidingOfficerUserId = overrides?.decidingOfficerUserId === undefined ? null : overrides.decidingOfficerUserId
  const rejectionReason = overrides?.rejectionReason === undefined ? null : overrides.rejectionReason
  const verificationCidValue = overrides?.verificationCid === undefined ? null : overrides.verificationCid

  const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson })
  if (!cidRow || cidRow.d == null) throw new Error('seedRequest: PayloadCid Digest() returned null')
  const payloadCid = cidRow.d as string

  const digestRow = await auth.ctx.db
    .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
    .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid, submittedAt })
  if (!digestRow || digestRow.d == null) throw new Error('seedRequest: SignatureValid Digest() returned null')
  const requesterSignature = signer.signDigest(digestRow.d as string)

  await auth.ctx.db.exec(
    `insert into RegistrationRequest (
      Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt,
      RequesterSignature, VerificationCid, DecidedAt, DecidingOfficerUserId, RejectionReason
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt,
      :requesterSignature, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason)`,
    {
      id,
      authorityId,
      requesterKey,
      issuerType,
      bridgeId,
      payload: payloadJson,
      payloadCid,
      status,
      submittedAt,
      receivedAt,
      requesterSignature,
      verificationCid: verificationCidValue,
      decidedAt,
      decidingOfficerUserId,
      rejectionReason,
      tid: Date.now()
    }
  )

  return { id, requesterKey, payload, submittedAt, receivedAt }
}

/**
 * Register a bridge key via the real `'vrg'`-scoped officer ceremony —
 * mirrors `registration-request.spec.ts`'s own `seedBridgeKey`.
 */
async function seedBridgeKey (auth: TestAuthority, opts: { label: string; key: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const authorityId = auth.authority.id
  const label = opts.label
  const bridgeKey = opts.key
  const revokedAt = null
  const tid = Date.now()
  // RegistrationBridgeKey.MutationValid's Digest(...) argument order, field
  // for field: Digest(context.Tid, new.Id, new.AuthorityId, new.Label,
  // new.BridgeKey, new.RevokedAt). `authId` avoids seedSignedMutation's
  // reserved `authorityId` bind name.
  const digestExpr = 'select Digest(:tid, :id, :authId, :label, :bridgeKey, :revokedAt) as d'
  const digestParams = { tid, id, authId: authorityId, label, bridgeKey, revokedAt }
  const { nonce } = await seedSignedMutation(auth.ctx, authorityId, 'vrg', tid, digestExpr, digestParams, auth.user)
  await auth.ctx.db.exec(
    `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
     with context SigningNonce = :nonce, Tid = :tid
     values (:id, :authorityId, :label, :bridgeKey, :revokedAt)`,
    { id, authorityId, label, bridgeKey, revokedAt, nonce, tid }
  )
  return { id }
}

/**
 * Creates a REAL second `Authority` row inside the SAME db as `auth` — the
 * proven `'rad'` recipe mirrored verbatim from `registrant-list.spec.ts`'s
 * own `createSecondAuthority`, needed to prove `getRegistrationTransparencyStats`
 * is actually authority-SCOPED by its `AuthorityId = :authorityId` predicate,
 * not merely db-isolated (two separate `createTestNetwork()` dbs would never
 * exercise that predicate at all).
 */
async function createSecondAuthority (auth: TestAuthority, name: string, domainName: string): Promise<string> {
  const inviteCtx = await seedAuthorityInvite(auth, {
    name,
    domainName,
    officers: [{ userId: auth.user.id, title: 'Chair', scopes: JSON.stringify(['rad']) }]
  })
  await auth.networkEngine.createAuthority(
    { name, domainName },
    {
      officers: [{ init: { name: 'Officer', title: 'Chair', scopes: ['rad'] as Scope[] } }],
      effectiveAt: inviteCtx.adminEffectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    { inviteSlotCid: inviteCtx.inviteSlotCid, inviteSignature: 'a'.repeat(128) }
  )
  const row = await auth.ctx.db.prepare('select Id from Authority where Name = :n').get({ n: name })
  return row!.Id as string
}

// ---------------------------------------------------------------------------
// listRegistrationRequests (D-06/D-09/T-48-08-11)
// ---------------------------------------------------------------------------

describe('listRegistrationRequests', () => {
  it('returns rows in strictly non-decreasing receivedAt order, oldest received first', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    const r1 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base) })
    const r2 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base + 60_000) })
    const r3 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base + 120_000) })

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    expect(result.rows.map((r) => r.requestId)).to.deep.equal([r1.id, r2.id, r3.id])
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i]!.receivedAt >= result.rows[i - 1]!.receivedAt).to.equal(true)
    }
  })

  it('T-48-08-11: the anti-backdating proof — a submittedAt order reversed against receivedAt buys NO queue position', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    // A claims the EARLIER submittedAt but is RECEIVED SECOND.
    const a = await seedRequest(auth, { submittedAt: toIsoZDatetime(base), receivedAt: toIsoZDatetime(base + 120_000) })
    // B claims the LATER submittedAt but is RECEIVED FIRST.
    const b = await seedRequest(auth, { submittedAt: toIsoZDatetime(base + 60_000), receivedAt: toIsoZDatetime(base + 60_000) })

    // Stake: submittedAt is submitter-CHOSEN. If this assertion ever inverts, any submitter can
    // jump an officer's triage queue by editing one string before signing — the backdated claim
    // would sit inside a validly-signed row with nothing downstream looking wrong. This test is
    // the ENTIRE reason the order key changed off SubmittedAt; it must not be softened into
    // "returns rows in some order".
    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const returnedOrder = result.rows.map((r) => r.requestId)
    const receivedAtOrder = [b.id, a.id]
    const submittedAtOrder = [a.id, b.id]
    expect(returnedOrder, 'must come back in receivedAt order').to.deep.equal(receivedAtOrder)
    expect(returnedOrder, 'must NOT come back in submittedAt order').to.not.deep.equal(submittedAtOrder)
  })

  it('two rows sharing an identical receivedAt come back in ascending requestId order (the tiebreak is real, not incidental)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const sharedReceivedAt = toIsoZDatetime(Date.now())
    const r1 = await seedRequest(auth, { receivedAt: sharedReceivedAt })
    const r2 = await seedRequest(auth, { receivedAt: sharedReceivedAt })
    const [lo, hi] = [r1.id, r2.id].sort()

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    expect(result.rows.map((r) => r.requestId)).to.deep.equal([lo, hi])
  })

  it('filter.status and filter.issuerType each narrow the set, and together AND (exact intersection)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'Legacy Roll Importer', key: bridgeSigner.publicHex })

    await seedRequest(auth, { status: 'p', issuerType: 'registrant' })
    await seedRequest(auth, {
      status: 'a',
      issuerType: 'registrant',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })
    const pendingBridge = await seedRequest(auth, { status: 'p', issuerType: 'bridge', signer: bridgeSigner, bridgeId })

    const pendingOnly = await engine.listRegistrationRequests({ authorityId: auth.authority.id, status: 'p' })
    expect(pendingOnly.rows).to.have.lengthOf(2)
    expect(pendingOnly.rows.every((r) => r.status === 'p')).to.equal(true)

    const bridgeOnly = await engine.listRegistrationRequests({ authorityId: auth.authority.id, issuerType: 'bridge' })
    expect(bridgeOnly.rows).to.have.lengthOf(1)
    expect(bridgeOnly.rows[0]!.requestId).to.equal(pendingBridge.id)

    const both = await engine.listRegistrationRequests({ authorityId: auth.authority.id, status: 'p', issuerType: 'bridge' })
    expect(both.rows).to.have.lengthOf(1)
    expect(both.rows[0]!.requestId).to.equal(pendingBridge.id)
  })

  it("a bridge row's bridgeLabel equals the registered RegistrationBridgeKey.Label; a registrant row's bridgeLabel/bridgeId are undefined", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'County Clerk Import', key: bridgeSigner.publicHex })
    const bridgeReq = await seedRequest(auth, { issuerType: 'bridge', signer: bridgeSigner, bridgeId })
    const registrantReq = await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const bridgeRow = result.rows.find((r) => r.requestId === bridgeReq.id)!
    const registrantRow = result.rows.find((r) => r.requestId === registrantReq.id)!
    expect(bridgeRow.bridgeLabel).to.equal('County Clerk Import')
    expect(bridgeRow.bridgeId).to.equal(bridgeId)
    expect(registrantRow.bridgeLabel).to.equal(undefined)
    expect(registrantRow.bridgeId).to.equal(undefined)
  })

  it('pageSize=2 over 5 matching rows pages with no overlap and no gap; the union equals the full set by id', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    const seeded: SeedRequestResult[] = []
    for (let i = 0; i < 5; i++) {
      // submittedAt deliberately OUT OF STEP with receivedAt — a cursor predicate that still keys
      // on SubmittedAt would produce a gap or a repeat here and fail, rather than passing by
      // coincidence.
      seeded.push(
        await seedRequest(auth, {
          receivedAt: toIsoZDatetime(base + i * 60_000),
          submittedAt: toIsoZDatetime(base + (4 - i) * 60_000)
        })
      )
    }

    const page1 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2 })
    expect(page1.rows).to.have.lengthOf(2)
    expect(page1.nextCursor).to.not.equal(undefined)

    const page2 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: page1.nextCursor })
    expect(page2.rows).to.have.lengthOf(2)
    expect(page2.nextCursor).to.not.equal(undefined)

    const page3 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: page2.nextCursor })
    expect(page3.rows).to.have.lengthOf(1)
    expect(page3.nextCursor).to.equal(undefined)

    const seenIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.requestId)
    expect(new Set(seenIds).size, 'no overlap and no gap').to.equal(5)
    expect(new Set(seenIds)).to.deep.equal(new Set(seeded.map((s) => s.id)))
  })

  it('total is defined and equals the filtered row count on the cursor-absent call, and is undefined on every cursor-bearing call', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    for (let i = 0; i < 3; i++) await seedRequest(auth)

    const first = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2 })
    expect(first.total).to.equal(3)

    const second = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: first.nextCursor })
    expect(second.total).to.equal(undefined)
  })

  it('an unknown/stale cursor returns { rows: [] }, does not throw, and does not return page 1', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { cursor: crypto.randomUUID() })
    expect(result.rows).to.deep.equal([])
  })

  it('hasPriorRejections is true only for a request whose RequesterKey has an EARLIER rejected request, and a rejection never counts itself', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const repeatSigner = makeRequesterSigner()

    const rejected = await seedRequest(auth, {
      signer: repeatSigner,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Could not verify identity'
    })
    const resubmission = await seedRequest(auth, { signer: repeatSigner })
    const firstTime = await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const rejectedRow = result.rows.find((r) => r.requestId === rejected.id)!
    const resubmissionRow = result.rows.find((r) => r.requestId === resubmission.id)!
    const firstTimeRow = result.rows.find((r) => r.requestId === firstTime.id)!

    expect(resubmissionRow.hasPriorRejections, 'a pending request from a key with an earlier rejection').to.equal(true)
    expect(firstTimeRow.hasPriorRejections, 'a first-time key').to.equal(false)
    expect(rejectedRow.hasPriorRejections, 'a rejected request does not count itself as its own prior rejection').to.equal(false)
  })

  it('WR-12: filter.name matches the PUBLIC name fields only — it is not an oracle over the private tier, and % is not a wildcard', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)

    // A payload whose PRIVATE tier carries a distinctive sentinel that appears nowhere in the
    // public tier. Before WR-12 the filter was `R.Payload like '%<name>%'` over the whole
    // serialized RegisterInit, so typing this sentinel into the inbox search box returned the row
    // — confirming the value's presence in a pending request and turning a name search into an
    // oracle over exactly the tier this phase never logs or discloses.
    const privateSentinel = '555-90-1234'
    const target = await seedRequest(auth, {
      payload: {
        registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        public: { lastName: 'Okonkwo', firstName: 'Ada' },
        private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'ssn', value: privateSentinel }] }
      } as RegisterInit
    })
    await seedRequest(auth, {
      payload: {
        registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        public: { lastName: 'Nakamura', firstName: 'Kenji' },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      } as RegisterInit
    })

    const byPrivate = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: privateSentinel })
    expect(
      byPrivate.rows,
      'a private-tier value must never be reachable through the name filter — the search box must not be an oracle over private.details'
    ).to.deep.equal([])

    // The filter still does its actual job, on the public tier, case-insensitively.
    const byLastName = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: 'okon' })
    expect(byLastName.rows.map((r) => r.requestId)).to.deep.equal([target.id])

    const byFirstName = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: 'ADA' })
    expect(byFirstName.rows.map((r) => r.requestId)).to.deep.equal([target.id])

    // `%` is matched LITERALLY now, not as a wildcard. Under the old `like '%<name>%'` form this
    // query returned every row; Quereus supports no `escape` clause, so escaping was not an
    // available fix — the metacharacter-free `instr` is.
    const byWildcard = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: '%' })
    expect(byWildcard.rows, "a bare '%' must match nothing — it is a literal, not a wildcard").to.deep.equal([])

    // A request with no public tier at all must be excluded, not crash the inbox.
    await seedRequest(auth, {
      payload: {
        registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      } as RegisterInit
    })
    const stillWorks = await engine.listRegistrationRequests({ authorityId: auth.authority.id, name: 'okon' })
    expect(stillWorks.rows.map((r) => r.requestId)).to.deep.equal([target.id])
  })
})

// ---------------------------------------------------------------------------
// getRegistrationRequest — the point read backing all three approval-screen modes
// ---------------------------------------------------------------------------

describe('getRegistrationRequest', () => {
  it('a pending registrant-issued request round-trips, and a seeded submittedAt/receivedAt divergence survives the read', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const submittedAt = toIsoZDatetime(Date.now() - 45 * 60_000)
    const receivedAt = toIsoZDatetime(Date.now())
    const seeded = await seedRequest(auth, { submittedAt, receivedAt })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read, 'a seeded request must round-trip').to.not.equal(undefined)
    expect(read!.payload).to.deep.equal(seeded.payload)
    expect(read!.issuerType).to.equal('registrant')
    expect(read!.bridgeId).to.equal(undefined)
    expect(read!.bridgeLabel).to.equal(undefined)
    expect(read!.decidedAt).to.equal(undefined)
    expect(read!.registrantId).to.equal(undefined)

    // The point read surfaces the divergence rather than collapsing it —
    // the only way an officer can ever notice a requester whose claim
    // disagrees with the authority's own observation.
    expect(read!.submittedAt).to.equal(stripTrailingZeroMs(submittedAt))
    expect(read!.receivedAt).to.equal(stripTrailingZeroMs(receivedAt))
    expect(read!.submittedAt).to.not.equal(read!.receivedAt)
  })

  it('a bridge-issued request returns issuerType=bridge, its bridgeId, and the registered Label as bridgeLabel', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'State Voter Roll Import', key: bridgeSigner.publicHex })
    const seeded = await seedRequest(auth, { issuerType: 'bridge', signer: bridgeSigner, bridgeId })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read!.issuerType).to.equal('bridge')
    expect(read!.bridgeId).to.equal(bridgeId)
    expect(read!.bridgeLabel).to.equal('State Voter Roll Import')
  })

  it('an approved request with an existing Registrant returns registrantId; one whose Registrant is absent returns registrantId=undefined and does not throw', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)

    // T-48-08-05: seed a REAL Registrant row through the real register()
    // ceremony (Registrant.MutationValid requires a genuine 'vrg' AdminSigning
    // row and a genuine SignatureValid — a raw INSERT cannot fabricate this)
    // so the existence probe below has something real to find.
    const registrantId = crypto.randomUUID()
    const officerSign = makeOfficerSigner(auth.user.id)
    const producedPayload: RegisterInit = {
      registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [] }
    }
    await engine.register(producedPayload, officerSign)

    const produced = await seedRequest(auth, {
      payload: producedPayload,
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })

    const missingPayload: RegisterInit = {
      registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [] }
    }
    const missing = await seedRequest(auth, {
      payload: missingPayload,
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })

    const producedRead = await engine.getRegistrationRequest(produced.id)
    expect(producedRead!.registrantId).to.equal(registrantId)

    const missingRead = await engine.getRegistrationRequest(missing.id)
    expect(missingRead!.registrantId).to.equal(undefined)
  })

  it('a request decided with checklist [id, roll] returns verificationChecklist deep-equal to the canonical ordering, and verificationCid equal to the stored digest; an unknown id returns undefined', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const checklist: RegistrationVerificationChecklistItem[] = ['id', 'roll']
    const cid = await computeTestVerificationCid(auth, checklist)
    const seeded = await seedRequest(auth, {
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      verificationCid: cid
    })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read!.verificationCid).to.equal(cid)
    // VERIFICATION_CHECKLIST_ITEM_ORDER is ['id','roll','eligibility','none'] — canonical order
    // regardless of the input order above.
    expect(read!.verificationChecklist).to.deep.equal(['id', 'roll'])

    const unknown = await engine.getRegistrationRequest(crypto.randomUUID())
    expect(unknown).to.equal(undefined)
  })
})

// ---------------------------------------------------------------------------
// getPriorRejections (D-06 reachability)
// ---------------------------------------------------------------------------

describe('getPriorRejections', () => {
  it('three rejections for one requesterKey come back newest-rejectedAt-first, each carrying its own rejectionReason and decidingOfficerUserId', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const signer = makeRequesterSigner()
    const base = Date.now()

    const r1 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Illegible identification'
    })
    const r2 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base + 60_000),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Address mismatch'
    })
    const r3 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base + 120_000),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Duplicate submission'
    })

    const rejections = await engine.getPriorRejections(signer.publicHex)
    expect(rejections.map((r) => r.requestId)).to.deep.equal([r3.id, r2.id, r1.id])
    expect(rejections.map((r) => r.rejectionReason)).to.deep.equal(['Duplicate submission', 'Address mismatch', 'Illegible identification'])
    expect(rejections.every((r) => r.decidingOfficerUserId === auth.user.id)).to.equal(true)
  })

  it('a key with no rejections returns []; an entirely unknown key returns [] without throwing', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const seeded = await seedRequest(auth)

    const noRejections = await engine.getPriorRejections(seeded.requesterKey)
    expect(noRejections).to.deep.equal([])

    const unknownKey = await engine.getPriorRejections(randomTestKeyPair().publicHex)
    expect(unknownKey).to.deep.equal([])
  })

  it('rejections belonging to a DIFFERENT RequesterKey are not returned (the read is key-scoped, not authority-scoped)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const signerA = makeRequesterSigner()
    const signerB = makeRequesterSigner()

    await seedRequest(auth, {
      signer: signerA,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'signer A reason'
    })
    const bRejection = await seedRequest(auth, {
      signer: signerB,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'signer B reason'
    })

    const forB = await engine.getPriorRejections(signerB.publicHex)
    expect(forB.map((r) => r.requestId)).to.deep.equal([bRejection.id])
  })
})

// ---------------------------------------------------------------------------
// getRegistrationTransparencyStats (D-09)
// ---------------------------------------------------------------------------

describe('getRegistrationTransparencyStats', () => {
  it('counts match a seeded mix exactly (3 pending / 2 approved / 1 rejected)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    for (let i = 0; i < 3; i++) await seedRequest(auth, { status: 'p' })
    for (let i = 0; i < 2; i++) {
      await seedRequest(auth, { status: 'a', decidedAt: toIsoZDatetime(Date.now()), decidingOfficerUserId: auth.user.id })
    }
    await seedRequest(auth, {
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Could not verify identity'
    })

    const stats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(stats.pending).to.equal(3)
    expect(stats.approved).to.equal(2)
    expect(stats.rejected).to.equal(1)
  })

  it('an authority with zero requests returns all-zero counts and medianTimeToDecisionMs=undefined — never NaN', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)

    const stats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(stats).to.deep.equal({ pending: 0, approved: 0, rejected: 0, medianTimeToDecisionMs: undefined })
    // Not merely `to.be.undefined` — explicitly assert it is never the OTHER
    // degenerate numeric value a naive 0/0 division would produce.
    expect(Number.isNaN(stats.medianTimeToDecisionMs), 'medianTimeToDecisionMs must never be NaN').to.equal(false)
  })

  it('requests belonging to a DIFFERENT authority do not contribute to counts or the median (authority-scoped)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const authorityBId = await createSecondAuthority(auth, 'Stats Authority B', 'stats-authority-b.example.com')

    await seedRequest(auth, { status: 'p' })
    await seedRequest(auth, {
      authorityId: authorityBId,
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })

    const stats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(stats.pending).to.equal(1)
    expect(stats.approved, 'the approved row belongs to authority B and must not be counted').to.equal(0)
    expect(stats.medianTimeToDecisionMs, 'authority B\'s decided row must not enter the median').to.equal(undefined)
  })

  it('an odd count yields the middle delta; an even count yields the rounded mean of the two middle deltas — measured from ReceivedAt, not SubmittedAt', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()

    // Three rows, deltas (DecidedAt - ReceivedAt) = 10min / 20min / 30min.
    // submittedAt is deliberately engineered to a CONSTANT 100s offset from
    // DecidedAt for every row — if the median were (wrongly) computed from
    // SubmittedAt instead of ReceivedAt, every row would report the SAME
    // ~100s delta and the median would be ~100000, not the ReceivedAt-based
    // expectation below. This fails on that wrong basis rather than passing
    // by coincidence.
    const rows = [10, 20, 30].map((min) => {
      const receivedAt = base + min * 1000
      const decidedAt = receivedAt + min * 60_000
      return { receivedAt: toIsoZDatetime(receivedAt), decidedAt: toIsoZDatetime(decidedAt), submittedAt: toIsoZDatetime(decidedAt - 100_000) }
    })
    for (const r of rows) {
      await seedRequest(auth, {
        receivedAt: r.receivedAt,
        submittedAt: r.submittedAt,
        status: 'a',
        decidedAt: r.decidedAt,
        decidingOfficerUserId: auth.user.id
      })
    }

    const oddStats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(oddStats.medianTimeToDecisionMs).to.equal(20 * 60_000)
    expect(Number.isInteger(oddStats.medianTimeToDecisionMs)).to.equal(true)

    // A 4th row (delta = 40min) makes the count even: sorted deltas are
    // [10,20,30,40] minutes -> rounded mean of the two middle = 25min.
    const fourth = { receivedAt: base + 40 * 1000, decidedAt: base + 40 * 1000 + 40 * 60_000 }
    await seedRequest(auth, {
      receivedAt: toIsoZDatetime(fourth.receivedAt),
      submittedAt: toIsoZDatetime(fourth.decidedAt - 100_000),
      status: 'a',
      decidedAt: toIsoZDatetime(fourth.decidedAt),
      decidingOfficerUserId: auth.user.id
    })

    const evenStats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(evenStats.medianTimeToDecisionMs).to.equal(25 * 60_000)
    expect(Number.isInteger(evenStats.medianTimeToDecisionMs)).to.equal(true)
  })

  it('a row whose DecidedAt precedes its ReceivedAt (seeded clock skew) is excluded from the median, which stays finite and non-negative', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()

    // Valid row: 10-minute delta.
    await seedRequest(auth, {
      receivedAt: toIsoZDatetime(base),
      status: 'a',
      decidedAt: toIsoZDatetime(base + 10 * 60_000),
      decidingOfficerUserId: auth.user.id
    })
    // Skewed row: DecidedAt is BEFORE ReceivedAt (a documented emulator
    // clock-skew class this project has hit before) — must be discarded,
    // not poison the statistic with a negative delta.
    await seedRequest(auth, {
      receivedAt: toIsoZDatetime(base + 60_000),
      status: 'a',
      decidedAt: toIsoZDatetime(base + 60_000 - 45_000),
      decidingOfficerUserId: auth.user.id
    })

    const stats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(stats.medianTimeToDecisionMs).to.equal(10 * 60_000)
    expect(stats.medianTimeToDecisionMs! >= 0).to.equal(true)
    expect(Number.isFinite(stats.medianTimeToDecisionMs)).to.equal(true)
  })

  it('a pending row (null DecidedAt) contributes to pending but is excluded from the median, AND (D-09 negative space) registration-engine.ts carries no rating/score/ranking/stars/thumbs surface', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()

    await seedRequest(auth, {
      receivedAt: toIsoZDatetime(base),
      status: 'a',
      decidedAt: toIsoZDatetime(base + 15 * 60_000),
      decidingOfficerUserId: auth.user.id
    })
    await seedRequest(auth, { status: 'p' })

    const stats = await engine.getRegistrationTransparencyStats(auth.authority.id)
    expect(stats.pending).to.equal(1)
    expect(stats.medianTimeToDecisionMs).to.equal(15 * 60_000)

    // D-09 negative space, the grep-checkable form: this fails the SUITE at
    // TEST time, not only at review time, if a rating/score/rank/thumbs
    // surface is ever added to the engine source. `rank` alone is
    // deliberately excluded from the pattern — SQL/JS identifiers
    // legitimately contain it as a substring (e.g. a future `ranking`
    // column-name fragment); the word-boundary list below is the enforced
    // vocabulary.
    const src = readFileSync(join(SRC_REGISTRATION_DIR, 'registration-engine.ts'), 'utf8')
    const stripped = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    const forbidden = /\b(rating|ratings|score|scores|ranking|stars|thumbs)\b/i
    const match = stripped.match(forbidden)
    expect(match, `forbidden D-09 identifier found: ${match?.[0]}`).to.equal(null)
  })
})
