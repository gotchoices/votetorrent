/**
 * Keyholder policy guard for Create / Edit Election.
 *
 * Mirrors vote-engine's `assertDkgThreshold` (2 <= threshold <= participants): no device ever
 * holds the full key, and a threshold of 1 would let a single keyholder decrypt results early.
 * An election proposed below 2-of-2 can never generate its key, so the UI refuses it up front.
 * The ElectionRevision schema is deliberately not tightened; the DKG is the backstop.
 *
 * Operates on already-trimmed, non-empty keyholder names.
 */
export type KeyholderPolicyReason = "duplicate-keyholder-name" | "too-few-keyholders" | "threshold-too-low" | "threshold-above-count";

export type KeyholderPolicyResult = { ok: true } | { ok: false; reason: KeyholderPolicyReason };

/** Same normalization as the engine's keyholder-name rule: trim, NFC, lowercase. */
function normalizeKeyholderName(name: string): string {
	return name.trim().normalize("NFC").toLowerCase();
}

export function validateKeyholderPolicy(keyholders: string[], threshold: number): KeyholderPolicyResult {
	// A keyholder slot binds to its invitee by name, so names are unique per election (REVIEW/IN-06).
	const seen = new Set<string>();
	for (const name of keyholders) {
		const key = normalizeKeyholderName(name);
		if (seen.has(key)) return { ok: false, reason: "duplicate-keyholder-name" };
		seen.add(key);
	}
	if (keyholders.length < 2) return { ok: false, reason: "too-few-keyholders" };
	if (threshold < 2) return { ok: false, reason: "threshold-too-low" };
	if (threshold > keyholders.length) return { ok: false, reason: "threshold-above-count" };
	return { ok: true };
}

/** i18n key for a refusal reason. */
export const KEYHOLDER_POLICY_ERROR_KEY: Record<KeyholderPolicyReason, string> = {
	"duplicate-keyholder-name": "keyholderPolicyDuplicateName",
	"too-few-keyholders": "keyholderPolicyTooFewKeyholders",
	"threshold-too-low": "keyholderPolicyThresholdTooLow",
	"threshold-above-count": "keyholderPolicyThresholdAboveCount",
};
