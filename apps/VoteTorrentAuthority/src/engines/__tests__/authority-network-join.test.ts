/**
 * authority-network-join (D-26, D-30, D-09, D-06): the cadre-core wiring around vote-engine's
 * `joinNetwork`, run over a fake CadreNode and a fake networks engine. cadre-core is virtual-mocked
 * (ESM-only, boots libp2p); the REAL joinNetwork, founder-intent, joined-networks, join-bootstrap,
 * owner-trust, self-voucher and errorClassName run. Codes are the real-encoder fixtures. The OQ1
 * decision (Branch B, a founder-cannot-join guard) is recorded in the glue's header.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {JoinCodeFixtureName} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {decodeNetworkJoinCode} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinCode} from '@votetorrent/vote-engine/rn';
import * as fs from 'fs';
import * as path from 'path';

const mockDecodeCadreInvitation = jest.fn();
const mockMergeSeedPeers = jest.fn();
const mockVerifyInvitationAdmission = jest.fn();
const mockVerifyCadrePeerVoucher = jest.fn();
jest.mock(
	'@serfab/cadre-core',
	() => ({
		decodeCadreInvitation: (...args: unknown[]) => mockDecodeCadreInvitation(...args),
		mergeSeedPeers: (...args: unknown[]) => mockMergeSeedPeers(...args),
		verifyInvitationAdmission: (...args: unknown[]) => mockVerifyInvitationAdmission(...args),
		verifyCadrePeerVoucher: (...args: unknown[]) => mockVerifyCadrePeerVoucher(...args),
	}),
	{virtual: true},
);

import {
	completeAuthorityJoin,
	isFounderGuardUnreadableError,
	runAuthorityNetworkJoin,
	type AuthorityJoinNode,
} from '../authority-network-join';
import {AUTHORITY_JOIN_BOOTSTRAP_KEY, readJoinBootstrap} from '../join-bootstrap';
import {AUTHORITY_JOINED_NETWORKS_KEY, readJoinedNetworkHashes} from '../joined-networks';
import {
	isFounderIntentBusyError,
	isJoinedNetworksUnreadableError,
	takeFounderIntent,
	withFounding,
} from '../founder-intent';
import {OWNER_REANCHOR_TIMEOUT_MS, OwnerTrustUnreadableError} from '../owner-trust';
import {captureConsole, expectNoSecretInConsole} from '../__fixtures__/console-leak';
import {consoleTags, nonLiteralConsoleFirstArgs} from '../../screens/__fixtures__/log-content-scan';

const SELF = 'peer-self';
const SELF_KEY = 'self-pub';
const RELAY_ID = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
const PEER_C1 = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const PEER_C2 = '12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzNAc5dVLAHZmwCe';
const circuit = (peer: string) => `/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY_ID}/p2p-circuit/p2p/${peer}`;
const C1 = circuit(PEER_C1);
const C2 = circuit(PEER_C2);
const D1 = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${RELAY_ID}`;
const CLOSED_DETAIL = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|(?:[A-Z][A-Za-z0-9]{0,58})?Error|unknown)$/;

const TAG_NOT_RECORDED = '[authority-join] joined but not recorded:';
const TAG_NOT_VOUCHED = '[authority-join] complete: not self-vouched';
const TAG_REFRESH_FAILED = '[authority-join] complete: trust refresh failed:';
const TAG_GUARD_REFUSED = '[authority-join] founder guard: refused';
const TAG_GUARD_UNREADABLE = '[authority-join] founder guard: unreadable:';

function codeFor(name: JoinCodeFixtureName): NetworkJoinCode {
	const decoded = decodeNetworkJoinCode(JOIN_CODE_FIXTURES[name].text);
	if (!decoded.ok) throw new Error('fixture does not decode');
	return decoded.code;
}

/** The REAL invitation behind a fixture code (the encoder's own output). */
function realInvitation(code: NetworkJoinCode): {
	members: string[];
	ownerKeys: string[];
	invitePrivateKey: string;
	invite: {expiresAt: string};
} {
	const rest = code.invitation.slice('sereus-invite:1.'.length);
	return JSON.parse(Buffer.from(rest, 'base64url').toString('utf8'));
}

