/**
 * registration.spec.ts — Phase 42-03 real-engine spec for RegistrationEngine +
 * MockRegistrationEngine + RegistrationRegisterBuilder.
 *
 * Covers (per 42-03-PLAN.md):
 *   - Task 1: Registrant/RegistrantPublic/RegistrantPrivate tier CRUD, each
 *     authorized by its OWN vrg-scoped AdminSigning/AdminSignature pair;
 *     RegistrantPublic fixed-column + ExtraFields (json_extract/json_each,
 *     D-18/D-21) reads; InsertOnly double-insert rejection; mock parity.
 *   - Task 2: RegistrationRegisterBuilder (KIND='registration.register')
 *     multi-row Cids-before-parent ceremony inside one BEGIN/COMMIT/ROLLBACK
 *     (Pitfall 4); rollback-on-partial-failure; builder validation/serialization.
 *   - Task 3: positive + negative cid(Digest(...)) CHECK exercise (D-15) for
 *     RegistrantPublic and RegistrantPrivate; ExtraFields read round-trip;
 *     mock/real parity; full-suite floor gate (verified via the plan's own
 *     `yarn test` command, not asserted inline here).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'
import type { Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'
import { RegistrationRegisterBuilder } from '../src/registration/builders/registration-register-builder.js'
import { createTestNetwork, addTestAuthority, addTestElection, seedSignedMutation as seedSignedMutationFixture } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes, toCanonicalDatetime } from '../src/utils.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRegistrantSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex }
}

/** A signer that throws on the Nth invocation — simulates a real mid-flow signing failure
 * (e.g. the user cancels a biometric prompt) to exercise register()'s ROLLBACK path. */
function makeFailingSigner (userId: string, publicHex: string, privateHex: string, failOnCall: number): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(privateHex)
  let calls = 0
  return async (digest: Uint8Array): Promise<Signature> => {
    calls++
    if (calls === failOnCall) {
      throw new Error(`Simulated signer failure on call ${calls}`)
    }
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

async function setupRegistrationTest (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
  publicHex: string
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign, publicHex } = makeRegistrantSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign, publicHex }
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `registrant-${Date.now()}-${registrantSeq}`
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

/**
 * Mirrors RegistrationEngine's private computeRegistrantPublicCid — standalone
 * createRegistrantPublic() calls (Task 1's own test scope) need the PARENT
 * Registrant row to already carry this SAME deterministic Cid in its
 * PublicCid column (RegistrantCidMatch), exactly like register() does
 * internally (compute BEFORE the Registrant insert, Pitfall 4).
 */
async function computePublicCid (
  ctx: EngineContext,
  registrantId: string,
  input: { lastName?: string; firstName?: string; district?: string; extraFields?: Record<string, unknown> }
): Promise<string> {
  const row = await ctx.db
    .prepare('select cid(Digest(:registrantId, :lastName, :firstName, :district, :extraFields)) as c')
    .get({
      registrantId,
      lastName: input.lastName ?? null,
      firstName: input.firstName ?? null,
      district: input.district ?? null,
      extraFields: input.extraFields ? JSON.stringify(input.extraFields) : null
    })
  return row!.c as string
}

/** Mirrors RegistrationEngine's private computeRegistrantPrivateCid (see computePublicCid). */
async function computePrivateCid (
  ctx: EngineContext,
  registrantId: string,
  input: { expiration: number; details: Array<Record<string, unknown>> }
): Promise<string> {
  const expiration = new Date(input.expiration).toISOString()
  const row = await ctx.db
    .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
    .get({ registrantId, expiration, privateDetails: JSON.stringify(input.details) })
  return row!.c as string
}

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

/**
 * Task-1-only test fixture helper: raw-updates a Registrant's Status/
 * Expiration bypassing RegistrationEngine.changeStatus/changeExpiration
 * (Task 2's own methods — this file's Task-1 describe block must stand on
 * its own since it is committed/verified before Task 2 lands). Mirrors the
 * exact dual-signing ceremony RegistrationEngine.createRegistrant/
 * updateRegistrantRow use (row-level SignatureValid + vrg MutationValid).
 *
 * Expiration inputs are rounded to whole seconds so the deferred-check
 * coercion (Z-strip + Temporal minimal-fraction serialization, T-42-03) is
 * trivially satisfied by the plain `toCanonicalDatetime` (no-Z, no-fraction)
 * form — avoiding the need to reproduce registration-engine.ts's private
 * `toDeferredCheckDatetime` helper here.
 */
