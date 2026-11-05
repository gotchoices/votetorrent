/**
 * ios-association-ceremony.spec.ts — the iOS associate ceremony, end to end, on REAL Apple bytes.
 *
 * WHAT WAS MISSING. Phase 51 had two halves that had each been proven alone and never together:
 *
 *   - `ios-hardware-attestation.spec.ts` proves the VERIFIER accepts a real iPhone 13 submission
 *     (spike 085 leg 9), but stops at `verify()` — it never writes a row.
 *   - `association-ios-cross-field.spec.ts` proves the BUILDER's iOS validators, but against
 *     `{} as unknown as IAssociationEngine` — a stub. It never reaches `associate()` or a database.
 *   - `association.spec.ts` drives the full ceremony against a real Quereus DB, but every
 *     attestation in it is synthetic and Android-shaped.
 *
 * So `AssociationAssociateBuilder.commit()` had never once run with genuine iOS hardware bytes.
 * That is the gap this file closes: real captured attestation -> real builder -> real
 * `AssociationEngine.associate()` -> real `AppAttestVerifier` -> real signed rows in a real DB.
 *
 * WHAT THIS DOES NOT PROVE. It is a Node spec, not a device run. The voter app's own screen wiring
 * (`ConfirmationScreen.onConfirm`) is NOT exercised here, and `produceIos()` does not run — its
 * OUTPUT is replayed from the hardware capture. `produceIos` itself was proven on an iPhone 13 on
 * 2026-08-25; what remains unproven after this file is the app UI driving these two proven halves.
 * Do not describe this spec as "the ceremony ran on iOS".
 *
 * ONE PINNED RANDOM VALUE, and why it is faithful. The captured attestation is cryptographically
 * bound to spike 085's exact `nonce` and `deviceKey`: BOUND_DIGEST is `Digest(nonce, deviceKey)`,
 * and the assertion and the proof-of-possession both sign digests derived from it. Meanwhile
 * `issueAttestationChallenge` mints its nonce with `crypto.randomUUID()`. So the ONLY way real
 * bytes can meet the real challenge path is to pin that one random draw. Everything else in
 * `issueAttestationChallenge` runs for real — the 'vrg' AdminSigning ceremony, the signature, the
 * `AttestationChallenge` insert and all its CHECKs. Spike 085 leg 9 established the same point from
 * the other direction: `produceIos` reads `nonce` and `deviceKey` and nothing else, so a pinned
 * UUID is the same input by construction.
 */
import 'reflect-metadata'
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { DeviceAttestation, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { AppAttestVerifier } from '../src/association/app-attest-verifier.js'
import { PlatformDispatchingAttestationVerifier } from '../src/association/platform-dispatching-verifier.js'
import { PlayIntegrityVerifier } from '../src/association/play-integrity-verifier.js'
import { AssociationAssociateBuilder } from '../src/association/builders/association-associate-builder.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, testKeyPairFor } from './fixtures/test-context.js'
import { APPLE_APP_ATTEST_ROOT_DER } from './fixtures/attestation/apple-app-attest-root.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

/** The 2026-08-25 iPhone 13 capture — the same file `ios-hardware-attestation.spec.ts` pins. */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/attestation/ios-hardware-2026-08-25.json', import.meta.url)),
    'utf8'
  )
) as {
  startedAt: string
  challenge: { nonce: string, deviceKey: string }
  attestation: DeviceAttestation
}

const APP_ID = '94TY7UR2W5.org.votetorrent.voter'
const FUTURE_REGISTRANT_EXPIRATION = '2099-01-01T00:00:00.000Z'

/**
 * The real device's own capture timestamp. Apple App Attest development-environment leaf certs are
 * short-lived, so a fixed real-hardware fixture inevitably crosses its own validity window as
 * wall-clock time passes. Every test in this file replays the SAME real hardware capture, so the
 * whole file verifies at capture time rather than at `new Date()`. Nothing in the shipped verifier
 * ever passes an injected `now`; see `app-attest.ts`'s `now?: Date` doc for why this seam exists.
 */
