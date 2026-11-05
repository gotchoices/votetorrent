/**
 * recovery-branch-proof.ts — D-26a leg 5, LOCAL half (49-CONTEXT D-26/D-26a)
 *
 * WHY THIS EXISTS
 * D-26a requires the device-credential recovery branch to be demonstrated on the fleet. As
 * originally specified, that leg is folded into D-24 leg 3's revoke-then-add ceremony, whose
 * success criterion is a replacement key landing in the network `UserKey` table — so it cannot
 * run until a network exists whose `User` resolves with BOTH keys registered. That precondition
 * has been blocked behind an unrelated P2P/relay chain.
 *
 * But the branch itself needs no network. Splitting the leg:
 *
 *   LOCAL  (this file)  — the recovery key signs, via the API-appropriate branch, after the
 *                         signing key has been invalidated, and the signature is accepted by
 *                         the SAME verifier the schema uses. No network, no relay, no drone.
 *   DEFERRED            — `UserKey.DeleteValid`/`InsertValid` accept the revoke+add round trip.
 *                         Genuinely needs network state; rides along whenever one next exists.
 *
 * WHAT THE LOCAL HALF DOES AND DOES NOT PROVE
 * It DOES prove the load-bearing D-26a claim (the branch runs and produces a valid P-256
 * signature) AND the encoding agreement that D-24 leg 1's second sub-claim is about — because
 * it verifies with `verifySigP256`, which IS the function `SignatureValidP256` calls. A
 * hand-rolled noble verify would prove nothing about schema agreement.
 * It does NOT prove the DB write path. Do not record it as closing D-24 leg 3.
 *
 * D-26A RESCOPED 2026-08-21 — API 30+ ONLY
 * Recovery is supported on API 30+ via `BiometricPrompt` + `DEVICE_CREDENTIAL`. Below API 30 it
 * is explicitly UNSUPPORTED: measured n=2 on Device B (Redmi 8, API 29) after a clean `pm clear`,
 * the recovery key is auth-per-use below API 30 and the OS confirm-device-credential API performs
 * a time-bound authentication that cannot authorize it, producing `RESULT_OK` followed by
 * `KeyStoreException: Key user not authenticated`. 49-19 removed the sub-API-30 dispatch branch
 * from the native layer entirely; `signWithRecoveryKey` now rejects with
 * `code: 'RECOVERY_UNSUPPORTED_OS'` below API 30 BEFORE any key handle or UI. See
 * `.planning/todos/pending/2026-08-19-d26-keyguard-fallback-cannot-authorize-per-use-key.md` for
 * the n=2 measurement and the rescope decision. Whether the branch executes AT ALL below API 30
 * was itself settled by measurement, not inference — the `d26a-branch` OS
 * `CONFIRM_DEVICE_CREDENTIAL` activity, observed twice on hardware before the rescope, is the
 * measurement that produced this decision and is preserved in the phase's proof log. This
 * module's remaining value is exercising the API 30+ path (the only one that still exists)
 * without a network.
 *
 * BRANCH ATTRIBUTION IS MEASURED, NOT INFERRED (API 30+)
 * The ceremony script's `recover-branch` leg asserts the SDK>=30 `BiometricPrompt` dispatch by
 * source guarantee. Below API 30 the leg is now `N/A` — there is no branch left to measure or
 * infer, since the native layer terminally rejects before any dispatch decision.
 *
 * iOS: `sdkInt` / the `branch` label are not meaningful there (`Platform.Version` is the iOS version
 * string, and there is no API-30 split). The proof itself is still valid on iOS: it signs with the
 * recovery key through `nativeSignInputBase64(PROOF_DIGEST, platformOS)` (iOS pre-hashes, Android
 * does not) and verifies with the schema verifier. The deferred iPhone re-check (I-8-alt) uses it.
 */

import { verifySigP256 } from '@votetorrent/vote-engine/rn';
import { nativeSignInputBase64 } from '@votetorrent/attestation-native/src/native-sign-input';
import { getDeviceProvisioningRecord } from './device-user';

const TAG = '[d26a-local]';

/** Plain base64 of RAW digest bytes — the `digestBase64` contract (NEVER base64url). */
function base64FromDigestBytes(digest: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]!);
	const { btoa: btoaFn } = globalThis as unknown as { btoa: (data: string) => string };
	return btoaFn(binary);
}

/**
 * base64url of the same raw bytes — what `verifySigP256` expects for its digest argument.
 * The two encodings are deliberately different at the two call sites; getting this wrong is
 * exactly the class of defect this proof is meant to catch, so both are derived here from the
 * SAME source bytes rather than converted from one another.
 */