async function rawUpdateRegistrant (
  auth: TestAuthorityContext,
  registrantId: string,
  changes: { status?: string; expirationMs?: number },
  sign: (digest: Uint8Array) => Promise<Signature>,
  /** Ceremony scope override — 'vrg' (correct) unless testing the D-16 sole-control reject path. */
  scope: 'vrg' | 'rad' = 'vrg'
): Promise<void> {
  const ctx = auth.ctx
  const current = await ctx.db
    .prepare('select AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration from Registrant where Id = :registrantId')
    .get({ registrantId })
  if (!current) throw new Error('rawUpdateRegistrant: Registrant not found')
  const authorityId = current.AuthorityId as string
  const privateCid = current.PrivateCid as string
  const publicCid = (current.PublicCid as string | null) ?? null
  const selectiveCid = (current.SelectiveCid as string | null) ?? null
  const status = changes.status ?? (current.Status as string)
  const alignedMs = changes.expirationMs !== undefined ? Math.floor(changes.expirationMs / 1000) * 1000 : undefined
  const expiration = alignedMs !== undefined ? new Date(alignedMs).toISOString() : (current.Expiration as string)
  const expirationDeferred = alignedMs !== undefined
    ? new Date(alignedMs).toISOString().slice(0, 19)
    : toCanonicalDatetime(current.Expiration as string)

  const rowDigestRow = await ctx.db
    .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
    .get({ id: registrantId, authorityId, privateCid, publicCid, selectiveCid, status, expiration })
  const rowSignature = await sign(digestToBytes(rowDigestRow!.d))

  const tid = Date.now() + Math.floor(Math.random() * 100_000)
  const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
  const digestParams = {
    tid, id: registrantId, authorityId, privateCid, publicCid, selectiveCid, status,
    expirationDeferred,
    rowSignorKey: rowSignature.signerKey,
    rowSignature: rowSignature.signature
  }
  const { nonce } = await seedSignedMutationFixture(ctx, authorityId, scope, tid, digestExpr, digestParams, auth.user)

  await ctx.db.exec(
    `update Registrant
     with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
     set Status = :status, Expiration = :expiration, SignorKey = :signorKey, Signature = :signature
     where Id = :id`,
    {
      id: registrantId, status, expiration,
      signorKey: rowSignature.signerKey, signature: rowSignature.signature,
      signingNonce: nonce, now: new Date().toISOString().slice(0, 19)
    }
  )
}

// ===========================================================================
// RegistrationEngine — Registrant/Public/Private tier CRUD (Task 1)
// ===========================================================================