/** The real fixture's first member machine (the peer id its connection would carry). */
const MEMBER_ID = realInvitation(codeFor('v2-1-member')).members[0].split('/p2p/').pop() as string;

const NET_REF = {hash: 'a1b2c3d4e5f60718', relays: [], name: 'Net', primaryAuthorityDomainName: 'example.org'};
const OK_JOIN = (fingerprint = 'aaaa bbbb cccc dddd') => ({
	ok: true as const,
	outcome: 'joined' as const,
	networkRef: NET_REF,
	fingerprint,
});

const ADMITTED_ROW = {peerId: SELF, vouchSig: null, vouchUsage: 'usage-1'};
const OWNER_VOUCHED_ROW = {peerId: SELF, stampId: 'stamp-1', vouchOwner: 'owner-1', vouchSig: 'sig-1', vouchUsage: null};

interface NodeOpts {
	selfRow?: Record<string, unknown> | null;
	redeem?: (state: {selfRow: Record<string, unknown> | null}) => Promise<unknown>;
	owners?: string[];
	ownerKeysError?: Error;
	dbNull?: boolean;
	identityThrows?: boolean;
	peersError?: Error;
	wire?: () => Promise<boolean>;
	connections?: unknown[];
}

const allNodes: Array<{trustOwnerKeys: jest.Mock; store: {trust: jest.Mock}}> = [];

function fakeNode(opts: NodeOpts = {}) {
	const callOrder: string[] = [];
	const state = {selfRow: opts.selfRow ?? null};
	const closed: string[] = [];
	const trustOwnerKeys = jest.fn(async () => undefined);
	const store = {has: () => true, trust: jest.fn(async () => undefined)};
	const memberId = MEMBER_ID;
	const connections = opts.connections ?? [
		{remotePeer: {toString: () => memberId}, close: jest.fn(async () => { closed.push(memberId); })},
	];
	const node = {
		partyId: 'votetorrent',
		peerId: {toString: () => SELF},
		redeemCadreInvitation: jest.fn(async (_inv: unknown) => {
			callOrder.push('redeem');
			return opts.redeem ? opts.redeem(state) : {};
		}),
		getControlDatabase: () =>
			opts.dbNull
				? null
				: {
						queryCadrePeers: async () => {
							callOrder.push('queryCadrePeers');
							if (opts.peersError) throw opts.peersError;
							return state.selfRow ? [state.selfRow] : [];
						},
						queryCadreInvites: async () => [{key: 'invite-key'}],
						queryCadreInviteUsages: async () => [{usageStampId: 'usage-1', inviteKey: 'invite-key'}],
						querySeedPeers: async () => [{peerId: SELF}, {peerId: memberId}],
						getOwnerKeys: async () => {
							callOrder.push('getOwnerKeys');
							if (opts.ownerKeysError) throw opts.ownerKeysError;
							return new Set<string>(opts.owners ?? []);
						},
					},
		getTrustedOwnerStore: () => store,
		getIdentityOwnerKey: () => {
			if (opts.identityThrows) throw new Error('no identity');
			return {publicKeyB64: SELF_KEY};
		},
		getControlNode: () => ({getConnections: () => connections as unknown[]}),
		refreshMembershipGate: jest.fn(async () => undefined),
		reconcileControlCohort: jest.fn(async () => undefined),
		wireOwnKeyIfOwner: jest.fn(async () => {
			callOrder.push('wireOwnKeyIfOwner');
			return opts.wire ? opts.wire() : true;
		}),
		trustOwnerKeys,
	};
	allNodes.push({trustOwnerKeys, store});
	return {node: node as unknown as AuthorityJoinNode & typeof node, callOrder, closed, state};
}

