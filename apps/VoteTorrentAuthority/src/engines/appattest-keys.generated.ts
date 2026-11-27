// appattest-keys.generated.ts — PROVISIONED (paid Apple Developer Program team).
//
// Bundled, clearly-labeled config for the offline iOS App Attest verifier
// (Phase 51), the exact sibling of `attestation-roots.generated.ts` +
// `attestation-keys.generated.ts` on the Android side. Three snapshots live
// here:
//
//   1. Apple's App Attest trust-anchor root certificate — PROVISIONED
//      2026-08-26. Verification record in the constant's own doc comment.
//   2. The App ID (`<teamId>.<bundleId>`) every attestation and assertion is
//      pinned to — now the PAID Apple Developer Program team, swapped
//      2026-09-01, which RETIRES D-13's accepted risk. See that constant's own
//      doc comment for what changed and what is still unproven.
//   3. Which App Attest environment this authority accepts — the literal
//      strict value (`production`, D-15).
//
// So `APP_ATTEST_PROVISIONED` below is TRUE and the iOS branch no longer fails
// closed on missing config. `scripts/fastlane/vt_appattest_release_gate.rb`
// (D-14) — which failed every release lane while the personal-team value sat
// here — now CLEARS. The proof debt that remains is a real signed build
// producing a `production` attestation on paid-team hardware; see
// `.planning/todos/completed/2026-08-25-ios-appattest-team-id-and-entitlement.md`.
//
// This file lives in the AUTHORITY app because the authority is what VERIFIES.
// A near-identical empty file previously sat in `apps/VoteTorrentVoter/src/
// engines/appattest-roots.generated.ts` — the voter is the attestation
// PRODUCER and never holds a trust anchor, so that copy was referenced by
// nothing and is removed. SETUP.md §4d points here.
//
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
//
// `Buffer` MUST be imported explicitly from the `buffer` module — it is NOT a
// Hermes global (see vote-engine/src/utils.ts).
import { Buffer } from 'buffer';

/**
 * Base64-encoded DER of Apple's App Attest root certificate(s).
 *
 * A trust anchor is the single value in this system that must not be taken on
 * faith from an automated step: an unverified or truncated root would not fail
 * loudly, it would silently redefine what "genuine Apple hardware" means.
 * Everything else in the attestation path fails loudly when it is wrong.
 *
 * PROVISIONED 2026-08-26. What was actually checked, and what was not:
 *
 *   1. Fetched over TLS from
 *      https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 *   2. Genuinely self-signed — subject EQUALS issuer, and `openssl verify`
 *      accepts it under its own key (name equality alone proves nothing; a
 *      forged cert can carry any subject it likes).
 *   3. SHA-256 equals the value independently recorded by spike 085 on
 *      2026-08-25, and the value stated by the project owner. See
 *      APPLE_APP_ATTEST_ROOT_SHA256.
 *   4. CRYPTOGRAPHIC corroboration, which does not depend on the download
 *      channel at all: this exact root verifies the certificate chain inside a
 *      REAL attestation captured from an iPhone 13 Secure Enclave on
 *      2026-08-25 (spike 085 leg 9). Substituting the root during the fetch
 *      would require also holding the key that signed Apple's real
 *      intermediate. Pinned as a test — see
 *      `vote-engine/test/ios-hardware-attestation.spec.ts`.
 *
 * NOT checked, because it is not possible: Apple publishes NO fingerprint
 * alongside this download (verified 2026-08-26 — the certificateauthority page
 * carries only the link). SETUP.md §4d used to instruct comparing against
 * "Apple's published value"; there is no such value. Item 4 is what stands in
 * its place, and it is a stronger check than a published hex string would be.
 */
const APPLE_APP_ATTEST_ROOTS_BASE64: readonly string[] = [
	// Apple App Attestation Root CA — CN=Apple App Attestation Root CA, O=Apple Inc.,
	// ST=California. P-384, ecdsa-with-SHA384, CA:TRUE, valid 2020-03-18 -> 2045-03-15.
	// Fetched 2026-08-26 from
	// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
	// See APPLE_APP_ATTEST_ROOT_SHA256 below for what was checked before pasting.
	'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD',
];

/**
 * SHA-256 of the DER above, lowercase hex.
 *
 * Recorded as a CONSTANT, not a comment, because `appattest-keys.provisioned.test.ts`
 * recomputes the digest of what is actually embedded and compares it against this. A
 * truncated or partially-pasted base64 blob still decodes to *something*; the digest
 * is what makes a bad paste loud instead of silent.
 *
 * Do NOT resolve a mismatch by updating this constant. A mismatch means the bytes
 * above are not the certificate they claim to be, and the response is to re-fetch and
 * re-verify — never to move the goalpost to match the artifact.
 */
