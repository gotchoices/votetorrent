/**
 * dev-only-key-gen.ts — the LAST remaining plaintext secp256k1 key generator in this app
 * (D-12, Phase 49). Body relocated VERBATIM from `device-user.ts`'s pre-Phase-49
 * `getOrCreateDeviceUser`.
 *
 * STRUCTURALLY UNREACHABLE FROM A RELEASE BUNDLE, NOT MERELY GATED. The only reference to this
 * module anywhere under `apps/VoteTorrentAuthority/src` is a CommonJS `require()` written
 * lexically inside a literal `if (__DEV__) { ... }` block in `device-user.ts` — the ONE shape
 * Metro's minifier actually eliminates (RESEARCH Pitfall 4, grounded in this repo's own
 * committed WR-11 correction: a static top-level `import` of a `__DEV__`-guarded module keeps
 * that module IN the release bundle regardless of its internal guard, because Metro does not
 * tree-shake and its minifier only eliminates lexically nested `if (__DEV__) { ... }` branches —
 * `registrant-dev-seed.ts` is this repo's own committed counter-example, not a template).
 *
 * A runtime `__DEV__` check on ITS OWN only proves unreachability at RUNTIME, never absence from
 * the BUNDLE. This module's own release-guard test (`dev-only-key-gen.releaseGuard.test.ts`)
 * proves only the SOURCE shape (one lexically-guarded `require`, no static `import` anywhere).
 * The actual bundle-absence proof is 49-13's release-bundle grep for the fingerprint constant
 * below — a green jest run here is NOT that proof.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'

/**
 * Unique, greppable fingerprint. 49-13's release-bundle grep searches for this exact string
 * literal; its ABSENCE from a built release bundle is the only real proof of D-12's "no code
 * path" property (Metro does not strip identifier names, but it also does not tree-shake unused
 * exports — so this string surviving into a release .js bundle would mean this module shipped).
 * Exported AND referenced inside the function body below so a minifier cannot drop the constant
 * while keeping the function's code that would otherwise reference it.
 */
export const DEV_ONLY_PLAINTEXT_KEYGEN_FINGERPRINT_49 = 'DEV_ONLY_PLAINTEXT_KEYGEN_FINGERPRINT_49'

/**
 * Generate a plaintext secp256k1 keypair — `device-user.ts`'s pre-Phase-49
 * `getOrCreateDeviceUser` body, relocated verbatim, including its AUTH-01 requirement:
 * `bytesToHex` is mandatory — never the native `Uint8Array` serializer, which produces a
 * comma-separated decimal string, not a valid secp256k1 hex key.
 *
 * Dev-only fixture use ONLY — e.g. a future `__DEV__`/flag-gated software signer alongside
 * `registrant-dev-seed.ts` (D-11). NEVER a production signing path: production signing goes
 * through the hardware-backed `signWithDeviceKey` TurboModule (`device-signer.ts`, 49-04/49-07).
 */
export function generateSoftwareDeviceKey(): { privHex: string; pubHex: string } {
	// Referenced here (not just declared above) so a minifier cannot strip the fingerprint
	// constant while keeping this function's code — see the module doc comment.
	void DEV_ONLY_PLAINTEXT_KEYGEN_FINGERPRINT_49

	// Generate a real secp256k1 keypair (CSPRNG — T-16-02 mitigation, unchanged from the
	// pre-Phase-49 body this was relocated from)
	const privKey = secp256k1.utils.randomSecretKey()
	const pubKey = secp256k1.getPublicKey(privKey, true) // compressed (33 bytes)

	// AUTH-01: hex-encode via bytesToHex (not the native Uint8Array serializer)
	const pubHex = bytesToHex(pubKey)
	const privHex = bytesToHex(privKey)

	return { privHex, pubHex }
}