function fakeEngine(code: NetworkJoinCode, result: unknown = OK_JOIN()) {
	const seenIntents: Array<string | null> = [];
	const joinFromStrand = jest.fn(async (..._a: unknown[]) => {
		seenIntents.push(takeFounderIntent(code.networkHash));
		return result;
	});
	return {engine: {joinFromStrand} as never, joinFromStrand, seenIntents};
}

/** Restore point for the AsyncStorage jest mock's own jest.fn implementations. */
function failOnce(method: 'setItem' | 'getItem', key: string, error: Error): () => void {
	const fn = AsyncStorage[method] as unknown as jest.Mock;
	const prior = fn.getMockImplementation();
	let used = false;
	fn.mockImplementation(async (k: string, ...rest: unknown[]) => {
		if (!used && k === key) {
			used = true;
			throw error;
		}
		return prior ? prior(k, ...rest) : undefined;
	});
	return () => fn.mockImplementation(prior);
}

const decodeReal = (encoded: string) => {
	if (!encoded.startsWith('sereus-invite:1.')) throw new Error('bad');
	return JSON.parse(Buffer.from(encoded.slice('sereus-invite:1.'.length), 'base64url').toString('utf8'));
};

beforeEach(async () => {
	jest.useRealTimers();
	await AsyncStorage.clear();
	allNodes.length = 0;
	mockDecodeCadreInvitation.mockReset().mockImplementation(decodeReal);
	mockMergeSeedPeers.mockReset().mockResolvedValue(1);
	mockVerifyInvitationAdmission.mockReset().mockReturnValue(true);
	mockVerifyCadrePeerVoucher.mockReset().mockResolvedValue(true);
});

afterEach(() => {
	jest.useRealTimers();
	jest.restoreAllMocks();
	// CJ-8: nothing in the glue ever pins.
	for (const n of allNodes) {
		expect(n.trustOwnerKeys).not.toHaveBeenCalled();
		expect(n.store.trust).not.toHaveBeenCalled();
	}
});

const FAKE_TIMERS = {doNotFake: ['queueMicrotask', 'nextTick'] as Array<'queueMicrotask' | 'nextTick'>};