describe('RegistrationEngine', () => {
  describe('createRegistrant / getRegistrant', () => {
    it('inserts a Registrant row via its own vrg AdminSigning/AdminSignature ceremony and reads it back', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()

      const created = await engine.createRegistrant(
        {
          id: registrantId,
          authorityId: auth.authority.id,
          privateCid: 'test-private-cid-placeholder',
          expiration: FUTURE_EXPIRATION
        },
        sign
      )
      expect(created.id).to.equal(registrantId)
      expect(created.signorKey).to.be.a('string').with.length.greaterThan(0)

      const row = await engine.getRegistrant(registrantId)
      expect(row).to.not.be.undefined
      expect(row!.authorityId).to.equal(auth.authority.id)
      expect(row!.status).to.equal('a')
    })

    it('authorizes the Registrant mutation via a vrg-scoped AdminSigning row', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
        sign
      )
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'vrg'`)
        .get({ id: auth.authority.id })
      expect(Number(row?.n)).to.be.greaterThan(0)
    })
  })

  describe('createRegistrantPublic / getRegistrantPublic', () => {
    it('inserts a RegistrantPublic row and reads back fixed columns', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const publicInput = { lastName: 'Doe', firstName: 'Jane', district: 'D-7' }
      const publicCid = await computePublicCid(ctx, registrantId, publicInput)
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      const created = await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)
      expect(created.cid).to.be.a('string').with.length.greaterThan(0)

      const row = await engine.getRegistrantPublic(registrantId)
      expect(row).to.not.be.undefined
      expect(row!.lastName).to.equal('Doe')
      expect(row!.firstName).to.equal('Jane')
      expect(row!.district).to.equal('D-7')
    })

    it('resolves ExtraFields via getRegistrantPublicField (json_extract) and getRegistrantPublicExtraFieldKeys (json_each) — D-18/D-21', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const publicInput = { lastName: 'Doe', district: 'D-7', extraFields: { PartyCode: 'IND', PrecinctCode: 'P-12' } }
      const publicCid = await computePublicCid(ctx, registrantId, publicInput)
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)

      const fixedField = await engine.getRegistrantPublicField(registrantId, 'district')
      expect(fixedField).to.equal('D-7')

      const extraField = await engine.getRegistrantPublicField(registrantId, 'PartyCode')
      expect(extraField).to.equal('IND')

      const keys = await engine.getRegistrantPublicExtraFieldKeys(registrantId)
      expect(keys.sort()).to.deep.equal(['PartyCode', 'PrecinctCode'].sort())
    })

    it('rejects a second RegistrantPublic insert for the same (RegistrantId, Cid) — InsertOnly', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const publicInput = { lastName: 'Doe' }
      const publicCid = await computePublicCid(ctx, registrantId, publicInput)
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)

      let threw = false
      try {
        // Identical inputs -> identical deterministic Cid -> PK collision.
        await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)
      } catch {
        threw = true
      }
      expect(threw, 'expected a second identical RegistrantPublic insert to be rejected').to.be.true
    })
  })

  describe('createRegistrantPrivate / getRegistrantPrivate', () => {
    it('inserts a RegistrantPrivate row and reads back PrivateDetails', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const details = [{ name: 'ssn-last-4', value: '1234' }]
      const privateCid = await computePrivateCid(ctx, registrantId, { expiration: FUTURE_EXPIRATION, details })
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      const created = await engine.createRegistrantPrivate({ registrantId, expiration: FUTURE_EXPIRATION, details }, sign)
      expect(created.cid).to.be.a('string').with.length.greaterThan(0)

      const row = await engine.getRegistrantPrivate(registrantId)
      expect(row).to.not.be.undefined
      expect(row!.privateDetails).to.deep.equal([{ name: 'ssn-last-4', value: '1234' }])
    })

    it('rejects a second identical RegistrantPrivate insert for the same (RegistrantId, Cid) — InsertOnly', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const details = [{ name: 'ssn-last-4', value: '1234' }]
      const privateCid = await computePrivateCid(ctx, registrantId, { expiration: FUTURE_EXPIRATION, details })
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPrivate({ registrantId, expiration: FUTURE_EXPIRATION, details }, sign)

      let threw = false
      try {
        await engine.createRegistrantPrivate({ registrantId, expiration: FUTURE_EXPIRATION, details }, sign)
      } catch {
        threw = true
      }
      expect(threw, 'expected a second identical RegistrantPrivate insert to be rejected').to.be.true
    })
  })

  describe('each tier row uses its own vrg AdminSigning/AdminSignature pair (Pitfall 4)', () => {
    it('creates three distinct AdminSigning rows for Registrant + RegistrantPublic + RegistrantPrivate', async () => {
      const { auth, engine, sign } = await setupRegistrationTest()
      const registrantId = nextRegistrantId()
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx

      const publicInput = { lastName: 'Doe' }
      const privateDetails = [{ name: 'k', value: 'v' }]
      const publicCid = await computePublicCid(ctx, registrantId, publicInput)
      const privateCid = await computePrivateCid(ctx, registrantId, { expiration: FUTURE_EXPIRATION, details: privateDetails })

      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid, publicCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)
      await engine.createRegistrantPrivate(
        { registrantId, expiration: FUTURE_EXPIRATION, details: privateDetails },
        sign
      )

      const row = await ctx.db
        .prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'vrg'`)
        .get({ id: auth.authority.id })
      expect(Number(row?.n)).to.equal(3)

      const distinctNonces = await ctx.db
        .prepare(`select count(distinct Nonce) as n from AdminSigning where AuthorityId = :id and Scope = 'vrg'`)
        .get({ id: auth.authority.id })
      expect(Number(distinctNonces?.n)).to.equal(3)
    })
  })

  describe('MockRegistrationEngine parity', () => {
    it('getRegistrantPublic returns a seeded in-memory record without a DB', async () => {
      const mock = new MockRegistrationEngine()
      const registrantId = nextRegistrantId()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      await mock.register(
        {
          registrant: { id: registrantId, authorityId: 'authority-mock', expiration: FUTURE_EXPIRATION },
          public: { lastName: 'Mock', firstName: 'User', district: 'D-1' },
          private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'k', value: 'v' }] }
        },
        dummySig
      )
      const row = await mock.getRegistrantPublic(registrantId)
      expect(row).to.not.be.undefined
      expect(row!.lastName).to.equal('Mock')
      expect(row!.district).to.equal('D-1')
    })
  })
})