function base64UrlFromDigestBytes(digest: Uint8Array): string {
	return base64FromDigestBytes(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fixed, non-canonical digest. Deterministic so repeat runs are comparable. */
const PROOF_DIGEST = new Uint8Array(32).fill(0x5a);

/**
 * Error `code` values that mean "the branch was never reached" — a cancelled prompt or an
 * invalidated recovery key — as opposed to a genuine signing/verification failure. Checked
 * BEFORE the message regex fallback so a code-bearing error is classified on its code, never
 * on message text (R5c — the ceremony harness's `isPrecondition` classifier had the opposite
 * order: message-only, with `code` consulted for exactly one literal).
 */
const PRECONDITION_CODES = new Set([
	'CANCELED',
	// Phase 65 review CR-01: a system-ended prompt (app backgrounded, screen locked) never reached
	// the branch either.
	'SYSTEM_CANCELED',
	'CANCELLED',
	'USER_CANCELED',
	'NEGATIVE_BUTTON',
	'KEY_INVALIDATED_REASSOCIATE',
]);

/** Message-text fallback for errors that carry no usable `code` (e.g. a bare `Error`). */
const PRECONDITION_MESSAGE_PATTERN =
	/invalidated|re-association|CANCELED|CANCELLED|USER_CANCELED|NEGATIVE_BUTTON/i;

/**
 * Classify a thrown recovery-signing error into one of three terminal buckets. Order is
 * load-bearing:
 *   1. the exact `RECOVERY_UNSUPPORTED_OS` code — the branch does not exist on this OS version;
 *   2. a precondition `code` — the branch was never reached (cancel/invalidation);
 *   3. the message-regex fallback — covers errors with no `code` at all;
 *   4. otherwise `'fail'` — a genuine failure. Nothing above this line can turn a real failure
 *      green: the negative control in the unit test asserts a message with no matching code and
 *      no matching text classifies as `'fail'`.
 */
export function classifyRecoveryFailure(
	err: unknown,
): 'unsupported-os' | 'precondition-unmet' | 'fail' {
	const errCode = (err as { code?: unknown })?.code;
	if (errCode === 'RECOVERY_UNSUPPORTED_OS') {
		return 'unsupported-os';
	}
	if (typeof errCode === 'string' && PRECONDITION_CODES.has(errCode)) {
		return 'precondition-unmet';
	}
	const message = String((err as { message?: unknown })?.message ?? err);
	if (PRECONDITION_MESSAGE_PATTERN.test(message)) {
		return 'precondition-unmet';
	}
	return 'fail';
}

export interface RecoveryBranchProofResult {
	passed: boolean;
	/**
	 * Distinguishes "the branch was exercised and failed" from "the branch was never reached".
	 * Recording a precondition failure as FAIL would put a false negative into the phase record —
	 * the same void-vs-negative-result distinction that invalidated a `dialTimeout` experiment
	 * earlier in this phase. A PRECONDITION outcome claims NOTHING about D-26a either way.
	 *
	 * `unsupported-os` extends that same reasoning one step further: below API 30 the branch does
	 * not merely go unreached by a stalled precondition — it DOES NOT EXIST on this OS version
	 * (D-26a RESCOPED 2026-08-21; `signWithRecoveryKey` rejects `RECOVERY_UNSUPPORTED_OS` before
	 * any key handle or UI). A run that observes this claims nothing about D-26a either way and is
	 * not a defect — it is the terminal, by-design outcome of an unsupported OS version.
	 */
	outcome: 'pass' | 'fail' | 'precondition-unmet' | 'unsupported-os';
	sdkInt?: number;
	branch?: 'unsupported-below-api-30' | 'biometric-prompt-device-credential';
}

/**
 * Drive the recovery-key signing branch locally and verify the result.
 *
 * `native` is injected rather than imported so this module stays testable and does not pull the
 * TurboModule into a Node test graph.
 */
export async function runRecoveryBranchProof(
	native: {
		provisionRecoveryKey(alias: string): Promise<unknown>;
		signWithRecoveryKey(
			alias: string,
			digestBase64: string,
			promptTitle: string,
			promptSubtitle: string,
			promptNegativeButton: string,
		): Promise<unknown>;
	},
	recoveryKeyAlias: string,
	sdkInt: number,
	prompts: { title: string; subtitle: string; negative: string },
	platformOS: string,
): Promise<RecoveryBranchProofResult> {
	const branch = sdkInt >= 30 ? 'biometric-prompt-device-credential' : 'unsupported-below-api-30';
	console.info(`${TAG} starting`, JSON.stringify({ sdkInt, branch, recoveryKeyAlias }));

	try {
		// Source the PUBLIC value from the persisted provisioning record first, and fall back to
		// the native call only if absent. `provisionRecoveryKey` is idempotent as of 49-14's
		// `reuseExistingRecoveryKey` fix, but preferring the recorded value keeps this proof from
		// depending on that fix being present — a device on an older native build would otherwise
		// have its alias regenerated here and orphan whatever a network already holds.
		const record = await getDeviceProvisioningRecord().catch(() => undefined);
		let recoveryPubHex = record?.recoveryPublicKeyCompressedHex;
		if (!recoveryPubHex) {
			const provisioned = (await native.provisionRecoveryKey(recoveryKeyAlias)) as {
				publicKeyCompressedHex?: string;
			};
			recoveryPubHex = provisioned?.publicKeyCompressedHex;
			console.info(`${TAG} recovery key sourced from native (no provisioning record)`);
		} else {
			console.info(`${TAG} recovery key sourced from the provisioning record`);
		}
		if (!recoveryPubHex) {
			console.error(`${TAG} PRECONDITION — no recovery public key available`);
			console.info(`${TAG} ========== D-26A LOCAL VERDICT: PRECONDITION-UNMET ==========`);
			return { passed: false, outcome: 'precondition-unmet', sdkInt, branch };
		}

		// This raises the real credential UI: BiometricPrompt DEVICE_CREDENTIAL at API 30+, the only
		// branch that still exists (D-26a RESCOPED 2026-08-21). Below API 30 `signWithRecoveryKey`
		// rejects with `RECOVERY_UNSUPPORTED_OS` before reaching any UI. A human must satisfy the
		// prompt with the DEVICE CREDENTIAL (PIN/pattern/password) — never a fingerprint; the
		// fingerprint is what invalidated the signing key in the first place.
		console.info(`${TAG} ACTION REQUIRED — satisfy the DEVICE CREDENTIAL prompt (not a fingerprint)`);
		const signed = (await native.signWithRecoveryKey(
			recoveryKeyAlias,
			nativeSignInputBase64(PROOF_DIGEST, platformOS),
			prompts.title,
			prompts.subtitle,
			prompts.negative,
		)) as { signatureHex?: string };

		const signatureHex = signed?.signatureHex;
		if (!signatureHex) {
			console.error(`${TAG} FAIL — native returned no signatureHex`);
			return { passed: false, outcome: 'fail', sdkInt, branch };
		}
		console.info(`${TAG} signature obtained, hexLen=${signatureHex.length}`);

		// THE assertion: the schema's own verifier accepts a real Keystore P-256 signature.
		const valid = verifySigP256(
			base64UrlFromDigestBytes(PROOF_DIGEST),
			signatureHex,
			recoveryPubHex,
		);
		console.info(`${TAG} verifySigP256 =`, valid);
		console.info(`${TAG} ========== D-26A LOCAL VERDICT: ${valid === true ? 'PASS' : 'FAIL'} ==========`);
		return { passed: valid === true, outcome: valid === true ? 'pass' : 'fail', sdkInt, branch };
	} catch (err) {
		// A cancellation is a legitimate outcome of a human-driven prompt, not a defect — log the
		// raw value so it is distinguishable from a genuine verification failure (the 49-14 lesson
		// about generic copy masking real faults).
		console.error(`${TAG} raw error —`, err);
		// D-26a RESCOPED 2026-08-21: below API 30, recovery does not exist at all — 49-19 removed the
		// sub-API-30 dispatch branch from the native layer, and `signWithRecoveryKey` now rejects with
		// an exact `code: 'RECOVERY_UNSUPPORTED_OS'` before any key handle or UI. An invalidated
		// recovery key, or a cancelled prompt, means the branch was NEVER REACHED. Measured on
		// Device B 2026-08-19: the Keystore recovery key reported `recovery key invalidated —
		// re-association required` while AsyncStorage still held its public value — an app-record/
		// Keystore divergence, not a branch defect. Classifying that as FAIL would write a false
		// negative into the D-26a record. `classifyRecoveryFailure` (R5c) is code-first, with the
		// message regex only as a fallback for errors that carry no usable code.
		const classification = classifyRecoveryFailure(err);
		const verdict =
			classification === 'unsupported-os'
				? 'UNSUPPORTED-OS'
				: classification === 'precondition-unmet'
					? 'PRECONDITION-UNMET'
					: 'FAIL';
		console.info(`${TAG} ========== D-26A LOCAL VERDICT: ${verdict} ==========`);
		return { passed: false, outcome: classification, sdkInt, branch };
	}
}
