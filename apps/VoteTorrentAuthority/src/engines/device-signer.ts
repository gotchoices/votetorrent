/**
 * device-signer.ts — App-layer device signing module (D-01 / Phase 21 Plan 01).
 *
 * SECURITY NOTES:
 *   D-01 (key boundary): The device private key NEVER crosses into vote-engine.
 *     `createDeviceSigner` reads the private key, closes over it in the returned
 *     callback, and the callback returns only a `Signature` (public key + hex sig +
 *     signer UUID). No vote-engine method ever receives `privKeyHex`.
 *
 *   WR-10 (prehash contract): `secp256k1.sign` is called with @noble/curves v2
 *     DEFAULT options — prehash:true, meaning the signed domain is sha256(digest).
 *     NEVER pass `{ prehash: false }` here. Any drift silently breaks every verifier
 *     that uses the noble v2 default (prehash:true). OfficerSignature.SignatureValid
 *     depends on this invariant.
 *
 *   D-02 (key storage — accepted, deferred): The device private key is stored
 *     in plaintext AsyncStorage (T-16-01). Android Keystore / secure-storage
 *     migration is a separate v1.3 hardening task. This module does NOT change
 *     key storage.
 *
 *   D-03 (digest source): The engine computes the canonical SQL Digest() and passes
 *     the resulting bytes to this callback. The callback signs EXACTLY those bytes —
 *     it does NOT recompute a canonical form app-side.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { getOrCreateDeviceUser, getDevicePrivKeyHex } from './device-user'

// D-05 (Phase 28): Permanent production boot guard — fail loud if the wrong
// @noble/curves instance was bound by Metro/Hermes (multi-copy binding bug).
// This check MUST stay at module load, not inside createDeviceSigner, so a
// re-split surfaces on the first require() of this module, not at first sign call.
// NEVER make this __DEV__-only — a release-build regression must be caught.
if (typeof secp256k1.sign !== 'function') {
  throw new Error(
    '@noble/curves secp256k1.sign did not resolve to a function — ' +
    'got ' + typeof secp256k1.sign + '. Metro/Hermes multi-copy binding bug detected.'
  )
}

/**
 * App-layer sign callback type: receives canonical digest bytes from the engine
 * and returns a `Signature { signerUserId, signerKey, signature }`.
 *
 * The private key closes over this callback — it never crosses into vote-engine.
 */
export type SignCallback = (digest: Uint8Array) => Promise<Signature>

/**
 * Create a `SignCallback` that signs with the stored device user's secp256k1 key.
 *
 * @param displayName - Display name for the device user (used if the user does not
 *   yet exist and needs to be generated on first run via `getOrCreateDeviceUser`).
 * @returns A `SignCallback` that closes over the device private key bytes.
 * @throws Error if no device private key is stored (user not yet initialised).
 */
export async function createDeviceSigner (displayName: string): Promise<SignCallback> {
  const user = await getOrCreateDeviceUser(displayName)
  const privHex = await getDevicePrivKeyHex()
  if (!privHex) {
    throw new Error('Device user not initialised — cannot sign')
  }
  // Close over the private key bytes — they never leave this closure.
  const privBytes = hexToBytes(privHex)

  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: user.id,
    signerKey: user.activeKeys[0]!.key,
    // secp256k1.sign with v2 defaults: prehash:true (signed domain = sha256(digest)).
    // NEVER pass { prehash:false } — WR-10.
    signature: bytesToHex(secp256k1.sign(digest, privBytes)),
  })
}
