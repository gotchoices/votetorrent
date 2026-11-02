/**
 * voter-network-join (spike 100): the cadre-core wiring around vote-engine's `joinNetwork`.
 *
 * cadre-core is mocked (it is ESM-only and boots libp2p); vote-engine's real `joinNetwork` runs,
 * over a fake CadreNode and a fake networks engine. The real CadreNode path is proven on the host
 * by `.planning/spikes/100-voter-joins-authority-network/product-join.ts`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {NetworkJoinCode} from '@votetorrent/vote-engine/rn';

const mockVerifyInvitationAdmission = jest.fn();
const mockMergeSeedPeers = jest.fn();
const mockDecodeCadreInvitation = jest.fn();
jest.mock(
	'@serfab/cadre-core',
	() => ({
		decodeCadreInvitation: (...args: unknown[]) => mockDecodeCadreInvitation(...args),
		verifyInvitationAdmission: (...args: unknown[]) => mockVerifyInvitationAdmission(...args),
		mergeSeedPeers: (...args: unknown[]) => mockMergeSeedPeers(...args),
	}),
	{virtual: true},
);

import {belongsToOtherCadre, invitationExpiresAtMs, isSelfAdmitted, runVoterNetworkJoin, type VoterJoinNode} from '../voter-network-join';
import {readJoinBootstrap} from '../join-bootstrap';

const SELF = 'peer-self';
const MEMBER_ID = '12D3KooWMemberMemberMemberMemberMemberMemberMemberMemb';
const MEMBER = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${MEMBER_ID}`;
const CODE: NetworkJoinCode = {
	v: 1,
	invitation: 'encoded-invitation',
	networkHash: 'a1b2c3d4e5f60718',
	name: 'Utah County Elections',
	genesis: {userId: 'u', signerKey: 'k', authorityId: 'a', adminEffectiveAt: '2026-10-12T10:00:00'},
	digest: 'F7AJ0wXlmPNm6-p8U1rL5Fm7kn6UtStmc6FfK6YQ43E',
};
const NET_REF = {hash: CODE.networkHash, relays: [], name: CODE.name, primaryAuthorityDomainName: 'example.org'};

function fakeNode(
	opts: {
		selfRow?: Record<string, unknown> | null;
		redeem?: () => Promise<unknown>;
		connections?: unknown[];
		/** owner keys in this phone's control database (OwnerKey rows, replicated from any peer) */
		controlOwners?: string[];
		/** owner keys in the persisted trust anchor */
		anchorOwners?: string[];
	} = {},
) {
	const closed: string[] = [];
	const connections = opts.connections ?? [
		{remotePeer: {toString: () => MEMBER_ID}, close: async () => { closed.push(MEMBER_ID); }},
	];
	const node = {
		partyId: 'votetorrent',
		peerId: {toString: () => SELF},
		redeemCadreInvitation: jest.fn(opts.redeem ?? (async () => ({peerId: MEMBER_ID}))),
		getControlDatabase: () => ({
			getOwnerKeys: async () => new Set(opts.controlOwners ?? []),
			queryCadrePeers: async () => (opts.selfRow === null || opts.selfRow === undefined ? [] : [opts.selfRow]),
			queryCadreInvites: async () => [{key: 'invite-key'}],
			queryCadreInviteUsages: async () => [{usageStampId: 'usage-1', inviteKey: 'invite-key'}],
			querySeedPeers: async () => [{peerId: SELF}, {peerId: MEMBER_ID}],
		}),
		getTrustedOwnerStore: () => ({has: () => true, all: () => new Set(opts.anchorOwners ?? [])}),
		getControlNode: () => ({getConnections: () => connections}),
		refreshMembershipGate: jest.fn(async () => undefined),
		reconcileControlCohort: jest.fn(async () => undefined),
	};
	return {node: node as unknown as VoterJoinNode & typeof node, closed};
}

const ADMITTED_ROW = {peerId: SELF, vouchSig: null, vouchUsage: 'usage-1'};

