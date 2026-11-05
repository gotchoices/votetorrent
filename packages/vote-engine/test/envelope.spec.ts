/**
 * envelope.spec.ts — Phase 62 Plan 04 (D-03, D-04, D-25)
 *
 * Proves the per-officer multi-recipient envelope in
 * `src/crypto/envelope.ts` against `doc/encryption-formats.md` section 2:
 * sealing, opening, the D-04 hard failures, fail-closed tampering/transplant
 * behavior, an independent `node:crypto` re-implementation (KAT-ENV-INDEP),
 * a FROZEN regression pin, and the normative open check order.
 *
 * `node:crypto` is used ONLY in this test file — never in `src/crypto/`.
 */

import { expect } from 'chai'
import { createCipheriv, createECDH, hkdfSync } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  ENCRYPTION_KEY_ALG,
  ENVELOPE_ALG,
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_MAX_RECIPIENTS,
  EnvelopeSealError,
  encryptionPublicKeyFromSecret,
  envelopeRecipientUserIds,
  generateEncryptionKeyPair,
  isValidEncryptionPublicKey,
  openEnvelope,
  sealToRecipients,
  sealToRecipientsWithRandomness,
  serializeEnvelope
} from '../src/crypto/envelope.js'
import type { EnvelopeRecipient, EnvelopeRecipientSecret, SealedEnvelope } from '../src/crypto/envelope.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const repeated = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte)
const sequence = (start: number, length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (start + i) & 0xff)

const CONTENT_KEY = repeated(0x40, 32)
const CONTENT_NONCE = sequence(0xa0, 12)
const SECRET_A = repeated(0x11, 32)
const SECRET_B = repeated(0x22, 32)
const PUB_A = bytesToHex(secp256k1.getPublicKey(SECRET_A, true))
const PUB_B = bytesToHex(secp256k1.getPublicKey(SECRET_B, true))
const EPH_A = repeated(0x31, 32)
const EPH_B = repeated(0x32, 32)
const WRAP_NONCE_A = sequence(0xb0, 12)
const WRAP_NONCE_B = sequence(0xc0, 12)
const REQUEST_ID = 'req-kat-1'
const DIGEST = 'digest-kat-1'
const KAT_PLAINTEXT = new TextEncoder().encode('{"kat":"vt-env-1"}')

const KAT_RECIPIENTS: readonly EnvelopeRecipient[] = [
  { userId: 'officer-a', publicKey: PUB_A },
  { userId: 'officer-b', publicKey: PUB_B }
]
const KAT_BINDING = { requestId: REQUEST_ID, digest: DIGEST }
const KAT_RANDOMNESS = {
  contentKey: CONTENT_KEY,
  contentNonce: CONTENT_NONCE,
  wraps: [
    { ephemeralSecretKey: EPH_A, nonce: WRAP_NONCE_A },
    { ephemeralSecretKey: EPH_B, nonce: WRAP_NONCE_B }
  ]
}

/** FROZEN REGRESSION PIN (repo-generated) — serializeEnvelope of the KAT-ENV-INDEP envelope. */
const FROZEN_ENV_JSON =
  '{"v":1,"alg":"vt-env-1","nonce":"oKGio6Slpqeoqaqr","kc":"dbPrAPqU2qkN0FJ1Uu-MOQTovtUMzqWu-acX5yKhcKQ","ct":"nNvFkZe4yb1e5G_Iiwnix1DrUz2k7Whp7rj3XAVmDVnJ5Q","recipients":[{"userId":"officer-a","pub":"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa","eph":"036930f46dd0b16d866d59d1054aa63298b357499cd1862ef16f3f55f1cafceb82","nonce":"sLGys7S1tre4ubq7","wrap":"ZRwVCgN6bg28y-dPWata8b4Jc55RRk4BQ5ZIjz_R1wzzoVhmCgJKfjSFoiHEtgv-"},{"userId":"officer-b","pub":"02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27","eph":"0290999dbbf43034bffb1dd53eac1eb4c33a4ea1c4f48ba585cfde3830840f0555","nonce":"wMHCw8TFxsfIycrL","wrap":"vduWmSiLAhpq047XVyAHId4k_Qjbj0ptmkTSfJxGWdaVH5dLXHOPSjv754fwkTpG"}]}'

const PII_CANARY = 'PII-CANARY-5f21'

