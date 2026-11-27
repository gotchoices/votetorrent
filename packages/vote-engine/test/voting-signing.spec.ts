// Phase 63 plan 02 (D-26 / D-07): a mocha port of the spike-097 harness for
// src/voting/vote-signing.ts. node:crypto (OpenSSL) appears only in this test, as the independent
// Android signer, and never in src/voting/.

import { expect } from 'chai'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { verifySigP256 } from '../src/database/initialize.js'
import { digestToBytes } from '../src/utils.js'
import { createTestNetwork } from './fixtures/test-context.js'
import { checkVotingKey, p256KeyToCompressedHex } from '../src/voting/vote-signing.js'

interface SpecEntry {
  v: number
  electionId: string
  electionRevision: number
  registrantId: string
  privateCid: string
  publicCid: string | null
  deviceKey: string
  attestationCid: string | null
  ballots: Array<{ ballotId: string, templateDigest: string }>
}

// Spec-local mirror of the D-25 field order. The signing checks need only a real base64url
// Digest() output and its one-field tamper variants; the binding to the shipped voterEntryDigest is
// exercised where 63-11 signs the real entry.
function specVoterDigest (e: SpecEntry): string {
  return digestFields(
    ['VoterEntry', e.v, e.electionId, e.electionRevision, e.registrantId, e.privateCid, e.publicCid, e.deviceKey, e.attestationCid, JSON.stringify(e.ballots)] as never,
    resolveHasher('sha256'), resolveOutputEncoder('base64url')) as string
}

interface DeviceKey { priv: KeyObject, privRaw: Uint8Array, spkiBase64: string, compressedHex: string }
function makeDeviceKey (): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string }
  const privRaw = new Uint8Array(Buffer.from(jwk.d, 'base64url'))
  const spkiBase64 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64') // Android publicKeyBase64
  const compressedHex = bytesToHex(p256.getPublicKey(privRaw, true)) // iOS publicKeyCompressedHex
  return { priv: privateKey, privRaw, spkiBase64, compressedHex }
}

// KeyAttestationHelper.derToCompactLowS, ported
const N = p256.Point.CURVE().n
function derToCompact (der: Uint8Array, normalizeLowS: boolean): string {
  let o = 2
  const rLen = der[o + 1]!; const r = der.subarray(o + 2, o + 2 + rLen); o += 2 + rLen
  const sLen = der[o + 1]!; const s = der.subarray(o + 2, o + 2 + sLen)
  let sBig = BigInt('0x' + bytesToHex(s))
  if (normalizeLowS && sBig > N >> 1n) sBig = N - sBig
  const rBig = BigInt('0x' + bytesToHex(r))
  return rBig.toString(16).padStart(64, '0') + sBig.toString(16).padStart(64, '0')
}
function androidSign (k: DeviceKey, digestB64: string, normalizeLowS = true): string {
  const der = createSign('SHA256').update(digestToBytes(digestB64)).sign(k.priv)
  return derToCompact(new Uint8Array(der), normalizeLowS)
}
function iosSign (k: DeviceKey, digestB64: string): string {
  return bytesToHex(p256.sign(sha256(digestToBytes(digestB64)), k.privRaw, { prehash: false, lowS: true }))
}

function throwsMessage (fn: () => unknown): string | undefined {
  try { fn() } catch (e) { return (e as Error).message }
  return undefined
}

