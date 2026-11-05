// attestation-keys.generated.ts — committed default (UNPROVISIONED).
//
// Bundled, clearly-labeled config for the offline device-attestation verifier
// (D-04b / D-10). Two independent snapshots live here:
//
//   1. Play Console key material (decryption + JWS verification keys) that
//      `LocalConfigKeyProvider` reads. EMPTY by default = NOT provisioned. As
//      of D-09 (Phase 47), the empty default is threaded into
//      `PlayIntegrityVerifier`'s `keysProvisioned` constructor parameter — the
//      real verifier still constructs (engine-factory 'association' no longer
//      fails at construction), but `verify()` returns `{ ok: false, reason:
//      'Play Console key material is not provisioned — see SETUP.md' }` while
//      unprovisioned, so the associate() ceremony still fails closed. This
//      replaces the previously-committed all-zero placeholder secrets, which —
//      combined with the pre-CR-01/CR-02 verifier — allowed a full Play
//      Integrity bypass. Provision the real per-app values from secure config
//      as part of the Play Console registration runbook (SETUP.md).
//
//   2. The expected app identity (package name + signing-certificate SHA-256
//      digest allowlist) BOTH attestation halves pin the token/key to (CR-04 /
//      WR-03). `EXPECTED_APP_CERT_SHA256_DIGESTS` are lowercase-hex of the raw
//      32-byte SHA-256 of each accepted signing certificate.
//
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).

/**
 * SECRET-HANDLING RULE for the two constants below (47-REVIEW WR-10). This
 * file is GIT-TRACKED. Both values MUST stay empty in the tracked tree, and
 * real key material must be injected by the build/deploy step into an
 * ephemeral workspace copy — never typed in here and "remembered" out of a
 * commit. `attestation-keys.secretGuard.test.ts` enforces the empty default
 * and runs with the app suite, so CI rejects a commit that carries a key. If
 * you provision locally and that test goes red, that redness is the intended
 * signal that your working tree holds a secret: clear the values before
 * committing rather than weakening the guard. See packages/vote-engine/SETUP.md §3.
 */

/** Base64-encoded Play Console A256KW/A256GCM decryption key. Empty = not provisioned (fail closed). */
export const PLAY_CONSOLE_DECRYPTION_KEY_BASE64 = '';
/** Base64-encoded Play Console ES256 SPKI verification public key. Empty = not provisioned (fail closed). */
export const PLAY_CONSOLE_VERIFICATION_KEY_BASE64 = '';

/**
 * The VOTER app's package name (the attestation PRODUCER) both attestation halves must
 * be pinned to — NOT the authority app's own package. This corrects the Phase-43
 * placeholder value (the authority app's own package name, pinned here in error), which
 * would fail-closed reject the real voter app's tokens/keys (WR-03).
 */
export const EXPECTED_APP_PACKAGE = 'org.votetorrent.voter';
/**
 * Signing-certificate digests that are PUBLIC KNOWLEDGE and therefore prove nothing
 * about app identity. Anyone can sign an APK with these keys, so accepting one in a
 * release build would reduce the CR-04/WR-03 pin to "some app", defeating its purpose.
 *
 * The entry below is the standard Android SDK debug key (`CN=Android Debug`, alias
 * `androiddebugkey`, store password `android`, valid 2014-01-01 → 2052-05-01). Its
 * private key ships in every Android SDK install AND is committed in this repo at
 * apps/VoteTorrentVoter/android/app/debug.keystore (byte-identical to the authority
 * app's copy), so it is public twice over.
 *
 * `buildExpectedCertDigests()` below strips these from the accepted set in release
 * builds. Never remove an entry here to "make release work" — add the real release
 * digest to `EXPECTED_APP_CERT_SHA256_DIGESTS` instead.
 */
export const PUBLIC_DEBUG_CERT_SHA256_DIGESTS: readonly string[] = [
	'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c',
];

/**
 * Lowercase-hex raw SHA-256 digests of the voter app's accepted signing certificate(s),
 * no colons.
 *
 * The single entry below is the committed `debug.keystore` cert (androiddebugkey),
 * which covers DEBUG builds only. Release builds are signed with the real VoteTorrent
 * keystore (see apps/VoteTorrentAuthority/BUILD-RELEASE.md), whose cert digest is NOT
 * yet listed here — so a release voter build's attestation would be rejected once the
 * Play Console keys above are provisioned.
 *
 * TO ADD IT: build the voter release APK, then read the digest off it —
 *   apksigner verify --print-certs app-release.apk | grep 'SHA-256 digest'
 * and append it (lowercase hex, no colons) as a second array element. Keep the debug
 * digest so debug builds keep working.
 */
export const EXPECTED_APP_CERT_SHA256_DIGESTS: string[] = [
	'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c',
];

/**
 * The accepted signing-cert digests for THIS build, fail-closed against the
 * public debug key.
 *
 * In `__DEV__` the full list is returned unchanged, so debug-signed voter builds keep
 * attesting exactly as they do today. In a release build every digest in
 * `PUBLIC_DEBUG_CERT_SHA256_DIGESTS` is stripped — with only the debug digest listed
 * (the committed default) that yields an EMPTY allowlist, and both verifier halves
 * already reject on an empty set (`play-integrity.ts:144-155`,
 * `key-attestation.ts:193-197`). A release build therefore fails attestation loudly
 * instead of silently trusting a certificate anyone can produce.
 *
 * This is the interim guard, NOT the fix: the real resolution is adding the voter
 * release signing digest to `EXPECTED_APP_CERT_SHA256_DIGESTS`, after which this
 * function returns it in release and the pin becomes meaningful.
 */
export function buildExpectedCertDigests(isDev: boolean): string[] {
	if (isDev) return [...EXPECTED_APP_CERT_SHA256_DIGESTS];
	const publicDigests = new Set(PUBLIC_DEBUG_CERT_SHA256_DIGESTS);
	return EXPECTED_APP_CERT_SHA256_DIGESTS.filter((digest) => !publicDigests.has(digest));
}
