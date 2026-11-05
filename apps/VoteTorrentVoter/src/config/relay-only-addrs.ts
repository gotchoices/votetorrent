/**
 * relay-only-addrs.ts — the addresses this phone publishes to its cadre (spike 100, F2 decision).
 *
 * A voter is a member of the authority's cadre, and every member's control database replicates
 * every member's `CadrePeer` row, address included. So whatever this phone publishes, every other
 * voter's phone stores. The decision recorded for spike 100: phones publish ONLY relay-circuit
 * addresses (`…/p2p-circuit/p2p/<self>`), which name the authority's relay, never the phone's own
 * IP. Wired as cadre-core's `network.inviteAddressResolver`, which feeds both the redemption
 * request and the self-record refresh (`resolveInviteAddresses` → `collectSelfAddrs`). An empty
 * list is a valid answer: a phone dials out; nobody needs to dial it.
 *
 * Still visible to every member (recorded limits, not fixed here): this phone's peer id, and one
 * `CadrePeer` row per voter on every phone.
 */
export function relayOnlyAddrs(addrs: readonly string[]): string[] {
	return addrs.filter(addr => typeof addr === 'string' && addr.includes('/p2p-circuit'));
}
