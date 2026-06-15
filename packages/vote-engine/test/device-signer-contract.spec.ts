/**
 * device-signer-contract.spec.ts
 *
 * Wave-0 contract spec for:
 *   - callback round-trip: seedElectionSigning(fields, sign) produces a real
 *     AdminSignature row whose signature verifies under SignatureValid.
 *   - exact-bytes / no-privkey-param: the engine computes the Digest, hands
 *     digestBytes to the callback; the adapted method carries NO privKeyHex param.
 *   - prehash contract: a callback that signs with { prehash:false } produces a
 *     signature that FAILS the schema gate (no AdminSignature row — WR-10 guard).
 *
 * The spec compiles against the ADAPTED seedElectionSigning callback signature
 * introduced in Task 2. It is the RED phase that drives the adapter refactor.
 *
 * Invariants verified:
 *   D-01 — private key stays app-side (no privKeyHex param on the engine method).
 *   D-03 — engine computes the canonical digest; callback receives those exact bytes.
 *   WR-10 — @noble/curves v2 prehash:true is the ONLY accepted signing domain.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { createTestNetwork, addTestAuthority, makeElectionInit } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { Signature } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Inline callback type (mirrors the shape Task 2 introduces on the engine method;
// vote-engine cannot import the app-layer SignCallback, so the type is inline here)
// ---------------------------------------------------------------------------
type SignCallback = (digest: Uint8Array) => Promise<Signature>

/**
 * Build a SignCallback that signs with @noble/curves v2 defaults (prehash:true —
 * signed domain = sha256(digestBytes)). Used for the round-trip + exact-bytes tests.
 */
function makePrehashCallback (privateHex: string, userId: string, signerKey: string): SignCallback {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return {
      signerUserId: userId,
      signerKey,
      signature: bytesToHex(sig),
    }
  }
}