const FIXTURE_CAPTURED_AT = new Date(fixture.startedAt)

function makeRealSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const priv = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: userId,
    signerKey: publicHex,
    signature: bytesToHex(secp256k1.sign(digest, priv))
  })
}

let registrantSeq = 0
const nextRegistrantId = (): string => `ios-ceremony-registrant-${++registrantSeq}`

/**
 * Run `fn` with `crypto.randomUUID` pinned to `value` for its duration.
 *
 * Restored in a `finally` so a throw inside the ceremony cannot leak a fixed UUID into any
 * sibling test — which would silently turn *their* randomness into a constant.
 */
async function withPinnedUuid<T> (value: string, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.crypto.randomUUID
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => value, configurable: true, writable: true
  })
  try {
    return await fn()
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: original, configurable: true, writable: true
    })
  }
}

interface Ceremony {
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}

/**
 * A real network + authority + registrant, with the REAL iOS verifier behind the REAL platform
 * dispatcher — the same composition `apps/VoteTorrentAuthority/src/engines/engine-factory.ts`
 * builds. Not `StubAttestationVerifier`: a stub accepts everything, so a ceremony driven through
 * one proves only that rows can be written, never that these bytes were checked.
 */
async function setupIosCeremony (environment: 'development' | 'production' = 'development'): Promise<Ceremony> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const sign = makeRealSigner(auth.user.id)

  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    {
      id: registrantId,
      authorityId: auth.authority.id,
      privateCid: 'ios-ceremony-private-cid-placeholder',
      expiration: FUTURE_REGISTRANT_EXPIRATION
    },
    sign
  )

  const verifier = new PlatformDispatchingAttestationVerifier(
    new PlayIntegrityVerifier(
      { getDecryptionKey: async () => new Uint8Array(), getVerificationKey: async () => new Uint8Array() } as never,
      [],
      { packageName: 'org.votetorrent.voter', certificateSha256Digests: [] },
      new Set<string>(),
      false
    ),
    new AppAttestVerifier([APPLE_APP_ATTEST_ROOT_DER], APP_ID, environment, undefined, true, FIXTURE_CAPTURED_AT)
  )

  return { auth, registrantId, engine: new AssociationEngine(auth.ctx, verifier), sign }
}

/** Issue a challenge whose nonce/deviceKey are the ones the captured bytes are bound to. */
async function issuePinnedChallenge (c: Ceremony): Promise<void> {
  await withPinnedUuid(fixture.challenge.nonce, async () => {
    await c.engine.issueAttestationChallenge(
      c.registrantId, fixture.challenge.deviceKey, c.sign
    )
  })
}

