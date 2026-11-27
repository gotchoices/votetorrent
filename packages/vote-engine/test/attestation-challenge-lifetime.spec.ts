/**
 * attestation-challenge-lifetime.spec.ts — Phase 51 plan 05 (D-10/D-11).
 *
 * Proves the schema + engine surface of removing `AttestationChallenge.Expiration` (D-10)
 * and making the challenge genuinely single-use by having `associate()` consume it (D-11):
 *
 *   1. A successful `associate()` leaves ZERO `AttestationChallenge` rows for that nonce.
 *   2. A second `associate()` with the same nonce throws at the challenge lookup with the
 *      existing "already been consumed" message.
 *   3. A FAILING `associate()` (attestation verification rejected) leaves the challenge row
 *      INTACT — the rejection happens before `BEGIN`, so nothing is consumed and the device
 *      may retry with the same challenge.
 *   4. A failure INSIDE the write transaction (a second `associate()` colliding with an
 *      already-associated (RegistrantId, DeviceKey) pair — the pre-existing D-06 Association
 *      primary-key CHECK) leaves the challenge row INTACT: the consumption step (51-05's
 *      `associate()` deviation — see association-engine.ts's inline comment) only runs AFTER
 *      the write transaction has durably committed, so a failure inside that transaction never
 *      reaches it.
 *   5. Schema-level: an `AttestationChallenge` insert supplying an `Expiration` column now
 *      FAILS outright — the column does not exist.
 *
 * Uses real signers (secp256k1) throughout — every rejection case is asserted as a THROW,
 * never a bare row-count of 0.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes, bytesToHex } from '@noble/curves/utils.js'
import type { AttestationVerification, DeviceAttestation, IAttestationVerifier, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation as seedSignedMutationFixture, testKeyPairFor } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

// ---------------------------------------------------------------------------
// Helpers — mirror association.spec.ts's small self-contained versions
// (that file's own module scope does not export them).
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign }
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `challenge-lifetime-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `challenge-lifetime-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `challenge-lifetime-device-pubkey-${deviceSeq}`,
    deviceId: `challenge-lifetime-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/** Seed an active Registrant (Status='a') for the attestation flow to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'challenge-lifetime-test-private-cid', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, sign }
}

/** Always-reject verifier — proves the pre-BEGIN rejection path (behavior 3). */
const rejectingVerifier: IAttestationVerifier = {
  async verify (): Promise<AttestationVerification> {
    return { ok: false, reason: 'simulated rejection (D-03 fail-path)' }
  }
}

/** Point-read the AttestationChallenge row count for a given nonce. */
async function challengeRowCount (auth: TestAuthorityContext, nonce: string): Promise<number> {
  const row = await auth.ctx.db
    .prepare('select count(*) as n from AttestationChallenge where Nonce = :nonce')
    .get({ nonce })
  return Number(row?.n ?? 0)
}

