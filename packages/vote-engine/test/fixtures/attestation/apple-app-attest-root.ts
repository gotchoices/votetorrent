/**
 * apple-app-attest-root.ts — Apple's REAL App Attest trust anchor, for tests only.
 *
 * Sibling of `apple-app-attest-ca.ts`, and the deliberate opposite of it. That file mints a
 * SYNTHETIC CA so the bulk of the suite stays hermetic and can forge adversarial chains. This file
 * carries the genuine Apple root so that exactly one test — the chain step over real hardware bytes
 * — can prove the thing a synthetic root structurally cannot: that the shipped verifier accepts a
 * certificate chain Apple actually issued, and terminates it at Apple's actual anchor.
 *
 * WHY THIS IS NOT A POLICY CHANGE. `ios-hardware-attestation.spec.ts` used to skip §2 on the
 * grounds that "pinning a downloaded root inside a test would quietly undo" the app's fail-closed
 * decision. That concern was about the PRODUCTION anchor, and it still holds: the production anchor
 * lives in `apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts`, is human-verified
 * out of band, and is the only one any running code reads. Nothing in `packages/vote-engine/src`
 * imports this file — it is reachable from `test/` alone. A CA certificate is public by
 * construction, so committing it leaks nothing; what would be wrong is letting a test-fixture root
 * become a production default, and that is what the src/test split prevents.
 *
 * DO NOT import this from `src/`. If a future change needs a root in library code, that is a
 * signal the injection seam has been lost, not a reason to reach in here.
 */

/** Lowercase-hex SHA-256 of the DER below. */
export const APPLE_APP_ATTEST_ROOT_SHA256 =
  '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932'

/**
 * Apple App Attestation Root CA, base64 DER.
 *
 * CN=Apple App Attestation Root CA, O=Apple Inc., ST=California — P-384, ecdsa-with-SHA384,
 * CA:TRUE, valid 2020-03-18 -> 2045-03-15. Fetched 2026-08-26 from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem, confirmed
 * self-signed (subject equals issuer AND the signature verifies under its own key), and confirmed
 * to be the anchor a real iPhone's attestation chain terminates at.
 *
 * The fingerprint above is duplicated verbatim in the app's generated config. Both files pin the
 * same literal on purpose: if one is ever refreshed without the other, the pair disagrees and a
 * test says so.
 */
const APPLE_APP_ATTEST_ROOT_BASE64 =
  'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD'

/** Decoded DER of the real Apple App Attest root. */
export const APPLE_APP_ATTEST_ROOT_DER: Uint8Array = new Uint8Array(
  Buffer.from(APPLE_APP_ATTEST_ROOT_BASE64, 'base64')
)
