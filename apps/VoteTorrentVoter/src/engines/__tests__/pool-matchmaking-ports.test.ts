/**
 * pool-matchmaking-ports — the seeker transport is given the node's own cohort-topic service as
 * `localRegistrations` (required since @optimystic/db-p2p 1.29.0). Without it a walk of the pool topic
 * this phone has registered a provider offer for would call `holds` on undefined, and before 1.29 the
 * walk replaced the offer and withdrew it when it ended.
 */
const mockCreateTransport = jest.fn(() => ({queryCohort: jest.fn(), verifyEntry: jest.fn()}));

jest.mock('@optimystic/db-p2p', () => ({
	MatchmakingProviderSession: jest.fn(),
	createLibp2pMatchmakingTransport: (deps: unknown) => mockCreateTransport(deps),
	createMatchmakingQueryHandler: jest.fn(() => jest.fn()),
	signPeer: jest.fn(),
}));

jest.mock('@optimystic/db-core', () => ({
	b64urlToBytes: jest.fn(),
	bytesToB64url: jest.fn(),
	createMatchTopicAnchor: jest.fn(() => ({topicId: jest.fn()})),
	createRingHash: jest.fn(),
	createTierAddressing: jest.fn(),
	decodeQueryReplyV1: jest.fn(),
	encodeQueryV1: jest.fn(),
	verifyProviderEntry: jest.fn(),
}));

jest.mock('@votetorrent/vote-engine/rn', () => ({poolMatchTopic: jest.fn()}));

import {POOL_MATCH_WANT_K, poolMatchmakingPorts} from '../pool-matchmaking-ports';

describe('poolMatchmakingPorts', () => {
	beforeEach(() => mockCreateTransport.mockClear());

	it('PMP-1 passes the node cohort-topic service as the transport localRegistrations', () => {
		const service = {holds: jest.fn(() => false)};
		const node = {
			peerId: {toString: () => 'peer-self'},
			services: {fret: {}},
			peerPrivateKey: {},
			cohortTopicHost: {service, registry: {}},
		};
		const ports = poolMatchmakingPorts({getStrand: () => ({libp2pNode: node})}, 'net-hash');

		expect(ports).not.toBeNull();
		expect(mockCreateTransport).toHaveBeenCalledTimes(1);
		const deps = (mockCreateTransport.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect(deps.localRegistrations).toBe(service);
		expect(deps.selfPeerId).toBe('peer-self');
		expect(deps.wantK).toBe(POOL_MATCH_WANT_K);
	});

	it('PMP-2 returns null and builds no transport when the strand has no cohort-topic service', () => {
		const node = {peerId: {toString: () => 'p'}, services: {fret: {}}, peerPrivateKey: {}, cohortTopicHost: {registry: {}}};
		expect(poolMatchmakingPorts({getStrand: () => ({libp2pNode: node})}, 'net-hash')).toBeNull();
		expect(mockCreateTransport).not.toHaveBeenCalled();
	});
});
