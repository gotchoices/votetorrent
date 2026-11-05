/**
 * CR-02 (Phase 47 review): the release-build fail-closed guard on the
 * app-identity cert pin.
 *
 * The committed default for `EXPECTED_APP_CERT_SHA256_DIGESTS` lists ONLY the
 * standard Android SDK debug certificate, whose private key ships in every SDK
 * install and is committed in this repo. Accepting it in a release build would
 * reduce the CR-04/WR-03 pin to "some app signed by a key anyone has", which is
 * the exact property the pin exists to deny.
 *
 * These assertions are written as INVARIANTS rather than exact-value snapshots,
 * so they keep holding once the real voter release digest is appended — at that
 * point `buildExpectedCertDigests(false)` starts returning it, and only the
 * "empty by default" case below needs revisiting.
 */

import {
	EXPECTED_APP_CERT_SHA256_DIGESTS,
	PUBLIC_DEBUG_CERT_SHA256_DIGESTS,
	buildExpectedCertDigests,
} from '../attestation-keys.generated';

/**
 * SHA-256 of the standard Android SDK debug certificate (CN=Android Debug,
 * alias androiddebugkey, store password `android`). Verified against
 * apps/VoteTorrentVoter/android/app/debug.keystore via
 *   keytool -list -v -keystore debug.keystore -storepass android
 * which reports FA:C6:17:45:...:03:3B:9C — the same value lowercased and
 * de-colonned. Duplicated here deliberately: if someone edits the constant in
 * the source module, this test must fail rather than silently follow along.
 */
const ANDROID_DEBUG_CERT_SHA256 =
	'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

describe('CR-02 release-build cert-pin guard', () => {
	it('classifies the universal Android debug cert as public', () => {
		expect(PUBLIC_DEBUG_CERT_SHA256_DIGESTS).toContain(ANDROID_DEBUG_CERT_SHA256);
	});

	it('never accepts a publicly-known signing cert in a release build', () => {
		// The load-bearing invariant. Survives adding the real release digest.
		const releaseDigests = buildExpectedCertDigests(false);
		for (const publicDigest of PUBLIC_DEBUG_CERT_SHA256_DIGESTS) {
			expect(releaseDigests).not.toContain(publicDigest);
		}
	});

	it('keeps the debug cert in __DEV__ so debug builds still attest', () => {
		expect(buildExpectedCertDigests(true)).toEqual([...EXPECTED_APP_CERT_SHA256_DIGESTS]);
		expect(buildExpectedCertDigests(true)).toContain(ANDROID_DEBUG_CERT_SHA256);
	});

	it('yields an EMPTY release allowlist until a real release digest is added', () => {
		// Both verifier halves reject on an empty allowlist
		// (play-integrity.ts:144-155, key-attestation.ts:193-197), so a release
		// build fails attestation loudly instead of trusting a public key.
		//
		// EXPECTED TO CHANGE: once the voter release signing digest is appended to
		// EXPECTED_APP_CERT_SHA256_DIGESTS, this expectation flips to that digest.
		// Update it then — do NOT weaken the guard to keep this green.
		expect(buildExpectedCertDigests(false)).toEqual([]);
	});

	it('does not mutate the underlying constant', () => {
		const before = [...EXPECTED_APP_CERT_SHA256_DIGESTS];
		buildExpectedCertDigests(true).push('mutated');
		buildExpectedCertDigests(false).push('mutated');
		expect(EXPECTED_APP_CERT_SHA256_DIGESTS).toEqual(before);
	});
});
