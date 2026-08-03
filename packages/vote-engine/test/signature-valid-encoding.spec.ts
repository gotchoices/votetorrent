/**
 * signature-valid-encoding.spec.ts — WR-01 regression lock (Phase 29 gap closure)
 *
 * Phase 29 (SIGN-05) swapped the JS function backing the SQL `SignatureValid`
 * scalar from the plugin's old `SignatureValid` export to `verify`. In
 * @optimystic/quereus-plugin-crypto@0.14.1, `verify` defaults inputEncoding,
 * sigEncoding, AND keyEncoding all to 'base64url'. But VoteTorrent feeds a
 * base64url digest (the `Digest()` output) together with a HEX signature and a
 * HEX public key (see signing builders + test/fixtures/keys.ts). Without explicit
 * encodings, the SQL `SignatureValid()` would decode hex inputs as base64url and
 * silently return false for every real signature.
 *
 * This was dormant when discovered — the schema still gates on
 * `context.IsSignatureValid` (votetorrent.qsql:226 `-- TODO fix signature`) and
 * nothing exercised the scalar with real arguments. These tests exercise
 * `SignatureValid()` at the SQL level with a real base64url digest + hex
 * signature + hex public key so the encoding contract cannot silently rot once
 * real SQL-level validation is wired up.
 *
 * Reference: 29-REVIEW.md WR-01.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { sign as pluginSign } from '@optimystic/quereus-plugin-crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { prepareDb } from '../src/database/initialize.js'
import { randomTestKeyPair } from './fixtures/keys.js'

/** Produce the live canonical base64url Digest for a single string arg. */
async function liveDigest(db: Database, arg: string): Promise<string> {
  const row = (await db.prepare('select Digest(:a0) as d').get({ a0: arg })) as
    | { d: unknown }
    | undefined
  expect(row?.d, `Digest(${JSON.stringify(arg)}) must return a non-empty string`)
    .to.be.a('string')
    .and.have.length.greaterThan(0)
  return row!.d as string
}

/**
 * Sign a base64url digest, producing a HEX signature — mirrors production, where
 * signatures are hex-encoded (signing builders) over the base64url digest.
 */
function hexSignOverBase64urlDigest(digest: string, privateHex: string): string {
  return pluginSign(digest, privateHex, 'secp256k1', 'base64url', 'hex', 'hex')
}

describe('SignatureValid SQL function encoding (WR-01 regression)', () => {
  let db: Database

  before(async () => {
    db = new Database()
    await prepareDb(db)
  })

  it('WR-01: SignatureValid(base64url digest, hex signature, hex pubkey) === true for a valid signature', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digest = await liveDigest(db, 'hello')

    const signatureHex = hexSignOverBase64urlDigest(digest, privateHex)
    expect(signatureHex, 'plugin sign() must emit a hex signature').to.match(/^[0-9a-f]+$/)

    const row = (await db
      .prepare('select SignatureValid(:d, :s, :k) as v')
      .get({ d: digest, s: signatureHex, k: publicHex })) as { v: unknown }

    // Only passes when SignatureValid pins inputEncoding=base64url, sigEncoding=hex,
    // keyEncoding=hex. With the pre-fix base64url defaults this returns false.
    expect(row.v, 'valid hex signature over a base64url digest must verify true').to.equal(true)
  })

  it('WR-01: SignatureValid returns false for a tampered signature', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digest = await liveDigest(db, 'tamper-case')

    const signatureHex = hexSignOverBase64urlDigest(digest, privateHex)
    const tampered =
      signatureHex.slice(0, -1) + (signatureHex.slice(-1) === '0' ? '1' : '0')

    const row = (await db
      .prepare('select SignatureValid(:d, :s, :k) as v')
      .get({ d: digest, s: tampered, k: publicHex })) as { v: unknown }

    expect(row.v, 'a tampered signature must verify false').to.equal(false)
  })

  it('WR-01: SignatureValid returns false for a signature under a different key', async () => {
    const signer = randomTestKeyPair()
    const other = randomTestKeyPair()
    const digest = await liveDigest(db, 'wrong-key-case')

    const signatureHex = hexSignOverBase64urlDigest(digest, signer.privateHex)

    const row = (await db
      .prepare('select SignatureValid(:d, :s, :k) as v')
      .get({ d: digest, s: signatureHex, k: other.publicHex })) as { v: unknown }

    expect(row.v, "another key's public key must verify false").to.equal(false)
  })

  it('WR-01: SignatureValid returns false when any argument is empty (boot-guard short-circuit)', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digest = await liveDigest(db, 'guard-case')
    const signatureHex = hexSignOverBase64urlDigest(digest, privateHex)

    const empties = [
      { d: '', s: signatureHex, k: publicHex },
      { d: digest, s: '', k: publicHex },
      { d: digest, s: signatureHex, k: '' },
    ]
    for (const args of empties) {
      const row = (await db
        .prepare('select SignatureValid(:d, :s, :k) as v')
        .get(args)) as { v: unknown }
      expect(row.v, 'empty argument must short-circuit to false').to.equal(false)
    }
  })
})

// Document the encoding contract the fixtures rely on, so a future fixture change
// that drops hex keys is caught here rather than silently breaking SQL validation.
describe('SignatureValid encoding contract sanity', () => {
  it('test key pairs are hex-encoded (the encoding SignatureValid pins)', () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    expect(privateHex, 'private key fixture must be hex').to.match(/^[0-9a-f]{64}$/)
    expect(publicHex, 'public key fixture must be hex').to.match(/^[0-9a-f]{66}$/)
    // Round-trip the public key through noble to confirm it is a real compressed key.
    expect(bytesToHex(secp256k1.getPublicKey(hexToBytes(privateHex)))).to.equal(publicHex)
  })
})
