/**
 * field-policy.spec.ts — Phase 42-07 real-engine spec for
 * `ElectionRegistrationField` policy CRUD (Task 1) and Register-time
 * field-policy enforcement (Task 2, D-09).
 *
 * Covers (per 42-07-PLAN.md):
 *   - Task 1: addElectionRegistrationField/removeElectionRegistrationField
 *     (mel-signed, election-keyed) CRUD + TEXT-code Tier/Requirement
 *     enum-view validation.
 *   - Task 2: validateFieldPolicy enforcement (missing-required, wrong-tier,
 *     optional-absent-is-fine, fully-conforming) wired into
 *     RegistrationEngine.register() BEFORE any DB ceremony, plus the
 *     deliberate no-DB-CHECK-backstop gap (D-09).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegistrantTier, FieldRequirement, Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { FieldPolicyViolationError } from '../src/registration/field-policy.js'
import { createTestNetwork, addTestAuthority, addTestElection } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRegistrantSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

async function setupFieldPolicyTest (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
  electionId: string
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
  const sign = makeRegistrantSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign, electionId }
}

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `field-policy-registrant-${Date.now()}-${registrantSeq}`
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

// ===========================================================================
// ElectionRegistrationField CRUD (Task 1)
// ===========================================================================

describe('ElectionRegistrationField CRUD', () => {
  it('addElectionRegistrationField inserts exactly one row via a mel-scoped AdminSigning ceremony', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()

    await engine.addElectionRegistrationField(
      { electionId, fieldName: 'district', tier: 'public', requirement: 'required' },
      sign
    )

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const row = await ctx.db
      .prepare('select count(*) as n from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
      .get({ electionId, fieldName: 'district' })
    expect(Number(row?.n)).to.equal(1)

    const signingRow = await ctx.db
      .prepare(`select count(*) as n from AdminSigning where Scope = 'mel'`)
      .get({})
    expect(Number(signingRow?.n)).to.be.greaterThan(0)
  })

  it('removeElectionRegistrationField deletes the row (count back to 0) after add', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()

    await engine.addElectionRegistrationField(
      { electionId, fieldName: 'dob', tier: 'private', requirement: 'optional' },
      sign
    )
    await engine.removeElectionRegistrationField(electionId, 'dob', sign)

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const row = await ctx.db
      .prepare('select count(*) as n from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
      .get({ electionId, fieldName: 'dob' })
    expect(Number(row?.n)).to.equal(0)
  })

  it('rejects an out-of-enum Tier value at insert (TierValid CHECK)', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()

    let threw = false
    try {
      await engine.addElectionRegistrationField(
        { electionId, fieldName: 'bogus-field', tier: 'not-a-tier' as unknown as RegistrantTier, requirement: 'required' },
        sign
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected TierValid to reject an out-of-enum Tier code').to.be.true
  })

  it('rejects an out-of-enum Requirement value at insert (RequirementValid CHECK)', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()

    let threw = false
    try {
      await engine.addElectionRegistrationField(
        { electionId, fieldName: 'bogus-field-2', tier: 'public', requirement: 'not-a-requirement' as unknown as FieldRequirement },
        sign
      )
    } catch {
      threw = true
    }
    expect(threw, 'expected RequirementValid to reject an out-of-enum Requirement code').to.be.true
  })

  it('Tier/Requirement round-trip as their TEXT codes', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()

    await engine.addElectionRegistrationField(
      { electionId, fieldName: 'income', tier: 'selective', requirement: 'required' },
      sign
    )

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const row = await ctx.db
      .prepare('select Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
      .get({ electionId, fieldName: 'income' })
    expect(row?.Tier).to.equal('selective')
    expect(row?.Requirement).to.equal('required')
  })

  describe('MockRegistrationEngine parity', () => {
    it('add stores an in-memory row and remove deletes it', async () => {
      const { MockRegistrationEngine } = await import('../src/registration/mock-registration-engine.js')
      const mock = new MockRegistrationEngine()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      const electionId = 'election-mock-1'

      await mock.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, dummySig)
      let fields = await mock.getElectionRegistrationFields(electionId)
      expect(fields).to.have.length(1)
      expect(fields[0]!.fieldName).to.equal('district')

      await mock.removeElectionRegistrationField(electionId, 'district', dummySig)
      fields = await mock.getElectionRegistrationFields(electionId)
      expect(fields).to.have.length(0)
    })
  })
})

// ===========================================================================
// Register-time field-policy enforcement (Task 2, D-09)
// ===========================================================================

describe('field policy enforcement', () => {
  it('rejects a submission missing a Required public field (missing-required)', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, sign)

    const registrantId = nextRegistrantId()
    let violationError: FieldPolicyViolationError | undefined
    try {
      await engine.register(
        {
          electionId,
          registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        sign
      )
    } catch (err) {
      violationError = err instanceof FieldPolicyViolationError ? err : undefined
    }
    expect(violationError, 'expected a FieldPolicyViolationError').to.not.be.undefined
    expect(violationError!.violations.some((v) => v.fieldName === 'district' && v.reason === 'missing-required')).to.be.true

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'no partial Registrant row after a policy rejection').to.be.undefined
  })

  it('rejects a submission furnishing a Required private field in the wrong tier (public ExtraFields)', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'ssn', tier: 'private', requirement: 'required' }, sign)

    const registrantId = nextRegistrantId()
    let violationError: FieldPolicyViolationError | undefined
    try {
      await engine.register(
        {
          electionId,
          registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
          public: { extraFields: { ssn: '123-45-6789' } },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        sign
      )
    } catch (err) {
      violationError = err instanceof FieldPolicyViolationError ? err : undefined
    }
    expect(violationError, 'expected a FieldPolicyViolationError').to.not.be.undefined
    expect(violationError!.violations.some((v) => v.fieldName === 'ssn' && v.reason === 'wrong-tier')).to.be.true

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'no partial Registrant row after a policy rejection').to.be.undefined
  })

  it('rejects a submission missing a Required selective field with no selective payload (missing-required)', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'income', tier: 'selective', requirement: 'required' }, sign)

    const registrantId = nextRegistrantId()
    let violationError: FieldPolicyViolationError | undefined
    try {
      await engine.register(
        {
          electionId,
          registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        sign
      )
    } catch (err) {
      violationError = err instanceof FieldPolicyViolationError ? err : undefined
    }
    expect(violationError, 'expected a FieldPolicyViolationError').to.not.be.undefined
    expect(violationError!.violations.some((v) => v.fieldName === 'income' && v.reason === 'missing-required')).to.be.true
  })

  it('allows an Optional policy field to be absent — Register succeeds', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'nickname', tier: 'public', requirement: 'optional' }, sign)

    const registrantId = nextRegistrantId()
    await engine.register(
      {
        electionId,
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'expected Register to succeed when only an Optional field is absent').to.not.be.undefined
  })

  it('allows a fully-conforming submission — Register succeeds and rows land', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, sign)
    await engine.addElectionRegistrationField({ electionId, fieldName: 'dob', tier: 'private', requirement: 'required' }, sign)

    const registrantId = nextRegistrantId()
    await engine.register(
      {
        electionId,
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        public: { district: 'D-1' },
        private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'dob', value: '1990-01-01' }] }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant).to.not.be.undefined
    const publicRow = await engine.getRegistrantPublic(registrantId)
    expect(publicRow!.district).to.equal('D-1')
    const privateRow = await engine.getRegistrantPrivate(registrantId)
    expect(privateRow!.privateDetails).to.deep.equal([{ name: 'dob', value: '1990-01-01' }])
  })

  it('does not enforce any policy when the submission carries no electionId (backward-compatible no-op)', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, sign)

    const registrantId = nextRegistrantId()
    // No electionId on this submission — validateFieldPolicy is never invoked,
    // even though a Required 'district' field exists for a DIFFERENT election context.
    await engine.register(
      {
        registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
        private: { expiration: FUTURE_EXPIRATION, details: [] }
      },
      sign
    )

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'expected Register to succeed with no electionId — no policy is evaluated').to.not.be.undefined
  })
})

describe('field policy — no DB CHECK backstop (deliberate gap, D-09)', () => {
  it('a raw signed Registrant insert missing a policy-Required field STILL succeeds', async () => {
    const { auth, engine, sign, electionId } = await setupFieldPolicyTest()
    await engine.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, sign)

    // Bypass validateFieldPolicy entirely — createRegistrant() is the raw
    // signed-mutation ceremony without any field-policy check (only
    // register() calls validateFieldPolicy). There is NO schema CHECK
    // enforcing field policy (deliberate gap, D-09) — this insert succeeds
    // even though it omits the Required 'district' field entirely (no
    // RegistrantPublic tier row at all).
    const registrantId = nextRegistrantId()
    const created = await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid-placeholder', expiration: FUTURE_EXPIRATION },
      sign
    )
    expect(created.id).to.equal(registrantId)

    const row = await engine.getRegistrant(registrantId)
    expect(row, 'expected the DB layer to accept a policy-violating Registrant row — enforcement is engine-only (D-09)').to.not.be.undefined
  })
})
