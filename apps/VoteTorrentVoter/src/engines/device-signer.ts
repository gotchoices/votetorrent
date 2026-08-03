/**
 * device-signer.ts — App-layer device signing module (D-05, Phase 44-02).
 *
 * SECURITY NOTES:
 *   Key boundary: The device private key NEVER crosses into vote-engine.
 *     `createDeviceSigner` reads the private key, closes over it in the returned
 *     callback, and the callback returns only a `Signature` (public key + hex sig +
 *     signer UUID). No vote-engine method ever receives the raw private key.
 *
 *   WR-10 (prehash contract): `secp256k1.sign` is called with @noble/curves v2
 *     DEFAULT options — prehash:true, meaning the signed domain is sha256(digest).
 *     NEVER pass `{ prehash: false }` here. Any drift silently breaks every verifier
 *     that uses the noble v2 default (prehash:true). AdminSigning.SignatureValid /
 *     OfficerSignature.SignatureValid depend on this invariant.
 *
 *   Key storage (accepted, deferred, matches authority app posture): The device
 *     private key is stored in plaintext AsyncStorage. Android Keystore / secure
 *     storage migration is a deferred hardening task; this module does NOT change
 *     key storage.
 *
 *   Digest source: The engine computes the canonical SQL Digest() and passes the
 *     resulting bytes to this callback. The callback signs EXACTLY those bytes —
 *     it does NOT recompute a canonical form app-side.
 *
 *   T-44-05 (44-RESEARCH.md Anti-Patterns): this is the SAME device signer used both
 *     as register()'s registrant signing key AND as the dev-seed's founding-officer
 *     key (44-06) — one identity, two roles. It is NEVER `loadOrCreateRNPeerKey`
 *     (the libp2p/CadreNode transport identity) — that key is never inserted into
 *     User/Officer/UserKey and AdminSigning.UserIdValid rejects it outright.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Signature } from '@votetorrent/vote-core'
import { getOrCreateDeviceUser, getDevicePrivKeyHex } from './device-user'

// T-44-04: Permanent production boot guard — fail loud if the wrong @noble/curves
// instance was bound by Metro/Hermes (multi-copy binding bug, spike-013 / Pitfall 3).
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
export async function createDeviceSigner(displayName: string): Promise<SignCallback> {
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
