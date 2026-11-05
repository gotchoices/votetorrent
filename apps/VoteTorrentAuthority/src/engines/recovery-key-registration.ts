import { getDeviceProvisioningRecord } from "./device-user";

/**
 * Recovery-key registration gate.
 *
 * `networks-engine.create()` registers ONLY the founding signing key as a network
 * `UserKey` (its bootstrap branch writes `user.activeKeys[0]`, and has no analog for a
 * second key). The recovery key is registered exclusively by
 * `ProvisionSigningKeyScreen`'s first-run stage 2 — which needs a network `User` to
 * already resolve, so on the create-network path it can only run on a LATER visit.
 *
 * Until 49-19 nothing in the app enforced, or even prompted, that return visit. An
 * officer who provisioned (stage 1, network-independent per D-14), created or joined a
 * network, and never wandered back into Settings carried an unregistered recovery key
 * indefinitely — and was then exactly one biometric enrolment away from a permanently
 * stranded device: `addKey` needs a valid signing key, and only the recovery key can
 * replace an invalidated one, so losing the signing key with no registered recovery key
 * is a closed loop. The recorded escape was a destructive `adb shell pm clear`, which
 * also drops the app's Keystore entries.
 *
 * Measured on BOTH devices in the fleet (49-14 proof log §G.3): the provisioning record
 * held the recovery key while the user's `activeKeys` held only the signing key.
 *
 * This module answers one question — "is that gap open right now?" — so the create and
 * join paths can route the officer into the (idempotent, reconciling) registration
 * ceremony instead of relying on them to find it themselves.
 */

/** The subset of a resolved user summary this gate needs. */
export interface RegisteredKeyHolder {
	activeKeys?: Array<{ key: string }> | undefined;
}

/**
 * True when this device holds a locally-provisioned recovery key that the supplied
 * network user does NOT yet carry as an active key.
 *
 * Returns false — meaning "nothing to do" — in every ambiguous case, so this gate can
 * never fabricate a ceremony out of missing information:
 *
 * - no provisioning record (device never locally provisioned, or a legacy pre-49-16
 *   install): stage 1 has not run, so there is no recovery key to register yet;
 * - a record carrying no recovery key: same;
 * - `summary` undefined (the network `User` did not resolve): a DISTINCT condition that
 *   `ProvisionSigningKeyScreen`'s `tryResolveNetworkUserEngine` already surfaces on its
 *   own; this gate must not misreport it as a registration gap;
 * - the recovery key already present in `activeKeys`: the gap is closed.
 */
export function needsRecoveryKeyRegistration(
	summary: RegisteredKeyHolder | undefined,
	recoveryPublicKeyCompressedHex: string | undefined,
): boolean {
	if (!recoveryPublicKeyCompressedHex) return false;
	if (summary === undefined) return false;
	const activeKeys = summary.activeKeys ?? [];
	return !activeKeys.some((k) => k.key === recoveryPublicKeyCompressedHex);
}

/**
 * Reads this device's provisioning record and answers {@link needsRecoveryKeyRegistration}
 * against the supplied network user summary.
 *
 * Never throws: a storage read failure resolves to `false` (no prompt) rather than
 * blocking a network the officer just created over a diagnostic that could not be taken.
 * The gate is a safety prompt, not a correctness barrier — the schema's own
 * `SignatureValid` CHECK remains the authority on what is registered.
 */
export async function deviceNeedsRecoveryKeyRegistration(
	summary: RegisteredKeyHolder | undefined,
): Promise<boolean> {
	try {
		const record = await getDeviceProvisioningRecord();
		return needsRecoveryKeyRegistration(summary, record?.recoveryPublicKeyCompressedHex);
	} catch {
		return false;
	}
}

/**
 * Resolves the current network user's key set and reports whether this device still
 * owes a recovery-key registration.
 *
 * `resolveSummary` is supplied by the caller (the create/join screens already hold
 * `getEngine`) so this module stays free of navigation and engine imports and remains
 * unit-testable. It is expected to resolve `undefined` when no network user resolves —
 * this gate treats that as "nothing to prompt", never as a gap.
 *
 * Never throws, for the same reason as {@link deviceNeedsRecoveryKeyRegistration}: a
 * post-create safety prompt must not be able to fail a network the officer just created.
 */
export async function shouldPromptRecoveryKeyRegistration(
	resolveSummary: () => Promise<RegisteredKeyHolder | undefined>,
): Promise<boolean> {
	let summary: RegisteredKeyHolder | undefined;
	try {
		summary = await resolveSummary();
	} catch {
		return false;
	}
	return deviceNeedsRecoveryKeyRegistration(summary);
}
