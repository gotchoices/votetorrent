/**
 * A cadre-core `DurableSlot` over AsyncStorage, and the strand network state that sits on it.
 *
 * WHY. cadre-core 1.9.0 saves each strand node's NETWORK STATE per strand: Optimystic db-p2p's FRET
 * routing table, every entry carrying the peer's signed address record, plus the network-size
 * high-water mark and which peers it saw serving the strand. db-p2p re-imports it when the strand
 * node is next built, so a restarted phone dials the strand peers it was talking to before anything
 * else, instead of depending solely on the control-cohort strand-addr RPC. That RPC path is where
 * P2P-11 kept breaking (the late-enrolment gap, sereus#21's throttle, sereus#22's masking).
 * Without an injected store the state is in-memory and dies with the process. On a phone every
 * launch is a restart; the proof's D-05 relaunch is one too.
 *
 * It replaces 1.7.0's strand PEER BOOK (spike 094), which 1.9.0 deleted: the saved FRET table now
 * does that job. The old `@votetorrent/strandPeerBook/...` AsyncStorage keys are no longer read.
 *
 * Adapted from sereus-chat `apps/mobile/src/cadre/rn-durable-slot.ts`. We omit its `RNKeyStore` /
 * `joinedStrands` half: that records strands joined from ANOTHER party, while VoteTorrent's
 * strands arrive over this party's own control network and are re-offered from its rows.
 *
 * THE FAULT/ABSENT DISTINCTION IS LOAD-BEARING (cadre-core's own contract). `undefined` means
 * "cold start, nothing was ever written", and the caller then snapshot-writes the whole record.
 * So a read that FAILS must throw. It must never be caught into `undefined`, or a transient
 * AsyncStorage error would destroy an intact book on the next save.
 *
 * It also holds the trusted-owner anchor (D-08, phase 64): the saved set of owner keys this party's
 * `isAuthorizedMember` checks admissions against. Without it a restart leaves an in-memory anchor
 * and every voter is refused at the pool rendezvous.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PersistentStrandNetworkStateStore,
  PersistentTrustedOwnerStore,
  type DurableSlot,
  type StrandNetworkStateStore,
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

/**
 * The strand network state for one node, namespaced by party AND by store scope. Two nodes on one
 * device (the app's own and a proof runner's) must never share one.
 */
export function openStrandNetworkState(partyId: string, scope: string): Promise<StrandNetworkStateStore> {
  return PersistentStrandNetworkStateStore.open(
    new AsyncStorageDurableSlot(`@votetorrent/strandNetworkState/${scope}/${partyId}`),
    partyId,
  );
}

/**
 * The trusted-owner anchor for one node (D-08). The anchor is per PARTY, not per network, and
 * namespaced by store scope so two nodes on one device never share a slot.
 *
 * Plain AsyncStorage is deliberate: owner pins are public integrity data, not secrets.
 * `open` rejects only when the slot cannot be READ (the D-10 trigger). A corrupt, foreign-party or
 * unknown-version record loads EMPTY instead; owner-trust.ts classification and the boot re-anchor
 * cover that case. Never point two nodes at one scope.
 */
export function openTrustedOwnerStore(partyId: string, scope: string): Promise<TrustedOwnerStore> {
  return PersistentTrustedOwnerStore.open(
    new AsyncStorageDurableSlot(`@votetorrent/trustedOwners/${scope}/${partyId}`),
    partyId,
  );
}
