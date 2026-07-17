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
import { createTestNetwork, addTestAuthority, seedSignedMutation as seedSignedMutationFixture } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
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
