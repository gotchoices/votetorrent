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
import { createTestNetwork, addTestAuthority, addTestElection, provisionTestIntakeRecipient, testKeyPairFor } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRegistrantSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
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
  // D-49 (62-31): register() below (now D-49-sealed) runs field-policy validation BEFORE sealing,
  // so a policy-violating payload never reaches the sealer — but every test here that register()s a
  // policy-CONFORMING payload needs a recipient, so one provisioning call here covers them all.
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
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
// T-46-08-01 — remove-then-add PK-collision class (real engine)
// ===========================================================================
//
// Phase 46's screen edits an existing policy row as remove-then-add, because
// `addElectionRegistrationField` / `addElectionDisclosurePolicy` are plain
// `insert into` (registration-engine.ts:918, :1018) against
// `primary key (ElectionId, FieldName)` (votetorrent.qsql:1668, :1717) — a bare
// re-add on an existing row is a PK violation, not an upsert.
//
// That sequencing was written but never proven: `MockRegistrationEngine`'s
// `add*` are `Map.set` upserts, so every mock-backed jest test passes whether
// the app removes first or not, and 46-10's on-device run only ever added a
// NEW field. These tests close that gap against the real engine, and pin the
// mock's blindness as an asserted fact so it cannot silently drift.
//
// Each edit pair is deliberately a CHANGE (public/required -> selective/optional,
// everyone -> district). The delete digest binds the row's OLD Tier/Requirement
// (resp. Audience), so a remove leg that failed to re-read the current values
// would be rejected by DeleteValid rather than passing vacuously.

