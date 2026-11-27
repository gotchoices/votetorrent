/**
 * A cadre-core `DurableSlot` over AsyncStorage, and the two node-local stores a joined voter
 * needs to survive a restart (spike 100).
 *
 * WHY. A voter joins the authority's cadre by redeeming a cadre invitation, which pins the
 * invitation's owner keys into the node's trusted-owner ANCHOR. Without an injected store that
 * anchor is in-memory: measured on real CadreNodes (spike 100 `product-join.ts`,
 * TRUST_STORE=memory), a restarted voter held 0 anchored owners and could no longer verify its
 * own admission row. The bootstrap-peer store keeps the dial target the redemption retained
 * (cadre-core `retainDialTarget`) for the cold-start reconcile. Both are NON-replicated and
 * per-party; nothing in either is secret.
 *
 * Copied from the Authority's `engines/rn-durable-slot.ts` (itself adapted from sereus-chat).
 *
 * THE FAULT/ABSENT DISTINCTION IS LOAD-BEARING (cadre-core's own contract). `undefined` means
 * "cold start, nothing was ever written", and the caller then snapshot-writes the whole record.
 * So a read that FAILS must throw. It must never be caught into `undefined`, or a transient
 * AsyncStorage error would destroy an intact anchor on the next save.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	PersistentBootstrapPeerStore,
	PersistentTrustedOwnerStore,
	type BootstrapPeerStore,
	type DurableSlot,
	type TrustedOwnerStore,
} from '@serfab/cadre-core';

export class AsyncStorageDurableSlot implements DurableSlot {
	constructor(private readonly key: string) {}

	async load(): Promise<string | undefined> {
		// A rejection propagates on purpose (see header): absence is `null` from a RESOLVED call.
		const raw = await AsyncStorage.getItem(this.key);
		return raw ?? undefined;
	}

	async save(text: string): Promise<void> {
		await AsyncStorage.setItem(this.key, text);
	}
}

/** The voter node's trusted-owner anchor, namespaced by store scope and party. */
export function openTrustedOwnerStore(partyId: string, scope: string): Promise<TrustedOwnerStore> {
	return PersistentTrustedOwnerStore.open(new AsyncStorageDurableSlot(`@votetorrent/trustedOwners/${scope}/${partyId}`), partyId);
}

/** The voter node's cold-start bootstrap-peer store, namespaced like the anchor. */
export function openBootstrapPeerStore(partyId: string, scope: string): Promise<BootstrapPeerStore> {
	return PersistentBootstrapPeerStore.open(new AsyncStorageDurableSlot(`@votetorrent/bootstrapPeers/${scope}/${partyId}`), partyId);
}