// ===========================================================================
// RegistrationRegisterBuilder — multi-row ceremony (Task 2)
// ===========================================================================

describe('RegistrationRegisterBuilder', () => {
  it('has the expected KIND/KIND_VERSION', () => {
    expect(RegistrationRegisterBuilder.KIND).to.equal('registration.register')
    expect(RegistrationRegisterBuilder.KIND_VERSION).to.equal(1)
  })

  it('commit() succeeds and creates Registrant + RegistrantPublic + RegistrantPrivate rows satisfying their CHECKs', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()

    const builder = engine
      .buildRegister()
      .setRegistrant({ id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION })
      .setPublic({ lastName: 'Voter', firstName: 'Test', district: 'D-9' })
      .setPrivate({ expiration: FUTURE_EXPIRATION, details: [{ name: 'dob', value: '1990-01-01' }] })
      .setSignatureOrCallback(sign)

    await builder.commit()

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant).to.not.be.undefined
    expect(registrant!.publicCid).to.be.a('string')
    expect(registrant!.privateCid).to.be.a('string')

    const publicRow = await engine.getRegistrantPublic(registrantId)
    expect(publicRow).to.not.be.undefined
    expect(publicRow!.cid).to.equal(registrant!.publicCid)

    const privateRow = await engine.getRegistrantPrivate(registrantId)
    expect(privateRow).to.not.be.undefined
    expect(privateRow!.cid).to.equal(registrant!.privateCid)
  })

  it('runs the ceremony in Cids-before-parent order — each row insert uses its own vrg pair', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    await engine
      .buildRegister()
      .setRegistrant({ id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION })
      .setPublic({ lastName: 'Voter' })
      .setPrivate({ expiration: FUTURE_EXPIRATION, details: [] })
      .setSignatureOrCallback(sign)
      .commit()

    const row = await ctx.db
      .prepare(`select count(distinct Nonce) as n from AdminSigning where AuthorityId = :id and Scope = 'vrg'`)
      .get({ id: auth.authority.id })
    expect(Number(row?.n)).to.equal(3)
  })

  it('rolls back the whole transaction on a partial failure — no orphaned Registrant', async () => {
    const { auth, engine, publicHex } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const { privateHex } = randomTestKeyPair()
    // Fail on the 3rd sign invocation — call 1+2 succeed inside createRegistrant
    // (row-level + admin ceremony), call 3 fails inside createRegistrantPublic's
    // admin ceremony, simulating a real mid-flow signing failure.
    const failingSign = makeFailingSigner(auth.user.id, publicHex, privateHex, 3)

    let threw = false
    try {
      await engine
        .buildRegister()
        .setRegistrant({ id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION })
        .setPublic({ lastName: 'Voter' })
        .setPrivate({ expiration: FUTURE_EXPIRATION, details: [] })
        .setSignatureOrCallback(failingSign)
        .commit()
    } catch {
      threw = true
    }
    expect(threw, 'expected the simulated signer failure to propagate').to.be.true

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'Registrant must NOT exist after rollback').to.be.undefined
    const publicRow = await engine.getRegistrantPublic(registrantId)
    expect(publicRow, 'RegistrantPublic must NOT exist after rollback').to.be.undefined
    const privateRow = await engine.getRegistrantPrivate(registrantId)
    expect(privateRow, 'RegistrantPrivate must NOT exist after rollback').to.be.undefined
  })

  it('throws BuilderValidationError from toEngineInput()/commit() when required fields are missing', async () => {
    const { engine } = await setupRegistrationTest()
    const builder = engine.buildRegister()
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)
    let threw = false
    try {
      await builder.commit()
    } catch (err) {
      threw = err instanceof BuilderValidationError
    }
    expect(threw, 'expected commit() to throw BuilderValidationError').to.be.true
  })

  it('throws BuilderAlreadyCommittedError on a second commit()', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const builder = engine
      .buildRegister()
      .setRegistrant({ id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION })
      .setPrivate({ expiration: FUTURE_EXPIRATION, details: [] })
      .setSignatureOrCallback(sign)

    await builder.commit()
    let threw = false
    try {
      await builder.commit()
    } catch (err) {
      threw = err instanceof BuilderAlreadyCommittedError
    }
    expect(threw, 'expected the second commit() to throw BuilderAlreadyCommittedError').to.be.true
  })

  it('round-trips a draft via toJSON()/fromJSON() (registrant/public/private, minus the non-serializable signature callback)', async () => {
    const { auth, engine } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const builder = engine
      .buildRegister()
      .setRegistrant({ id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION })
      .setPublic({ lastName: 'Voter' })
      .setPrivate({ expiration: FUTURE_EXPIRATION, details: [] })

    const json = builder.toJSON()
    expect(json.kind).to.equal('registration.register')
    expect(json.version).to.equal(1)

    const restored = RegistrationRegisterBuilder.fromJSON(json, engine)
    const input = restored.toEngineInput()
    expect(input.registrant.id).to.equal(registrantId)
    expect(input.public?.lastName).to.equal('Voter')
  })
})