describe('iOS associate ceremony — REAL hardware bytes through the REAL engine', () => {
  it('commit() lands the signed Association and AssociationPrivate rows', async () => {
    const c = await setupIosCeremony()
    await issuePinnedChallenge(c)

    // The builder, exactly as ConfirmationScreen drives it.
    await new AssociationAssociateBuilder(c.engine)
      .setRegistrantId(c.registrantId)
      .setDeviceKey(fixture.challenge.deviceKey)
      .setNonce(fixture.challenge.nonce)
      .setAttestation(fixture.attestation)
      .setSignatureOrCallback(c.sign)
      .commit()

    const publicRow = await c.auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :r and DeviceKey = :d')
      .get({ r: c.registrantId, d: fixture.challenge.deviceKey })
    expect(Number(publicRow?.n), 'public Association row').to.equal(1)

    const privateRow = await c.auth.ctx.db
      .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :r and DeviceKey = :d')
      .get({ r: c.registrantId, d: fixture.challenge.deviceKey })
    expect(Number(privateRow?.n), 'authority-held AssociationPrivate row').to.equal(1)

    const association = await c.engine.getAssociation(c.registrantId, fixture.challenge.deviceKey)
    expect(association, 'getAssociation must read the row back').to.not.be.undefined
    expect(association!.attestationCid).to.be.a('string').with.length.greaterThan(0)
  })

  it('records a PASSING AttestationVerdict — the real verifier ran and accepted', async () => {
    // Without this, the row-count assertions above would look identical whether the verifier
    // accepted the bytes or was never consulted at all.
    const c = await setupIosCeremony()
    await issuePinnedChallenge(c)

    await new AssociationAssociateBuilder(c.engine)
      .setRegistrantId(c.registrantId)
      .setDeviceKey(fixture.challenge.deviceKey)
      .setNonce(fixture.challenge.nonce)
      .setAttestation(fixture.attestation)
      .setSignatureOrCallback(c.sign)
      .commit()

    const verdicts = await c.engine.getAttestationVerdicts(c.registrantId)
    expect(verdicts.length, 'exactly one verdict for this ceremony').to.equal(1)
    expect(verdicts[0].verdict, `verdict must be 'pass', got reason: ${String(verdicts[0].reason ?? '')}`).to.equal('pass')
  })

  // ---- negative controls: without these, the passes above prove far less ----

  it('a PRODUCTION authority REJECTS these development bytes, and writes no row', async () => {
    // The asymmetry that matters for shipping. Same bytes, same ceremony, stricter authority.
    const c = await setupIosCeremony('production')
    await issuePinnedChallenge(c)

    let threw = false
    try {
      await new AssociationAssociateBuilder(c.engine)
        .setRegistrantId(c.registrantId)
        .setDeviceKey(fixture.challenge.deviceKey)
        .setNonce(fixture.challenge.nonce)
        .setAttestation(fixture.attestation)
        .setSignatureOrCallback(c.sign)
        .commit()
    } catch {
      threw = true
    }
    expect(threw, 'a production authority must reject a development attestation').to.be.true

    const publicRow = await c.auth.ctx.db
      .prepare('select count(*) as n from Association where RegistrantId = :r and DeviceKey = :d')
      .get({ r: c.registrantId, d: fixture.challenge.deviceKey })
    expect(Number(publicRow?.n), 'a rejected ceremony must leave NO Association row').to.equal(0)

    const verdicts = await c.engine.getAttestationVerdicts(c.registrantId)
    expect(verdicts.length, 'the failure is still recorded').to.equal(1)
    expect(verdicts[0].verdict, 'a rejection is durably recorded as a fail').to.equal('fail')
    expect(verdicts[0].reason, 'and the reason names the environment mismatch')
      .to.match(/development attestation is never accepted in production/)
  })

  it('the builder rejects a tampered assertionCounter before the engine is ever called', async () => {
    // validateNonceCrossField's iOS branch (the Phase 51 fail-open fix) against genuine producer
    // output rather than a hand-built object. A zero counter is what a replayed assertion looks
    // like. This is the cheap gate, not the security boundary — but it must still fire.
    const c = await setupIosCeremony()
    await issuePinnedChallenge(c)

    const tampered = {
      ...fixture.attestation,
      platformDetails: { ...(fixture.attestation.platformDetails as object), assertionCounter: 0 }
    } as DeviceAttestation

    let threw = false
    try {
      await new AssociationAssociateBuilder(c.engine)
        .setRegistrantId(c.registrantId)
        .setDeviceKey(fixture.challenge.deviceKey)
        .setNonce(fixture.challenge.nonce)
        .setAttestation(tampered)
        .setSignatureOrCallback(c.sign)
        .commit()
    } catch {
      threw = true
    }
    expect(threw, 'assertionCounter 0 must be rejected').to.be.true
  })

  it('a nonce the challenge was not issued for is rejected structurally', async () => {
    // The anti-replay lookup: associate() matches on (nonce, registrantId, deviceKey) together.
    const c = await setupIosCeremony()
    await issuePinnedChallenge(c)

    let threw = false
    try {
      await c.engine.associate(
        {
          registrantId: c.registrantId,
          deviceKey: fixture.challenge.deviceKey,
          nonce: '00000000-0000-4000-8000-000000000000',
          attestation: fixture.attestation
        },
        c.sign
      )
    } catch {
      threw = true
    }
    expect(threw, 'an unissued nonce must not associate').to.be.true
  })
})
