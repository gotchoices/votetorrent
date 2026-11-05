/**
 * join-bootstrap.ts — the dial targets a network join leaves behind for the next launch.
 *
 * A joined Authority install (a keyholder install, D-18, or a D-09 re-invite) may ship with no
 * relay config. A join code's cadre invitation names the member machines; once the invitation is
 * redeemed those addresses are this install's bootstrap, so they are kept here and merged into
 * `controlNetwork.bootstrapNodes` at the next boot (CadreNodeProvider). They are dial hints only:
 * trust comes from the pinned owner keys, never from this list.
 *
 * Every address is peer-id-pinned (`isBootstrapAddr`, T-56-10-01) and the list is bounded with the
 * limits `bootstrap-config.ts` puts on the shipped document. Unlike the Voter's copy it keeps
 * RELAY-CIRCUIT addresses only. The key differs from the Voter's and from the joined list of
 * `joined-networks.ts`. Per D-26 and the planning notes' deviation 9 (research M4), it mirrors
 * `apps/VoteTorrentVoter/src/engines/join-bootstrap.ts`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {BOOTSTRAP_CONFIG_MAX_ADDRS, isBootstrapAddr} from '../config/bootstrap-config';

export const AUTHORITY_JOIN_BOOTSTRAP_KEY = '@votetorrent/authorityJoinBootstrap';

/**
 * The join-bootstrap store holds relay-circuit addresses only (the outline's threat model). Phones
 * and Authority installs advertise relay-circuit addresses only, so an invitation's members are
 * circuit addresses (RESEARCH-DEVICE-PROOF l.182): relay peer id, the circuit marker, then the
 * target's peer id at the end.
 */
function isRelayCircuitAddr(value: unknown): value is string {
	return isBootstrapAddr(value) && !/\s/.test(value) && /\/p2p\/[^/]+\/p2p-circuit\/p2p\/[^/]+$/.test(value);
}

/** Keep only plausible relay-circuit multiaddr strings, deduplicated, within the config limits. */
export function sanitizeJoinBootstrap(addrs: unknown): string[] {
	if (!Array.isArray(addrs)) {
		return [];
	}
	const out: string[] = [];
	for (const addr of addrs) {
		if (typeof addr !== 'string') continue;
		const trimmed = addr.trim();
		if (!isRelayCircuitAddr(trimmed)) continue;
		if (!out.includes(trimmed)) out.push(trimmed);
		if (out.length >= BOOTSTRAP_CONFIG_MAX_ADDRS) break;
	}
	return out;
}

/** The addresses a previous join stored; [] when there are none or the record is unreadable. Never rejects, never logs. */
export async function readJoinBootstrap(): Promise<string[]> {
	try {
		const raw = await AsyncStorage.getItem(AUTHORITY_JOIN_BOOTSTRAP_KEY);
		return raw ? sanitizeJoinBootstrap(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

/** Replace the stored addresses with the ones a join just used. A storage rejection propagates. */
export async function rememberJoinBootstrap(addrs: readonly string[]): Promise<void> {
	await AsyncStorage.setItem(AUTHORITY_JOIN_BOOTSTRAP_KEY, JSON.stringify(sanitizeJoinBootstrap([...addrs])));
}