// ===========================================================================
// registration Cid integrity (D-15) + ExtraFields read path + mock parity (Task 3)
// ===========================================================================

describe('registration Cid integrity (D-15)', () => {
  it('rejects a RegistrantPublic row whose stored Cid does not match the actual field values (CidValid)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    // Cid computed for LastName='Original', but the row we insert carries LastName='Tampered'.
    const cidRow = await ctx.db
      .prepare('select cid(Digest(:registrantId, :lastName, :firstName, :district, :extraFields)) as c')
      .get({ registrantId, lastName: 'Original', firstName: null, district: null, extraFields: null })
    const cid = cidRow!.c as string
    const tid = Date.now()

    // Seed a vrg AdminSigning ceremony matching the TAMPERED row values (so InsertValid
    // passes) — isolating CidValid as the ONLY constraint that should reject this insert.
    const { nonce } = await seedSignedMutationFixture(
      auth.ctx,
      auth.authority.id,
      'vrg',
      tid,
      'select Digest(:tid, :cid, :registrantId, :lastName, :firstName, :district, :extraFields) as d',
      { tid, cid, registrantId, lastName: 'Tampered', firstName: null, district: null, extraFields: null },
      auth.user
    )

    let threw = false
    try {
      await ctx.db.exec(
        `insert into RegistrantPublic (Cid, RegistrantId, LastName, FirstName, District, ExtraFields)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:cid, :registrantId, :lastName, :firstName, :district, :extraFields)`,
        { cid, registrantId, lastName: 'Tampered', firstName: null, district: null, extraFields: null, signingNonce: nonce }
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected CidValid to reject a Cid that does not match the tampered LastName').to.be.true
  })

  it('rejects a RegistrantPrivate row whose stored Cid does not match the actual field values (CidValid)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const expiration = new Date(FUTURE_EXPIRATION).toISOString().slice(0, 19)
    const originalDetails = JSON.stringify([{ name: 'k', value: 'original' }])
    const tamperedDetails = JSON.stringify([{ name: 'k', value: 'tampered' }])

    const cidRow = await ctx.db
      .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
      .get({ registrantId, expiration, privateDetails: originalDetails })
    const cid = cidRow!.c as string
    const tid = Date.now() + 1

    const { nonce } = await seedSignedMutationFixture(
      auth.ctx,
      auth.authority.id,
      'vrg',
      tid,
      'select Digest(:tid, :cid, :registrantId, :expiration, :privateDetails) as d',
      { tid, cid, registrantId, expiration, privateDetails: tamperedDetails },
      auth.user
    )

    let threw = false
    try {
      await ctx.db.exec(
        `insert into RegistrantPrivate (Cid, RegistrantId, Expiration, PrivateDetails)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:cid, :registrantId, :expiration, :privateDetails)`,
        { cid, registrantId, expiration, privateDetails: tamperedDetails, signingNonce: nonce, now: new Date().toISOString().slice(0, 19) }
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected CidValid to reject a Cid that does not match the tampered PrivateDetails').to.be.true
  })

  it('ExtraFields read round-trip: resolves a fixed column AND an ExtraFields key, and enumerates all extra keys (D-18/D-21)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const publicInput = { district: 'D-42', extraFields: { PartyCode: 'GRN', BallotLanguage: 'en' } }
    const publicCid = await computePublicCid(ctx, registrantId, publicInput)
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid, expiration: FUTURE_EXPIRATION },
      sign
    )
    await engine.createRegistrantPublic({ registrantId, ...publicInput }, sign)

    const publicRow = await engine.getRegistrantPublic(registrantId)
    expect(publicRow!.district).to.equal('D-42')
    expect(publicRow!.extraFields).to.deep.equal({ PartyCode: 'GRN', BallotLanguage: 'en' })

    const fixedViaField = await engine.getRegistrantPublicField(registrantId, 'District')
    expect(fixedViaField).to.equal('D-42')

    const extraViaField = await engine.getRegistrantPublicField(registrantId, 'PartyCode')
    expect(extraViaField).to.equal('GRN')

    const keys = await engine.getRegistrantPublicExtraFieldKeys(registrantId)
    expect(keys.sort()).to.deep.equal(['BallotLanguage', 'PartyCode'].sort())
  })

  describe('mock/real parity', () => {
    it('MockRegistrationEngine exposes the same IRegistrationEngine surface (buildRegister + tier reads)', async () => {
      const mock = new MockRegistrationEngine()
      const builder = mock.buildRegister()
      expect(builder).to.be.instanceOf(RegistrationRegisterBuilder)
      expect(typeof builder.commit).to.equal('function')

      const registrantId = nextRegistrantId()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      await mock.register(
        {
          registrant: { id: registrantId, authorityId: 'authority-mock', expiration: FUTURE_EXPIRATION },
          public: { lastName: 'Parity', district: 'D-5' },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        dummySig
      )
      const registrant = await mock.getRegistrant(registrantId)
      expect(registrant).to.not.be.undefined
      expect(registrant!.authorityId).to.equal('authority-mock')
      const publicRow = await mock.getRegistrantPublic(registrantId)
      expect(publicRow!.lastName).to.equal('Parity')
    })
  })
})

