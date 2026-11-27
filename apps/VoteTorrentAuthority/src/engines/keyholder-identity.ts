/**
 * keyholder-identity.ts — thin binding. Identity provisioning, the public identity store and the
 * per-signature signer moved to `packages/workflows/src/authority/keyholder-identity.ts` (phase 67
 * plan 05); this path stays so existing imports and tests keep working. The shared code has NO default
 * store (`storage` is required there); this file is the ONE place the app supplies its platform store,
 * and it keeps the old optional-storage signatures for the app callers. No workflow logic lives here.
 *
 * `appStorage` is a single module-level object (the store module's default export itself), so the
 * shared per-storage mutex keeps serializing every app read-modify-write of the identity store exactly
 * as before; a fresh adapter per call would split that lock.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	provisionKeyholderIdentity as sharedProvisionKeyholderIdentity,
	discardKeyholderIdentity as sharedDiscardKeyholderIdentity,
	getKeyholderIdentity as sharedGetKeyholderIdentity,
	listKeyholderIdentities as sharedListKeyholderIdentities,
} from '@votetorrent/workflows/authority';
import type { KeyholderIdentityRecord, ProvisionedKeyholderIdentity } from '@votetorrent/workflows/authority';
import type { KeyVaultStorage } from './key-vault';

export {
	KEYHOLDER_IDENTITY_STORAGE_KEY,
	KEYHOLDER_SIGNING_KEY_POLICY,
	keyholderSigningKeyAlias,
	KEYHOLDER_SIGNING_KEY_LIFETIME_MS,
	KeyholderIdentityError,
	createKeyholderSigner,
} from '@votetorrent/workflows/authority';
export type { KeyholderIdentityRecord, ProvisionedKeyholderIdentity, KeyholderIdentityErrorCode } from '@votetorrent/workflows/authority';

/** The app's platform store, passed as the same object on every call (see the header). */
const appStorage = AsyncStorage as unknown as KeyVaultStorage;

/** App-facing shape: `storage` stays optional here and defaults to the app store. */
export interface KeyholderIdentityDeps {
	vault: IKeyVault;
	storage?: KeyVaultStorage;
}

export function provisionKeyholderIdentity(deps: KeyholderIdentityDeps, inviteSlotCid: string): Promise<ProvisionedKeyholderIdentity> {
	return sharedProvisionKeyholderIdentity({ vault: deps.vault, storage: deps.storage ?? appStorage }, inviteSlotCid);
}

export function discardKeyholderIdentity(deps: KeyholderIdentityDeps, userId: string): Promise<void> {
	return sharedDiscardKeyholderIdentity({ vault: deps.vault, storage: deps.storage ?? appStorage }, userId);
}

export function getKeyholderIdentity(userId: string, storage?: KeyVaultStorage): Promise<KeyholderIdentityRecord | undefined> {
	return sharedGetKeyholderIdentity(userId, storage ?? appStorage);
}

export function listKeyholderIdentities(storage?: KeyVaultStorage): Promise<KeyholderIdentityRecord[]> {
	return sharedListKeyholderIdentities(storage ?? appStorage);
}