beforeEach(async () => {
	await AsyncStorage.clear();
	mockVerifyInvitationAdmission.mockReset().mockReturnValue(true);
	mockMergeSeedPeers.mockReset().mockResolvedValue(1);
	mockDecodeCadreInvitation.mockReset().mockImplementation(() => ({
		partyId: 'votetorrent',
		members: [MEMBER],
		invite: {expiresAt: '2099-01-01T00:00:00'},
	}));
});

describe('isSelfAdmitted', () => {
	it('is true only for this node\'s own invitation-admitted row that verifies', async () => {
		expect(await isSelfAdmitted(fakeNode({selfRow: ADMITTED_ROW}).node)).toBe(true);
		expect(mockVerifyInvitationAdmission).toHaveBeenCalledWith(
			'votetorrent',
			ADMITTED_ROW,
			{usageStampId: 'usage-1', inviteKey: 'invite-key'},
			{key: 'invite-key'},
			expect.any(Function),
		);
	});

	it('is false with no row, an owner-vouched row, a missing usage, or a failed verification', async () => {
		expect(await isSelfAdmitted(fakeNode({selfRow: null}).node)).toBe(false);
		expect(await isSelfAdmitted(fakeNode({selfRow: {peerId: SELF, vouchSig: 'sig', vouchUsage: null}}).node)).toBe(false);
		expect(await isSelfAdmitted(fakeNode({selfRow: {...ADMITTED_ROW, vouchUsage: 'other'}}).node)).toBe(false);
		mockVerifyInvitationAdmission.mockReturnValue(false);
		expect(await isSelfAdmitted(fakeNode({selfRow: ADMITTED_ROW}).node)).toBe(false);
	});
});

describe('belongsToOtherCadre (UAT 65 F1)', () => {
	const INVITATION = {ownerKeys: ['owner-b1', 'owner-b2']};

	it('is false on a fresh install: this phone knows no owner yet', async () => {
		expect(await belongsToOtherCadre(fakeNode().node, INVITATION)).toBe(false);
	});

	it('is false when an owner the anchor pins is one the invitation pins (the same authority)', async () => {
		expect(await belongsToOtherCadre(fakeNode({anchorOwners: ['owner-x', 'owner-b2']}).node, INVITATION)).toBe(false);
	});

	it('is true when the anchor pins owners and none of them is the invitation\'s', async () => {
		expect(await belongsToOtherCadre(fakeNode({anchorOwners: ['owner-a']}).node, INVITATION)).toBe(true);
	});

	it('ignores control-database owners: a fresh phone replicates them from its boot peer before any join', async () => {
		expect(await belongsToOtherCadre(fakeNode({controlOwners: ['owner-a']}).node, INVITATION)).toBe(false);
	});

	it('is false for an invitation that pins no owners', async () => {
		const {node} = fakeNode({anchorOwners: ['owner-a']});
		expect(await belongsToOtherCadre(node, {})).toBe(false);
		expect(await belongsToOtherCadre(node, {ownerKeys: []})).toBe(false);
	});
});

describe('invitationExpiresAtMs', () => {
	it('reads cadre-core\'s zone-less T-form datetime as UTC', () => {
		expect(invitationExpiresAtMs({invite: {expiresAt: '2026-11-11T11:26:21.316'}})).toBe(Date.parse('2026-11-11T11:26:21.316Z'));
	});

	it('is null for a never-expiring or unreadable invitation', () => {
		expect(invitationExpiresAtMs({invite: {expiresAt: null}})).toBeNull();
		expect(invitationExpiresAtMs({})).toBeNull();
		expect(invitationExpiresAtMs({invite: {expiresAt: 'soon'}})).toBeNull();
	});
});