// ===========================================================================
// ElectionRegistrant roster (authority-only, D-17) — Phase 42-06 Task 1
// ===========================================================================

describe('ElectionRegistrant roster (authority-only, D-17)', () => {
  it('enrollElectionRegistrant creates exactly one row for (electionId, registrantId)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )

    await engine.enrollElectionRegistrant(electionId, registrantId, sign)

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const row = await ctx.db
      .prepare('select count(*) as n from ElectionRegistrant where ElectionId = :electionId and RegistrantId = :registrantId')
      .get({ electionId, registrantId })
    expect(Number(row?.n)).to.equal(1)
  })

  it('removeElectionRegistrant deletes the row (count back to 0) after enroll', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    await engine.enrollElectionRegistrant(electionId, registrantId, sign)

    await engine.removeElectionRegistrant(electionId, registrantId, sign)

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const row = await ctx.db
      .prepare('select count(*) as n from ElectionRegistrant where ElectionId = :electionId and RegistrantId = :registrantId')
      .get({ electionId, registrantId })
    expect(Number(row?.n)).to.equal(0)
  })

  it('rejects enrolling a registrant whose Status != a (RegistrantIdValid)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', status: 's', expiration: FUTURE_EXPIRATION },
      sign
    )

    let threw = false
    try {
      await engine.enrollElectionRegistrant(electionId, registrantId, sign)
    } catch {
      threw = true
    }
    expect(threw, 'expected enrolling a suspended (Status=s) registrant to be rejected by RegistrantIdValid').to.be.true
  })

  it('rejects enrolling a registrant whose Expiration <= now (RegistrantNotExpired)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    const registrantId = nextRegistrantId()
    // ExpirationFuture is insert-only — insert with a future Expiration, then
    // raw-update it into the past (update bypasses ExpirationFuture, D-16),
    // producing an active-but-expired registrant WITHOUT depending on Task 2's
    // own changeExpiration method (this describe block is verified standalone).
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: Date.now() + 60_000 },
      sign
    )
    await rawUpdateRegistrant(auth, registrantId, { expirationMs: Date.now() - 60_000 }, sign)

    let threw = false
    try {
      await engine.enrollElectionRegistrant(electionId, registrantId, sign)
    } catch {
      threw = true
    }
    expect(threw, 'expected enrolling an expired registrant to be rejected by RegistrantNotExpired').to.be.true
  })

  it('rejects an enroll whose ceremony produced a NON-vrg scope — authority-only, no self-enroll path (D-17)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const tid = Date.now() + Math.floor(Math.random() * 100_000)
    const digestExpr = 'select Digest(:tid, :electionId, :registrantId) as d'
    const digestParams = { tid, electionId, registrantId }
    // Sign the ceremony under 'rad' (wrong scope for ElectionRegistrant, which requires 'vrg').
    const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'rad', tid, digestExpr, digestParams, auth.user)

    let threw = false
    try {
      await ctx.db.exec(
        `insert into ElectionRegistrant (ElectionId, RegistrantId)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:electionId, :registrantId)`,
        { electionId, registrantId, signingNonce: nonce, now: new Date().toISOString().slice(0, 19) }
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected the rad-scoped ceremony to be rejected by ElectionRegistrant.InsertValid (requires vrg) — no self-enroll path').to.be.true

    const row = await ctx.db
      .prepare('select count(*) as n from ElectionRegistrant where ElectionId = :electionId and RegistrantId = :registrantId')
      .get({ electionId, registrantId })
    expect(Number(row?.n)).to.equal(0)
  })

  describe('MockRegistrationEngine parity', () => {
    it('enroll adds and remove deletes the in-memory roster entry', async () => {
      const mock = new MockRegistrationEngine()
      const dummySign = async (): Promise<Signature> => ({ signerUserId: 'u', signerKey: 'k', signature: 's' })
      const electionId = 'election-mock-1'
      const registrantId = 'registrant-mock-1'

      await mock.enrollElectionRegistrant(electionId, registrantId, dummySign)
      await mock.removeElectionRegistrant(electionId, registrantId, dummySign)
      // No public read method to assert against directly (getElectionRegistrants
      // stays a [] stub, out of this plan's scope) — parity is exercised by the
      // fact that both calls resolve without throwing (matches the real
      // engine's insert-then-delete-succeeds shape).
    })
  })
})

