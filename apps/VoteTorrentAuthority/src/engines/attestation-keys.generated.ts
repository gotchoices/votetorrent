// attestation-keys.generated.ts — committed default (UNPROVISIONED).
//
// Bundled, clearly-labeled config for the offline device-attestation verifier
// (D-04b / D-10). Two independent snapshots live here:
//
//   1. Play Console key material (decryption + JWS verification keys) that
//      `LocalConfigKeyProvider` reads. EMPTY by default = NOT provisioned; the
//      real `PlayIntegrityVerifier` then FAILS CLOSED at construction
//      (engine-factory 'association') unless the __DEV__ stub gate is active
//      (CR-03). This replaces the previously-committed all-zero placeholder
//      secrets, which — combined with the pre-CR-01/CR-02 verifier — allowed a
//      full Play Integrity bypass. Provision the real per-app values from
//      secure config as part of the Play Console registration runbook (SETUP.md).
//
//   2. The expected app identity (package name + signing-certificate SHA-256
//      digest allowlist) BOTH attestation halves pin the token/key to (CR-04 /
//      WR-03). `EXPECTED_APP_CERT_SHA256_DIGESTS` are lowercase-hex of the raw
//      32-byte SHA-256 of each accepted signing certificate.
//
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).

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
