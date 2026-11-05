/**
 * association-record-validity.spec.ts — Phase 51 Plan 09, Task 1 (D-12).
 *
 * Proves `ElectionRecordValidityPolicy` (landed schema-only by 51-01) is now the SOURCE of
 * `Association`/`AssociationPrivate.Expiration` (via `AssociationEngine.associate()`) and
 * `Registrant`/`RegistrantPrivate.Expiration` (via `SignatureTasksEngine.finalizeRegistrantApproval`),
 * replacing 51-05's `INTERIM_ASSOCIATION_VALIDITY_DAYS` placeholder and the ten-year submitter-
 * proposed "dev posture" window D-12 exists to retire — one `it()` per `<behavior>` bullet:
 *
 *   1. a policy row present -> associate() derives Expiration from AssociationValidityDays.
 *   2. no policy row -> associate() falls back to the CONSERVATIVE DEFAULT_ASSOCIATION_VALIDITY_DAYS.
 *   3. a failure of the policy SELECT itself PROPAGATES, never silently defaults.
 *   4. finalizeRegistrantApproval overrides a ten-year submitter-proposed expiration with the
 *      policy's RegistrantValidityDays value.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback,
  provisionTestIntakeRecipient,
  seedSignedMutation as seedSignedMutationFixture,
  testKeyPairFor
} from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { resolveRecordValidity, DEFAULT_ASSOCIATION_VALIDITY_DAYS, DEFAULT_REGISTRANT_VALIDITY_DAYS } from '../src/association/record-validity.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type { DeviceAttestation, RegisterInit, RegistrationRequestInit, RegistrantSignatureTask, Signature } from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

const DAY_MS = 86400000
// A tolerance well inside one calendar day — the ceremony issues the challenge, associates and
// reads the row back in well under a second of real wall-clock time in this suite.
const DAY_TOLERANCE = 0.05

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `record-validity-device-${Date.now()}-${deviceSeq}`
}

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `record-validity-device-pubkey-${deviceSeq}`,
    deviceId: `record-validity-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db.prepare('select Id from Election where AuthorityId = :authorityId limit 1').get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

/** Seed an active Registrant for the association ceremony to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const sign = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = `record-validity-registrant-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'record-validity-private-cid-placeholder', expiration: Date.now() + 365 * DAY_MS },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, sign }
}

/** Seeds an `ElectionRecordValidityPolicy` row via a real 'mel'-scoped ceremony — the D-12 policy row. */
async function seedRecordValidityPolicy (
  auth: TestAuthorityContext,
  electionId: string,
  values: { registrantValidityDays: number; associationValidityDays: number }
): Promise<void> {
  const tid = Date.now() + Math.floor(Math.random() * 100_000)
  const digestExpr = 'select Digest(:tid, :electionId, :registrantValidityDays, :associationValidityDays) as d'
  const digestParams = {
    tid,
    electionId,
    registrantValidityDays: values.registrantValidityDays,
    associationValidityDays: values.associationValidityDays
  }
  const { nonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'mel', tid, digestExpr, digestParams, auth.user)
  await auth.ctx.db.exec(
    `insert into ElectionRecordValidityPolicy (ElectionId, RegistrantValidityDays, AssociationValidityDays)
     with context SigningNonce = :nonce, Tid = ${tid}
     values (:electionId, :registrantValidityDays, :associationValidityDays)`,
    { electionId, registrantValidityDays: values.registrantValidityDays, associationValidityDays: values.associationValidityDays, nonce }
  )
}

function makeTestPayload (authorityId: string, electionId: string | undefined, tenYearExpiration: string): RegisterInit {
  return {
    registrant: { id: crypto.randomUUID(), authorityId, expiration: tenYearExpiration },
    ...(electionId === undefined ? {} : { electionId }),
    private: { expiration: tenYearExpiration, details: [] }
  }
}

async function getRegistrantTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  expect(found, `registrant task for requestId=${requestId} must be present`).to.not.be.undefined
  return found!
}

function makeNetworkRef () {
  return { hash: 'record-validity-hash', name: 'Test Network', relays: [] as string[], primaryAuthorityDomainName: 'test.example' }
}

async function daysFromNow (isoZ: string): Promise<number> {
  return (Date.parse(isoZ) - Date.now()) / DAY_MS
}

// ===========================================================================

