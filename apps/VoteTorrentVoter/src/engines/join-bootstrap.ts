/**
 * join-bootstrap.ts — the dial targets a network join leaves behind for the next launch.
 *
 * `bootstrap.config.json` ships EMPTY (a reported config fault: an app with no peers cannot join
 * anything). A join code's cadre invitation names the authority's member machines; once the
 * invitation is redeemed those addresses are this phone's bootstrap, so they are kept here and
 * merged into `controlNetwork.bootstrapNodes` at the next boot (CadreNodeProvider). They are dial
 * hints only — every address is re-bound to its peer id before a dial, and trust comes from the
 * pinned owner keys, never from this list.
 *
 * Bounded with the same limits `bootstrap-config.ts` puts on the shipped document.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {BOOTSTRAP_ADDR_MAX_LENGTH, BOOTSTRAP_CONFIG_MAX_ADDRS} from '../config/bootstrap-config';

export const JOIN_BOOTSTRAP_KEY = '@votetorrent/voterJoinBootstrap';
/** The hashes of networks this phone joined from a join code (boot reopens the most recent one). */
export const JOINED_NETWORKS_KEY = '@votetorrent/voterJoinedNetworks';

/** Keep only plausible multiaddr strings, deduplicated, within the config limits. */
export function sanitizeJoinBootstrap(addrs: unknown): string[] {
	if (!Array.isArray(addrs)) {
		return [];
	}
	const out: string[] = [];
	for (const addr of addrs) {
		if (typeof addr !== 'string') continue;
		const trimmed = addr.trim();
		if (!trimmed.startsWith('/') || trimmed.length > BOOTSTRAP_ADDR_MAX_LENGTH || !trimmed.includes('/p2p/')) continue;
		if (!out.includes(trimmed)) out.push(trimmed);
		if (out.length >= BOOTSTRAP_CONFIG_MAX_ADDRS) break;
	}
	return out;
}

/** The addresses a previous join stored; [] when there are none or the record is unreadable. */
export async function readJoinBootstrap(): Promise<string[]> {
	try {
		const raw = await AsyncStorage.getItem(JOIN_BOOTSTRAP_KEY);
		return raw ? sanitizeJoinBootstrap(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

/** Replace the stored addresses with the ones a join just used. */
export async function rememberJoinBootstrap(addrs: readonly string[]): Promise<void> {
	await AsyncStorage.setItem(JOIN_BOOTSTRAP_KEY, JSON.stringify(sanitizeJoinBootstrap([...addrs])));
}

/** Hashes of networks this phone joined; [] when none or unreadable. */
export async function readJoinedNetworkHashes(): Promise<string[]> {
	try {
		const raw = await AsyncStorage.getItem(JOINED_NETWORKS_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string' && h.length > 0) : [];
	} catch {
		return [];
	}
}

/** Record that this phone joined `hash` (idempotent). */
export async function rememberJoinedNetwork(hash: string): Promise<void> {
	const hashes = await readJoinedNetworkHashes();
	if (!hashes.includes(hash)) {
		await AsyncStorage.setItem(JOINED_NETWORKS_KEY, JSON.stringify([...hashes, hash]));
	}
}