describe('runAuthorityNetworkJoin (D-26, D-30)', () => {
	const code = codeFor('v2-1-member');

	it('RJ-1 redeems inside the joining window, records the hash and the circuit members, and frees the slot', async () => {
		const {node} = fakeNode();
		const {engine, joinFromStrand, seenIntents} = fakeEngine(code);
		const steps: string[] = [];
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code, onStep: (s) => steps.push(s)});
		expect(result).toMatchObject({ok: true, outcome: 'joined', admittedVia: 'redeemed'});
		expect(seenIntents).toEqual(['joining']);
		expect(steps).toEqual(['admitting', 'syncing', 'done']);
		expect(await readJoinedNetworkHashes()).toEqual([code.networkHash]);
		expect(await readJoinBootstrap()).toEqual(realInvitation(code).members);
		const options = (joinFromStrand.mock.calls[0] as unknown[])[2] as {getPeerCount: () => number};
		expect(options.getPeerCount()).toBe(1);
		expect(takeFounderIntent(code.networkHash)).toBeNull();
	});

	it('RJ-2 a redeem that throws but seated this node runs the skipped post-steps', async () => {
		const {node, closed} = fakeNode({
			redeem: async (state) => {
				state.selfRow = ADMITTED_ROW;
				throw new Error('StreamStateError');
			},
		});
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: true, admittedVia: 'self-admission'});
		expect(closed).toEqual([MEMBER_ID]);
		expect(mockMergeSeedPeers).toHaveBeenCalledWith(expect.anything(), [{peerId: MEMBER_ID}]);
		expect(node.refreshMembershipGate).toHaveBeenCalledWith('invitation-redeemed');
		expect(node.reconcileControlCohort).toHaveBeenCalled();
	});

	it('RJ-3 an already-admitted node never redeems', async () => {
		const {node} = fakeNode({selfRow: ADMITTED_ROW});
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: true, admittedVia: 'already-member'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
	});

	it('RJ-4 a malformed invitation fails with a closed detail, no redeem and nothing recorded', async () => {
		mockDecodeCadreInvitation.mockImplementation(() => {
			throw new Error(JOIN_CODE_FIXTURES['v2-1-member'].text);
		});
		const {node} = fakeNode();
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: false, reason: 'invitation-malformed'});
		expect((result as {detail: string}).detail).toMatch(CLOSED_DETAIL);
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(await readJoinedNetworkHashes()).toEqual([]);
	});

	it('RJ-5 an expired invitation fails before any redeem', async () => {
		mockDecodeCadreInvitation.mockImplementation((e: string) => {
			const o = decodeReal(e);
			return {...o, invite: {...o.invite, expiresAt: '2020-01-01T00:00:00'}};
		});
		const {node} = fakeNode();
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: false, reason: 'invitation-expired'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
	});

	it.each([
		['invite-invalid', 'not-admitted'],
		['invite-spent', 'invitation-used-up'],
	])('RJ-6/7 a typed %s refusal with no admission maps to %s after the bounded wait', async (errCode, reason) => {
		jest.useFakeTimers(FAKE_TIMERS);
		const refusal = Object.assign(new Error(JOIN_CODE_FIXTURES['v2-1-member'].text), {
			name: 'CadreInviteRejectedError',
			code: errCode,
		});
		const {node} = fakeNode({
			redeem: async () => {
				throw refusal;
			},
		});
		const {engine} = fakeEngine(code);
		const pending = runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		await jest.advanceTimersByTimeAsync(21_000);
		await expect(pending).resolves.toEqual({ok: false, reason, detail: errCode});
		expect(await readJoinedNetworkHashes()).toEqual([]);
	});

	it('RJ-8 a digest mismatch is reported once and nothing is recorded', async () => {
		const {node} = fakeNode();
		const text = JOIN_CODE_FIXTURES['v2-1-member'].text;
		const {engine, joinFromStrand} = fakeEngine(code, {
			ok: false,
			reason: 'digest-mismatch',
			retryable: false,
			detail: 'join: RAW ENGINE TEXT ' + text.slice(0, 20),
		});
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: false, reason: 'digest-mismatch'});
		expect(joinFromStrand).toHaveBeenCalledTimes(1);
		expect(await readJoinedNetworkHashes()).toEqual([]);
	});

	it('RJ-9 an occupied founder-intent slot rejects busy before any decode, redeem, join or write', async () => {
		const {node} = fakeNode();
		const {engine, joinFromStrand} = fakeEngine(code);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const outer = withFounding(() => held);
		try {
			const error = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(isFounderIntentBusyError(error)).toBe(true);
		} finally {
			release();
			await outer;
		}
		expect(mockDecodeCadreInvitation).not.toHaveBeenCalled();
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
		expect(await AsyncStorage.getItem(AUTHORITY_JOINED_NETWORKS_KEY)).toBeNull();
		expect(await AsyncStorage.getItem(AUTHORITY_JOIN_BOOTSTRAP_KEY)).toBeNull();
	});

	it('RJ-10 joined but not recorded: an unreadable list rejects, logs one closed token, stays byte-identical', async () => {
		await AsyncStorage.setItem(AUTHORITY_JOINED_NETWORKS_KEY, '{corrupt');
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {node} = fakeNode();
		const {engine} = fakeEngine(code);
		const error = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(isJoinedNetworksUnreadableError(error)).toBe(true);
		expect(errorSpy.mock.calls).toEqual([[TAG_NOT_RECORDED, 'JoinedNetworksUnreadableError']]);
		expect(await AsyncStorage.getItem(AUTHORITY_JOINED_NETWORKS_KEY)).toBe('{corrupt');
		expect(takeFounderIntent(code.networkHash)).toBeNull();
	});

	it('RJ-11 a remember write failure rejects with that same object and logs only the class name', async () => {
		const failure = new Error('planted-remember-text');
		const restore = failOnce('setItem', AUTHORITY_JOINED_NETWORKS_KEY, failure);
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const {node} = fakeNode();
			const {engine} = fakeEngine(code);
			await expect(runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code})).rejects.toBe(failure);
			expect(errorSpy.mock.calls).toEqual([[TAG_NOT_RECORDED, 'Error']]);
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('planted-remember-text');
		} finally {
			restore();
		}
	});

	it('RJ-12 only circuit members are remembered as bootstrap', async () => {
		mockDecodeCadreInvitation.mockImplementation((e: string) => ({...decodeReal(e), members: [C1, D1, C2]}));
		const {node} = fakeNode();
		const {engine} = fakeEngine(code);
		await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(await readJoinBootstrap()).toEqual([C1, C2]);
	});
});

