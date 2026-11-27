/**
 * Phase 51: the embedded Apple App Attest trust anchor.
 *
 * A trust anchor is the one value in this system where a wrong-but-well-formed
 * input does not fail — it silently redefines what "genuine Apple hardware"
 * means. Every other attestation input fails loudly when it is wrong, so every
 * other input can be left to the verifier. This one cannot.
 *
 * These tests do NOT re-verify that the certificate is Apple's. That was done
 * out of band when it was provisioned (see the constant's doc comment, and the
 * chain proof in `vote-engine/test/ios-hardware-attestation.spec.ts`, which
 * checks this same root against bytes a real Secure Enclave produced). What
 * they defend against is the failure mode a human introduces AFTER that check:
 * a truncated paste, a stray character, a base64 body that decodes to
 * *something* and is quietly accepted, or a well-meaning "refresh" that swaps
 * the anchor for a different certificate.
 *
 * The sibling `attestation-keys.secretGuard.test.ts` asserts the Android Play
 * Console keys stay EMPTY in the tracked tree, because those are secrets. This
 * file asserts the opposite for the Apple root, because a CA certificate is
 * public by construction and is meant to be committed. Do not "harmonise" the
 * two: they guard different things in opposite directions.
 */
import { createHash } from 'node:crypto';
import {
	PINNED_APP_ATTEST_ROOTS_DER,
	APPLE_APP_ATTEST_ROOT_SHA256,
	APPLE_APP_ID,
	APP_ATTEST_ENVIRONMENT,
	APP_ATTEST_PROVISIONED,
} from '../appattest-keys.generated';

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('Apple App Attest root — embedded trust anchor', () => {
	it('is provisioned with exactly one root', () => {
		// More than one is not wrong in principle, but Apple publishes a single
		// long-lived root with no rotation feed. A second entry appearing is a
		// change worth a human looking at, not something to accept silently.
		expect(PINNED_APP_ATTEST_ROOTS_DER).toHaveLength(1);
		expect(PINNED_APP_ATTEST_ROOTS_DER[0].length).toBeGreaterThan(0);
	});

	it('the embedded bytes hash to the recorded fingerprint', () => {
		// THE load-bearing assertion. Recomputed from what is actually embedded,
		// not from the base64 string literal — so a paste that decodes to fewer
		// bytes than intended is caught rather than round-tripped.
		expect(sha256Hex(PINNED_APP_ATTEST_ROOTS_DER[0])).toBe(APPLE_APP_ATTEST_ROOT_SHA256);
	});

	it('the recorded fingerprint is the Apple App Attest Root CA value confirmed on 2026-08-26', () => {
		// Pinned as a LITERAL, deliberately duplicating the constant. If someone
		// resolves a failure of the test above by editing the constant to match a
		// bad artifact — moving the goalpost instead of re-fetching — this fails
		// and says so. A guard that reads its expected value from the thing it is
		// guarding guards nothing.
		expect(APPLE_APP_ATTEST_ROOT_SHA256).toBe(
			'1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932'
		);
	});

	it('decodes as DER: a SEQUENCE whose declared length matches the buffer', () => {
		// Cheap structural check with no X.509 dependency. Truncation is the
		// realistic paste error, and it shows up here as a length disagreement.
		const der = PINNED_APP_ATTEST_ROOTS_DER[0];
		expect(der[0]).toBe(0x30); // universal, constructed, SEQUENCE
		expect(der[1]).toBe(0x82); // long form, 2 length bytes
		const declared = (der[2] << 8) | der[3];
		expect(der.length).toBe(declared + 4);
	});
});

describe('App Attest configuration — provisioned on the paid Apple Developer Program team', () => {
	it('APPLE_APP_ID is provisioned as <teamId>.<bundleId> for THIS app, and has not drifted back to empty', () => {
		// D-13 committed a real App ID deliberately, for a runnable proof. An empty App ID
		// fail-closes every genuine device (the App ID gate in `AppAttestVerifier.verify`
		// returns first), so a silent drift back to '' would look like the old, correct
		// unprovisioned state instead of the regression it now is. This asserts that drift
		// never happens unnoticed.
		//
		// WR-03 (51-REVIEW): asserts the INVARIANT, not the current literal. Pinning the exact
		// free-personal-team string made this test and D-14's release gate
		// (`scripts/fastlane/vt_appattest_release_gate.rb`, which refuses to build WHILE the
		// constant holds that value) mutually exclusive — there was no value of APPLE_APP_ID for
		// which both were green, so performing the tracked paid-team swap would have turned a
		// green suite red and this assertion's own comment would have read as a regression
		// rather than the intended change. The two gates now divide the work cleanly: this one
		// owns "provisioned and belongs to this app", the fastlane gate owns "shippable".
		expect(APPLE_APP_ID).toMatch(/^[A-Z0-9]{10}\.[a-z0-9.]+$/);
		expect(APPLE_APP_ID.endsWith('.org.votetorrent.voter')).toBe(true);
	});

	it('APP_ATTEST_PROVISIONED is true now that both required values are present', () => {
		// Both the root and the App ID have no safe default; both are now present.
		// This does not assert the App ID is a SAFE value to ship — that is D-14's
		// job (`scripts/fastlane/vt_appattest_release_gate.rb`), which fails a
		// release build while this constant equals the personal-team value.
		expect(APP_ATTEST_PROVISIONED).toBe(true);
	});

	it('the environment default is still the STRICT one', () => {
		// 'development' here would accept every sideloaded build, and the credCert
		// aaguid is the only thing separating the two environments.
		//
		// WR-03: this test no longer also claims to guard the App ID against drifting to
		// another TEAM's identifier. It never could — it does not read APPLE_APP_ID — and after
		// the assertion above was loosened to an invariant, a team-id swap is an EXPECTED
		// change. What still cannot drift is the bundle id, which the assertion above pins.
		expect(APP_ATTEST_ENVIRONMENT).toBe('production');
	});
});