function toBase64url (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function lengthPrefixed (fields: readonly string[]): Buffer {
  const parts: Buffer[] = []
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(bytes.length, 0)
    parts.push(len, bytes)
  }
  return Buffer.concat(parts)
}

/**
 * An INDEPENDENT (node:crypto / OpenSSL) re-implementation of
 * `doc/encryption-formats.md` section 2's sealing construction, built from
 * `createECDH`, `hkdfSync` and `createCipheriv('aes-256-gcm', ...)` only.
 * Used by KAT-ENV-INDEP to prove the noble-based implementation composes
 * the primitives correctly, not merely that each primitive is individually
 * correct (crypto-kat.spec.ts already covers that).
 */
function nodeSealToRecipients (
  plaintext: Uint8Array,
  recipients: readonly EnvelopeRecipient[],
  binding: { requestId: string, digest: string },
  randomness: typeof KAT_RANDOMNESS
): SealedEnvelope {
  const contentKdf = hkdfSync('sha256', Buffer.from(randomness.contentKey), Buffer.alloc(0), Buffer.from('vt-env-1/content'), 64)
  const contentKdfBuf = Buffer.from(contentKdf)
  const kEnc = contentKdfBuf.subarray(0, 32)
  const kc = contentKdfBuf.subarray(32, 64)
  const contentCipher = createCipheriv('aes-256-gcm', kEnc, Buffer.from(randomness.contentNonce))
  contentCipher.setAAD(lengthPrefixed(['vt-env-1/content', binding.requestId, binding.digest]))
  const ctBody = Buffer.concat([contentCipher.update(Buffer.from(plaintext)), contentCipher.final()])
  const ct = Buffer.concat([ctBody, contentCipher.getAuthTag()])

  const recipientEntries = recipients.map((recipient, i) => {
    const wrapRandomness = randomness.wraps[i]!
    const ecdh = createECDH('secp256k1')
    ecdh.setPrivateKey(Buffer.from(wrapRandomness.ephemeralSecretKey))
    const ephPub = Buffer.from(secp256k1.getPublicKey(wrapRandomness.ephemeralSecretKey, true))
    const recipientPubBytes = Buffer.from(recipient.publicKey, 'hex')
    const z = ecdh.computeSecret(recipientPubBytes)
    const salt = Buffer.concat([ephPub, recipientPubBytes])
    const kek = Buffer.from(hkdfSync('sha256', z, salt, Buffer.from('vt-env-1/wrap'), 32))
    const wrapCipher = createCipheriv('aes-256-gcm', kek, Buffer.from(wrapRandomness.nonce))
    wrapCipher.setAAD(
      lengthPrefixed(['vt-env-1/wrap', recipient.userId, recipient.publicKey, ephPub.toString('hex'), binding.requestId, binding.digest])
    )
    const wrapBody = Buffer.concat([wrapCipher.update(Buffer.from(randomness.contentKey)), wrapCipher.final()])
    const wrap = Buffer.concat([wrapBody, wrapCipher.getAuthTag()])

    return {
      userId: recipient.userId,
      pub: recipient.publicKey,
      eph: ephPub.toString('hex'),
      nonce: toBase64url(wrapRandomness.nonce),
      wrap: toBase64url(wrap)
    }
  })

  return {
    v: 1,
    alg: 'vt-env-1',
    nonce: toBase64url(randomness.contentNonce),
    kc: toBase64url(kc),
    ct: toBase64url(ct),
    recipients: recipientEntries
  }
}