describe('completeAuthorityJoin (D-09, D-26)', () => {
	const mk = (opts: NodeOpts = {selfRow: ADMITTED_ROW}) => {
		const made = fakeNode(opts);
		const selectNetwork = jest.fn(async () => {
			made.callOrder.push('selectNetwork');
		});
		const refreshOwnerTrust = jest.fn(async () => {
			made.callOrder.push('refreshOwnerTrust');
		});
		return {...made, selectNetwork, refreshOwnerTrust};
	};
	const run = (m: ReturnType<typeof mk>) =>
		completeAuthorityJoin({node: m.node, networkRef: NET_REF as never, selectNetwork: m.selectNetwork, refreshOwnerTrust: m.refreshOwnerTrust});

	it('CJ-1 runs selectNetwork, the wiring, the own-row read, then the refresh', async () => {
		const m = mk();
		await expect(run(m)).resolves.toEqual({trustSaved: true});
		expect(m.callOrder).toEqual(['selectNetwork', 'wireOwnKeyIfOwner', 'queryCadrePeers', 'refreshOwnerTrust']);
	});

	it('CJ-2 a not-self-vouched own row never refreshes and reports trustSaved false', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const m = mk({selfRow: null});
		await expect(run(m)).resolves.toEqual({trustSaved: false});
		expect(m.refreshOwnerTrust).not.toHaveBeenCalled();
		expect(warnSpy.mock.calls).toEqual([[TAG_NOT_VOUCHED]]);
	});

	it('CJ-3 an unreadable refresh reports trustSaved false and logs the class name', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const m = mk();
		m.refreshOwnerTrust.mockRejectedValueOnce(new OwnerTrustUnreadableError());
		await expect(run(m)).resolves.toEqual({trustSaved: false});
		expect(errorSpy.mock.calls).toEqual([[TAG_REFRESH_FAILED, 'OwnerTrustUnreadableError']]);
	});

	it('CJ-4 a wiring failure still refreshes and reports trustSaved false', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const m = mk({
			selfRow: ADMITTED_ROW,
			wire: async () => {
				throw new Error('wiring');
			},
		});
		await expect(run(m)).resolves.toEqual({trustSaved: false});
		expect(warnSpy.mock.calls).toEqual([['[owner-trust] reanchor: failed']]);
		expect(m.refreshOwnerTrust).toHaveBeenCalledTimes(1);
	});

	it('CJ-5 a hanging wiring is bounded, then the refresh still runs', async () => {
		jest.useFakeTimers(FAKE_TIMERS);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const m = mk({selfRow: ADMITTED_ROW, wire: () => new Promise<boolean>(() => undefined)});
		const pending = run(m);
		await jest.advanceTimersByTimeAsync(OWNER_REANCHOR_TIMEOUT_MS);
		await expect(pending).resolves.toEqual({trustSaved: false});
		expect(m.refreshOwnerTrust).toHaveBeenCalledTimes(1);
	});

	it('CJ-6 a selectNetwork rejection (NO_KEY_PROVISIONED) propagates as the same object and nothing follows', async () => {
		const m = mk();
		const failure = Object.assign(new Error('no key'), {code: 'NO_KEY_PROVISIONED'});
		m.selectNetwork.mockRejectedValueOnce(failure);
		await expect(run(m)).rejects.toBe(failure);
		expect(m.node.wireOwnKeyIfOwner).not.toHaveBeenCalled();
		expect(m.refreshOwnerTrust).not.toHaveBeenCalled();
	});

	it('CJ-7 an own-row read failure never refreshes and logs the class name', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const m = mk({selfRow: ADMITTED_ROW, peersError: new Error('read')});
		await expect(run(m)).resolves.toEqual({trustSaved: false});
		expect(m.refreshOwnerTrust).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls).toEqual([[TAG_REFRESH_FAILED, 'Error']]);
	});
});

