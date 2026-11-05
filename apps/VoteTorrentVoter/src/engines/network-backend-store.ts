/**
 * network-backend-store.ts — which store CREATED each network this Voter founded (UAT 65 gap 4, D-98).
 *
 * A fresh iPhone Debug install launches twice. Launch 1 seeds the dev network on the SOLO store
 * (the CadreNode is not up yet). Launch 2 re-attaches it once the node is set, and the node-based
 * dispatch would open an empty strand store as a JOINER that waits for a Header nobody can push.
 * Recording the creating store per network hash lets the dispatcher re-open a solo-created network
 * on the solo store.
 *
 * Written only when a create's founding window is consumed; a joined or never-created hash has no
 * record and keeps the node-based dispatch. Non-secret (a network hash and a store name); no logging.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const NETWORK_BACKEND_KEY_PREFIX = 'votetorrent.networkBackend.';

export type NetworkBackend = 'solo' | 'strand';

/** The creating store for this network; a missing, unreadable or foreign value reads null. */
export async function readNetworkBackend(hash: string): Promise<NetworkBackend | null> {
	try {
		const raw = await AsyncStorage.getItem(`${NETWORK_BACKEND_KEY_PREFIX}${hash}`);
		return raw === 'solo' || raw === 'strand' ? raw : null;
	} catch {
		return null;
	}
}

export async function recordNetworkBackend(hash: string, backend: NetworkBackend): Promise<void> {
	await AsyncStorage.setItem(`${NETWORK_BACKEND_KEY_PREFIX}${hash}`, backend);
}
