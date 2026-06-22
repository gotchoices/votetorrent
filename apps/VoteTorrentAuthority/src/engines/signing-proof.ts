/**
 * signing-proof.ts — Phase 28 on-device signing round-trip proof (D-07 / SIGN-04)
 *
 * Exports runSigningProof: signs a known secp256k1 vector and asserts verify().
 * Dev-only (driven by signing-proof-runner.ts when SIGNING_PROOF_ENABLED).
 * Logs under [spike013].
 *
 * WR-10: secp256k1.sign is called with v2 defaults (prehash:true). NEVER pass
 * { prehash: false } — WR-10 prehash contract must be identical to device-signer.ts:61.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'

// Known secp256k1 test vector (deterministic — same output every run).
// Private key: 32 bytes of 0x01 (not a real key — dev proof only).
// Digest: 32 bytes of 0xab (the message to sign — not canonical VoteTorrent data).
const PROOF_PRIVKEY = new Uint8Array(32).fill(0x01)
const PROOF_DIGEST  = new Uint8Array(32).fill(0xab)

/**
 * Sign a known secp256k1 vector and assert verify() returns true.
 * Never throws — all errors are logged under [spike013] FATAL and { passed: false } returned.
 *
 * The sign call uses v2 defaults (no options object) — prehash:true — matching
 * device-signer.ts:61 exactly (WR-10).
 */
export async function runSigningProof(): Promise<{ passed: boolean }> {
  console.log('[spike013] signing proof: starting')
  try {
    // Sign the known vector — v2 defaults (prehash:true). NO options object (WR-10).
    const sigBytes = secp256k1.sign(PROOF_DIGEST, PROOF_PRIVKEY)
    const sigHex = bytesToHex(sigBytes)
    console.log('[spike013] sign ok, sigHex length=', sigHex.length)

    // Derive the public key and verify
    const pubKeyBytes = secp256k1.getPublicKey(PROOF_PRIVKEY)
    const valid = secp256k1.verify(sigBytes, PROOF_DIGEST, pubKeyBytes)
    const passed = valid === true
    console.log('[spike013] verify =', valid, '—', passed ? 'PASS' : 'FAIL')
    console.log('[spike013] ========== SIGNING VERDICT:', passed ? 'PASS' : 'FAIL', '==========')
    return { passed }
  } catch (e) {
    console.error('[spike013] FATAL —', e)
    console.log('[spike013] ========== SIGNING VERDICT: FAIL ==========')
    return { passed: false }
  }
}