describe('AttestationChallenge lifetime — D-10 (Expiration removed) / D-11 (associate() consumes)', () => {
  it('behavior 1: a successful associate() leaves ZERO AttestationChallenge rows for that nonce', async () => {
    const { auth, registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)

    expect(await challengeRowCount(auth, challenge.nonce), 'challenge must exist before associate()').to.equal(1)

    await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

    expect(await challengeRowCount(auth, challenge.nonce), 'challenge must be CONSUMED after a successful associate()').to.equal(0)
  })

  it('behavior 2: a second associate() with the same nonce throws at the challenge lookup ("already been consumed")', async () => {
    const { auth, registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
    await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

    let thrown: unknown
    try {
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected a replayed associate() with the same (now-consumed) nonce to throw').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.match(/already been consumed/)

    // Still exactly one Association row — the replay never got past the lookup to write a second.
    const assocRow = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(assocRow?.n)).to.equal(1)
  })

  it('behavior 3: a FAILING associate() (attestation verification rejected) leaves the challenge row INTACT', async () => {
    const { auth, registrantId, sign } = await setupAssociationTest()
    const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
    const deviceKey = nextDeviceKey()
    const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)

    let thrown: unknown
    try {
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected a rejected attestation to throw').to.be.instanceOf(Error)
    expect((thrown as Error).message).to.match(/attestation verification failed/)

    expect(await challengeRowCount(auth, challenge.nonce), 'a pre-BEGIN rejection must never consume the challenge').to.equal(1)

    // The device may retry with the SAME challenge — prove the nonce is still usable by a
    // (hypothetical) subsequent accepting attempt: the challenge lookup itself still succeeds.
    const stillFound = await auth.ctx.db
      .prepare('select 1 as found from AttestationChallenge where Nonce = :nonce and RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ nonce: challenge.nonce, registrantId, deviceKey })
    expect(stillFound).to.not.be.undefined
  })

  it('behavior 4: a failure INSIDE the write transaction (D-06 Association PK collision) leaves the challenge row INTACT', async () => {
    const { auth, registrantId, engine, sign } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()

    // First association succeeds and consumes its own challenge (behavior 1).
    const challenge1 = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
    await engine.associate({ registrantId, deviceKey, nonce: challenge1.nonce, attestation: makeDeviceAttestation() }, sign)

    // A FRESH second challenge for the SAME (registrantId, deviceKey) — the challenge layer
    // permits re-issuance (association.spec.ts's replay-reject suite already proves this).
    // Attempting to associate against it fails INSIDE the write transaction at the Association
    // primary-key CHECK, not at the challenge lookup.
    const challenge2 = await engine.issueAttestationChallenge(registrantId, deviceKey, sign)
    let thrown: unknown
    try {
      await engine.associate({ registrantId, deviceKey, nonce: challenge2.nonce, attestation: makeDeviceAttestation() }, sign)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected the second associate() to be rejected by the Association PK CHECK').to.be.instanceOf(Error)

    // The consumption step only runs AFTER the write transaction durably commits (see
    // association-engine.ts's associate() doc comment, step 5) — a failure inside that
    // transaction never reaches it, so challenge2 is left intact.
    expect(await challengeRowCount(auth, challenge2.nonce), 'an in-transaction failure must leave the challenge row intact').to.equal(1)

    // Still exactly one Association row (from the first, successful associate()).
    const assocRow = await auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
      .get({ registrantId, deviceKey })
    expect(Number(assocRow?.n)).to.equal(1)
  })

  it('behavior 5 (D-10 schema): an AttestationChallenge insert supplying an Expiration column now FAILS — the column does not exist', async () => {
    const { auth, registrantId } = await setupAssociationTest()
    const deviceKey = nextDeviceKey()
    const nonce = crypto.randomUUID()
    const tid = Date.now() + Math.floor(Math.random() * 100_000)

    // Real 6-argument digest/signature over the CURRENT (post-D-10) InsertValid shape — this
    // insert is expected to fail on the EXTRA `Expiration` column, not on signature validity.
    // NOTE: `challengeNonce` (not `nonce`) — the test-context fixture's seedSignedMutation
    // reserves `nonce`/`authorityId` for ITS OWN ceremony bind params (it spreads the caller's
    // digestParams THEN overwrites `nonce`), exactly the T-42-03 collision class
    // issueAttestationChallenge's own doc comment warns about.
    const digestExpr = 'select Digest(:tid, :challengeNonce, :authorityId, :registrantId, :deviceKey, :electionId) as d'
    const digestParams = { tid, challengeNonce: nonce, authorityId: auth.authority.id, registrantId, deviceKey, electionId: null }
    const { nonce: signingNonce } = await seedSignedMutationFixture(auth.ctx, auth.authority.id, 'vrg', tid, digestExpr, digestParams, auth.user)

    let thrown: unknown
    try {
      await auth.ctx.db.exec(
        `insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:nonce, :authorityId, :registrantId, :deviceKey, :electionId, :expiration)`,
        { nonce, authorityId: auth.authority.id, registrantId, deviceKey, electionId: null, expiration: new Date(Date.now() + 60_000).toISOString(), signingNonce }
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected an insert naming the removed Expiration column to fail').to.be.instanceOf(Error)

    expect(await challengeRowCount(auth, nonce), 'the rejected insert must not have landed a row').to.equal(0)
  })
})
