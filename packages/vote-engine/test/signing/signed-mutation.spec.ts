import { expect } from 'chai'
import type { Signature } from '@votetorrent/vote-core'
import { digest as pluginDigest, sign as pluginSign } from '@optimystic/quereus-plugin-crypto'
import { seedSignedMutation } from '../../src/signing/signed-mutation.js'
import { peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { toCanonicalDatetime } from '../../src/utils.js'
import { verifySig } from '../../src/database/initialize.js'
import { randomTestKeyPair } from '../fixtures/keys.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeElectionInit,
  makeTestSignature,
  seedElectionSigning,
} from '../fixtures/test-context.js'

// The Election digest expression, byte-for-byte the same shape
// seedElectionSigning / Election.InsertValid use — reused here so the spec
// proves seedSignedMutation's generalization is faithful without depending
// on the (wave-3) registration tables.
const ELECTION_DIGEST_EXPR =
  'select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d'

describe('verifySig', () => {
  // D-14 unit triad — the shared verification primitive extracted in
  // 999.1-06, backing both the SQL `SignatureValid` UDF and future TS call
  // sites (plans 07/08/09). Uses the plugin's OWN `digest`/`sign` helpers so
  // the fixtures exercise the exact base64url-digest/hex-sig/hex-key
  // encoding convention `verifySig` expects (Pitfall 6) — no hand-fabricated
  // signatures.
  it('returns true for a genuinely-signed base64url digest (valid case)', () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digestB64url = pluginDigest(['verifySig-fixture', 1, true], 'sha256', 'base64url') as string
    const sigHex = pluginSign(digestB64url, privateHex, 'secp256k1', 'base64url', 'hex', 'hex') as string

    expect(verifySig(digestB64url, sigHex, publicHex)).to.equal(true)
  })

  it('returns false when the same digest is checked against a wrong/other signature (invalid case)', () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const other = randomTestKeyPair()
    const digestB64url = pluginDigest(['verifySig-fixture', 2, true], 'sha256', 'base64url') as string
    // Sign with a DIFFERENT private key — the resulting signature does not
    // verify against `publicHex` (the "wrong signature" case).
    const wrongSigHex = pluginSign(digestB64url, other.privateHex, 'secp256k1', 'base64url', 'hex', 'hex') as string

    expect(verifySig(digestB64url, wrongSigHex, publicHex)).to.equal(false)
    // Sanity: the genuinely-matching signature for THIS digest still verifies true.
    const rightSigHex = pluginSign(digestB64url, privateHex, 'secp256k1', 'base64url', 'hex', 'hex') as string
    expect(verifySig(digestB64url, rightSigHex, publicHex)).to.equal(true)
  })

  it('returns false when the digest is byte-tampered after signing, with the otherwise-valid signature (tampered case)', () => {
    const { privateHex, publicHex } = randomTestKeyPair()
    const digestB64url = pluginDigest(['verifySig-fixture', 3, true], 'sha256', 'base64url') as string
    const sigHex = pluginSign(digestB64url, privateHex, 'secp256k1', 'base64url', 'hex', 'hex') as string
    // A different digest (distinct field tuple) stands in for a tampered
    // digest — the same signature, computed over the original digest, must
    // not verify against this one.
    const tamperedDigestB64url = pluginDigest(['verifySig-fixture', 4, true], 'sha256', 'base64url') as string

    expect(verifySig(tamperedDigestB64url, sigHex, publicHex)).to.equal(false)
  })

  it('returns false (never throws) for falsy digest/signature/key inputs', () => {
    const { publicHex } = randomTestKeyPair()
    expect(verifySig(null, 'aa', publicHex)).to.equal(false)
    expect(verifySig('', 'aa', publicHex)).to.equal(false)
    expect(verifySig('digest', null, publicHex)).to.equal(false)
    expect(verifySig('digest', 'aa', null)).to.equal(false)
    expect(verifySig(null, null, null)).to.equal(false)
  })
})

describe('signed-mutation', () => {
  it('produces a Digest byte-identical to seedElectionSigning for the same inputs (generalization fidelity)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const e = init.election
    const tid = await peekNextElectionTid(auth.ctx.db)

    const digestParams = {
      tid,
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: toCanonicalDatetime(e.date),
      revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
      ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
      type: e.type,
    }

    // Reference path — the existing seedElectionSigning fixture.
    const { nonce: refNonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)

    // Generalized helper path — same inputs, same scope.
    let receivedDigest: Uint8Array | undefined
    const sign = async (digest: Uint8Array): Promise<Signature> => {
      receivedDigest = digest
      return makeTestSignature(auth.user)
    }
    const helperNonce = await seedSignedMutation(
      auth.ctx,
      auth.authority.id,
      'mel',
      tid,
      ELECTION_DIGEST_EXPR,
      digestParams,
      sign
    )

    expect(helperNonce).to.be.a('string').and.not.equal(refNonce)
    expect(receivedDigest).to.be.instanceOf(Uint8Array)

    const refRow = await auth.ctx.db
      .prepare('select Scope, Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce: refNonce })
    const helperRow = await auth.ctx.db
      .prepare('select Scope, Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce: helperNonce })

    expect(helperRow).to.exist
    expect(helperRow?.Scope).to.equal('mel')
    expect(helperRow?.Digest).to.equal(refRow?.Digest)

    const sigRow = await auth.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce: helperNonce })
    expect(Number(sigRow?.n)).to.equal(1)
  })

  it('throws a descriptive error when CurrentAdmin is missing for the authority', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const tid = await peekNextElectionTid(auth.ctx.db)

    let threw = false
    try {
      await seedSignedMutation(
        auth.ctx,
        'nonexistent-authority-id',
        'mel',
        tid,
        'select Digest(:tid, :x) as d',
        { tid, x: 'y' },
        async () => makeTestSignature(auth.user)
      )
    } catch (err) {
      threw = true
      expect((err as Error).message).to.match(/CurrentAdmin/)
    }
    expect(threw).to.equal(true)
  })
})