describe('D-12 record validity — ElectionRecordValidityPolicy', () => {
  it('associate() derives Association/AssociationPrivate.Expiration from AssociationValidityDays when a policy row is present', async () => {
    const { auth, registrantId, engine, sign } = await setupAssociationTest()
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    // Distinct values for RegistrantValidityDays (20) vs AssociationValidityDays (10) so the test
    // proves the RIGHT column feeds associate(), not merely that SOME policy value did.
    await seedRecordValidityPolicy(auth, electionId, { registrantValidityDays: 20, associationValidityDays: 10 })

    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign, electionId)
    await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

    const association = await engine.getAssociation(registrantId, deviceKey)
    expect(association, 'Association row must exist').to.not.be.undefined
    expect(await daysFromNow(association!.expiration), 'Association.Expiration must derive from the 10-day AssociationValidityDays policy, not the 365-day fallback or the 20-day RegistrantValidityDays sibling column').to.be.closeTo(10, DAY_TOLERANCE)

    const privateRow = await auth.ctx.db
      .prepare('select Expiration from AssociationPrivate where RegistrantId = :r and DeviceKey = :d')
      .get({ r: registrantId, d: deviceKey })
    expect(privateRow, 'AssociationPrivate row must exist').to.not.be.undefined
    const privateExpiration = privateRow!.Expiration as string
    const withZ = privateExpiration.endsWith('Z') ? privateExpiration : `${privateExpiration}Z`
    expect(await daysFromNow(withZ), 'AssociationPrivate.Expiration must derive from the SAME policy value as the public Association row').to.be.closeTo(10, DAY_TOLERANCE)
  })

  it('associate() falls back to the CONSERVATIVE DEFAULT_ASSOCIATION_VALIDITY_DAYS when no policy row exists for the election', async () => {
    const { registrantId, engine, sign } = await setupAssociationTest()
    // No ElectionRecordValidityPolicy row seeded, and no electionId passed at all (undefined) —
    // the "electionId is undefined" half of the fallback condition.
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
    await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

    const association = await engine.getAssociation(registrantId, deviceKey)
    expect(association, 'Association row must exist').to.not.be.undefined
    expect(await daysFromNow(association!.expiration), 'Association.Expiration must fall back to DEFAULT_ASSOCIATION_VALIDITY_DAYS').to.be.closeTo(DEFAULT_ASSOCIATION_VALIDITY_DAYS, DAY_TOLERANCE)
  })

  it('a failure of the ElectionRecordValidityPolicy SELECT itself propagates, never silently defaults', async () => {
    const throwingCtx = {
      db: {
        prepare: () => {
          throw new Error('record-validity.spec: simulated SELECT failure')
        }
      }
    } as unknown as EngineContext

    let caught: unknown
    try {
      await resolveRecordValidity(throwingCtx, 'some-election-id')
    } catch (err) {
      caught = err
    }
    expect(caught, 'resolveRecordValidity must PROPAGATE a SELECT failure, never swallow it into a default').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('simulated SELECT failure')
  })

  it("finalizeRegistrantApproval overrides a ten-year submitter-proposed expiration with the policy's RegistrantValidityDays value", async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const elec = await addTestElection(auth)
    const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
    // 7 days — distinct from BOTH the ten-year submitter proposal AND the 365-day fallback, so a
    // pass here can only mean the POLICY value actually landed.
    await seedRecordValidityPolicy(auth, electionId, { registrantValidityDays: 7, associationValidityDays: 30 })

    const tenYearExpiration = toIsoZDatetime(Date.now() + 3650 * DAY_MS)
    const requester = randomTestKeyPair()
    const registrationEngine = new RegistrationEngine(auth.ctx)
    const init: RegistrationRequestInit = {
      id: crypto.randomUUID(),
      authorityId: auth.authority.id,
      payload: makeTestPayload(auth.authority.id, electionId, tenYearExpiration),
      submittedAt: toIsoZDatetime(Date.now())
    }
    const requestId = await registrationEngine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))

    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const officerSign = makeTestSignCallback(auth.user)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)
    await tasksEngine.completeSignature(task, {
      isAccepted: true,
      signature: headerSignature,
      sign: officerSign,
      decision: { checklist: ['id'] }
    })

    const registrantRow = await auth.ctx.db
      .prepare('select Expiration from Registrant where Id = :id')
      .get({ id: init.payload.registrant.id })
    expect(registrantRow, 'Registrant row must exist post-approval').to.not.be.undefined
    const registrantExpiration = registrantRow!.Expiration as string
    const registrantWithZ = registrantExpiration.endsWith('Z') ? registrantExpiration : `${registrantExpiration}Z`
    expect(await daysFromNow(registrantWithZ), 'Registrant.Expiration must be the 7-day POLICY value, not the submitter-proposed 3650-day (ten-year) value, and not the 365-day default').to.be.closeTo(7, DAY_TOLERANCE)

    const privateRow = await auth.ctx.db
      .prepare('select Expiration from RegistrantPrivate where RegistrantId = :id')
      .get({ id: init.payload.registrant.id })
    expect(privateRow, 'RegistrantPrivate row must exist post-approval').to.not.be.undefined
    const privateExpiration = privateRow!.Expiration as string
    const privateWithZ = privateExpiration.endsWith('Z') ? privateExpiration : `${privateExpiration}Z`
    expect(await daysFromNow(privateWithZ), 'RegistrantPrivate.Expiration must agree with Registrant.Expiration (the SAME overridden value)').to.be.closeTo(7, DAY_TOLERANCE)

    // Sanity: DEFAULT_REGISTRANT_VALIDITY_DAYS is imported and asserted distinct from the policy
    // value used here, proving this test would have failed had the override been silently skipped
    // in favor of the default rather than the ten-year submitter value.
    expect(DEFAULT_REGISTRANT_VALIDITY_DAYS).to.not.equal(7)
  })
})