describe('envelope (62-04, D-03/D-04)', () => {
  // -------------------------------------------------------------------------
  // KAT-ENV-INDEP and FROZEN-ENV
  // -------------------------------------------------------------------------
  describe('KAT-ENV-INDEP — independent node:crypto re-implementation, doc/encryption-formats.md section 2', () => {
    it('KAT-ENV-INDEP-a: sealToRecipientsWithRandomness equals a node:crypto-built envelope, member for member', () => {
      const ours = sealToRecipientsWithRandomness(KAT_PLAINTEXT, KAT_RECIPIENTS, KAT_BINDING, KAT_RANDOMNESS)
      const reference = nodeSealToRecipients(KAT_PLAINTEXT, KAT_RECIPIENTS, KAT_BINDING, KAT_RANDOMNESS)
      expect(ours.nonce, 'content nonce').to.equal(reference.nonce)
      expect(ours.kc, 'key commitment tag').to.equal(reference.kc)
      expect(ours.ct, 'content ciphertext').to.equal(reference.ct)
      expect(ours.recipients.length).to.equal(reference.recipients.length)
      for (let i = 0; i < ours.recipients.length; i++) {
        expect(ours.recipients[i]!.eph, `recipients[${i}].eph`).to.equal(reference.recipients[i]!.eph)
        expect(ours.recipients[i]!.nonce, `recipients[${i}].nonce`).to.equal(reference.recipients[i]!.nonce)
        expect(ours.recipients[i]!.wrap, `recipients[${i}].wrap`).to.equal(reference.recipients[i]!.wrap)
      }
    })

    it('KAT-ENV-INDEP-b: the node:crypto-built envelope opens with openEnvelope', () => {
      const reference = nodeSealToRecipients(KAT_PLAINTEXT, KAT_RECIPIENTS, KAT_BINDING, KAT_RANDOMNESS)
      const resultA = openEnvelope(reference, { userId: 'officer-a', secretKey: SECRET_A }, KAT_BINDING)
      expect(resultA.ok, 'officer-a must open the node:crypto-built envelope').to.equal(true)
      if (resultA.ok) expect(Buffer.from(resultA.plaintext).toString('utf8')).to.equal('{"kat":"vt-env-1"}')
      const resultB = openEnvelope(reference, { userId: 'officer-b', secretKey: SECRET_B }, KAT_BINDING)
      expect(resultB.ok, 'officer-b must open the node:crypto-built envelope').to.equal(true)
    })
  })

  describe('FROZEN-ENV — repo-generated regression and cross-runtime parity pin', () => {
    it('FROZEN-ENV: serializeEnvelope of the KAT envelope equals the pinned string', () => {
      const ours = sealToRecipientsWithRandomness(KAT_PLAINTEXT, KAT_RECIPIENTS, KAT_BINDING, KAT_RANDOMNESS)
      expect(serializeEnvelope(ours)).to.equal(FROZEN_ENV_JSON)
    })

    it('FROZEN-ENV: the pinned string opens for both officers', () => {
      const parsed = JSON.parse(FROZEN_ENV_JSON)
      const resultA = openEnvelope(parsed, { userId: 'officer-a', secretKey: SECRET_A }, KAT_BINDING)
      const resultB = openEnvelope(parsed, { userId: 'officer-b', secretKey: SECRET_B }, KAT_BINDING)
      expect(resultA.ok).to.equal(true)
      expect(resultB.ok).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // Round trip and D-04 multi-recipient behavior
  // -------------------------------------------------------------------------
  describe('round trip', () => {
    it('RT-1: seal to 3 recipients, each opens to the identical plaintext bytes', () => {
      const secrets = [repeated(0x51, 32), repeated(0x52, 32), repeated(0x53, 32)]
      const recipients: EnvelopeRecipient[] = secrets.map((sk, i) => ({
        userId: `officer-${i}`,
        publicKey: bytesToHex(secp256k1.getPublicKey(sk, true))
      }))
      const plaintext = new TextEncoder().encode('registration payload')
      const binding = { requestId: 'req-rt-1', digest: 'digest-rt-1' }
      const sealed = sealToRecipients(plaintext, recipients, binding)

      for (let i = 0; i < secrets.length; i++) {
        const result = openEnvelope(sealed, { userId: `officer-${i}`, secretKey: secrets[i]! }, binding)
        expect(result.ok, `officer-${i} must open`).to.equal(true)
        if (result.ok) expect(Buffer.from(result.plaintext).equals(Buffer.from(plaintext))).to.equal(true)
      }
    })

    it('RT-2: serializeEnvelope then JSON.parse then openEnvelope round-trips (the string, not just the object)', () => {
      const sk = repeated(0x61, 32)
      const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
      const binding = { requestId: 'req-rt-2', digest: 'digest-rt-2' }
      const sealed = sealToRecipients(new TextEncoder().encode('x'), recipients, binding)
      const serialized = serializeEnvelope(sealed)
      const result = openEnvelope(serialized, { userId: 'u1', secretKey: sk }, binding)
      expect(result.ok).to.equal(true)
    })
  })

  describe('D-04 — non-recipient and secretKey-mismatch', () => {
    const secretA = repeated(0x71, 32)
    const secretB = repeated(0x72, 32)
    const secretC = repeated(0x73, 32)
    const secretOutsider = repeated(0x74, 32)
    const recipients: EnvelopeRecipient[] = [
      { userId: 'a', publicKey: bytesToHex(secp256k1.getPublicKey(secretA, true)) },
      { userId: 'b', publicKey: bytesToHex(secp256k1.getPublicKey(secretB, true)) },
      { userId: 'c', publicKey: bytesToHex(secp256k1.getPublicKey(secretC, true)) }
    ]
    const binding = { requestId: 'req-d04', digest: 'digest-d04' }
    const sealed = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)

    it('a 4th keypair not in the list gets not-a-recipient', () => {
      const result = openEnvelope(sealed, { userId: 'outsider', secretKey: secretOutsider }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('not-a-recipient')
    })

    it('a recipient whose userId matches but whose secretKey differs gets not-a-recipient', () => {
      const result = openEnvelope(sealed, { userId: 'a', secretKey: secretB }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('not-a-recipient')
    })

    it('the real recipient still opens (paired positive control)', () => {
      const result = openEnvelope(sealed, { userId: 'b', secretKey: secretB }, binding)
      expect(result.ok).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // D-04 hard failures at seal time
  // -------------------------------------------------------------------------
  describe('D-04 — seal-time hard failures', () => {
    const binding = { requestId: 'req-seal', digest: 'digest-seal' }
    const plaintext = new TextEncoder().encode('p')
    const validKey = bytesToHex(secp256k1.getPublicKey(repeated(0x81, 32), true))

    it('zero recipients throws EnvelopeSealError code no-recipients', () => {
      expect(() => sealToRecipients(plaintext, [], binding)).to.throw(EnvelopeSealError)
      try {
        sealToRecipients(plaintext, [], binding)
        expect.fail('must throw')
      } catch (err) {
        expect(err).to.be.instanceOf(EnvelopeSealError)
        expect((err as EnvelopeSealError).code).to.equal('no-recipients')
      }
    })

    it('65 recipients throws too-many-recipients', () => {
      const recipients: EnvelopeRecipient[] = Array.from({ length: 65 }, (_, i) => ({
        userId: `u${i}`,
        publicKey: bytesToHex(secp256k1.getPublicKey(sequence(i + 1, 32), true))
      }))
      try {
        sealToRecipients(plaintext, recipients, binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('too-many-recipients')
      }
    })

    it(`${ENVELOPE_MAX_RECIPIENTS} recipients (the boundary) succeeds (paired positive control)`, () => {
      const recipients: EnvelopeRecipient[] = Array.from({ length: ENVELOPE_MAX_RECIPIENTS }, (_, i) => ({
        userId: `u${i}`,
        publicKey: bytesToHex(secp256k1.getPublicKey(sequence(i + 1, 32), true))
      }))
      expect(() => sealToRecipients(plaintext, recipients, binding)).to.not.throw()
    })

    it('a duplicate userId throws duplicate-recipient', () => {
      const recipients: EnvelopeRecipient[] = [
        { userId: 'dup', publicKey: validKey },
        { userId: 'dup', publicKey: bytesToHex(secp256k1.getPublicKey(repeated(0x82, 32), true)) }
      ]
      try {
        sealToRecipients(plaintext, recipients, binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('duplicate-recipient')
      }
    })

    it('two userIds may share one publicKey: the seal succeeds and each opens only through its own userId (initial/G1 WR-03)', () => {
      const secret = repeated(0x91, 32)
      const shared = bytesToHex(secp256k1.getPublicKey(secret, true))
      const recipients: EnvelopeRecipient[] = [
        { userId: 'a', publicKey: shared },
        { userId: 'b', publicKey: shared }
      ]
      const sealed = sealToRecipients(plaintext, recipients, binding)
      expect(openEnvelope(sealed, { userId: 'a', secretKey: secret }, binding).ok).to.equal(true)
      expect(openEnvelope(sealed, { userId: 'b', secretKey: secret }, binding).ok).to.equal(true)
      const z = openEnvelope(sealed, { userId: 'z', secretKey: secret }, binding)
      expect(z.ok).to.equal(false)
    })

    it('a repeated userId still throws even when the publicKeys differ or match', () => {
      for (const second of [validKey, bytesToHex(secp256k1.getPublicKey(repeated(0x83, 32), true))]) {
        try {
          sealToRecipients(plaintext, [{ userId: 'u1', publicKey: validKey }, { userId: 'u1', publicKey: second }], binding)
          expect.fail('must throw')
        } catch (err) {
          expect((err as EnvelopeSealError).code).to.equal('duplicate-recipient')
        }
      }
    })

    it('an off-curve publicKey throws invalid-recipient-key', () => {
      const offCurve = '02' + '00'.repeat(32)
      try {
        sealToRecipients(plaintext, [{ userId: 'u1', publicKey: offCurve }], binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-recipient-key')
      }
    })

    it('an uppercase publicKey throws invalid-recipient-key', () => {
      try {
        sealToRecipients(plaintext, [{ userId: 'u1', publicKey: validKey.toUpperCase() }], binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-recipient-key')
      }
    })

    it('a 64-char (uncompressed-length-mismatched) publicKey throws invalid-recipient-key', () => {
      try {
        sealToRecipients(plaintext, [{ userId: 'u1', publicKey: validKey.slice(2) }], binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-recipient-key')
      }
    })

    it('an empty requestId throws invalid-binding', () => {
      try {
        sealToRecipients(plaintext, [{ userId: 'u1', publicKey: validKey }], { requestId: '', digest: 'd' })
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-binding')
      }
    })

    it('an empty digest throws invalid-binding', () => {
      try {
        sealToRecipients(plaintext, [{ userId: 'u1', publicKey: validKey }], { requestId: 'r', digest: '' })
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-binding')
      }
    })

    it('a non-Uint8Array plaintext throws invalid-plaintext', () => {
      try {
        sealToRecipients('not-bytes' as unknown as Uint8Array, [{ userId: 'u1', publicKey: validKey }], binding)
        expect.fail('must throw')
      } catch (err) {
        expect((err as EnvelopeSealError).code).to.equal('invalid-plaintext')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Transplant (wrong binding)
  // -------------------------------------------------------------------------
  describe('transplant — binding mismatch', () => {
    const sk = repeated(0x91, 32)
    const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
    const binding = { requestId: 'req-transplant', digest: 'digest-transplant' }
    const sealed = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)

    it('opening with requestId changed gives authentication-failed', () => {
      const result = openEnvelope(sealed, { userId: 'u1', secretKey: sk }, { ...binding, requestId: 'other-request' })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('opening with digest changed gives authentication-failed', () => {
      const result = openEnvelope(sealed, { userId: 'u1', secretKey: sk }, { ...binding, digest: 'other-digest' })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('the correct binding still opens (paired positive control)', () => {
      const result = openEnvelope(sealed, { userId: 'u1', secretKey: sk }, binding)
      expect(result.ok).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // Content-AAD binding, isolated from wrap-AAD binding (62-04 Task 3 / M1)
  //
  // The high-level transplant tests above cannot by themselves prove the
  // CONTENT layer's AAD is load-bearing: the WRAP layer independently binds
  // the SAME requestId/digest, so a naive "reseal under binding A, open
  // under binding B" transplant already fails at the wrap-unwrap step
  // before the content layer is ever reached — a content-AAD mutation would
  // stay invisible to that style of test. This block isolates the content
  // layer by reusing the SAME content key/nonce (a TEST-ONLY adversarial
  // construction via the deep-path deterministic seal — never valid in
  // production) across two envelopes sealed to two DIFFERENT bindings with
  // two DIFFERENT plaintexts, then splices the second envelope's `ct` onto
  // the first envelope's otherwise-untouched (correctly wrap-bound) wire
  // shape.
  // -------------------------------------------------------------------------
  describe('content-AAD binding (isolated from wrap-AAD binding)', () => {
    it('a ct spliced from a SAME-content-key envelope sealed under a DIFFERENT binding/plaintext is rejected, not silently substituted', () => {
      const sk = repeated(0xa9, 32)
      const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
      const bindingReal = { requestId: 'req-isolate-real', digest: 'digest-isolate-real' }
      const bindingOther = { requestId: 'req-isolate-other', digest: 'digest-isolate-other' }
      const sharedRandomness = {
        contentKey: repeated(0xb9, 32),
        contentNonce: sequence(0xe0, 12),
        wraps: [{ ephemeralSecretKey: repeated(0xc9, 32), nonce: sequence(0xf0, 12) }]
      }
      const realPlaintext = new TextEncoder().encode('REAL payload for the real request')
      const otherPlaintext = new TextEncoder().encode('OTHER payload for an unrelated request')

      const sealedReal = sealToRecipientsWithRandomness(realPlaintext, recipients, bindingReal, sharedRandomness)
      const sealedOther = sealToRecipientsWithRandomness(otherPlaintext, recipients, bindingOther, sharedRandomness)

      // sealedReal's wrap entries are untouched and correctly bound to
      // bindingReal; only the content ciphertext is substituted.
      const spliced: SealedEnvelope = { ...sealedReal, ct: sealedOther.ct }

      const result = openEnvelope(spliced, { userId: 'u1', secretKey: sk }, bindingReal)
      expect(result.ok, 'content AAD must reject a ct encrypted under a different binding, even with a correctly-unwrapped CK').to.equal(false)
      if (!result.ok) {
        expect(result.reason).to.equal('authentication-failed')
        expect(result.detail).to.not.contain('REAL payload')
        expect(result.detail).to.not.contain('OTHER payload')
      }
    })

    it('the unspliced envelope still opens to its own plaintext (paired positive control)', () => {
      const sk = repeated(0xa9, 32)
      const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
      const bindingReal = { requestId: 'req-isolate-real', digest: 'digest-isolate-real' }
      const sharedRandomness = {
        contentKey: repeated(0xb9, 32),
        contentNonce: sequence(0xe0, 12),
        wraps: [{ ephemeralSecretKey: repeated(0xc9, 32), nonce: sequence(0xf0, 12) }]
      }
      const realPlaintext = new TextEncoder().encode('REAL payload for the real request')
      const sealedReal = sealToRecipientsWithRandomness(realPlaintext, recipients, bindingReal, sharedRandomness)
      const result = openEnvelope(sealedReal, { userId: 'u1', secretKey: sk }, bindingReal)
      expect(result.ok).to.equal(true)
      if (result.ok) expect(Buffer.from(result.plaintext).toString('utf8')).to.equal('REAL payload for the real request')
    })
  })

  // -------------------------------------------------------------------------
  // Key commitment and tampering
  // -------------------------------------------------------------------------
  describe('key commitment and tampering', () => {
    const sk = repeated(0xa1, 32)
    const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
    const binding = { requestId: 'req-tamper', digest: 'digest-tamper' }
    const sealed = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)
    const recipient: EnvelopeRecipientSecret = { userId: 'u1', secretKey: sk }

    function flip (b64u: string): string {
      const bytes = Buffer.from(b64u, 'base64url')
      bytes[0] = bytes[0]! ^ 0x01
      return bytes.toString('base64url')
    }

    it('replacing kc with another valid 32-byte base64url gives authentication-failed', () => {
      const otherKc = Buffer.alloc(32, 0x55).toString('base64url')
      const tampered = { ...sealed, kc: otherKc }
      const result = openEnvelope(tampered, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in ct gives authentication-failed', () => {
      const tampered = { ...sealed, ct: flip(sealed.ct) }
      const result = openEnvelope(tampered, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it("a flipped bit in a recipient's wrap gives authentication-failed", () => {
      const tampered = {
        ...sealed,
        recipients: [{ ...sealed.recipients[0]!, wrap: flip(sealed.recipients[0]!.wrap) }]
      }
      const result = openEnvelope(tampered, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a flipped bit in nonce gives authentication-failed', () => {
      const tampered = { ...sealed, nonce: flip(sealed.nonce) }
      const result = openEnvelope(tampered, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })
  })

  // -------------------------------------------------------------------------
  // Oracle-free
  // -------------------------------------------------------------------------
  describe('oracle-free failure collapse', () => {
    const sk = repeated(0xb1, 32)
    const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
    const binding = { requestId: 'req-oracle', digest: 'digest-oracle' }
    const plaintext = new TextEncoder().encode(`{"marker":"${PII_CANARY}"}`)
    const sealed = sealToRecipients(plaintext, recipients, binding)
    const recipient: EnvelopeRecipientSecret = { userId: 'u1', secretKey: sk }
    const ck = CONTENT_KEY

    function flip (b64u: string): string {
      const bytes = Buffer.from(b64u, 'base64url')
      bytes[0] = bytes[0]! ^ 0x01
      return bytes.toString('base64url')
    }

    it('wrong-binding, tampered-wrap, tampered-ct and tampered-kc all report exactly authentication-failed, and no detail leaks material', () => {
      const cases: Array<{ label: string, sealedOverride: SealedEnvelope, b: typeof binding }> = [
        { label: 'wrong-binding', sealedOverride: sealed, b: { ...binding, requestId: 'wrong' } },
        {
          label: 'tampered-wrap',
          sealedOverride: { ...sealed, recipients: [{ ...sealed.recipients[0]!, wrap: flip(sealed.recipients[0]!.wrap) }] },
          b: binding
        },
        { label: 'tampered-ct', sealedOverride: { ...sealed, ct: flip(sealed.ct) }, b: binding },
        { label: 'tampered-kc', sealedOverride: { ...sealed, kc: flip(sealed.kc) }, b: binding }
      ]
      for (const c of cases) {
        const result = openEnvelope(c.sealedOverride, recipient, c.b)
        expect(result.ok, c.label).to.equal(false)
        if (!result.ok) {
          expect(result.reason, c.label).to.equal('authentication-failed')
          expect(result.detail, `${c.label} detail must not leak the plaintext canary`).to.not.contain(PII_CANARY)
          expect(result.detail.toLowerCase(), `${c.label} detail must not leak CK as hex`).to.not.contain(Buffer.from(ck).toString('hex'))
        }
      }
    })
  })

  // -------------------------------------------------------------------------
  // Ordering (NC style)
  // -------------------------------------------------------------------------
  describe('ordering — version gate runs BEFORE decryption, malformed cases', () => {
    const sk = repeated(0xc1, 32)
    const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
    const binding = { requestId: 'req-nc', digest: 'digest-nc' }
    const sealed = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)
    const recipient: EnvelopeRecipientSecret = { userId: 'u1', secretKey: sk }

    it('v: 2 returns unsupported-version, not authentication-failed', () => {
      const result = openEnvelope({ ...sealed, v: 2 }, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.reason).to.equal('unsupported-version')
        expect(result.reason, 'the version gate must run before decryption').to.not.equal('authentication-failed')
      }
    })

    it("a recipient entry whose eph is off-curve returns malformed-envelope", () => {
      const offCurveEph = '02' + '00'.repeat(32)
      const tampered = { ...sealed, recipients: [{ ...sealed.recipients[0]!, eph: offCurveEph }] }
      const result = openEnvelope(tampered, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('a non-JSON string returns malformed-envelope', () => {
      const result = openEnvelope('not json {{{', recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('null returns malformed-envelope', () => {
      const result = openEnvelope(null, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('an array returns malformed-envelope', () => {
      const result = openEnvelope([1, 2, 3], recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('a missing member returns malformed-envelope', () => {
      const { ct, ...rest } = sealed
      const result = openEnvelope(rest, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('a recipients array longer than 64 returns malformed-envelope', () => {
      const tooMany = Array.from({ length: 65 }, (_, i) => ({ ...sealed.recipients[0]!, userId: `u${i}` }))
      const result = openEnvelope({ ...sealed, recipients: tooMany }, recipient, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('a zero-scalar secretKey returns invalid-argument', () => {
      const result = openEnvelope(sealed, { userId: 'u1', secretKey: new Uint8Array(32) }, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('invalid-argument')
    })

    it('the unmodified envelope still opens (paired positive control)', () => {
      const result = openEnvelope(sealed, recipient, binding)
      expect(result.ok).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // openEnvelope never throws
  // -------------------------------------------------------------------------
  describe('openEnvelope never throws — hostile inputs', () => {
    const sk = repeated(0xd1, 32)
    const recipient: EnvelopeRecipientSecret = { userId: 'u1', secretKey: sk }
    const binding = { requestId: 'req-hostile', digest: 'digest-hostile' }

    const hostileInputs: unknown[] = [
      0,
      1,
      -1,
      NaN,
      Infinity,
      true,
      false,
      undefined,
      { nested: { garbage: [1, { deep: 'x' }] } },
      '',
      '{}',
      Symbol('x') as unknown
    ]

    for (const [i, input] of hostileInputs.entries()) {
      it(`hostile input #${i} (${String(input)}) returns ok:false, never throws`, () => {
        let result: ReturnType<typeof openEnvelope> | undefined
        expect(() => { result = openEnvelope(input, recipient, binding) }).to.not.throw()
        expect(result?.ok).to.equal(false)
      })
    }
  })

  // -------------------------------------------------------------------------
  // envelopeRecipientUserIds
  // -------------------------------------------------------------------------
  describe('envelopeRecipientUserIds', () => {
    it('returns userIds in envelope order for a valid envelope', () => {
      const secrets = [repeated(0xe1, 32), repeated(0xe2, 32)]
      const recipients: EnvelopeRecipient[] = secrets.map((s, i) => ({
        userId: `u${i}`,
        publicKey: bytesToHex(secp256k1.getPublicKey(s, true))
      }))
      const sealed = sealToRecipients(new TextEncoder().encode('p'), recipients, { requestId: 'r', digest: 'd' })
      expect(envelopeRecipientUserIds(sealed)).to.deep.equal(['u0', 'u1'])
      expect(envelopeRecipientUserIds(serializeEnvelope(sealed))).to.deep.equal(['u0', 'u1'])
    })

    it('returns null for malformed input', () => {
      expect(envelopeRecipientUserIds(null)).to.equal(null)
      expect(envelopeRecipientUserIds('not json')).to.equal(null)
      expect(envelopeRecipientUserIds({})).to.equal(null)
    })
  })

  // -------------------------------------------------------------------------
  // Freshness
  // -------------------------------------------------------------------------
  describe('freshness', () => {
    it('two seals of the same plaintext to the same recipients differ in nonce, kc, ct and every eph', () => {
      const sk = repeated(0xf1, 32)
      const recipients: EnvelopeRecipient[] = [{ userId: 'u1', publicKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }]
      const binding = { requestId: 'req-fresh', digest: 'digest-fresh' }
      const a = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)
      const b = sealToRecipients(new TextEncoder().encode('p'), recipients, binding)
      expect(a.nonce).to.not.equal(b.nonce)
      expect(a.kc).to.not.equal(b.kc)
      expect(a.ct).to.not.equal(b.ct)
      expect(a.recipients[0]!.eph).to.not.equal(b.recipients[0]!.eph)
    })
  })

  // -------------------------------------------------------------------------
  // Keypairs
  // -------------------------------------------------------------------------
  describe('keypairs', () => {
    it('generateEncryptionKeyPair returns a 32-byte valid scalar and a matching 66-char 02/03 hex key', () => {
      const { secretKey, publicKey } = generateEncryptionKeyPair()
      expect(secretKey.length).to.equal(32)
      expect(secp256k1.utils.isValidSecretKey(secretKey)).to.equal(true)
      expect(publicKey).to.match(/^0[23][0-9a-f]{64}$/)
      expect(publicKey).to.equal(encryptionPublicKeyFromSecret(secretKey))
    })

    it('isValidEncryptionPublicKey rejects uppercase, 04-prefix uncompressed, wrong length and off-curve input', () => {
      const { publicKey } = generateEncryptionKeyPair()
      expect(isValidEncryptionPublicKey(publicKey), 'positive control').to.equal(true)
      expect(isValidEncryptionPublicKey(publicKey.toUpperCase())).to.equal(false)
      const uncompressed = '04' + '11'.repeat(64)
      expect(isValidEncryptionPublicKey(uncompressed)).to.equal(false)
      expect(isValidEncryptionPublicKey(publicKey.slice(0, -2))).to.equal(false)
      expect(isValidEncryptionPublicKey('02' + '00'.repeat(32))).to.equal(false)
    })

    it('encryptionPublicKeyFromSecret throws TypeError on an invalid scalar', () => {
      expect(() => encryptionPublicKeyFromSecret(new Uint8Array(32))).to.throw(TypeError)
      expect(() => encryptionPublicKeyFromSecret(new Uint8Array(31).fill(1))).to.throw(TypeError)
    })

    it('ENCRYPTION_KEY_ALG is the locked literal 62-14 writes into UserEncryptionKey.Alg', () => {
      expect(ENCRYPTION_KEY_ALG).to.equal('secp256k1-ecdh-hkdf-sha256-aes256gcm')
    })

    it('locked constants', () => {
      expect(ENVELOPE_FORMAT_VERSION).to.equal(1)
      expect(ENVELOPE_ALG).to.equal('vt-env-1')
      expect(ENVELOPE_MAX_RECIPIENTS).to.equal(64)
    })
  })
})