export const APPLE_APP_ATTEST_ROOT_SHA256 =
	'1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932';

/**
 * Decoded pinned roots, injected into `AppAttestVerifier`. Empty until
 * provisioned — which the verifier treats as a fail-closed configuration
 * error, not as "accept anything".
 */
export const PINNED_APP_ATTEST_ROOTS_DER: Uint8Array[] = APPLE_APP_ATTEST_ROOTS_BASE64.map(
	(b64) => new Uint8Array(Buffer.from(b64, 'base64'))
);

/**
 * `<teamId>.<bundleId>` for the VOTER app (the attestation PRODUCER) — NOT the
 * authority app's own identifier. `verifyAppAttest` checks
 * `rpIdHash === SHA256(appId)`, and the assertion half re-checks it, so a wrong
 * value here fail-closed rejects every genuine device.
 *
 * SWAPPED 2026-09-01 to the PAID Apple Developer Program team `6849Q7KVP5`
 * (confirmed by the project owner; the same team already carried in the
 * authority app's `DEVELOPMENT_TEAM`). This RETIRES D-13's accepted risk.
 * Until now this held the FREE PERSONAL TEAM value
 * `94TY7UR2W5.org.votetorrent.voter`, committed deliberately on 2026-08-27 so
 * spike 085's real-iPhone-13 proof could run end to end — and a shipped
 * authority built from that tree would have treated that personal team's builds
 * as the legitimate attestation producer.
 * `scripts/fastlane/vt_appattest_release_gate.rb` (D-14) enforced that as a hard
 * build failure, and it now clears.
 *
 * WHAT THIS VALUE HAS AND HAS NOT BEEN PROVEN AGAINST. The bytes that prove the
 * pipeline works on real hardware (`vote-engine/test/ios-hardware-attestation.spec.ts`,
 * spike 085) were produced under the PERSONAL team, so those fixtures still pin
 * `94TY7UR2W5` and MUST NOT be rewritten to match this constant — they are a
 * recording of a real Secure Enclave, not configuration. No attestation has yet
 * been produced under `6849Q7KVP5`; the first paid-team device build is what
 * confirms this value against a live `rpIdHash`.
 *
 * A MISTYPED TEAM ID CLEARS EVERY AUTOMATED GATE HERE. The release gate only
 * checks that this is not the personal value; the unit test only checks the
 * shape and the bundle id (WR-03). Ten wrong-but-well-formed characters reject
 * every genuine iPhone with an App ID mismatch and nothing upstream complains.
 * Verify against developer.apple.com -> Membership details before editing.
 */
export const APPLE_APP_ID = '6849Q7KVP5.org.votetorrent.voter';

/**
 * Which App Attest environment this authority accepts.
 *
 * `production` is the correct DEFAULT for a shipped authority and is
 * deliberately the strict direction: a `development` attestation must NEVER be
 * accepted in production, and the credCert `aaguid` (`appattestdevelop` vs
 * `appattest` + 7 zero bytes) is the ONLY thing that distinguishes them.
 *
 * Measured 2026-08-25 (spike 085): the PROVISIONING PROFILE decides the
 * environment, not the entitlement plist — a build with no entitlements file at
 * all still received a `development` attestation, while TestFlight/App Store
 * builds get `production` regardless of the plist value. So do not flip this to
 * `development` to "make a test device work" in a deployed authority; that
 * accepts every sideloaded build.
 */
export const APP_ATTEST_ENVIRONMENT: 'development' | 'production' = 'production';

/**
 * True only when BOTH pieces of config with no safe default are present.
 *
 * Threaded into `AppAttestVerifier`'s `rootsProvisioned` parameter exactly as
 * `playConsoleKeysProvisioned` is threaded into `PlayIntegrityVerifier`'s
 * `keysProvisioned` (D-09): the verifier still CONSTRUCTS unconditionally so
 * association/registrant READS are never blocked, and `verify()` returns
 * `{ ok: false, reason: '... is not provisioned — see SETUP.md' }` until this
 * is true. `associate()`'s `if (!verification.ok) throw` is what converts that
 * tuple back into a fail-closed WRITE ceremony.
 *
 * The verifier reports the root gate and the App ID gate separately, so an
 * unprovisioned authority names which half it is missing rather than blaming
 * the device for an app-identity mismatch.
 */
export const APP_ATTEST_PROVISIONED: boolean =
	PINNED_APP_ATTEST_ROOTS_DER.length > 0 && APPLE_APP_ID.length > 0;
