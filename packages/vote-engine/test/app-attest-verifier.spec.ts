/**
 * app-attest-verifier.spec.ts — Phase 51. The iOS attestation path, end to end.
 *
 * Ported from spikes 081 (attestation half, 15/15) and 084 (cross-sign half, 12/12), plus the
 * composed `AppAttestVerifier` which neither spike covered.
 *
 * Discipline carried over from those spikes, because it is what made them worth anything:
 *   - every negative flips exactly ONE variable from a conformant fixture, so a rejection is
 *     attributable to that variable alone;
 *   - the adversarial chain cases matter most — a pinned-root verifier that only passes its happy
 *     path is worthless;
 *   - digests are RECOMPUTED by the verifier, never read from the submission.
 *
 * Everything here is SYNTHETIC. `DCAppAttestService` needs a signed build and a physical iPhone, so
 * a green run proves the wire format is self-consistent — not that iOS attestation works.
 */
import 'reflect-metadata'
import { expect } from 'aegir/chai'
import { Extension } from '@peculiar/x509'
import { createHash } from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'
import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
import { verifyAppAttest } from '../src/association/verifiers/app-attest.js'
import { verifyCrossSign, computeAssertionDigest, computePopDigest } from '../src/association/verifiers/app-attest-assertion.js'
import { cborEncode, cborDecode, CBOR_MAX_NESTING_DEPTH, CBOR_MAX_INPUT_BYTES, type CborValue } from '@votetorrent/vote-core'
import { encodeAppleNonceExtension, APPLE_NONCE_OID } from '../src/association/verifiers/apple-nonce-extension.js'
import { recomputeChallengeDigest } from '../src/association/verifiers/digest-binding.js'
import { AppAttestVerifier } from '../src/association/app-attest-verifier.js'
import {
  generateAppleRootCa,
  issueCert,
  keyIdForPublicKey,
  type TestCertificate
} from './fixtures/attestation/apple-app-attest-ca.js'

const APP_ID = 'ABCDE12345.org.votetorrent.voter'
const CHALLENGE_NONCE = 'phase51-authority-nonce'

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const toHex = (u: Uint8Array): string => Buffer.from(u).toString('hex')
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')

const AAGUID_DEV = utf8('appattestdevelop')
const AAGUID_PROD = (() => { const b = new Uint8Array(16); b.set(utf8('appattest')); return b })()

function buildAuthData (opts: { rpIdHash: Uint8Array, counter: number, aaguid: Uint8Array, credentialId: Uint8Array }): Uint8Array {
  const buf = new Uint8Array(32 + 1 + 4 + 16 + 2 + opts.credentialId.length)
  buf.set(opts.rpIdHash, 0)
  buf[32] = 0x40
  buf[33] = (opts.counter >>> 24) & 0xff
  buf[34] = (opts.counter >>> 16) & 0xff
  buf[35] = (opts.counter >>> 8) & 0xff
  buf[36] = opts.counter & 0xff
  buf.set(opts.aaguid, 37)
  buf[53] = (opts.credentialId.length >> 8) & 0xff
  buf[54] = opts.credentialId.length & 0xff
  buf.set(opts.credentialId, 55)
  return buf
}

interface AttestationMutation {
  wrongClientDataHash?: boolean
  wrongAppId?: boolean
  nonZeroCounter?: boolean
  productionAaguid?: boolean
  unpinnedRoot?: boolean
  tamperedNonceInCert?: boolean
  credIdMismatch?: boolean
  droppedIntermediate?: boolean
  attackerSuppliedRoot?: boolean
  forgedIntermediateSameName?: boolean
  /** T-51-10: a chain whose signatures are all intact but whose credCert is out of date. */
  expiredCredCert?: boolean
  notYetValidCredCert?: boolean
  expiredIntermediate?: boolean
}

interface AttestationFixture {
  attestationObject: Uint8Array
  keyId: Uint8Array
  pinnedRootsDer: Uint8Array[]
  expectedClientDataHash: Uint8Array
  attestedKeys: CryptoKeyPair
}

const ONE_YEAR = 365 * 24 * 60 * 60 * 1000
const DEVICE_KEY_FOR_ATTESTATION = 'phase51-vote-public-key'
const BOUND_DIGEST = recomputeChallengeDigest(CHALLENGE_NONCE, DEVICE_KEY_FOR_ATTESTATION)
const CLIENT_DATA_HASH = sha256(utf8(BOUND_DIGEST))

