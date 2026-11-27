/**
 * identity-owner-key.ts — binding. The adapter moved to
 * `packages/workflows/src/authority/identity-owner-key.ts` (phase 67 plan 07) so the vt CLI shares it.
 * This path stays so existing imports, tests and jest mocks keep working, and it is the one place the
 * app supplies its cadre-core helpers: the shared code takes them as a required parameter because the
 * shared authority subpath must load where cadre-core's import-only `exports` cannot be resolved.
 * The forwarders read the cadre-core export at call time, so every virtual mock and per-test
 * `jest.doMock` keeps governing the derivation exactly as before.
 */
import { ed25519KeyPairFromLibp2p, softwareOwnerSigner } from '@serfab/cadre-core';
import { withIdentityOwnerKey as sharedWithIdentityOwnerKey, type WithIdentityOwnerKey } from '@votetorrent/workflows/authority';

export type { IdentityOwnerSigner, IdentityOwnerKey, WithIdentityOwnerKey } from '@votetorrent/workflows/authority';

/**
 * Add `getIdentityOwnerKey()` and `getIdentityOwnerSigner()` to `node`, both derived from
 * `identityKey` on first use through the app's cadre-core. Returns the same node.
 */
export function withIdentityOwnerKey<T extends object>(
	node: T,
	identityKey: Parameters<typeof sharedWithIdentityOwnerKey>[1],
): WithIdentityOwnerKey<T> {
	return sharedWithIdentityOwnerKey(node, identityKey, {
		ed25519KeyPairFromLibp2p: (key) => ed25519KeyPairFromLibp2p(key),
		softwareOwnerSigner: (privateKeyB64) => softwareOwnerSigner(privateKeyB64),
	});
}
