/**
 * relayOnlyAddrs (spike 100, F2 decision): a voter phone publishes only relay-circuit addresses to
 * its cadre — never a direct address that would name its own IP to every other voter.
 */
import {relayOnlyAddrs} from '../relay-only-addrs';

const SELF = '12D3KooWEqqPhiUSHecCFe4ZxvMDuX48mwjxEKgYK8Y81RiMqVQN';
const RELAY = '12D3KooWRelayRelayRelayRelayRelayRelayRelayRelayRela';

describe('relayOnlyAddrs', () => {
	it('keeps relay-circuit addresses and drops every direct one', () => {
		const circuit = `/dns4/relay.example.org/tcp/443/wss/p2p/${RELAY}/p2p-circuit/p2p/${SELF}`;
		expect(
			relayOnlyAddrs([
				`/ip4/192.168.1.23/tcp/41234/ws/p2p/${SELF}`,
				`/ip4/203.0.113.7/tcp/41234/ws/p2p/${SELF}`,
				`/ip6/2001:db8::1/tcp/41234/ws/p2p/${SELF}`,
				circuit,
				`/ip4/127.0.0.1/tcp/55204/ws/p2p/${SELF}`,
			]),
		).toEqual([circuit]);
	});

	it('answers [] for a phone with no relay reservation (it dials out; nobody needs to dial it)', () => {
		expect(relayOnlyAddrs([`/ip4/10.0.2.16/tcp/41234/ws/p2p/${SELF}`])).toEqual([]);
		expect(relayOnlyAddrs([])).toEqual([]);
	});

	it('ignores non-string entries rather than throwing', () => {
		expect(relayOnlyAddrs([undefined as unknown as string, `/p2p/${RELAY}/p2p-circuit/p2p/${SELF}`])).toEqual([
			`/p2p/${RELAY}/p2p-circuit/p2p/${SELF}`,
		]);
	});
});
