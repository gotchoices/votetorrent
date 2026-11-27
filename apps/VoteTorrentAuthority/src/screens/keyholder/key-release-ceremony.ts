/**
 * key-release-ceremony.ts — thin binding. The share release ceremony moved to
 * `packages/workflows/src/authority/key-release-ceremony.ts` (phase 67 plan 14); this path stays so existing
 * imports, `jest.mock` targets and tests keep working. The shared code has NO default store (`storage` is
 * required there); this binding supplies the app's AsyncStorage as the default store, the SAME object the
 * keyholder-identity binding uses, so the shared per-storage mutex keeps serializing every app write of the
 * identity store. No workflow logic lives here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReleaseKeyTask } from '@votetorrent/vote-core';
import { releaseKeyholderShare as sharedReleaseKeyholderShare } from '@votetorrent/workflows/authority';
import type { KeyReleaseCeremonyDeps as SharedKeyReleaseCeremonyDeps, KeyReleaseCeremonyOutcome } from '@votetorrent/workflows/authority';
import type { KeyVaultStorage } from '../../engines/key-vault';

export { keyReleaseErrorCopyKey } from '@votetorrent/workflows/authority';
export type { KeyReleaseCeremonyOutcome } from '@votetorrent/workflows/authority';

/** The app's platform store, passed as the same object on every call (see the header). */
const appStorage = AsyncStorage as unknown as KeyVaultStorage;

/** App-facing shape: `storage` stays optional here and defaults to the app store. */
export interface KeyReleaseCeremonyDeps extends Omit<SharedKeyReleaseCeremonyDeps, 'storage'> {
	storage?: KeyVaultStorage;
}

export function releaseKeyholderShare(deps: KeyReleaseCeremonyDeps, task: ReleaseKeyTask): Promise<KeyReleaseCeremonyOutcome> {
	return sharedReleaseKeyholderShare({ ...deps, storage: deps.storage ?? appStorage }, task);
}
