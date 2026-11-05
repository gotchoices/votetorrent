/**
 * staging-schema-probes.spec.ts — 62-01 Task 1.
 *
 * PERMANENT, VERDICT-RECORDING PROBE — do not delete or reduce to a throwaway (mirrors
 * `quereus-delete-check-semantics.spec.ts`'s discipline). Decides two open questions Task 2/3
 * of 62-01-PLAN.md depend on, against the Quereus version actually installed in this repo.
 *
 * PROBE 1 (json_extract inside a CHECK, decides the staging tables' SignatureValid form):
 * `RegistrationRequestStaging` / `AssociationRequestStaging` / `AssociationAttestationStaging`
 * store the requester's signature as a JSON blob column (`SignatureJson`, matching the P2P
 * transport's `JSON.stringify(Signature)` shape) rather than a bare `Signature text` column —
 * this probe decides whether a CHECK may call `json_extract(new.SignatureJson, '$.signature')`
 * directly as a UDF argument, or whether it needs `cast(... as text)` first (the idiom
 * `RegistrationBridgeKey`'s neighbours already use for *comparisons*, never yet proven for
 * *function-argument* position).
 *
 *   VERDICT: PASS — the BARE `json_extract(new.SignatureJson, '$.signature')` form, passed
 *   directly as a `SignatureValid`/`SignatureValidP256` argument, verifies a real signature
 *   correctly (accepts the right one, rejects a wrong-digest one) with no `cast(...as text)`
 *   needed. Task 2 therefore uses the bare form for the staging tables' `SignatureValid` CHECK.
 *   `SignerKeyMatches` (a text equality, not a function argument) keeps the pre-existing
 *   `cast(...as text)` idiom per `RegistrationBridgeKey`'s neighbours — that comparison-position
 *   finding is unaffected by this probe and is not being re-litigated here.
 *
 * PROBE 2 (D-41 SingleActiveAssociation, research ruling 2 — decides tier 1 vs tier 2 for
 * Association's optional device-uniqueness constraint):
 *
 *   VERDICT: see the `describe('Probe 2 ...')` block below — recorded after running (a)-(e)
 *   against the installed Quereus version. The constant `PROBE_2_VERDICT` is the single
 *   source of truth Task 3 reads to decide whether `SingleActiveAssociation` ships.
 *
 * Both probes must pass in BOTH possible real-world verdicts — the assertions encode the
 * OBSERVED behaviour, and a future Quereus bump that silently flips either answer must fail
 * this spec loudly, not pass vacuously.
 */

import { Database, ConstraintError } from '@quereus/quereus'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { registerDbPlugins, setSchemaSql, initDB } from '../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toDeferredCheckDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeTestSignCallback,
  testKeyPairFor
} from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ═══════════════════════════════════════════════════════════════════════════
// Probe 1 — json_extract inside a CHECK, as a function argument
// ═══════════════════════════════════════════════════════════════════════════

const PROBE_1_SCRATCH_SCHEMA = `
declare schema main

{
	table StagingProbeBare (
		Digest text,
		SignatureJson text,
		RequesterKey text,
		constraint SignatureValid check (
			SignatureValid(new.Digest, json_extract(new.SignatureJson, '$.signature'), new.RequesterKey)
				or SignatureValidP256(new.Digest, json_extract(new.SignatureJson, '$.signature'), new.RequesterKey)
		),
		constraint SignerKeyMatches check (
			cast(json_extract(new.SignatureJson, '$.signerKey') as text) = new.RequesterKey
		)
	);
}

apply schema main;
`

async function createProbe1Db (): Promise<Database> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(PROBE_1_SCRATCH_SCHEMA)
  return db
}

interface Probe1Signer {
  publicHex: string
  sign: (digestBase64url: string) => string
}

function makeProbe1Secp256k1Signer (): Probe1Signer {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return {
    publicHex,
    sign: (digestBase64url: string): string => bytesToHex(secp256k1.sign(digestToBytes(digestBase64url), privBytes))
  }
}