describe('runVoterNetworkJoin', () => {
	it('redeems, joins from the strand, and remembers the invitation\'s members as bootstrap', async () => {
		const {node} = fakeNode();
		const joinFromStrand = jest.fn(async () => ({ok: true as const, outcome: 'joined' as const, networkRef: NET_REF, fingerprint: '17b0 6508 2fd5 aab2'}));
		const steps: string[] = [];
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand}, user: undefined, code: CODE, onStep: s => steps.push(s)});
		expect(result).toMatchObject({ok: true, outcome: 'joined', admittedVia: 'redeemed'});
		expect(mockDecodeCadreInvitation).toHaveBeenCalledWith('encoded-invitation');
		expect(node.redeemCadreInvitation).toHaveBeenCalledTimes(1);
		expect(await readJoinBootstrap()).toEqual([MEMBER]);
		expect(steps).toEqual(['admitting', 'syncing', 'done']);
		// The peer-count guard reads CONTROL connections (what the strand factory reads to decide founder).
		const options = (joinFromStrand.mock.calls[0] as unknown[])[2] as {getPeerCount: () => number};
		expect(options.getPeerCount()).toBe(1);
	});

	it('a redemption that throws but seated this phone runs the skipped post-steps, closing the member connection', async () => {
		let admittedChecks = 0;
		const {node, closed} = fakeNode({redeem: async () => { throw new Error('StreamStateError'); }});
		// Not admitted before the redeem; admitted on the first check after it threw.
		node.getControlDatabase = () => ({
			getOwnerKeys: async () => new Set<string>(),
			queryCadrePeers: async () => (admittedChecks++ === 0 ? [] : [ADMITTED_ROW]),
			queryCadreInvites: async () => [{key: 'invite-key'}],
			queryCadreInviteUsages: async () => [{usageStampId: 'usage-1', inviteKey: 'invite-key'}],
			querySeedPeers: async () => [{peerId: SELF}, {peerId: MEMBER_ID}],
		});
		const joinFromStrand = jest.fn(async () => ({ok: true as const, outcome: 'joined' as const, networkRef: NET_REF, fingerprint: 'f'}));
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand}, user: undefined, code: CODE});
		expect(result).toMatchObject({ok: true, admittedVia: 'self-admission'});
		expect(closed).toEqual([MEMBER_ID]);
		expect(mockMergeSeedPeers).toHaveBeenCalledWith(expect.anything(), [{peerId: MEMBER_ID}]);
		expect(node.refreshMembershipGate).toHaveBeenCalledWith('invitation-redeemed');
		expect(node.reconcileControlCohort).toHaveBeenCalled();
	});

	it('a malformed invitation inside the code fails before any redemption', async () => {
		mockDecodeCadreInvitation.mockImplementation(() => {
			throw new Error('not base64url JSON');
		});
		const {node} = fakeNode();
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand: jest.fn()}, user: undefined, code: CODE});
		expect(result).toMatchObject({ok: false, reason: 'invitation-malformed'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
	});

	it('an expired invitation fails before any redemption', async () => {
		mockDecodeCadreInvitation.mockImplementation(() => ({members: [MEMBER], invite: {expiresAt: '2020-01-01T00:00:00'}}));
		const {node} = fakeNode();
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand: jest.fn()}, user: undefined, code: CODE});
		expect(result).toMatchObject({ok: false, reason: 'invitation-expired'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
	});

	it('a phone already in another authority\'s cadre is refused before any redemption or open (UAT 65 F1)', async () => {
		mockDecodeCadreInvitation.mockImplementation(() => ({
			partyId: 'votetorrent',
			members: [MEMBER],
			ownerKeys: ['owner-b'],
			invite: {expiresAt: '2099-01-01T00:00:00'},
		}));
		const {node} = fakeNode({anchorOwners: ['owner-a'], controlOwners: ['owner-a']});
		const joinFromStrand = jest.fn();
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand}, user: undefined, code: CODE});
		expect(result).toEqual({ok: false, reason: 'other-cadre', detail: 'other-cadre'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
	});

	it('a digest mismatch is reported as such and is not retried', async () => {
		const {node} = fakeNode();
		const joinFromStrand = jest.fn(async () => ({ok: false as const, reason: 'digest-mismatch' as const, retryable: false, detail: 'x'}));
		const result = await runVoterNetworkJoin({node, networksEngine: {joinFromStrand}, user: undefined, code: CODE});
		expect(result).toMatchObject({ok: false, reason: 'digest-mismatch'});
		expect(joinFromStrand).toHaveBeenCalledTimes(1);
	});
});
