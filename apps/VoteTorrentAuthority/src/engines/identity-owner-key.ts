/**
 * identity-owner-key.ts — keeps this Authority's cadre owner key equal to its node identity key on
 * @serfab/cadre-core 1.18.
 *
 * Every Authority cadre founded so far anchors its owner on the node's identity key: owner genesis
 * (`ensureVoterInviteOwner`) inserts the identity public key as the genesis `OwnerKey` row, and the
 * boot re-anchor (`reanchorOwnKey`) wires it back on every start. cadre-core 1.18 removed both halves
 * of that (sereus tickets 1.08 "phone and web kits hold a separate owner key" and 2.4 "machine
 * invitation grants no ownership"):
 *  - `CadreNode.getIdentityOwnerKey()` is deleted;
 *  - `wireOwnKeyIfOwner()` with no argument now tries only a signer already wired, never the identity
 *    key ("a machine's network identity is never an owner key"), so an Authority would boot unable to
 *    sign anything as owner (no voter invitations, no re-issues).
 * cadre-core still accepts an identity-derived key as an owner when it is handed one explicitly
 * (`wireOwnKeyIfOwner(signer)`, `initializeSeedBootstrap(privateKeyB64)`). So this adapter gives the
 * node back `getIdentityOwnerKey()`, derived from the identity private key the provider already holds,
 * plus `getIdentityOwnerSigner()`, which `reanchorOwnKey` hands to `wireOwnKeyIfOwner`. Both are
 * derived on first use, so building the node never throws. A separate owner key (upstream's
 * `cadre/owner` slot, with export and backup) is a product decision this adapter deliberately does not
 * take.
 */
import { ed25519KeyPairFromLibp2p, softwareOwnerSigner } from '@serfab/cadre-core';

/** The node's libp2p identity key, as cadre-core's own helper takes it. */
type IdentityKey = Parameters<typeof ed25519KeyPairFromLibp2p>[0];

/** An owner signer over the identity key (cadre-core's `OwnerSigner`). */
export type IdentityOwnerSigner = ReturnType<typeof softwareOwnerSigner>;

/** The owner key pair derived from the node identity, in cadre-core's base64url forms. */
export interface IdentityOwnerKey {
	readonly publicKeyB64: string;
	readonly privateKeyB64: string;
}

/** A node with the identity owner key restored by {@link withIdentityOwnerKey}. */
export type WithIdentityOwnerKey<T> = T & {
	getIdentityOwnerKey(): IdentityOwnerKey;
	getIdentityOwnerSigner(): IdentityOwnerSigner;
};

/**
 * Add `getIdentityOwnerKey()` (cadre-core 1.16's shape) and `getIdentityOwnerSigner()` to `node`,
 * both derived from `identityKey` on first use. Returns the same node. Either throws for a
 * non-Ed25519 identity, as cadre-core 1.16's `getIdentityOwnerKey` did.
 */
export function withIdentityOwnerKey<T extends object>(node: T, identityKey: IdentityKey): WithIdentityOwnerKey<T> {
	let owner: IdentityOwnerKey | null = null;
	const adapted = node as WithIdentityOwnerKey<T>;
	adapted.getIdentityOwnerKey = () => {
		if (owner === null) {
			const pair = ed25519KeyPairFromLibp2p(identityKey);
			owner = { publicKeyB64: pair.publicKeyB64, privateKeyB64: pair.privateKeyB64 };
		}
		return owner;
	};
	adapted.getIdentityOwnerSigner = () => softwareOwnerSigner(adapted.getIdentityOwnerKey().privateKeyB64);
	return adapted;
}