describe('voting/vote-signing — spike 097 port (D-26, D-07)', function () {
  let kA: DeviceKey
  let kB: DeviceKey
  let entry: SpecEntry
  let d: string
  let sigAndroid: string
  let sigIos: string
  let norm: string
  let net: Awaited<ReturnType<typeof createTestNetwork>>

  const sqlVerify = async (sig: string, key: string): Promise<boolean> => {
    const row = await net.ctx.db.prepare('select SignatureValidP256(:d, :s, :k) as ok').get({ d, s: sig, k: key }) as { ok?: unknown } | undefined
    return row?.ok === true || row?.ok === 1
  }

  before(async function () {
    this.timeout(30000)
    kA = makeDeviceKey()
    kB = makeDeviceKey()
    entry = {
      v: 1, electionId: 'election-097', electionRevision: 0, registrantId: 'registrant-097', privateCid: 'bafy-private-097',
      publicCid: null, deviceKey: p256KeyToCompressedHex(kA.spkiBase64), attestationCid: null,
      ballots: [{ ballotId: 'ballot-097', templateDigest: 'td-097' }]
    }
    d = specVoterDigest(entry)
    sigAndroid = androidSign(kA, d)
    sigIos = iosSign(kA, d)
    norm = p256KeyToCompressedHex(kA.spkiBase64)
    net = await createTestNetwork()
  })

  it('H0 digestFields matches the shipped probe vector', () => {
    const probe = digestFields(['probe-nonce-v1', 'probe-devicekey-v1'], resolveHasher('sha256'), resolveOutputEncoder('base64url'))
    expect(probe).to.equal('epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI')
  })

  it('S1a Android-shaped signature verifies (verifySigP256, compressed key)', () => {
    expect(verifySigP256(d, sigAndroid, kA.compressedHex)).to.equal(true)
  })

  it('S1b iOS-shaped signature verifies (verifySigP256, compressed key)', () => {
    expect(verifySigP256(d, sigIos, kA.compressedHex)).to.equal(true)
  })

  it('S1c SQL SignatureValidP256 on a real engine db agrees (compressed key)', async () => {
    expect(await sqlVerify(sigAndroid, kA.compressedHex)).to.equal(true)
    expect(await sqlVerify(sigIos, kA.compressedHex)).to.equal(true)
  })

  it('S2a verifySigP256 REJECTS a valid signature when the key is Android SPKI base64', () => {
    expect(kA.spkiBase64.length).to.equal(124)
    expect(verifySigP256(d, sigAndroid, kA.spkiBase64)).to.equal(false)
  })

  it('S2b SQL SignatureValidP256 also rejects the SPKI form', async () => {
    expect(await sqlVerify(sigAndroid, kA.spkiBase64)).to.equal(false)
  })

  it('S3a SPKI base64 normalizes to the compressed form', () => {
    expect(p256KeyToCompressedHex(kA.spkiBase64)).to.equal(kA.compressedHex)
  })

  it('S3b the shipped verifier accepts the signature with the normalized key', () => {
    expect(verifySigP256(d, sigAndroid, norm)).to.equal(true)
  })

  it('S3c compressed and uncompressed hex normalize to the same key', () => {
    expect(p256KeyToCompressedHex(kA.compressedHex)).to.equal(norm)
    expect(p256KeyToCompressedHex(bytesToHex(p256.getPublicKey(kA.privRaw, false)))).to.equal(norm)
  })

  it('S3d garbage, truncated SPKI and an off-curve point are refused, not coerced', () => {
    for (const bad of ['not-a-key', kA.spkiBase64.slice(0, 60), '02' + 'ff'.repeat(32)]) {
      expect(() => p256KeyToCompressedHex(bad), bad).to.throw()
    }
  })

  it('S4a tampered registrantId is rejected', () => {
    expect(verifySigP256(specVoterDigest({ ...entry, registrantId: 'registrant-x' }), sigAndroid, norm)).to.equal(false)
  })

  it('S4b tampered ballot template is rejected', () => {
    expect(verifySigP256(specVoterDigest({ ...entry, ballots: [{ ballotId: 'ballot-097', templateDigest: 'td-x' }] }), sigAndroid, norm)).to.equal(false)
  })

  it('S4c the other device\'s key is rejected', () => {
    expect(verifySigP256(d, sigAndroid, kB.compressedHex)).to.equal(false)
  })

  it('S4d an iOS signature WITHOUT the pre-hash is rejected', () => {
    const sig = bytesToHex(p256.sign(digestToBytes(d), kA.privRaw, { prehash: false, lowS: true }))
    expect(verifySigP256(d, sig, norm)).to.equal(false)
  })

  it('S4e high-S signatures (no derToCompactLowS) are rejected, the low-S normalization is load-bearing', () => {
    let highS = 0
    let highSRejected = 0
    for (let i = 0; i < 200; i++) {
      const raw = androidSign(kA, d, false)
      if (BigInt('0x' + raw.slice(64)) > N >> 1n) {
        highS++
        if (!verifySigP256(d, raw, norm)) highSRejected++
      }
    }
    expect(highS, `${highS}/200 raw signatures were high-S, ${highSRejected} rejected`).to.be.greaterThan(0)
    expect(highSRejected, `${highS}/200 raw signatures were high-S, ${highSRejected} rejected`).to.equal(highS)
    // eslint-disable-next-line no-console
    console.log(`      S4e high-S count: ${highS}/200, rejected ${highSRejected}`)
  })

  it('S5a same key in different encodings is ok (a raw string compare would say rotated)', () => {
    const r = checkVotingKey(kA.compressedHex, kA.spkiBase64)
    expect(r.ok).to.equal(true)
    expect(kA.compressedHex).to.not.equal(kA.spkiBase64)
  })

  it('S5b Android D-13 rotation (alias now holds a new key) gives device-key-rotated', () => {
    const r = checkVotingKey(kB.spkiBase64, kA.spkiBase64)
    expect(r.ok).to.equal(false)
    if (!r.ok) expect(r.reason).to.equal('device-key-rotated')
  })

  it('S5c a vote signed by the rotated key fails under the recorded key', () => {
    expect(verifySigP256(d, androidSign(kB, d), norm)).to.equal(false)
  })

  it('S5d an unreadable current key gives unreadable-key, never ok', () => {
    const r = checkVotingKey('garbage', kA.spkiBase64)
    expect(r.ok).to.equal(false)
    if (!r.ok) expect(r.reason).to.equal('unreadable-key')
  })

  it('N1 global atob is the base64 path', () => {
    expect(typeof globalThis.atob).to.equal('function')
    expect(p256KeyToCompressedHex(kA.spkiBase64)).to.equal(kA.compressedHex)
  })

  it('N2 base64url-alphabet SPKI normalizes to the compressed form', () => {
    const url = kA.spkiBase64.replace(/\+/g, '-').replace(/\//g, '_')
    expect(p256KeyToCompressedHex(url)).to.equal(kA.compressedHex)
  })

  it('N3 uppercase hex normalizes to lowercase', () => {
    expect(p256KeyToCompressedHex(kA.compressedHex.toUpperCase())).to.equal(kA.compressedHex)
  })

  it('N4 SPKI, compressed and uncompressed forms of 50 fresh keys all agree', () => {
    for (let i = 0; i < 50; i++) {
      const k = makeDeviceKey()
      const a = p256KeyToCompressedHex(k.spkiBase64)
      const b = p256KeyToCompressedHex(k.compressedHex)
      const c = p256KeyToCompressedHex(bytesToHex(p256.getPublicKey(k.privRaw, false)))
      expect(a).to.match(/^0[23][0-9a-f]{64}$/)
      expect(b).to.equal(a)
      expect(c).to.equal(a)
    }
  })

  it('N5 the D-26 value: ok result carries the compressed key, which verifies the S1a signature', () => {
    const r = checkVotingKey(kA.spkiBase64, kA.compressedHex)
    expect(r.ok).to.equal(true)
    if (r.ok) {
      expect(r.compressedKey).to.equal(kA.compressedHex)
      expect(verifySigP256(d, sigAndroid, r.compressedKey)).to.equal(true)
    }
  })

  it('N6 an unreadable recorded key gives unreadable-key, never ok', () => {
    const r = checkVotingKey(kA.compressedHex, 'garbage')
    expect(r.ok).to.equal(false)
    if (!r.ok) expect(r.reason).to.equal('unreadable-key')
  })

  it('N7 rotation is detected when both sides are compressed hex', () => {
    const r = checkVotingKey(kB.compressedHex, kA.compressedHex)
    expect(r.ok).to.equal(false)
    if (!r.ok) expect(r.reason).to.equal('device-key-rotated')
  })

  it('N8 a non-P-256 (secp256k1) SPKI is refused', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
    const k1 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
    expect(() => p256KeyToCompressedHex(k1)).to.throw()
  })

  it('N9 thrown error text never echoes the refused input', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
    const k1 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64')
    for (const bad of ['not-a-key', kA.spkiBase64.slice(0, 60), '02' + 'ff'.repeat(32), k1]) {
      const msg = throwsMessage(() => p256KeyToCompressedHex(bad))
      expect(msg, `no throw for ${bad.length}-char input`).to.be.a('string')
      expect(msg!.includes(bad)).to.equal(false)
    }
  })
})