describe('T-46-08-01 — policy edit is remove-then-add (real-engine PK semantics)', () => {
  describe('ElectionRegistrationField', () => {
    it('a bare re-add over an existing (ElectionId, FieldName) row is REJECTED — the hazard is real', async () => {
      const { engine, sign, electionId } = await setupFieldPolicyTest()
      await engine.addElectionRegistrationField(
        { electionId, fieldName: 'district', tier: 'public', requirement: 'required' },
        sign
      )

      let threw: Error | undefined
      try {
        // No remove first — exactly what the app must never do.
        await engine.addElectionRegistrationField(
          { electionId, fieldName: 'district', tier: 'selective', requirement: 'optional' },
          sign
        )
      } catch (err) {
        threw = err as Error
      }
      expect(threw, 'expected a bare re-add to violate the (ElectionId, FieldName) primary key').to.not.be.undefined
      // Pin the REASON, not just that something threw — otherwise this test
      // could later pass vacuously on an unrelated failure (a signing error, a
      // missing election) and stop proving the PK class at all.
      expect(threw!.message, 'the throw must be the PK collision itself').to.match(/unique constraint failed/i)

      // The original row must survive intact — the failed insert wrote nothing.
      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName: 'district' })
      expect(Number(row?.n), 'the rejected insert must not have duplicated the row').to.equal(1)

      const fields = await engine.getElectionRegistrationFields(electionId)
      expect(fields[0]!.tier, 'the rejected insert must not have mutated the stored row').to.equal('public')
      expect(fields[0]!.requirement).to.equal('required')
    })

    it('remove-then-add edits the row in place — one row, new Tier/Requirement', async () => {
      const { engine, sign, electionId } = await setupFieldPolicyTest()
      await engine.addElectionRegistrationField(
        { electionId, fieldName: 'district', tier: 'public', requirement: 'required' },
        sign
      )

      // The sequence Phase 46's onChangeField performs.
      await engine.removeElectionRegistrationField(electionId, 'district', sign)
      await engine.addElectionRegistrationField(
        { electionId, fieldName: 'district', tier: 'selective', requirement: 'optional' },
        sign
      )

      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName: 'district' })
      expect(Number(row?.n), 'an edit must leave exactly one row').to.equal(1)

      const fields = await engine.getElectionRegistrationFields(electionId)
      expect(fields).to.have.length(1)
      expect(fields[0]!.tier).to.equal('selective')
      expect(fields[0]!.requirement).to.equal('optional')
    })
  })

  describe('ElectionDisclosurePolicy', () => {
    it('a bare re-add over an existing (ElectionId, FieldName) row is REJECTED — the hazard is real', async () => {
      const { engine, sign, electionId } = await setupFieldPolicyTest()
      await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'income', audience: 'everyone' }, sign)

      let threw: Error | undefined
      try {
        await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'income', audience: 'district' }, sign)
      } catch (err) {
        threw = err as Error
      }
      expect(threw, 'expected a bare re-add to violate the (ElectionId, FieldName) primary key').to.not.be.undefined
      expect(threw!.message, 'the throw must be the PK collision itself').to.match(/unique constraint failed/i)

      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from ElectionDisclosurePolicy where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName: 'income' })
      expect(Number(row?.n), 'the rejected insert must not have duplicated the row').to.equal(1)

      const policies = await engine.getElectionDisclosurePolicies(electionId)
      expect(policies[0]!.audience, 'the rejected insert must not have mutated the stored row').to.equal('everyone')
    })

    it('remove-then-add edits the row in place — one row, new Audience', async () => {
      const { engine, sign, electionId } = await setupFieldPolicyTest()
      await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'income', audience: 'everyone' }, sign)

      // The sequence Phase 46's onSetAudience performs.
      await engine.removeElectionDisclosurePolicy(electionId, 'income', sign)
      await engine.addElectionDisclosurePolicy({ electionId, fieldName: 'income', audience: 'district' }, sign)

      const ctx = (engine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from ElectionDisclosurePolicy where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName: 'income' })
      expect(Number(row?.n), 'an edit must leave exactly one row').to.equal(1)

      const policies = await engine.getElectionDisclosurePolicies(electionId)
      expect(policies).to.have.length(1)
      expect(policies[0]!.audience).to.equal('district')
    })
  })

  describe('MockRegistrationEngine is structurally blind to this class (pinned, not assumed)', () => {
    it('the mock ACCEPTS a bare re-add and upserts it — which is why the tests above must run against the real engine', async () => {
      const { MockRegistrationEngine } = await import('../src/registration/mock-registration-engine.js')
      const mock = new MockRegistrationEngine()
      const dummySig: Signature = { signature: 'a'.repeat(128), signerKey: 'b'.repeat(66), signerUserId: 'user-1' }
      const electionId = 'election-mock-t460801'

      await mock.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'public', requirement: 'required' }, dummySig)
      // No remove first. Against the real engine (above) this throws; the mock's
      // Map.set silently upserts, so a mock-backed test cannot detect a missing
      // remove leg. If this ever starts throwing, the mock gained real PK
      // semantics and 46-VALIDATION.md's declared blind spot should be revisited.
      await mock.addElectionRegistrationField({ electionId, fieldName: 'district', tier: 'selective', requirement: 'optional' }, dummySig)

      const fields = await mock.getElectionRegistrationFields(electionId)
      expect(fields, 'mock upserts rather than colliding').to.have.length(1)
      expect(fields[0]!.tier).to.equal('selective')
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

  // WR-03 (42-REVIEW): register() must reject a submission whose electionId
  // belongs to a DIFFERENT authority than the registrant — otherwise an
  // unrelated authority's field policy would govern (or a policy-less election
  // would silently bypass the caller's own stricter policy). The check fires
  // BEFORE any DB ceremony, so no partial row is written.
  it('rejects a submission whose electionId belongs to a different authority than the registrant (WR-03 cross-authority)', async () => {
    const { engine, sign, electionId } = await setupFieldPolicyTest()
    // electionId is owned by the test's authority A; the registrant claims a
    // different authority. (The registrant.authorityId need not exist — the
    // ownership mismatch is caught before the signing ceremony ever runs.)
    const registrantId = nextRegistrantId()
    let threw: Error | undefined
    try {
      await engine.register(
        {
          electionId,
          registrant: { id: registrantId, authorityId: 'some-other-authority-wr03', expiration: FUTURE_EXPIRATION },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        sign
      )
    } catch (err) {
      threw = err as Error
    }
    expect(threw, 'expected register() to reject a cross-authority electionId').to.not.be.undefined
    expect(threw!.message, 'error should name the cross-authority cause').to.match(/cross-authority/i)

    const registrant = await engine.getRegistrant(registrantId)
    expect(registrant, 'no partial Registrant row after a cross-authority rejection').to.be.undefined
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
