/**
 * keyholder-vault.ts — Phase 62 Plan 26 (D-16). The auth-required `IKeyVault` every keyholder
 * secret in this app lives in.
 *
 * Four points:
 *  1. The wrap alias below follows 62-08's `VOTETORRENT_<APP>_<PURPOSE>_WRAP_KEY_V<n>` naming rule
 *     and is `requireAuth: true`, forever — one alias is one fixed auth policy (62-08's
 *     `WRAP_KEY_POLICY_MISMATCH` enforces this natively and in `key-vault.ts`'s own construction
 *     check). It is never reused for a `requireUserAuth: false` secret.
 *  2. Every keyholder secret this app ever holds is wrapped under this ONE alias (since the
 *     prompt-batching change, directly for legacy seats and through one per-seat key for new seats,
 *     see `keyholder-seat-vault.ts`): the fresh
 *     signing key and DKG receiving key minted at accept (`keyholder-identity.ts`), 62-17's
 *     in-progress round secrets, and the final share (`keyholderDkgShareAlias`). D-16: a device
 *     holds only ITS OWN share — nothing in this app ever reconstructs the joint election key or
 *     a group secret.
 *  3. This file never edits `./key-vault.ts` — 62-21's `createAuthorityKeyVault` exposes the
 *     `authRequiredWrap` injection seam exactly so a consumer like this one can add a new
 *     auth-required alias without touching that file.
 *  4. 62-08's native wrap on iOS is a Keychain AES key, NOT Secure Enclave-backed. Hardware
 *     behaviour (both platforms), the BiometricPrompt/LAContext prompt itself, and biometric
 *     re-enrolment invalidation are code-complete and unverified on real hardware (D-23) — carried
 *     to 62-30.
 */

import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { createNativeSecretSealer, createNativeSecretWrapper } from '@votetorrent/attestation-native';
import type { SecretWrapPrompt } from '@votetorrent/attestation-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAuthorityKeyVault } from './key-vault';
import type { KeyVaultStorage } from './key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1, createKeyholderSeatVault } from './keyholder-seat-vault';

/** requireAuth true, forever — point 1 above. */
export const VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1 = 'VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1';

/** Resolved fresh on every wrap/unwrap call (never cached), so a locale change between calls is
 * honored. Reuses the existing `deviceSigningPrompt*` catalog keys (same biometric-confirmation
 * copy every other auth-required prompt in this app uses).
 *
 * `../i18n` is required LAZILY (call time, not module-load time): that module calls
 * `i18n.use(initReactI18next).init(...)` at its own module scope, and `engine-factory.ts` (which
 * imports `resolveKeyholderKeyVault` below) is reachable from nearly every screen's test. A
 * top-level import here would force every such test to supply a working `initReactI18next` mock,
 * even when nothing in that test ever wraps or unwraps a keyholder secret. Deferring the require
 * to the moment a prompt is actually needed keeps every other screen's test unaffected. */
export function keyholderVaultPrompt(): SecretWrapPrompt {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const i18n = require('../i18n').default as { t: (key: string) => string };
	return {
		title: i18n.t('deviceSigningPromptTitle'),
		subtitle: i18n.t('deviceSigningPromptSubtitle'),
		negativeButton: i18n.t('deviceSigningPromptNegativeButton'),
	};
}

let defaultVault: IKeyVault | undefined;
let testOverride: IKeyVault | undefined;

/** Test override: `undefined` restores the lazy default (built once, on first use after the
 * override is cleared). */
export function setKeyholderKeyVaultForTests(vault: IKeyVault | undefined): void {
	testOverride = vault;
}

/** The test override if set, else a lazily-built singleton: `keyholder-seat-vault.ts`'s seat vault
 * (one prompt per keyholder session for every seat accepted from now on; new seat keys sealed to the
 * native seal key, so an accept costs no prompt) over 62-21's
 * `createAuthorityKeyVault` with this file's auth-required alias injected through the
 * `authRequiredWrap` seam (point 3 above). The inner vault keeps serving 62-21's
 * `requireUserAuth: false` officer-encryption secrets and every legacy (pre-seat) keyholder secret.
 * Both layers share one native wrapper and one storage. */
export function resolveKeyholderKeyVault(): IKeyVault {
	if (testOverride !== undefined) return testOverride;
	if (defaultVault === undefined) {
		const wrapper = createNativeSecretWrapper();
		const storage = AsyncStorage as unknown as KeyVaultStorage;
		const inner = createAuthorityKeyVault({
			wrapper,
			storage,
			authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
		});
		defaultVault = createKeyholderSeatVault({
			inner,
			wrapper,
			storage,
			wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
			prompt: keyholderVaultPrompt,
			sealer: createNativeSecretSealer(),
			sealKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1,
		});
	}
	return defaultVault;
}
