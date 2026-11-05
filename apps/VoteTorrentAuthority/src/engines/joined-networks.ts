/**
 * D-30: the persisted list of network hashes this Authority JOINED (as opposed to founded).
 * A hash on this list never opens as founder (see `resolveFounderFlag`), which is what stops a
 * cold restart with zero control connections from forking a joined network.
 *
 * Deliberate departure from the Voter's `readJoinedNetworkHashes`, which swallows every read error
 * and returns []: that makes its refusal unreachable and turns an I/O failure into a fork. This
 * reader REJECTS `JoinedNetworksUnreadableError` on an I/O failure, corrupt JSON or a non-array
 * value, and `rememberJoinedNetwork` never writes over a list it could not read. Never logs.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { JoinedNetworksUnreadableError } from './founder-intent';

export const AUTHORITY_JOINED_NETWORKS_KEY = '@votetorrent/authorityJoinedNetworks';

function isHash(hash: unknown): hash is string {
	return typeof hash === 'string' && hash.length > 0;
}

/** [] when absent; rejects `JoinedNetworksUnreadableError` when unreadable, corrupt or not an array. */
export async function readJoinedNetworkHashes(): Promise<string[]> {
	let raw: string | null;
	try {
		raw = await AsyncStorage.getItem(AUTHORITY_JOINED_NETWORKS_KEY);
	} catch {
		throw new JoinedNetworksUnreadableError();
	}
	if (raw === null || raw === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new JoinedNetworksUnreadableError();
	}
	if (!Array.isArray(parsed)) throw new JoinedNetworksUnreadableError();
	const seen = new Set<string>();
	for (const item of parsed) {
		if (isHash(item)) seen.add(item);
	}
	return [...seen];
}

/** Rejects if the list is unreadable. */
export async function isJoinedNetwork(hash: string): Promise<boolean> {
	return (await readJoinedNetworkHashes()).includes(hash);
}

/** Idempotent. TypeError on a bad hash. Never writes over an unreadable list. */
export async function rememberJoinedNetwork(hash: string): Promise<void> {
	if (!isHash(hash)) {
		throw new TypeError('rememberJoinedNetwork needs a network hash');
	}
	const hashes = await readJoinedNetworkHashes();
	if (hashes.includes(hash)) return;
	await AsyncStorage.setItem(AUTHORITY_JOINED_NETWORKS_KEY, JSON.stringify([...hashes, hash]));
}