async function buildAttestation (mutate: AttestationMutation = {}): Promise<AttestationFixture> {
  const root = await generateAppleRootCa()
  const intermediate = await issueCert({
    issuer: root, name: 'CN=Test Apple App Attest CA 1', serialNumber: '02', isCa: true,
    ...(mutate.expiredIntermediate === true
      ? { notBefore: new Date(Date.now() - 2 * ONE_YEAR), notAfter: new Date(Date.now() - ONE_YEAR) }
      : {})
  })

  const attestedKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair
  const keyId = await keyIdForPublicKey(attestedKeys.publicKey)

  const aaguid = mutate.productionAaguid === true ? AAGUID_PROD : AAGUID_DEV
  const rpIdHash = sha256(utf8(mutate.wrongAppId === true ? 'ZZZZZ99999.com.attacker.app' : APP_ID))
  const credentialId = mutate.credIdMismatch === true ? sha256(new Uint8Array([9, 9, 9])) : keyId
  const authData = buildAuthData({ rpIdHash, counter: mutate.nonZeroCounter === true ? 1 : 0, aaguid, credentialId })

  const nonceSource = mutate.tamperedNonceInCert === true ? sha256(new Uint8Array([1, 2, 3])) : CLIENT_DATA_HASH
  const certNonce = sha256(authData, nonceSource)
  const nonceExt = new Extension(APPLE_NONCE_OID, false, encodeAppleNonceExtension(certNonce).buffer as ArrayBuffer)

  const credCert = await issueCert({
    issuer: intermediate, name: 'CN=Test App Attest credCert', serialNumber: '03',
    isCa: false, subjectKeys: attestedKeys, extraExtensions: [nonceExt],
    ...(mutate.expiredCredCert === true
      ? { notBefore: new Date(Date.now() - 2 * ONE_YEAR), notAfter: new Date(Date.now() - ONE_YEAR) }
      : {}),
    ...(mutate.notYetValidCredCert === true
      ? { notBefore: new Date(Date.now() + ONE_YEAR), notAfter: new Date(Date.now() + 2 * ONE_YEAR) }
      : {})
  })

  let attackerRoot: TestCertificate | undefined
  let attackerIntermediate: TestCertificate | undefined
  let attackerCredCert: TestCertificate | undefined
  if (mutate.attackerSuppliedRoot === true || mutate.forgedIntermediateSameName === true) {
    // The attacker reuses the GENUINE subject DNs — catching a verifier that matches issuers by name.
    attackerRoot = await generateAppleRootCa('CN=Test Apple App Attest Root CA 1')
    attackerIntermediate = await issueCert({ issuer: attackerRoot, name: 'CN=Test Apple App Attest CA 1', serialNumber: '02', isCa: true })
    attackerCredCert = await issueCert({
      issuer: attackerIntermediate, name: 'CN=Test App Attest credCert', serialNumber: '03',
      isCa: false, subjectKeys: attestedKeys, extraExtensions: [nonceExt]
    })
  }

  let x5c: CborValue[]
  if (mutate.droppedIntermediate === true) {
    x5c = [new Uint8Array(credCert.cert.rawData)]
  } else if (mutate.attackerSuppliedRoot === true) {
    x5c = [
      new Uint8Array(attackerCredCert!.cert.rawData),
      new Uint8Array(attackerIntermediate!.cert.rawData),
      new Uint8Array(attackerRoot!.cert.rawData)
    ]
  } else if (mutate.forgedIntermediateSameName === true) {
    x5c = [new Uint8Array(attackerCredCert!.cert.rawData), new Uint8Array(attackerIntermediate!.cert.rawData)]
  } else {
    x5c = [new Uint8Array(credCert.cert.rawData), new Uint8Array(intermediate.cert.rawData)]
  }

  const obj = new Map<CborValue, CborValue>([
    ['fmt', 'apple-appattest'],
    ['attStmt', new Map<CborValue, CborValue>([['x5c', x5c], ['receipt', new Uint8Array([0xde, 0xad])]])],
    ['authData', authData]
  ])

  const pinnedRoot = mutate.unpinnedRoot === true ? await generateAppleRootCa('CN=Some Other Root') : root

  return {
    attestationObject: cborEncode(obj),
    keyId,
    pinnedRootsDer: [new Uint8Array(pinnedRoot.cert.rawData)],
    expectedClientDataHash: mutate.wrongClientDataHash === true ? sha256(new Uint8Array([7, 7, 7])) : CLIENT_DATA_HASH,
    attestedKeys
  }
}

