/**
 * keyholder-dkg-driver.ts — thin binding. The pull-only DKG driver and the row-state mapping moved to
 * `packages/workflows/src/authority/keyholder-dkg-driver.ts` (phase 67 plan 14); this path stays so existing
 * imports, `jest.mock` targets and tests keep working. The shared code has NO default store (`storage` is
 * required there); this binding supplies the app's AsyncStorage as the default store, the SAME object the
 * keyholder-identity binding uses, so the shared per-storage mutex keeps serializing every app write of the
 * identity store. No workflow logic lives here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { driveKeyholderDkg as sharedDriveKeyholderDkg } from '@votetorrent/workflows/authority';
import type { KeyholderDkgDriverDeps as SharedKeyholderDkgDriverDeps, KeyholderDkgDriverOutcome } from '@votetorrent/workflows/authority';
import type { KeyVaultStorage } from '../../engines/key-vault';

export { keyholderDkgRowState } from '@votetorrent/workflows/authority';
export type { KeyholderDkgRowState, KeyholderDkgDriverOutcome } from '@votetorrent/workflows/authority';

/** The app's platform store, passed as the same object on every call (see the header). */
const appStorage = AsyncStorage as unknown as KeyVaultStorage;

/** App-facing shape: `storage` stays optional here and defaults to the app store. */
export interface KeyholderDkgDriverDeps extends Omit<SharedKeyholderDkgDriverDeps, 'storage'> {
	storage?: KeyVaultStorage;
}

export function driveKeyholderDkg(deps: KeyholderDkgDriverDeps, electionId: string, keyholderUserId: string | undefined): Promise<KeyholderDkgDriverOutcome> {
	return sharedDriveKeyholderDkg({ ...deps, storage: deps.storage ?? appStorage }, electionId, keyholderUserId);
}