describe('device-signer contract', () => {

  // -------------------------------------------------------------------------
  // Test 1 — round-trip: callback-based seedElectionSigning produces a real
  //           AdminSignature row (threshold=1 auto-completes). Proves D-03:
  //           the engine computes the digest and the resulting Signature passes
  //           OfficerSignature.SignatureValid so an AdminSignature row is created.
  // -------------------------------------------------------------------------
  it('Test 1 — round-trip: seedElectionSigning(fields, sign) creates AdminSignature row (signature verifies under SignatureValid)', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()

    // Wire the public key into the network user so SignerKey / IsSignerKeyValid passes.
    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: UserKeyType.mobile,
            expiration: Date.now() + 86_400_000,
          },
        ],
      },
    })
    const auth = await addTestAuthority(net)

    // Build a sign callback that signs with the private key but NEVER exposes it.
    const sign = makePrehashCallback(privateHex, auth.user.id, auth.user.activeKeys[0]!.key)

    const electionsEngine = new ElectionsEngine(auth.ctx)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const { election: e } = init

    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }

    // Call the ADAPTED seedElectionSigning — callback form (no privKeyHex param).
    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

    // createElection must succeed (InsertValid passes when the Digest matches).
    await electionsEngine.createElection(init, { signingNonce })

    // Assert that an AdminSignature row was created — threshold=1 auto-completed.
    const adminSigRow = (await auth.ctx.db
      .prepare('select count(*) as n from AdminSignature where Nonce = :nonce')
      .get({ nonce: signingNonce })) as { n: number } | null
    expect(
      adminSigRow?.n,
      'AdminSignature row count for the signing nonce (threshold=1 must auto-complete)'
    ).to.be.gte(1)
  })

  // -------------------------------------------------------------------------
  // Test 2 — exact-bytes / no-privkey-param: verify the callback receives the
  //           SQL Digest() bytes (D-03) and the adapted method carries no
  //           privKeyHex/signerUserId/signerKey params (D-01).
  // -------------------------------------------------------------------------
  it('Test 2 — exact-bytes / no-privkey-param: callback receives SQL Digest bytes; seedElectionSigning has no privKeyHex param', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()

    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: UserKeyType.mobile,
            expiration: Date.now() + 86_400_000,
          },
        ],
      },
    })
    const auth = await addTestAuthority(net)

    // Capture the digest bytes handed to the callback — proves D-03 (the engine
    // computes the canonical Digest; the callback receives exactly those bytes).
    let capturedDigestBytes: Uint8Array | undefined
    const sign: SignCallback = async (digest: Uint8Array): Promise<Signature> => {
      capturedDigestBytes = digest
      const privBytes = hexToBytes(privateHex)
      const sig = secp256k1.sign(digest, privBytes)
      return {
        signerUserId: auth.user.id,
        signerKey: auth.user.activeKeys[0]!.key,
        signature: bytesToHex(sig),
      }
    }

    const electionsEngine = new ElectionsEngine(auth.ctx)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const { election: e } = init

    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }

    // Peek the tid BEFORE calling seedElectionSigning — the engine peeks the same value.
    const tid = peekNextElectionTid()

    const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)

    // Assert the callback was invoked with a non-empty Uint8Array.
    expect(capturedDigestBytes, 'callback must be called with digest bytes').to.not.be.undefined
    expect(capturedDigestBytes!.length, 'digest bytes must be non-empty (SHA-256 = 32 bytes)').to.be.gte(1)

    // Recompute the SQL Digest independently to verify the bytes match (D-03).
    const { toCanonicalDatetime } = await import('../src/utils.js')
    const digestRow = (await auth.ctx.db
      .prepare(
        'select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d'
      )
      .get({
        tid,
        id: e.id,
        authorityId: e.authorityId,
        title: e.title,
        date: toCanonicalDatetime(e.date),
        revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
        ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
        type: e.type,
      })) as { d: unknown } | null

    // Normalise the DB Digest to a hex string for comparison.
    function normalise (v: unknown): string {
      if (v instanceof Uint8Array) return Buffer.from(v).toString('hex')
      if (typeof v === 'string' && v.length === 64 && /^[0-9a-fA-F]+$/.test(v)) return v
      if (typeof v === 'string' && v.length === 43) {
        // base64url — decode to hex
        const b64 = v.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=')
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        return Buffer.from(bytes).toString('hex')
      }
      return String(v)
    }

    const dbDigestHex = normalise(digestRow?.d)
    const callbackDigestHex = Buffer.from(capturedDigestBytes!).toString('hex')

    expect(
      callbackDigestHex,
      'callback digest bytes must match the SQL Digest() recompute (D-03)'
    ).to.equal(dbDigestHex)

    // TypeScript-level D-01 assertion: call seedElectionSigning with only 2 args
    // (electionFields, sign). If the adapted signature still had privKeyHex/signerUserId/signerKey
    // as required params, this call would fail to compile (TS2554 / TS2345).
    // The fact that this file compiles with only 2 args proves no privKeyHex param exists.
    await electionsEngine.createElection(init, { signingNonce })
  })

  // -------------------------------------------------------------------------
  // Test 3 — prehash contract: a callback that signs with { prehash:false }
  //           produces a signature over the raw bytes (NOT sha256(bytes)),
  //           which FAILS OfficerSignature.SignatureValid under @noble/curves v2
  //           default (prehash:true verifier). Result: no AdminSignature row.
  //           Guards WR-10: the signed domain MUST be sha256(digest).
  // -------------------------------------------------------------------------
  it('Test 3 — prehash:false rejection: a { prehash:false } signature fails the schema gate (no AdminSignature created)', async () => {
    const { privateHex, publicHex } = randomTestKeyPair()

    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: publicHex,
            type: UserKeyType.mobile,
            expiration: Date.now() + 86_400_000,
          },
        ],
      },
    })
    const auth = await addTestAuthority(net)

    // A callback that signs with prehash:false — the signed domain is the raw bytes,
    // not sha256(bytes). This mismatches the noble v2 verifier (prehash:true) in
    // OfficerSignature.SignatureValid, so the INSERT should be rejected (IsSignatureValid=false
    // context gate would fail if the schema re-validates, or SigningEngine.sign will produce
    // an OfficerSignature that IsSignatureValid rejects, preventing AdminSignature creation).
    const signBadPrehash: SignCallback = async (digest: Uint8Array): Promise<Signature> => {
      const privBytes = hexToBytes(privateHex)
      // @noble/curves v2 requires explicit { prehash: false } to bypass sha256 wrapping.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = (secp256k1 as any).sign(digest, privBytes, { prehash: false })
      return {
        signerUserId: auth.user.id,
        signerKey: auth.user.activeKeys[0]!.key,
        signature: bytesToHex(sig),
      }
    }

    const electionsEngine = new ElectionsEngine(auth.ctx)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    const { election: e } = init

    const electionFields = {
      id: e.id,
      authorityId: e.authorityId,
      title: e.title,
      date: e.date,
      revisionDeadline: e.revisionDeadline,
      ballotDeadline: e.ballotDeadline,
      type: e.type,
    }

    // The { prehash:false } signature will fail the schema's SignatureValid gate
    // when SigningEngine.sign() tries to create an OfficerSignature. The insert
    // should either throw (CHECK constraint) or silently produce no AdminSignature
    // because SignatureValid = false prevents the OfficerSignature/AdminSignature chain.
    let threw = false
    try {
      await electionsEngine.seedElectionSigning(electionFields, signBadPrehash)
    } catch (e) {
      threw = true
    }

    // Whether it threw or not, no AdminSignature row should exist for this test's
    // authority (the prehash:false signature is cryptographically invalid under v2 defaults).
    const adminSigCount = (await auth.ctx.db
      .prepare('select count(*) as n from AdminSignature')
      .get()) as { n: number } | null

    // Either (a) the engine threw (rejected the insert) OR (b) the AdminSignature
    // count is 0 (insert silently rejected by the schema gate).
    if (!threw) {
      expect(
        adminSigCount?.n,
        'prehash:false signature must NOT produce an AdminSignature row (WR-10 gate)'
      ).to.equal(0)
    }
    // If it threw, the gate is enforced — test passes.
  })
})
