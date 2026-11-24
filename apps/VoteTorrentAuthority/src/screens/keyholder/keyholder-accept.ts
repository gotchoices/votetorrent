/**
 * keyholder-accept.ts — thin binding. The keyholder accept driver moved to
 * `packages/workflows/src/authority/keyholder-accept.ts` (phase 67 plan 14); this path stays so existing
 * imports, `jest.mock` targets and tests keep working. The shared code has NO default store (`storage` is
 * required there); this binding supplies the app's AsyncStorage as the default store, the SAME object the
 * keyholder-identity binding uses, so the shared per-storage mutex keeps serializing every app write of the
 * identity store. No workflow logic lives here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { acceptKeyholderInvitation as sharedAcceptKeyholderInvitation } from '@votetorrent/workflows/authority';
import type { KeyholderAcceptDeps as SharedKeyholderAcceptDeps } from '@votetorrent/workflows/authority';
import type { KeyVaultStorage } from '../../engines/key-vault';

export type { SeatFacts } from '@votetorrent/workflows/authority';

/** The app's platform store, passed as the same object on every call (see the header). */
const appStorage = AsyncStorage as unknown as KeyVaultStorage;

/** App-facing shape: `storage` stays optional here and defaults to the app store. */
export interface KeyholderAcceptDeps extends Omit<SharedKeyholderAcceptDeps, 'storage'> {
	storage?: KeyVaultStorage;
}

export function acceptKeyholderInvitation(deps: KeyholderAcceptDeps, shareText: string): Promise<{ userId: string; slotCid: string }> {
	return sharedAcceptKeyholderInvitation({ ...deps, storage: deps.storage ?? appStorage }, shareText);
}
