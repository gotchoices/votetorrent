import { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import type { INetworkEngine } from "@votetorrent/vote-core";
import { useApp } from "../providers/AppProvider";
import {
	shouldPromptRecoveryKeyRegistration,
	type RegisteredKeyHolder,
} from "../engines/recovery-key-registration";
import type { NavigationProp } from "../navigation/types";

/**
 * Routes an officer into the recovery-key registration ceremony once — and only once —
 * a network exists for it to register against.
 *
 * WHY THIS EXISTS (49-19, recovery-key-registration gap)
 * `networks-engine.create()` registers ONLY the founding signing key: its bootstrap
 * branch writes `user.activeKeys[0]` and has no analog for a second key. The recovery
 * key is registered exclusively by `ProvisionSigningKeyScreen`'s stage 2, which requires
 * a resolvable network `User` and therefore CANNOT run until after create/join. Nothing
 * previously brought the officer back to it, so a device that provisioned, created or
 * joined a network, and never revisited Settings carried an unregistered recovery key
 * indefinitely — one biometric enrolment away from being permanently stranded, because
 * `addKey` needs a valid signing key and only the recovery key can replace an
 * invalidated one. The single recorded escape was a destructive `pm clear`, which also
 * drops the app's Keystore entries. Measured unregistered on BOTH fleet devices
 * (49-14 proof log §G.3).
 *
 * WHY A HOOK, NOT A `navigation.navigate` IN EACH SCREEN
 * `deviceSigningRollout.coverage.test.ts` pins a deliberate architectural contract: the
 * `ProvisionSigningKey` navigation target is referenced from the shared hooks and the
 * Settings entry point only, never duplicated per screen. Scattering the target across
 * call sites is exactly how the original rollout drifted. This hook keeps the new
 * create/join trigger inside that contract — the screens ask a question, the hook owns
 * the navigation.
 *
 * The ceremony it routes to is idempotent and reconciling (it registers only the keys
 * the network `User` is missing), so an unnecessary trip is harmless — but the gate
 * still checks first so officers with nothing to do are not shown a ceremony screen.
 */
/**
 * `replaceCurrent`: the calling screen is finished (a create or join just succeeded), so the
 * ceremony REPLACES it rather than stacking on top. The ceremony leaves with `goBack()`, which
 * would otherwise land the officer back on the finished form (Add Network or the join details)
 * with the network already created -- measured on a release APK, 2026-10-31.
 */
export interface RecoveryKeyGateOptions {
	replaceCurrent?: boolean;
}

export function useRecoveryKeyRegistrationGate(): (options?: RecoveryKeyGateOptions) => Promise<boolean> {
	const navigation = useNavigation<NavigationProp>();
	const { getEngine } = useApp();

	return useCallback(async (options?: RecoveryKeyGateOptions) => {
		let observed: RegisteredKeyHolder | undefined;
		const needed = await shouldPromptRecoveryKeyRegistration(async () => {
			const engine = await getEngine<INetworkEngine>("network");
			const userEngine = await engine.getCurrentUser();
			observed = userEngine ? await userEngine.getSummary() : undefined;
			return observed;
		});
		// Dev-only instrument: emit the gate's INPUTS alongside its verdict so an on-device run
		// can tell the three outcomes apart, which the navigation alone cannot. A gate that does
		// not fire is ambiguous by construction -- "the recovery key is already registered"
		// (nothing to do) and "no network User resolved" (a DISTINCT condition, see
		// `needsRecoveryKeyRegistration`'s doc comment) both return false and both look like
		// silence from outside.
		//
		// The AsyncStorage `deviceUser.activeKeys` blob is NOT a substitute instrument: it is
		// single-element BY DESIGN (`persistProvisionedDeviceUser` writes exactly one key, and
		// `device-user.ts` documents why the recovery key must not land in `activeKeys[1]`), so
		// reading it back would report the signing key alone whether or not registration
		// succeeded. The network `User`'s key set, logged here, is where a registered recovery
		// key actually appears.
		//
		// Safe to log: compressed PUBLIC keys only, never key material. __DEV__-gated so release
		// builds stay silent.
		if (__DEV__) {
			console.log(
				"[ceremony-recovery-gate]",
				JSON.stringify({
					needed,
					networkUserResolved: observed !== undefined,
					activeKeys: (observed?.activeKeys ?? []).map((k) => k.key),
				}),
			);
		}
		if (needed) {
			if (options?.replaceCurrent && navigation.replace) {
				navigation.replace("ProvisionSigningKey", { reason: "first-run" });
			} else {
				navigation.navigate("ProvisionSigningKey", { reason: "first-run" });
			}
		}
		return needed;
	}, [getEngine, navigation]);
}