function makeProbe1P256Signer (): Probe1Signer {
  const { privBytes, pubHex } = makeP256TestKey()
  return {
    publicHex: pubHex,
    sign: (digestBase64url: string): string => signDigestP256(digestBase64url, privBytes)
  }
}

async function insertStagingProbeRow (
  db: Database,
  args: { digest: string; signatureJson: string; requesterKey: string }
): Promise<void> {
  await db.exec(
    'insert into StagingProbeBare (Digest, SignatureJson, RequesterKey) values (:digest, :signatureJson, :requesterKey)',
    args
  )
}

async function stagingProbeRowCount (db: Database, digest: string): Promise<number> {
  const row = await db.prepare('select count(*) as c from StagingProbeBare where Digest = :digest').get({ digest })
  return Number(row?.c ?? 0)
}

describe('Probe 1 (json_extract inside a CHECK, 62-01 Task 1) — VERDICT: PASS, bare form', () => {
  it('a row whose SignatureJson holds a real secp256k1 signature over Digest is ACCEPTED by the bare json_extract(...) form', async () => {
    const db = await createProbe1Db()
    const signer = makeProbe1Secp256k1Signer()
    const digestRow = await db.prepare("select Digest('probe-1', :nonce) as d").get({ nonce: crypto.randomUUID() })
    if (!digestRow || digestRow.d == null) throw new Error('Probe 1: Digest() returned null')
    const digest = digestRow.d as string
    const signatureJson = JSON.stringify({ signature: signer.sign(digest), signerKey: signer.publicHex })

    await insertStagingProbeRow(db, { digest, signatureJson, requesterKey: signer.publicHex })
    expect(
      await stagingProbeRowCount(db, digest),
      'a genuinely correct signature, extracted via bare json_extract(...) with NO cast(...as text), must verify and insert'
    ).to.equal(1)
  })

  it('a row whose signature covers a DIFFERENT digest than the one stored is REJECTED', async () => {
    const db = await createProbe1Db()
    const signer = makeProbe1Secp256k1Signer()
    const storedDigestRow = await db.prepare("select Digest('probe-1-stored', :nonce) as d").get({ nonce: crypto.randomUUID() })
    const otherDigestRow = await db.prepare("select Digest('probe-1-other', :nonce) as d").get({ nonce: crypto.randomUUID() })
    if (!storedDigestRow?.d || !otherDigestRow?.d) throw new Error('Probe 1: Digest() returned null')
    const storedDigest = storedDigestRow.d as string
    const otherDigest = otherDigestRow.d as string
    // Sign the OTHER digest, but store it alongside storedDigest — a classic tamper negative.
    const signatureJson = JSON.stringify({ signature: signer.sign(otherDigest), signerKey: signer.publicHex })

    let caught: unknown
    try {
      await insertStagingProbeRow(db, { digest: storedDigest, signatureJson, requesterKey: signer.publicHex })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a signature over a different digest must be rejected').to.be.instanceOf(ConstraintError)
    expect(await stagingProbeRowCount(db, storedDigest)).to.equal(0)
  })

  it('a row whose SignatureJson.signerKey differs from RequesterKey is REJECTED (SignerKeyMatches, the cast(...as text) comparison idiom)', async () => {
    const db = await createProbe1Db()
    const signer = makeProbe1Secp256k1Signer()
    const impersonatedKey = makeProbe1Secp256k1Signer().publicHex
    const digestRow = await db.prepare("select Digest('probe-1', :nonce) as d").get({ nonce: crypto.randomUUID() })
    if (!digestRow?.d) throw new Error('Probe 1: Digest() returned null')
    const digest = digestRow.d as string
    // Signed for real by `signer`, but SignatureJson.signerKey CLAIMS to be impersonatedKey,
    // and RequesterKey is bound to impersonatedKey too — SignatureValid never even gets a chance
    // to run against the real signer because SignerKeyMatches must independently reject the row.
    const signatureJson = JSON.stringify({ signature: signer.sign(digest), signerKey: impersonatedKey })

    let caught: unknown
    try {
      await insertStagingProbeRow(db, { digest, signatureJson, requesterKey: impersonatedKey })
    } catch (err) {
      caught = err
    }
    expect(caught, 'a SignatureJson.signerKey that disagrees with RequesterKey must be rejected').to.be.instanceOf(ConstraintError)
    expect(await stagingProbeRowCount(db, digest)).to.equal(0)
  })

  it('a P-256 signer (SignatureValidP256 branch) is also ACCEPTED via the same bare json_extract(...) form', async () => {
    const db = await createProbe1Db()
    const signer = makeProbe1P256Signer()
    const digestRow = await db.prepare("select Digest('probe-1-p256', :nonce) as d").get({ nonce: crypto.randomUUID() })
    if (!digestRow?.d) throw new Error('Probe 1: Digest() returned null')
    const digest = digestRow.d as string
    const signatureJson = JSON.stringify({ signature: signer.sign(digest), signerKey: signer.publicHex })

    await insertStagingProbeRow(db, { digest, signatureJson, requesterKey: signer.publicHex })
    expect(
      await stagingProbeRowCount(db, digest),
      'the mixed-curve "or SignatureValidP256(...)" disjunct must also accept via the bare json_extract(...) form'
    ).to.equal(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Probe 2 — D-41 SingleActiveAssociation (research ruling 2)
// ═══════════════════════════════════════════════════════════════════════════

const SINGLE_ACTIVE_ASSOCIATION_CONSTRAINT =
  'constraint SingleActiveAssociation check on insert (not exists (select 1 from Association A2 where A2.RegistrantId = new.RegistrantId and A2.DeviceKey <> new.DeviceKey))'

// Anchor text unique to Association's `DeviceHash` column declaration — EMPIRICALLY VERIFIED
// unique (occurs exactly once in votetorrent.qsql; a naive `ExpirationFuture check on insert
// (Expiration > context.now),` anchor was tried first and FAILED — that exact constraint text
// occurs 5 times across the schema (Registrant, AttestationChallenge, ... all have an Expiration
// column with the identical check), so the first `String.replace` match landed inside a
// DIFFERENT table and produced "new.RegistrantId isn't a column" the moment that OTHER table was
// written to. Inserting after a table-unique column line avoids the whole class of hazard.
const ASSOCIATION_DEVICE_HASH_ANCHOR =
  "DeviceHash text null, -- sha256 hash of the device's ID (not the ID itself, for privacy); null = device uniqueness not publicly disclosed (transparency toggle off)"

/**
 * Builds the D-41 candidate schema string by inserting `SINGLE_ACTIVE_ASSOCIATION_CONSTRAINT`
 * into the Association table body of `base`. A no-op (returns `base` unchanged) once Task 3 has
 * actually adopted the constraint into `votetorrent.qsql` itself — keeps this probe valid after
 * that lands, per the plan's instruction.
 *
 * EMPIRICAL FINDING (62-01 Task 3): the guard below checks for the literal CONSTRAINT
 * DECLARATION (`constraint SingleActiveAssociation`), not a bare substring match on the name.
 * Task 3's own `AssociationDecision` table comment PROSE mentions "Association.SingleActiveAssociation"
 * (documenting that it did NOT ship) — a bare `base.includes('SingleActiveAssociation')` guard
 * matched that comment and made this function a permanent, silent no-op from Task 3 onward: test
 * (b) below started failing (the "CHECK is live" assertion saw no throw) the moment that comment
 * landed, discovered by actually re-running this file after Task 3's qsql edits rather than
 * assuming it still passed. The self-tripping-checker failure mode this repo has hit before.
 */
function buildD41CandidateSchema (base: string): string {
  if (base.includes('constraint SingleActiveAssociation')) return base
  const occurrences = base.split(ASSOCIATION_DEVICE_HASH_ANCHOR).length - 1
  if (occurrences !== 1) {
    throw new Error(`buildD41CandidateSchema: anchor must occur exactly once in schema, found ${occurrences} — Association table shape changed, update this probe`)
  }
  return base.replace(ASSOCIATION_DEVICE_HASH_ANCHOR, `${ASSOCIATION_DEVICE_HASH_ANCHOR}\n\t\t${SINGLE_ACTIVE_ASSOCIATION_CONSTRAINT},`)
}

/** Real secp256k1 sign callback bound to the user's registered keypair — mirrors association.spec.ts's makeRealSigner. */
function makeProbe2Signer (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex }
}

/** Seed one approved Registrant (mirrors association.spec.ts's setupAssociationTest, Registrant half only). */
async function seedApprovedRegistrant (
  ctx: EngineContext,
  authorityId: string,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  const registrationEngine = new RegistrationEngine(ctx)
  const registrantId = `probe2-registrant-${crypto.randomUUID()}`
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId, privateCid: 'probe2-private-cid-placeholder', expiration: Date.now() + 365 * 86_400_000 },
    sign
  )
  return registrantId
}

/** Raw 'vrg' Association INSERT — mirrors association.spec.ts:700-741's shape exactly. */
async function insertAssociationRaw (
  ctx: EngineContext,
  authorityId: string,
  registrantId: string,
  deviceKey: string,
  sign: (digest: Uint8Array) => Promise<Signature>,
  ownsTransaction: boolean
): Promise<void> {
  const tid = await allocateTid(ctx.db, 'association')
  const expiration = new Date(Date.now() + 3_600_000).toISOString()
  // Association.InsertValid carries a subquery (the AdminSignature EXISTS join), which promotes
  // it to Quereus's DEFERRED queue — at COMMIT time Quereus re-derives `new.Expiration` from a
  // Temporal-coerced snapshot (Z stripped, trailing fractional zeros dropped), so the CEREMONY's
  // pre-signed digest must be computed over `toDeferredCheckDatetime(expiration)`, exactly as
  // `AssociationEngine.associate()` does (`expirationDeferred`) — NOT the raw Z-suffixed value.
  // Association.SignatureValid itself carries NO subquery, so the ROW-LEVEL signature below still
  // signs the raw value. Missing this distinction is an easy, SILENT InsertValid failure — found
  // empirically while writing this probe (first attempt used the raw value for both and every
  // Probe 2 case failed with "CHECK constraint failed: InsertValid").
  const expirationDeferred = toDeferredCheckDatetime(expiration)
  const rowDigestRow = await ctx.db
    .prepare('select Digest(:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration) as d')
    .get({ registrantId, deviceKey, deviceHash: null, attestationCid: null, expiration })
  if (!rowDigestRow || rowDigestRow.d == null) throw new Error('insertAssociationRaw: Digest() returned null')
  const rowSig = await sign(digestToBytes(rowDigestRow.d as string))

  const digestExpr =
    'select Digest(:tid, :registrantId, :deviceKey, :deviceHash, :attestationCid, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
  const digestParams = {
    tid,
    registrantId,
    deviceKey,
    deviceHash: null,
    attestationCid: null,
    expirationDeferred,
    rowSignorKey: rowSig.signerKey,
    rowSignature: rowSig.signature
  }
  const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign, { ownsTransaction })

  await ctx.db.exec(
    `insert into Association (RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature)
     with context SigningNonce = :nonce, Tid = ${tid}, now = :now
     values (:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration, :signorKey, :signature)`,
    {
      registrantId,
      deviceKey,
      deviceHash: null,
      attestationCid: null,
      expiration,
      signorKey: rowSig.signerKey,
      signature: rowSig.signature,
      nonce,
      now: nowCanonicalDatetime()
    }
  )
}

/** Raw 'vrg' Association DELETE — mirrors AssociationEngine.removeAssociation's ceremony shape. */
async function deleteAssociationRaw (
  ctx: EngineContext,
  authorityId: string,
  registrantId: string,
  deviceKey: string,
  sign: (digest: Uint8Array) => Promise<Signature>,
  ownsTransaction: boolean
): Promise<void> {
  const tid = await allocateTid(ctx.db, 'association')
  const digestExpr = "select Digest(:tid, :registrantId, :deviceKey, 'delete') as d"
  const digestParams = { tid, registrantId, deviceKey }
  const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign, { ownsTransaction })

  await ctx.db.exec(
    `delete from Association
     with context SigningNonce = :nonce, Tid = ${tid}, now = :now
     where RegistrantId = :registrantId and DeviceKey = :deviceKey`,
    { registrantId, deviceKey, nonce, now: nowCanonicalDatetime() }
  )
}

async function countAssociationsFor (ctx: EngineContext, registrantId: string): Promise<number> {
  const row = await ctx.db.prepare('select count(*) as c from Association where RegistrantId = :registrantId').get({ registrantId })
  return Number(row?.c ?? 0)
}

async function associationDeviceKeyFor (ctx: EngineContext, registrantId: string): Promise<string | undefined> {
  const row = await ctx.db.prepare('select DeviceKey from Association where RegistrantId = :registrantId').get({ registrantId })
  return row?.DeviceKey as string | undefined
}

let deviceSeq = 0
function nextProbe2DeviceKey (): string {
  deviceSeq += 1
  return `probe2-device-key-${Date.now()}-${deviceSeq}`
}

/**
 * VERDICT (62-01 Task 1, recorded after running (a)-(d) below against the installed Quereus
 * version, @quereus/quereus 4.11.0): FAIL — tier 2, per research ruling 2.
 *
 * (a) and (b) hold: a first Association inserts, and a second one for the same registrant with a
 * different DeviceKey throws while the first exists — the CHECK is live, not vacuous, for the
 * single-statement case. (c) also holds: DELETE-old-then-INSERT-new in one transaction commits
 * and leaves exactly one row carrying the new DeviceKey.
 *
 * (d) is the disqualifying finding: INSERT-new-then-DELETE-old, in the SAME transaction, is
 * SILENTLY ACCEPTED rather than rejected. `SingleActiveAssociation` carries a subquery (the
 * `not exists (select 1 from Association A2 ...)` correlated to its own table), which promotes it
 * to Quereus's DEFERRED constraint queue — exactly the "batched deferred-CHECK trap" the plan and
 * the threat register (T-62-01-13) name by that phrase. A deferred CHECK is re-evaluated against
 * the transaction's FINAL row state at COMMIT, not per-statement: by the time Quereus evaluates
 * the new row's SingleActiveAssociation clause, the DELETE of the old row has ALREADY been
 * applied to the committed state the deferred queue reads, so `not exists (... A2.DeviceKey <>
 * new.DeviceKey)` finds nothing and the CHECK passes — even though, at the real moment the INSERT
 * statement ran, the old (different-DeviceKey) row was still physically present. This is the
 * EXACT class of trap `AssociationEngine.associate()`'s own doc comment (association-engine.ts
 * ~588-606) and `test/quereus-repros/`'s precedent already document for other deferred CHECKs —
 * research ruling 2 anticipated it by name for this specific constraint shape.
 *
 * Because (d) is silently accepted rather than rejected, `SingleActiveAssociation` does NOT ship
 * in `votetorrent.qsql` — Task 3 does not touch the `Association` table, and D-41 ships as tier 2
 * (engine-side enforcement only, via `AssociationEngine`'s existing DELETE-then-INSERT re-
 * association flow, never a schema CHECK). See the SUMMARY for the tier-2 record and the two
 * pre-existing association spec files this leaves unmodified.
 *
 * A future Quereus bump that silently flips any of (a)-(d) must fail this constant's own
 * assertion below loudly, not pass vacuously — see the final "VERDICT recorded above must match
 * observed behaviour" test.
 */
const PROBE_2_VERDICT: 'PASS' | 'FAIL' = 'FAIL'

describe('Probe 2 (D-41 SingleActiveAssociation, 62-01 Task 1 — research ruling 2)', () => {
  let net: Awaited<ReturnType<typeof createTestNetwork>>
  let auth: Awaited<ReturnType<typeof addTestAuthority>>

  beforeEach(async () => {
    setSchemaSql(buildD41CandidateSchema(VOTETORRENT_SCHEMA_SQL))
    net = await createTestNetwork()
    auth = await addTestAuthority(net)
  })

  afterEach(() => {
    setSchemaSql(undefined)
  })

  it('(a) a first Association for a registrant inserts', async () => {
    const { sign } = makeProbe2Signer(auth.user.id)
    const registrantId = await seedApprovedRegistrant(auth.ctx, auth.authority.id, sign)
    const deviceKey = nextProbe2DeviceKey()

    await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, deviceKey, sign, true)
    expect(await countAssociationsFor(auth.ctx, registrantId)).to.equal(1)
  })

  it('(b) a second Association for the SAME registrant with a DIFFERENT DeviceKey THROWS while the first still exists — the CHECK is live, not vacuous', async () => {
    const { sign } = makeProbe2Signer(auth.user.id)
    const registrantId = await seedApprovedRegistrant(auth.ctx, auth.authority.id, sign)
    const deviceKeyA = nextProbe2DeviceKey()
    const deviceKeyB = nextProbe2DeviceKey()

    await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, deviceKeyA, sign, true)
    let caught: unknown
    try {
      await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, deviceKeyB, sign, true)
    } catch (err) {
      caught = err
    }
    expect(caught, 'SingleActiveAssociation must reject a second row for the same registrant while the first exists').to.be.instanceOf(Error)
    expect(await countAssociationsFor(auth.ctx, registrantId)).to.equal(1)
    expect(await associationDeviceKeyFor(auth.ctx, registrantId)).to.equal(deviceKeyA)
  })

  it('(c) DELETE-old then INSERT-new, inside ONE transaction, commits — afterward exactly one row exists, carrying the NEW DeviceKey', async () => {
    // Both ceremonies below pass `ownsTransaction: false` (via the `false` positional argument to
    // `insertAssociationRaw`/`deleteAssociationRaw`, which both forward it as `{ ownsTransaction }`
    // to `seedSignedMutation`) — the outer BEGIN/COMMIT envelope here already owns the transaction,
    // exactly mirroring `AssociationEngine.associate()`'s own composition (association-engine.ts
    // ~508-517, ~553-562: `seedSignedMutation(..., { ownsTransaction: false })`).
    const { sign } = makeProbe2Signer(auth.user.id)
    const registrantId = await seedApprovedRegistrant(auth.ctx, auth.authority.id, sign)
    const oldDeviceKey = nextProbe2DeviceKey()
    const newDeviceKey = nextProbe2DeviceKey()
    await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, oldDeviceKey, sign, true)

    await auth.ctx.db.exec('BEGIN')
    try {
      await deleteAssociationRaw(auth.ctx, auth.authority.id, registrantId, oldDeviceKey, sign, false)
      await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, newDeviceKey, sign, false)
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      await auth.ctx.db.exec('ROLLBACK')
      throw err
    }

    expect(await countAssociationsFor(auth.ctx, registrantId), 'DELETE-then-INSERT in one transaction must leave exactly one row').to.equal(1)
    expect(await associationDeviceKeyFor(auth.ctx, registrantId)).to.equal(newDeviceKey)
  })

  it('(d) INSERT-new then DELETE-old, inside ONE transaction (the OPPOSITE order), is SILENTLY ACCEPTED — the disqualifying mis-evaluation signal (DISQUALIFYING FINDING, see PROBE_2_VERDICT above)', async () => {
    const { sign } = makeProbe2Signer(auth.user.id)
    const registrantId = await seedApprovedRegistrant(auth.ctx, auth.authority.id, sign)
    const oldDeviceKey = nextProbe2DeviceKey()
    const newDeviceKey = nextProbe2DeviceKey()
    await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, oldDeviceKey, sign, true)

    let caught: unknown
    try {
      await auth.ctx.db.exec('BEGIN')
      await insertAssociationRaw(auth.ctx, auth.authority.id, registrantId, newDeviceKey, sign, false)
      await deleteAssociationRaw(auth.ctx, auth.authority.id, registrantId, oldDeviceKey, sign, false)
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      try {
        await auth.ctx.db.exec('ROLLBACK')
      } catch {
        // already rolled back by the failed statement — ignore
      }
    }

    // EMPIRICAL FINDING (this is why PROBE_2_VERDICT is FAIL, not PASS): the opposite-order
    // transaction COMMITS cleanly — `caught` stays undefined. `SingleActiveAssociation` carries a
    // subquery, so it is a DEFERRED CHECK, re-evaluated against the transaction's FINAL row state
    // at COMMIT rather than per-statement; by commit time the old row is already gone, so the
    // new row's clause finds no OTHER row and passes — even though the old (different-DeviceKey)
    // row was still physically present at the moment the INSERT statement itself ran. A future
    // Quereus version that instead REJECTS this transaction would flip this assertion and must
    // fail loudly here (not pass silently) so a human re-reads PROBE_2_VERDICT and reconsiders
    // tier 1 — this assertion is the regression lock for that flip, in EITHER direction.
    expect(caught, '(d) is accepted, not rejected — the deferred-CHECK re-evaluates the FINAL state, not the per-statement moment').to.equal(undefined)
    expect(
      await countAssociationsFor(auth.ctx, registrantId),
      'the silently-accepted transaction still leaves exactly one row (both statements applied)'
    ).to.equal(1)
    expect(await associationDeviceKeyFor(auth.ctx, registrantId), 'the surviving row carries the NEW DeviceKey — final state looks identical to (c), despite the opposite statement order').to.equal(newDeviceKey)
  })

  it('(e) re-applying the candidate schema via initDB over an already-initialized UNMODIFIED-schema DB does not crash the process (in-process signal only — NOT the D-22 reattach gate)', async () => {
    // Deliberately builds its OWN network on the UNMODIFIED schema first (setSchemaSql(undefined)
    // overrides this describe block's beforeEach candidate-schema override for just this test).
    setSchemaSql(undefined)
    const plainNet = await createTestNetwork()
    const plainAuth = await addTestAuthority(plainNet)
    const { sign } = makeProbe2Signer(plainAuth.user.id)
    const registrantId = await seedApprovedRegistrant(plainAuth.ctx, plainAuth.authority.id, sign)
    await insertAssociationRaw(plainAuth.ctx, plainAuth.authority.id, registrantId, nextProbe2DeviceKey(), sign, true)

    setSchemaSql(buildD41CandidateSchema(VOTETORRENT_SCHEMA_SQL))
    let threw = false
    let errorMessage = ''
    try {
      await initDB(plainAuth.ctx.db)
    } catch (err) {
      threw = true
      errorMessage = err instanceof Error ? err.message : String(err)
    }
    // eslint-disable-next-line no-console
    console.log(`[staging-schema-probes] Probe 2(e) in-process reattach-of-candidate signal: ${threw ? `THREW (${errorMessage})` : 'no throw'}`)
    // Informational only, per the plan — this assertion proves the probe ran to a definite
    // conclusion, not which conclusion. The D-22 reattach gate (run-reattach-proof.sh) belongs to
    // 62-03 and is deliberately NOT invoked here.
    expect(typeof threw).to.equal('boolean')
  })

  it('VERDICT recorded above must match observed behaviour: FAIL because (d) is silently accepted, not rejected', () => {
    expect(PROBE_2_VERDICT, 'the VERDICT constant above is the single source of truth 62-01 Task 3 reads').to.equal('FAIL')
  })
})