describe('OQ1 Branch B: a founder cannot join a foreign cadre (gate review, 107c)', () => {
	const code = codeFor('v2-1-member');
	const founderShape = (extra: NodeOpts = {}) => fakeNode({owners: [SELF_KEY], ...extra});

	it('OQB-1 a self-vouched founder is refused before joinNetwork; nothing is read, redeemed or written', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const {node, callOrder} = founderShape({selfRow: OWNER_VOUCHED_ROW});
		const {engine, joinFromStrand} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toEqual({ok: false, reason: 'founder-cannot-join', detail: 'founder-of-own-cadre'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
		expect(callOrder).not.toContain('queryCadrePeers');
		expect(await AsyncStorage.getItem(AUTHORITY_JOINED_NETWORKS_KEY)).toBeNull();
		expect(await AsyncStorage.getItem(AUTHORITY_JOIN_BOOTSTRAP_KEY)).toBeNull();
		expect(warnSpy.mock.calls).toEqual([[TAG_GUARD_REFUSED]]);
		expect(takeFounderIntent(code.networkHash)).toBeNull();
	});

	it('OQB-2 a founder that is not self-vouched is refused the same way', async () => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const {node} = founderShape({selfRow: null});
		const {engine, joinFromStrand} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: false, reason: 'founder-cannot-join'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
	});

	it('OQB-3 a fresh keyholder (no owners) is allowed and joins as RJ-1', async () => {
		const {node} = fakeNode({owners: []});
		const {engine, seenIntents} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: true, admittedVia: 'redeemed'});
		expect(seenIntents).toEqual(['joining']);
	});

	it('OQB-4 a founder joining its own cadre (the invitation shares an owner) is allowed', async () => {
		const {node} = founderShape();
		(node as unknown as {getControlDatabase: () => unknown}).getControlDatabase = () => ({
			queryCadrePeers: async () => [],
			queryCadreInvites: async () => [],
			queryCadreInviteUsages: async () => [],
			querySeedPeers: async () => [],
			getOwnerKeys: async () => new Set([SELF_KEY, realInvitation(code).ownerKeys[0]]),
		});
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: true});
		expect(node.redeemCadreInvitation).toHaveBeenCalledTimes(1);
	});

	it('OQB-5 an unreadable owner list rejects FounderGuardUnreadableError and runs no join step', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const {node} = fakeNode({ownerKeysError: new Error('planted-owner-text')});
		const {engine, joinFromStrand} = fakeEngine(code);
		const error = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(isFounderGuardUnreadableError(error)).toBe(true);
		expect(errorSpy.mock.calls).toEqual([[TAG_GUARD_UNREADABLE, 'Error']]);
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
		expect(takeFounderIntent(code.networkHash)).toBeNull();
	});

	it('OQB-6 a missing control database rejects FounderGuardUnreadableError and runs no join step', async () => {
		const {node} = fakeNode({dbNull: true});
		const {engine, joinFromStrand} = fakeEngine(code);
		const error = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(isFounderGuardUnreadableError(error)).toBe(true);
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
		expect(joinFromStrand).not.toHaveBeenCalled();
	});

	it('OQB-7 a guard decode failure falls through to joinNetwork, which reports malformed without a redeem', async () => {
		mockDecodeCadreInvitation.mockImplementation(() => {
			throw new Error('bad');
		});
		const {node} = founderShape();
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: false, reason: 'invitation-malformed'});
		expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
	});

	it('OQB-8 an unreadable identity key means not a founder, and the join proceeds', async () => {
		const {node} = fakeNode({owners: [SELF_KEY], identityThrows: true});
		const {engine} = fakeEngine(code);
		const result = await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
		expect(result).toMatchObject({ok: true});
	});
});