// ===========================================================================
// Permissive registrant lifecycle (D-16) — Phase 42-06 Task 2
// ===========================================================================

describe('Permissive registrant lifecycle (D-16)', () => {
  it('allows all six a/s/r transitions with no directional guard', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const transitions: Array<'a' | 's' | 'r'> = ['s', 'a', 'r', 'a', 's', 'r']
    for (const next of transitions) {
      await engine.changeStatus(registrantId, next, sign)
      const row = await ctx.db.prepare('select Status from Registrant where Id = :id').get({ id: registrantId })
      expect(row?.Status).to.equal(next)
    }
  })

  it('renewRegistrant (changeExpiration) updates to a fresh future Expiration', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const newFuture = FUTURE_EXPIRATION + 86_400_000
    const newFutureIso = new Date(newFuture).toISOString()
    await engine.changeExpiration(registrantId, newFutureIso, sign)

    // A plain SELECT of a `datetime` column comes back Z-stripped (Quereus
    // column-read normalization, T-42-06) — compare by instant, not raw string.
    const row = await ctx.db.prepare('select Expiration from Registrant where Id = :id').get({ id: registrantId })
    const stored = row!.Expiration as string
    const storedMs = new Date(stored.endsWith('Z') ? stored : `${stored}Z`).getTime()
    expect(storedMs).to.equal(newFuture)
  })

  it('renewRegistrant (changeExpiration) to an already-elapsed value STILL succeeds on update (insert-only ExpirationFuture does not fire)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const elapsed = Date.now() - 3_600_000
    await engine.changeExpiration(registrantId, new Date(elapsed).toISOString(), sign)

    const row = await ctx.db.prepare('select Expiration from Registrant where Id = :id').get({ id: registrantId })
    expect(row?.Expiration).to.be.a('string')
  })

  it('rejects a status change whose ceremony did not produce a valid vrg AdminSignature (sole-control proof, D-16)', async () => {
    const { auth, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    const engine = new RegistrationEngine(auth.ctx)
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )

    let threw = false
    try {
      // Wrong scope ('rad' instead of 'vrg') — MutationValid must reject.
      await rawUpdateRegistrant(auth, registrantId, { status: 's' }, sign, 'rad')
    } catch {
      threw = true
    }
    expect(threw, 'expected a non-vrg-scoped ceremony to be rejected by MutationValid — the AdminSignature is the sole control').to.be.true
  })

  it('rejects a status change whose inline SignorKey/Signature does not verify over the new field values (SignatureValid)', async () => {
    const { auth, engine, sign } = await setupRegistrationTest()
    const registrantId = nextRegistrantId()
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', expiration: FUTURE_EXPIRATION },
      sign
    )
    // Align Expiration to a whole-second boundary via the REAL changeExpiration
    // method first, so the deferred-check coercion (Z-strip + Temporal minimal-
    // fraction serialization, T-42-03) is trivially satisfied by plain
    // toCanonicalDatetime below — isolating SignatureValid as the ONLY reason
    // this raw update is rejected (not an incidental MutationValid mismatch).
    const alignedFuture = Math.floor((Date.now() + 365 * 86_400_000) / 1000) * 1000
    await engine.changeExpiration(registrantId, new Date(alignedFuture).toISOString(), sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const current = await ctx.db
      .prepare('select AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration from Registrant where Id = :id')
      .get({ id: registrantId })
    const authorityId = current!.AuthorityId as string
    const privateCid = current!.PrivateCid as string
    const status = 's'
    const expiration = current!.Expiration as string
    const bogusSignorKey = 'b'.repeat(66)
    const bogusSignature = 'c'.repeat(128)

    const tid = Date.now() + Math.floor(Math.random() * 100_000)
    const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
    const digestParams = {
      tid, id: registrantId, authorityId, privateCid, publicCid: null, selectiveCid: null, status,
      expirationDeferred: toCanonicalDatetime(expiration),
      rowSignorKey: bogusSignorKey,
      rowSignature: bogusSignature
    }
    const { nonce } = await seedSignedMutationFixture(auth.ctx, authorityId, 'vrg', tid, digestExpr, digestParams, auth.user)

    let threw = false
    try {
      await ctx.db.exec(
        `update Registrant
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         set Status = :status, SignorKey = :signorKey, Signature = :signature
         where Id = :id`,
        { status, signorKey: bogusSignorKey, signature: bogusSignature, signingNonce: nonce, now: new Date().toISOString().slice(0, 19), id: registrantId }
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected a non-verifying SignorKey/Signature to be rejected by SignatureValid').to.be.true
  })

  describe('MockRegistrationEngine parity', () => {
    it('changeStatus/changeExpiration mutate the in-memory record with no transition guard', async () => {
      const mock = new MockRegistrationEngine()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      const registrantId = nextRegistrantId()
      await mock.register(
        {
          registrant: { id: registrantId, authorityId: 'authority-mock', expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        dummySig
      )

      await mock.changeStatus(registrantId, 'r', dummySig)
      let row = await mock.getRegistrant(registrantId)
      expect(row!.status).to.equal('r')

      await mock.changeStatus(registrantId, 'a', dummySig)
      row = await mock.getRegistrant(registrantId)
      expect(row!.status).to.equal('a')

      const newExpiration = FUTURE_EXPIRATION + 1000
      await mock.changeExpiration(registrantId, new Date(newExpiration).toISOString(), dummySig)
      row = await mock.getRegistrant(registrantId)
      expect(row!.expiration).to.equal(new Date(newExpiration).toISOString())
    })
  })
})
