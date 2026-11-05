/**
 * noble-dedupe-regression.spec.ts
 *
 * SIGN-04 CI regression lock — @noble/curves dedupe (SC2) + v2 API / boot-guard invariant (SC1).
 *
 * Guards two invariants that are otherwise only checked by `yarn why` (CLI) and inline grep gates:
 *
 *   SC1 — secp256k1.sign and secp256k1.verify are real functions at the Node module level
 *          (i.e. the v2 API is actually bound, not a degenerate hex-string copy from a v1 split).
 *
 *   SC2 (v2 API byte-shape guard) — secp256k1.sign() with v2 defaults returns a Uint8Array of
 *          64 bytes.  On v1.x the return type is an object (ECDH signature shape), not raw bytes,
 *          so a future dep re-split that reintroduces @noble/curves@1.9.7 will fail this assertion
 *          even if the typeof check above is naively satisfied (WR-01: boot guard alone passes if
 *          v1 binds, so the byte-shape check is the real re-split guard).
 *
 * Known vector (spike013):
 *   privkey = 32 bytes of 0x01  (deterministic test key — not a real device key)
 *   digest  = 32 bytes of 0xab  (not canonical VoteTorrent data)
 *
 * WR-10: secp256k1.sign is called with NO options object (v2 defaults → prehash:true),
 *        matching the device-signer.ts:61 call exactly. NEVER pass { prehash: false }.
 *
 * Uses the same import paths as device-signer.ts and signing-proof.ts so that the import
 * under test is the same module instance that the app's signing path resolves.
 *
 * SC3 / SC4 (62-05) — same multi-copy hazard, now for `abstract/frost.js`. `src/crypto/dkg.ts`
 * imports `secp256k1_FROST` from this SAME `@noble/curves/secp256k1.js` path, so a future dep
 * re-split that reintroduces a second `@noble/curves` copy would silently bind the DKG wrapper
 * to the wrong FROST implementation. SC3 is the boot-guard (functions are callable); SC4 is a
 * byte-shape/known-answer guard (`combineSecret` over RFC 9591 Appendix E.5 P1+P3 reproduces the
 * published group_secret_key).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// Known secp256k1 test vector — identical to signing-proof.ts PROOF_PRIVKEY / PROOF_DIGEST
const PROOF_PRIVKEY = new Uint8Array(32).fill(0x01)
const PROOF_DIGEST  = new Uint8Array(32).fill(0xab)

describe('@noble/curves dedupe regression (SIGN-04)', () => {

  // ---------------------------------------------------------------------------
  // SC1 boot-guard invariant: secp256k1.sign and secp256k1.verify must be functions
  // at the Node module level.  If a v1.x copy is bound the module exports an object
  // whose .sign property is a hex string, not a callable — this assertion catches that.
  // ---------------------------------------------------------------------------
  it('SC1 boot-guard: secp256k1.sign and secp256k1.verify are functions (not hex strings or objects)', () => {
    expect(typeof secp256k1.sign, 'secp256k1.sign must be a function (SC1 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1.verify, 'secp256k1.verify must be a function (SC1 boot-guard invariant)').to.equal('function')
  })

  // ---------------------------------------------------------------------------
  // SC2 v2 API byte-shape guard: sign() with v2 defaults returns a Uint8Array of
  // exactly 64 bytes (compact r‖s encoding).  v1.x returns an object instead,
  // so this assertion is the real re-split guard (WR-01).
  //
  // No options object — WR-10: prehash:true is the v2 default and must not be overridden.
  // ---------------------------------------------------------------------------
  it('SC2 v2 API byte-shape: secp256k1.sign() returns a 64-byte Uint8Array (v2 compact bytes, not a v1 object)', () => {
    const sig = secp256k1.sign(PROOF_DIGEST, PROOF_PRIVKEY)  // v2 defaults — NO options object (WR-10)

    expect(sig, 'sign() return value must be a Uint8Array (v1 returns an object — real re-split guard)').to.be.instanceOf(Uint8Array)
    expect(sig.length, 'compact secp256k1 signature must be exactly 64 bytes (r‖s encoding)').to.equal(64)
  })

  // ---------------------------------------------------------------------------
  // Round-trip verify: sign the known spike013 vector and assert verify() === true.
  // Proves the bound instance is self-consistent (sign + getPublicKey + verify all
  // resolve to the same v2 copy).
  // ---------------------------------------------------------------------------
  it('known-vector round-trip: sign spike013 vector and verify() === true (single instance self-consistency)', () => {
    // Sign — v2 defaults, NO options object (WR-10)
    const sig = secp256k1.sign(PROOF_DIGEST, PROOF_PRIVKEY)

    // Derive the public key from the same instance
    const pubkey = secp256k1.getPublicKey(PROOF_PRIVKEY)

    // Verify — must return true for the known-vector round-trip to close
    const valid = secp256k1.verify(sig, PROOF_DIGEST, pubkey)
    expect(valid, '[spike013] secp256k1.verify() must return true for the known-vector round-trip').to.equal(true)
  })

  // ---------------------------------------------------------------------------
  // SC3 (62-05) boot-guard: the FROST DKG and combine entry points used by
  // src/crypto/dkg.ts must be real functions on the SAME @noble/curves/secp256k1.js
  // instance as SC1/SC2 above — otherwise a re-split binds dkg.ts to a different copy.
  // ---------------------------------------------------------------------------
  it('SC3 boot-guard: secp256k1_FROST DKG round1/round2/round3, validateSecret, combineSecret and Identifier.derive are functions', () => {
    expect(typeof secp256k1_FROST.DKG.round1, 'secp256k1_FROST.DKG.round1 must be a function (SC3 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1_FROST.DKG.round2, 'secp256k1_FROST.DKG.round2 must be a function (SC3 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1_FROST.DKG.round3, 'secp256k1_FROST.DKG.round3 must be a function (SC3 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1_FROST.validateSecret, 'secp256k1_FROST.validateSecret must be a function (SC3 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1_FROST.combineSecret, 'secp256k1_FROST.combineSecret must be a function (SC3 boot-guard invariant)').to.equal('function')
    expect(typeof secp256k1_FROST.Identifier.derive, 'secp256k1_FROST.Identifier.derive must be a function (SC3 boot-guard invariant)').to.equal('function')
  })

  // ---------------------------------------------------------------------------
  // SC4 (62-05) known-answer byte-shape guard: combineSecret over RFC 9591
  // Appendix E.5 P1 and P3 must reproduce the published group_secret_key as a
  // 32-byte Uint8Array. A v1.x-shaped or otherwise mis-split copy would not
  // expose this split-round DKG API at all, or would return a different shape.
  // ---------------------------------------------------------------------------
  it('SC4 known-answer byte-shape: combineSecret(P1, P3) returns a 32-byte Uint8Array equal to RFC 9591 E.5 group_secret_key', () => {
    const P1 = { identifier: secp256k1_FROST.Identifier.fromNumber(1), signingShare: hexToBytes('08f89ffe80ac94dcb920c26f3f46140bfc7f95b493f8310f5fc1ea2b01f4254c') }
    const P3 = { identifier: secp256k1_FROST.Identifier.fromNumber(3), signingShare: hexToBytes('00e95d59dd0d46b0e303e500b62b7ccb0e555d49f5b849f5e748c071da8c0dbc') }
    const combined = secp256k1_FROST.combineSecret([P1, P3], { min: 2, max: 3 })

    expect(combined, 'combineSecret must return a Uint8Array (SC4 byte-shape guard)').to.be.instanceOf(Uint8Array)
    expect(combined.length, 'combined secp256k1 FROST group secret must be exactly 32 bytes').to.equal(32)
    expect(bytesToHex(combined), '[RFC 9591 E.5] combineSecret(P1, P3) must equal group_secret_key').to.equal(
      '0d004150d27c3bf2a42f312683d35fac7394b1e9e318249c1bfe7f0795a83114'
    )
  })

})