describe('console contract (D-06)', () => {
	const NAMES: JoinCodeFixtureName[] = ['v2-1-member', 'v2-6-members', 'v2-non-ascii-name', 'v1-legacy-1-member'];

	it.each(NAMES)('LK-1 no flow leaks the %s code, its parts or its members to the console', async (name) => {
		const code = codeFor(name);
		const text = JOIN_CODE_FIXTURES[name].text;
		const real = realInvitation(code);
		const secrets = [
			text,
			JOIN_CODE_FIXTURES[name].name,
			JOIN_CODE_FIXTURES[name].fingerprint,
			code.invitation,
			real.invitePrivateKey,
			...real.members,
		].filter((s) => typeof s === 'string' && s.length > 0);
		const hostile = (n: string) => Object.assign(new Error(text), {name: n});
		const c = captureConsole();
		try {
			// RJ-1 then CJ-3
			{
				const {node} = fakeNode({selfRow: ADMITTED_ROW});
				const {engine} = fakeEngine(code, OK_JOIN(JOIN_CODE_FIXTURES[name].fingerprint));
				await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
				await completeAuthorityJoin({
					node,
					networkRef: NET_REF as never,
					selectNetwork: async () => undefined,
					refreshOwnerTrust: async () => {
						throw hostile('OwnerTrustUnreadableError');
					},
				});
			}
			await AsyncStorage.clear();
			// RJ-4
			{
				mockDecodeCadreInvitation.mockImplementationOnce(() => {
					throw new Error(text);
				});
				const {node} = fakeNode();
				const {engine} = fakeEngine(code);
				await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
			}
			// RJ-6
			{
				jest.useFakeTimers(FAKE_TIMERS);
				const {node} = fakeNode({
					redeem: async () => {
						throw Object.assign(new Error(text), {name: 'CadreInviteRejectedError', code: 'invite-invalid'});
					},
				});
				const {engine} = fakeEngine(code);
				const pending = runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
				await jest.advanceTimersByTimeAsync(21_000);
				await pending;
				jest.useRealTimers();
			}
			// RJ-8
			{
				const {node} = fakeNode();
				const {engine} = fakeEngine(code, {ok: false, reason: 'digest-mismatch', retryable: false, detail: text});
				await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
			}
			// RJ-10
			{
				await AsyncStorage.setItem(AUTHORITY_JOINED_NETWORKS_KEY, '{corrupt');
				const {node} = fakeNode();
				const {engine} = fakeEngine(code);
				await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code}).catch(() => undefined);
			}
			// OQB-1
			{
				await AsyncStorage.clear();
				const {node} = fakeNode({owners: [SELF_KEY], selfRow: OWNER_VOUCHED_ROW});
				const {engine} = fakeEngine(code);
				await runAuthorityNetworkJoin({node, networksEngine: engine, user: undefined, code});
			}
			expect(c.calls().length).toBeGreaterThan(0);
			expectNoSecretInConsole(c, secrets);
		} finally {
			c.restore();
		}
	});

	it('LK-2 the glue source has only closed literal console tags and class-name arguments', () => {
		const source = fs.readFileSync(path.join(__dirname, '../authority-network-join.ts'), 'utf8');
		expect(nonLiteralConsoleFirstArgs(source)).toEqual([]);
		const allowed = new Set([TAG_NOT_RECORDED, TAG_NOT_VOUCHED, TAG_REFRESH_FAILED, TAG_GUARD_REFUSED, TAG_GUARD_UNREADABLE]);
		for (const tag of consoleTags(source)) expect(allowed.has(tag)).toBe(true);
		const calls = source.match(/console\.[a-z]+\([^;]*\);/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toMatch(/^console\.(?:warn|error)\('[^']*'(?:, errorClassName\([A-Za-z_$][\w$]*\))?\);$/);
		}
	});
});
