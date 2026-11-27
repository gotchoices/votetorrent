/**
 * attach-peer-sync-binding.ts — Authority binding (67-09). The peer sync binding's logic moved to
 * `packages/workflows/src/authority/attach-peer-sync-binding.ts`; this path stays so existing imports,
 * `jest.mock` paths and screens keep working. It is where the app supplies its native-wrapped vault
 * (`resolveAuthorityKeyVault`), passed by FUNCTION REFERENCE so the vault is still resolved lazily,
 * once per sync, never at boot-time attach. The registry write stays here (D-28).
 */
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	createPeerSyncBinding as createSharedPeerSyncBinding,
	createRegistrationDecisionPublisher,
	type PeerSyncBindingDeps as SharedPeerSyncBindingDeps,
} from '@votetorrent/workflows/authority';
import { registerSyncBinding, type SyncBindingHandle } from './bulk-import-sync-model';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';

export { createRegistrationDecisionPublisher };

/** The old shape: `resolveVault` is optional here and defaults to the app vault. */
export interface PeerSyncBindingDeps extends Omit<SharedPeerSyncBindingDeps, 'resolveVault'> {
	resolveVault?: () => IKeyVault;
}

export function createPeerSyncBinding(deps: PeerSyncBindingDeps): SyncBindingHandle {
	// A live view of `deps`, as the old closure was: every member is read at sync time, so a caller
	// that swaps `getEngine` after attach is honoured, and the app vault is resolved per sync.
	return createSharedPeerSyncBinding({
		get getEngine() {
			return deps.getEngine;
		},
		get createTransports() {
			return deps.createTransports;
		},
		get createSigner() {
			return deps.createSigner;
		},
		resolveVault: () => (deps.resolveVault ?? resolveAuthorityKeyVault)(),
	});
}

/** Registers the 'peer' binding unconditionally (D-28 — no dev-only build gate). */
export function attachPeerSyncBinding(deps: PeerSyncBindingDeps): void {
	registerSyncBinding(createPeerSyncBinding(deps));
}
