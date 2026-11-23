/**
 * strand-relay-seed.ts — feeds a network's relays into its strand's bootstrap seed.
 *
 * The relays entered on Add Network are stored in `Network.Relays` and in the network's reference
 * (`NetworkReference.relays`). Before this module they reached nothing: `addStrand` takes no relay
 * or bootstrap option (cadre-core 1.24's `StrandConfig` has none), and the node's own
 * `network.relayAddrs` is fixed at node construction and shared by every network.
 *
 * cadre-core 1.24's per-strand route is `CadreNode.recordCarriedStrandAddrs(strandId, addrs)`: the
 * addresses join the strand's cross-party discovery seed (`resolveCohortSeed`), which every launch
 * and resume of THAT strand hands its strand node as `bootstrapNodes`. Scoped to one strand, it
 * never seeds another strand or the control peer store. Entries must name a peer (`/p2p/<id>`);
 * cadre-core drops one that does not. A list that names a peer REPLACES the strand's earlier one,
 * so the relays are merged with whatever is already carried rather than written over it.
 *
 * NOT ON A FOUNDING CREATE. A founder normally launches with no seed and commits alone. Given a
 * seed it cannot hear (a relay that is down, offline, or a typo'd peer id), the founder cannot
 * create its catalog: Optimystic will not rule a block absent while a configured bootstrap peer is
 * unheard. Measured on the host (vote-engine's two-node harness, cadre-core 1.24 / optimystic 1.29,
 * 2026-11-23): the first strand a process founds with an unreachable seed was not writable after
 * 60 s (2 of 2 runs), where the same open with no seed, or with a reachable seed, took ~2.2-2.4 s.
 * That is the network-create hang this seed must never reintroduce. So only a RE-ATTACH carries
 * relays: `NetworksEngine.open` passes the stored ones on a cache miss (a cold reopen), while
 * create, import and join pass none. The `founding` guard below is a second line for a caller that
 * ever passes relays to a create.
 *
 * NOT MEASURED: a cold reopen whose relay is unreachable. The founder's blocks are local by then,
 * so no absence ruling should wait on the seed, but no host run has shown it yet.
 *
 * Fail-soft: a failed seed write is logged with a closed token and the open goes on unseeded.
 * Logs carry counts and closed tokens only, never an address or a network hash.
 */

/** The part of `CadreNode` this module calls. Optional so test fakes without it stay valid. */
export interface StrandSeedHost {
	getCarriedStrandAddrs?(strandId: string): string[];
	recordCarriedStrandAddrs?(strandId: string, addrs: readonly string[]): Promise<void>;
}

/** What happened to the relays, as a closed token for the factory's attach log. */
export type RelaySeedOutcome = 'seeded' | 'no-relays' | 'founding-skipped' | 'unsupported' | 'failed';

/** Trimmed, non-empty, de-duplicated, in the order given. */
export function normalizeRelaySeed(relays: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const relay of relays ?? []) {
		if (typeof relay !== 'string') continue;
		const trimmed = relay.trim();
		if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

/**
 * Merge `relays` into `strandId`'s carried seed before the strand launches. Never throws.
 *
 * @param founding true for the open a founding window was installed for (`NetworksEngine.create`).
 */
export async function seedStrandWithRelays(
	node: StrandSeedHost,
	strandId: string,
	relays: readonly string[] | undefined,
	founding: boolean,
): Promise<RelaySeedOutcome> {
	const seed = normalizeRelaySeed(relays);
	if (seed.length === 0) return 'no-relays';
	if (founding) return 'founding-skipped';
	if (typeof node.recordCarriedStrandAddrs !== 'function') return 'unsupported';
	try {
		const carried = typeof node.getCarriedStrandAddrs === 'function' ? node.getCarriedStrandAddrs(strandId) : [];
		const merged = [...carried, ...seed.filter((addr) => !carried.includes(addr))];
		await node.recordCarriedStrandAddrs(strandId, merged);
		return 'seeded';
	} catch {
		console.warn('[strand-factory] relay seed not recorded', { reason: 'record-failed' });
		return 'failed';
	}
}