async function runAttestation (mutate: AttestationMutation = {}): ReturnType<typeof verifyAppAttest> {
  const f = await buildAttestation(mutate)
  return await verifyAppAttest(f.attestationObject, {
    appId: APP_ID,
    expectedClientDataHash: f.expectedClientDataHash,
    keyId: f.keyId,
    pinnedRootsDer: f.pinnedRootsDer,
    environment: 'development'
  })
}

describe('CBOR (App Attest subset)', () => {
  it('round-trips maps, byte strings, text and 16-bit ints', () => {
    const probe = new Map<CborValue, CborValue>([
      ['fmt', 'apple-appattest'],
      ['authData', new Uint8Array([1, 2, 3, 250, 251])],
      ['n', 65535]
    ])
    const rt = cborDecode(cborEncode(probe))
    expect(rt).to.be.instanceOf(Map)
    const m = rt as Map<CborValue, CborValue>
    expect(m.get('fmt')).to.equal('apple-appattest')
    expect((m.get('authData') as Uint8Array)[4]).to.equal(251)
    expect(m.get('n')).to.equal(65535)
  })

  it('rejects trailing bytes rather than silently ignoring them', () => {
    const encoded = cborEncode(new Map<CborValue, CborValue>([['a', 1]]))
    const withTrailer = new Uint8Array([...encoded, 0xff])
    expect(() => cborDecode(withTrailer)).to.throw(/trailing bytes/)
  })

  // ---- T-51-09 resource bounds (phase 51 retroactive-STRIDE audit) ----
  //
  // These parse attacker-supplied bytes, so "it throws eventually" is not the property under test —
  // it must throw for the STATED reason, at a bounded cost, before recursion can exhaust the stack.
  describe('resource bounds on hostile input', () => {
    it('rejects nesting deeper than the limit — 0x81 is one byte per level', () => {
      // Each 0x81 is "array of 1", so N bytes buys N stack frames. This is the actual DoS vector;
      // a declared-but-absent LENGTH is already self-limiting because the Reader runs out of input.
      const bomb = new Uint8Array(CBOR_MAX_NESTING_DEPTH + 8).fill(0x81)
      expect(() => cborDecode(bomb)).to.throw(/nesting deeper than/)
    })

    it('accepts nesting up to the limit (control — the bound is not simply off)', () => {
      // Without this, a decoder that rejected EVERYTHING would pass the test above.
      const deep = new Uint8Array(CBOR_MAX_NESTING_DEPTH).fill(0x81)
      const atLimit = new Uint8Array([...deep, 0x00]) // innermost item: uint 0
      expect(() => cborDecode(atLimit)).to.not.throw()
    })

    it('rejects an oversized payload before decoding it', () => {
      const huge = new Uint8Array(CBOR_MAX_INPUT_BYTES + 1)
      expect(() => cborDecode(huge)).to.throw(/exceeds the .* limit/)
    })

    it('still accepts a real-sized attestation object (control — the size cap is not too tight)', () => {
      // A genuine App Attest object measured 5,873 bytes on an iPhone 13; the cap must clear it by a
      // wide margin or this control becomes an availability bug.
      const realistic = cborEncode(new Map<CborValue, CborValue>([['authData', new Uint8Array(8192)]]))
      expect(realistic.length).to.be.lessThan(CBOR_MAX_INPUT_BYTES)
      expect(() => cborDecode(realistic)).to.not.throw()
    })
  })
})