// ---------------------------------------------------------------------------
// WR-10 (51-REVIEW) — policy-column coercion. Unit-level: a stub ctx whose policy read returns
// each malformed shape, so the assertions are about the coercion itself rather than about what
// the schema currently permits to be written.
// ---------------------------------------------------------------------------

describe('resolveRecordValidity — policy column coercion (WR-10, 51-REVIEW)', () => {
  function ctxReturning (row: Record<string, unknown> | undefined): EngineContext {
    return {
      db: {
        prepare: () => ({ get: async () => row })
      }
    } as unknown as EngineContext
  }

  it('an explicit NULL column falls back to the conservative default, not to a zero-day window', async () => {
    // Number(null) === 0 put the expiration at NOW, so the deferred
    // `ExpirationFuture check on insert (Expiration > context.now)` on both Association and
    // AssociationPrivate failed at COMMIT — every associate() for that election dying with an
    // opaque CHECK-constraint error several layers from its cause.
    const result = await resolveRecordValidity(
      ctxReturning({ RegistrantValidityDays: null, AssociationValidityDays: null }),
      'election-1'
    )
    const associationDays = (Date.parse(result.associationExpiration) - Date.now()) / DAY_MS
    const registrantDays = (Date.parse(result.registrantExpiration) - Date.now()) / DAY_MS
    expect(associationDays).to.be.closeTo(DEFAULT_ASSOCIATION_VALIDITY_DAYS, DAY_TOLERANCE)
    expect(registrantDays).to.be.closeTo(DEFAULT_REGISTRANT_VALIDITY_DAYS, DAY_TOLERANCE)
  })

  it('an undecodable column throws an error NAMING the column, not a RangeError from new Date(NaN)', async () => {
    let thrown: unknown
    try {
      await resolveRecordValidity(
        ctxReturning({ RegistrantValidityDays: 365, AssociationValidityDays: 'not-a-number' }),
        'election-1'
      )
    } catch (err) { thrown = err }
    expect(thrown).to.be.instanceOf(Error)
    expect((thrown as Error).name, 'must not be the unclassified RangeError: Invalid time value').to.not.equal('RangeError')
    expect((thrown as Error).message).to.contain('AssociationValidityDays')
  })

  it('a negative or zero column throws rather than silently producing a PAST expiration', async () => {
    for (const bad of [-1, 0]) {
      let thrown: unknown
      try {
        await resolveRecordValidity(
          ctxReturning({ RegistrantValidityDays: bad, AssociationValidityDays: 365 }),
          'election-1'
        )
      } catch (err) { thrown = err }
      expect(thrown, `RegistrantValidityDays=${bad} must be refused`).to.be.instanceOf(Error)
      expect((thrown as Error).message).to.contain('RegistrantValidityDays')
    }
  })

  it('a valid positive integer is still honoured unchanged', async () => {
    const result = await resolveRecordValidity(
      ctxReturning({ RegistrantValidityDays: 7, AssociationValidityDays: 30 }),
      'election-1'
    )
    expect((Date.parse(result.registrantExpiration) - Date.now()) / DAY_MS).to.be.closeTo(7, DAY_TOLERANCE)
    expect((Date.parse(result.associationExpiration) - Date.now()) / DAY_MS).to.be.closeTo(30, DAY_TOLERANCE)
  })
})
