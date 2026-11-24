/**
 * workflows-platform-parity.test.ts (phase 67 plan 03).
 *
 * `engines/key-vault.ts` re-exports `KeyVaultStorage` from `@votetorrent/workflows/platform`. This file
 * pins that re-export, the platform `KvStorage` alias and the app's device-signer `SignCallback` (the
 * D-09 frozen shape) to the platform copies with a strict compile-time `Equal<>`, so any drift fails
 * `yarn typecheck` on this file. Every import is `import type`, so jest never loads the shared package at
 * runtime; the one `it` only makes jest report the file.
 */

import type AsyncStorage from '@react-native-async-storage/async-storage';
import type {
	KeyVaultStorage as PlatformKeyVaultStorage,
	KvStorage,
	SignCallback as PlatformSignCallback,
} from '@votetorrent/workflows/platform';
import type { SignCallback as AppSignCallback } from '../device-signer';
import type { KeyVaultStorage as AppKeyVaultStorage } from '../key-vault';

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assignable<A, B> = [A] extends [B] ? true : false;

const keyVaultStorageReexport: Equal<AppKeyVaultStorage, PlatformKeyVaultStorage> = true;
const keyVaultStorageIsKvStorage: Equal<AppKeyVaultStorage, KvStorage> = true;
const signCallbackParity: Equal<AppSignCallback, PlatformSignCallback> = true;
const appStoreIsKvStorage: Assignable<typeof AsyncStorage, KvStorage> = true;

describe('workflows platform parity (Authority)', () => {
	it('the compile-time pins hold (checked by yarn typecheck)', () => {
		expect([keyVaultStorageReexport, keyVaultStorageIsKvStorage, signCallbackParity, appStoreIsKvStorage]).toEqual([
			true,
			true,
			true,
			true,
		]);
	});
});