describe('verifyAppAttest — the attestation half', () => {
  it('accepts a conformant attestation', async () => {
    const r = await runAttestation()
    expect(r.ok, r.reason).to.equal(true)
    expect(r.attestedPublicKeyRaw).to.have.length(65)
  })

  it('rejects a wrong clientDataHash (challenge binding)', async () => {
    const r = await runAttestation({ wrongClientDataHash: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/challenge binding failed/)
  })

  it('rejects a tampered credCert nonce', async () => {
    const r = await runAttestation({ tamperedNonceInCert: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/challenge binding failed/)
  })

  it('rejects an attestation for a different app (rpIdHash)', async () => {
    const r = await runAttestation({ wrongAppId: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/rpIdHash/)
  })

  it('rejects a non-zero attestation counter', async () => {
    const r = await runAttestation({ nonZeroCounter: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/counter must be 0/)
  })

  it('NEVER accepts a production attestation in a development authority (aaguid)', async () => {
    const r = await runAttestation({ productionAaguid: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/aaguid/)
  })

  it('rejects a chain that does not reach the pinned root', async () => {
    const r = await runAttestation({ unpinnedRoot: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/pinned Apple App Attest root/)
  })

  it('rejects a credential id that is not the keyId', async () => {
    const r = await runAttestation({ credIdMismatch: true })
    expect(r.ok).to.equal(false)
  })

  it('rejects an x5c missing the intermediate', async () => {
    const r = await runAttestation({ droppedIntermediate: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/x5c/)
  })

  // The two that actually matter for a pinned-root verifier.
  it('REFUSES a complete attacker-supplied chain that ships its own root', async () => {
    const r = await runAttestation({ attackerSuppliedRoot: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/pinned Apple App Attest root/)
  })

  it('REFUSES a forged intermediate carrying the genuine subject DN', async () => {
    const r = await runAttestation({ forgedIntermediateSameName: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/pinned Apple App Attest root/)
  })

  // ---- T-51-10 certificate validity window (phase 51 retroactive-STRIDE audit) ----
  //
  // Each chain below is cryptographically PERFECT — it builds to the pinned root and every link
  // signature verifies — and is merely outside its validity window. Before this check the verifier
  // accepted all of them, because `verify({ signatureOnly: true })` skips validity by design. The
  // Android sibling (`key-attestation.ts`) had always rejected them; the asymmetry was undocumented.
  it('rejects an EXPIRED credCert even though the chain and signatures are intact', async () => {
    const r = await runAttestation({ expiredCredCert: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/expired or not yet valid/)
  })

  it('rejects a NOT-YET-VALID credCert (clock-skew / post-dated cert)', async () => {
    const r = await runAttestation({ notYetValidCredCert: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/expired or not yet valid/)
  })

  it('rejects an expired INTERMEDIATE, not just the leaf', async () => {
    const r = await runAttestation({ expiredIntermediate: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/expired or not yet valid/)
  })
})

// ---------------------------------------------------------------------------
// Cross-sign half
// ---------------------------------------------------------------------------

interface CrossSignMutation {
  wrongVoteKeyInAssertion?: boolean
  wrongChallengeNonce?: boolean
  wrongAppIdInAssertion?: boolean
  replayCounter?: boolean
  zeroCounter?: boolean
  popByWrongKey?: boolean
  popOverWrongDigest?: boolean
  assertionByWrongKey?: boolean
  missingDomainTag?: boolean
}

function buildCrossSign (mutate: CrossSignMutation = {}): {
  assertionCbor: Uint8Array
  popSignatureHex: string
  deviceKey: string
  appAttestPublicKeyRaw: Uint8Array
  previousCounter?: number
} {
  const kAttPriv = p256.utils.randomSecretKey()
  const kAttPubRaw = p256.getPublicKey(kAttPriv, false)
  const kVotePriv = p256.utils.randomSecretKey()
  const deviceKey = toHex(p256.getPublicKey(kVotePriv, true))

  const voteKeyInAssertion = mutate.wrongVoteKeyInAssertion === true
    ? toHex(p256.getPublicKey(p256.utils.randomSecretKey(), true))
    : deviceKey
  const nonceUsed = mutate.wrongChallengeNonce === true ? 'a-different-nonce' : CHALLENGE_NONCE

  const bound = recomputeChallengeDigest(nonceUsed, voteKeyInAssertion)
  const assertionDigest = mutate.missingDomainTag === true
    ? recomputeChallengeDigest(bound, voteKeyInAssertion)
    : computeAssertionDigest(bound, voteKeyInAssertion)

  const rpId = mutate.wrongAppIdInAssertion === true ? 'ZZZZZ99999.com.attacker.app' : APP_ID
  const authData = new Uint8Array(37)
  authData.set(sha256(utf8(rpId)), 0)
  const counter = mutate.zeroCounter === true ? 0 : (mutate.replayCounter === true ? 1 : 5)
  authData[36] = counter

  // `prehash: true` — Apple signs SHA256(nonce), not the nonce itself. Verified against a real
  // device assertion in spike 085; signing with `prehash: false` here would reproduce the exact
  // blind spot that let the original bug through a green suite.
  const assertionNonce = sha256(authData, sha256(utf8(assertionDigest)))
  const signingKey = mutate.assertionByWrongKey === true ? p256.utils.randomSecretKey() : kAttPriv
  const assertionSig = p256.sign(assertionNonce, signingKey, { prehash: true, format: 'der' })

  const popBound = recomputeChallengeDigest(CHALLENGE_NONCE, deviceKey)
  const popDigest = mutate.popOverWrongDigest === true
    ? computePopDigest('some-other-bound-digest')
    : computePopDigest(popBound)
  const popKey = mutate.popByWrongKey === true ? p256.utils.randomSecretKey() : kVotePriv
  const popSig = p256.sign(sha256(utf8(popDigest)), popKey, { prehash: false, format: 'compact' })

  return {
    assertionCbor: cborEncode(new Map<CborValue, CborValue>([
      ['signature', assertionSig],
      ['authenticatorData', authData]
    ])),
    popSignatureHex: toHex(popSig),
    deviceKey,
    appAttestPublicKeyRaw: kAttPubRaw,
    previousCounter: mutate.replayCounter === true ? 5 : undefined
  }
}

function runCrossSign (mutate: CrossSignMutation = {}): ReturnType<typeof verifyCrossSign> {
  const b = buildCrossSign(mutate)
  return verifyCrossSign(b.assertionCbor, b.popSignatureHex, {
    appId: APP_ID,
    challengeNonce: CHALLENGE_NONCE,
    deviceKey: b.deviceKey,
    appAttestPublicKeyRaw: b.appAttestPublicKeyRaw,
    previousCounter: b.previousCounter
  })
}

describe('verifyCrossSign — the K_vote binding half', () => {
  it('accepts a conformant cross-sign', () => {
    const r = runCrossSign()
    expect(r.ok, r.reason).to.equal(true)
    expect(r.counter).to.equal(5)
  })

  it('rejects a substituted vote key', () => {
    const r = runCrossSign({ wrongVoteKeyInAssertion: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/not bound to this attestation/)
  })

  it('rejects an assertion answering a different challenge', () => {
    expect(runCrossSign({ wrongChallengeNonce: true }).ok).to.equal(false)
  })

  it('rejects an assertion for a different app', () => {
    const r = runCrossSign({ wrongAppIdInAssertion: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/rpIdHash/)
  })

  it('rejects an assertion signed by the wrong key', () => {
    expect(runCrossSign({ assertionByWrongKey: true }).ok).to.equal(false)
  })

  it('rejects a producer that skipped the domain-separation tag', () => {
    expect(runCrossSign({ missingDomainTag: true }).ok).to.equal(false)
  })

  it('rejects a replayed counter', () => {
    const r = runCrossSign({ replayCounter: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/replay/)
  })

  it('rejects a zero counter at association time', () => {
    const r = runCrossSign({ zeroCounter: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/replay/)
  })

  it('rejects a proof-of-possession signed by the wrong key', () => {
    const r = runCrossSign({ popByWrongKey: true })
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/does not hold K_vote/)
  })

  it('rejects a proof-of-possession over the wrong digest', () => {
    expect(runCrossSign({ popOverWrongDigest: true }).ok).to.equal(false)
  })

  it('domain-separates the assertion and possession digests', () => {
    const bound = recomputeChallengeDigest(CHALLENGE_NONCE, 'k')
    expect(computeAssertionDigest(bound, 'k')).to.not.equal(computePopDigest(bound))
  })

  it('does not let a possession signature replay as an assertion signature', () => {
    const kVotePriv = p256.utils.randomSecretKey()
    const deviceKey = toHex(p256.getPublicKey(kVotePriv, true))
    const bound = recomputeChallengeDigest(CHALLENGE_NONCE, deviceKey)
    const popSig = p256.sign(sha256(utf8(computePopDigest(bound))), kVotePriv, { prehash: false, format: 'compact' })
    const accepted = p256.verify(popSig, sha256(utf8(computeAssertionDigest(bound, deviceKey))),
      Buffer.from(deviceKey, 'hex'), { prehash: false, format: 'compact', lowS: true })
    expect(accepted).to.equal(false)
  })
})

// ---------------------------------------------------------------------------
// The composed verifier
// ---------------------------------------------------------------------------

describe('AppAttestVerifier — composed IAttestationVerifier', () => {
  const challenge = {
    nonce: CHALLENGE_NONCE,
    authorityId: 'auth-1',
    registrantId: 'reg-1',
    deviceKey: 'phase51-device-key'
  } as unknown as AttestationChallenge

  function iosAttestation (overrides: Record<string, unknown> = {}): DeviceAttestation {
    return {
      publicKey: challenge.deviceKey,
      deviceId: 'appattest-keyid',
      attestationTime: Date.now(),
      attestationStatement: b64(new Uint8Array([1, 2, 3])),
      certificateChain: [],
      platformDetails: {
        type: 'iOS',
        secureEnclavePublicKey: challenge.deviceKey,
        appAttestKeyId: b64(new Uint8Array([4, 5, 6])),
        assertion: b64(new Uint8Array([7, 8, 9])),
        assertionCounter: 1,
        popSignature: 'ab'.repeat(64),
        boundDigest: recomputeChallengeDigest(challenge.nonce, challenge.deviceKey),
        environment: 'development',
        ...overrides
      }
    } as unknown as DeviceAttestation
  }

  const verifier = (roots: Uint8Array[] = [new Uint8Array([1])]): AppAttestVerifier =>
    new AppAttestVerifier(roots, APP_ID, 'development')

  it('reports unprovisioned roots FIRST, so no other reason can mask it', async () => {
    const r = await verifier([]).verify(challenge, iosAttestation())
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/not provisioned/)
  })

  it('reports an unprovisioned App ID as CONFIG, not as an app-identity mismatch', async () => {
    // An empty appId does not fail the way missing config should. It flows all the way into
    // `verifyAppAttest`, which compares rpIdHash against SHA256('') and rejects with
    // "attestation is for a different app" — a reason that blames a genuine device for a
    // deployment mistake, and sends whoever reads the log hunting a bundle-id mismatch that
    // does not exist.
    const r = await new AppAttestVerifier([new Uint8Array([1])], '', 'development')
      .verify(challenge, iosAttestation())
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/App ID .* is not provisioned/)
    // The negative half of the claim: it must NOT surface as the app-identity reason.
    expect(r.reason).to.not.match(/different app/)
  })

  it('checks the root gate BEFORE the App ID gate, so a wholly unconfigured authority names the anchor', async () => {
    const r = await new AppAttestVerifier([], '', 'development').verify(challenge, iosAttestation())
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/root material is not provisioned/)
  })

  it('rejects a non-iOS attestation (fail closed)', async () => {
    const android = { ...iosAttestation(), platformDetails: { type: 'Android', safetyNetAttestation: 'x', keystorePublicKey: 'k', nonce: 'n' } } as unknown as DeviceAttestation
    const r = await verifier().verify(challenge, android)
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/no iOS platform details/)
  })

  it('NEVER accepts a development attestation in a production authority', async () => {
    const prod = new AppAttestVerifier([new Uint8Array([1])], APP_ID, 'production')
    const r = await prod.verify(challenge, iosAttestation())
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/never accepted in production/)
  })

  it('rejects a vote key that is not the challenge deviceKey', async () => {
    const r = await verifier().verify(challenge, iosAttestation({ secureEnclavePublicKey: 'some-other-key' }))
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/secureEnclavePublicKey/)
  })

  it('recomputes boundDigest and rejects a submitted mismatch', async () => {
    const r = await verifier().verify(challenge, iosAttestation({ boundDigest: 'not-the-digest' }))
    expect(r.ok).to.equal(false)
    expect(r.reason).to.match(/anti-relay binding failed/)
  })

  it('never throws on adversarial input — always a structured reason', async () => {
    const junk = { publicKey: 'k', deviceId: 'd', attestationTime: 0, certificateChain: [], platformDetails: { type: 'iOS' } } as unknown as DeviceAttestation
    const r = await verifier().verify(challenge, junk)
    expect(r.ok).to.equal(false)
    expect(r.reason).to.be.a('string')
  })
})
