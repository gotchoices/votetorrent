/**
 * authority-network.binding.test.ts — the four Authority network-membership modules (authority-network-join,
 * voter-invite, pair-mint-host, dashboard-pairing) moved to `@votetorrent/workflows` (phase 67 plan 17); the
 * app paths under `engines/` are bindings. A binding that re-implemented logic, or a second
 * `FounderGuardUnreadableError` / `VoterInviteError` class, would fork the workflow, so this pins identity with
 * the shared exports, the exact export sets, the call-time hand-off of the app's cadre-core, device user and
 * key-value store, and that every binding keeps cadre-core off its load path (the navigator reaches the join
 * binding through JoinNetworkScreen, and the RN jest env cannot resolve cadre-core's import-only exports).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { JOIN_CODE_FIXTURES } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { decodeNetworkJoinCode } from '@votetorrent/vote-engine/rn';

// `mock`-prefixed so jest's hoisted module factory can reference them.
const mockDecodeCadreInvitation = jest.fn();
const mockEncodeCadreInvitation = jest.fn();
const mockMergeSeedPeers = jest.fn();
const mockVerifyCadrePeerVoucher = jest.fn();
const mockVerifyInvitationAdmission = jest.fn();
jest.mock(
	'@serfab/cadre-core',
	() => ({
		decodeCadreInvitation: (...a: unknown[]) => mockDecodeCadreInvitation(...a),
		encodeCadreInvitation: (...a: unknown[]) => mockEncodeCadreInvitation(...a),
		mergeSeedPeers: (...a: unknown[]) => mockMergeSeedPeers(...a),
		verifyCadrePeerVoucher: (...a: unknown[]) => mockVerifyCadrePeerVoucher(...a),
		verifyInvitationAdmission: (...a: unknown[]) => mockVerifyInvitationAdmission(...a),
	}),
	{ virtual: true },
);

const mockGetDeviceUser = jest.fn();
jest.mock('../device-user', () => ({
	getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require('@votetorrent/workflows/authority') as Record<string, unknown>;
import * as joinBinding from '../authority-network-join';
import * as voterInviteBinding from '../voter-invite';
import * as pairMintHostBinding from '../pair-mint-host';
import * as dashboardPairingBinding from '../dashboard-pairing';
import * as pairingOwnerStore from '../pairing-owner-store';

const sortedKeys = (m: object) => Object.keys(m).sort();
const SELF = 'peer-self';
const SELF_KEY = 'self-pub';

const JOIN_VALUES = ['FounderGuardUnreadableError', 'isFounderGuardUnreadableError'];
const VOTER_INVITE_VALUES = [
	'VOTER_INVITE_USES',
	'VOTER_INVITE_LIFETIME_MS',
	'PAIR_INVITE_USES',
	'PAIR_INVITE_LIFETIME_MS',
	'voterInviteCapability',
	'ensureVoterInviteOwner',
	'VoterInviteError',
	'inviteExpiryMs',
	'PairingInviteError',
];
const PAIR_MINT_HOST_VALUES = [
	'ACTIVE_NETWORKS_KEY',
	'REVOCATION_TABLE',
	'REVOCATION_BACKSTOP_MS',
	'REVOCATION_SWEEP_MAX_LOOKUPS',
	'REVOCATION_SWEEP_MAX_ACTIONS',
	'planRevocationActions',
];
const DASHBOARD_PAIRING_VALUES = ['PAIRING_INVITE_MAX_ADDRS', 'PAIRING_STATEMENT_LIFETIME_MS', 'pairingCapability', 'trimInvitationMembers', 'pairingRefusalReason'];
const OWNER_STORE_SHARED_VALUES = ['REVOCATION_RESULTS', 'REVOCATION_GRACE_MS'];

function expectIdentity(binding: object, names: readonly string[]): void {
	for (const name of names) {
		expect(shared[name]).toBeDefined();
		expect((binding as Record<string, unknown>)[name]).toBe(shared[name]);
	}
}

beforeEach(async () => {
	await AsyncStorage.clear();
	mockDecodeCadreInvitation.mockReset();
	mockEncodeCadreInvitation.mockReset();
	mockMergeSeedPeers.mockReset();
	mockVerifyCadrePeerVoucher.mockReset();
	mockVerifyInvitationAdmission.mockReset();
	mockGetDeviceUser.mockReset().mockResolvedValue(undefined);
});

describe('B-1 identity: every pass-through value is the shared export', () => {
	it('authority-network-join', () => expectIdentity(joinBinding, JOIN_VALUES));
	it('voter-invite', () => expectIdentity(voterInviteBinding, VOTER_INVITE_VALUES));
	it('pair-mint-host', () => expectIdentity(pairMintHostBinding, PAIR_MINT_HOST_VALUES));
	it('dashboard-pairing', () => expectIdentity(dashboardPairingBinding, DASHBOARD_PAIRING_VALUES));
	it('pairing-owner-store re-exports the two revocation values', () => expectIdentity(pairingOwnerStore, OWNER_STORE_SHARED_VALUES));
});

describe('B-2 exact export sets: the B-1 names plus the forwarding wrappers, which are not the shared functions', () => {
	const WRAPPERS: ReadonlyArray<[string, object, readonly string[], readonly string[]]> = [
		['authority-network-join', joinBinding, JOIN_VALUES, ['runAuthorityNetworkJoin', 'completeAuthorityJoin']],
		['voter-invite', voterInviteBinding, VOTER_INVITE_VALUES, ['createVoterJoinCode', 'createPairingInvitation']],
		['pair-mint-host', pairMintHostBinding, PAIR_MINT_HOST_VALUES, ['readActiveNetworkHash', 'hostPairMint', 'startPairMintHost']],
		['dashboard-pairing', dashboardPairingBinding, DASHBOARD_PAIRING_VALUES, ['loadPairingCapabilityState', 'requestPairingCode']],
	];
	it.each(WRAPPERS)('%s', (_name, binding, values, wrappers) => {
		expect(sortedKeys(binding)).toEqual([...values, ...wrappers].sort());
		for (const w of wrappers) {
			const fn = (binding as Record<string, unknown>)[w];
			expect(typeof fn).toBe('function');
			expect(typeof shared[w]).toBe('function');
			expect(fn).not.toBe(shared[w]);
		}
	});
});

describe('B-3 the bindings hand the app dependencies to the shared code at call time', () => {
	it('(a) runAuthorityNetworkJoin reaches the app cadre-core decoder', async () => {
		const decoded = decodeNetworkJoinCode(JOIN_CODE_FIXTURES['v2-1-member'].text);
		if (!decoded.ok) throw new Error('fixture does not decode');
		mockDecodeCadreInvitation.mockImplementation(() => {
			throw new Error('decode refused');
		});
		const node = {
			partyId: 'votetorrent',
			peerId: { toString: () => SELF },
			redeemCadreInvitation: jest.fn(async () => ({})),
			getControlDatabase: () => ({
				queryCadrePeers: async () => [],
				queryCadreInvites: async () => [],
				queryCadreInviteUsages: async () => [],
				querySeedPeers: async () => [],
				getOwnerKeys: async () => new Set<string>(),
			}),
			getTrustedOwnerStore: () => ({ has: () => true }),
			getIdentityOwnerKey: () => ({ publicKeyB64: SELF_KEY }),
			getControlNode: () => ({ getConnections: () => [] }),
			refreshMembershipGate: jest.fn(async () => undefined),
			reconcileControlCohort: jest.fn(async () => undefined),
			wireOwnKeyIfOwner: jest.fn(async () => true),
		};
		const joinFromStrand = jest.fn();
		const result = await joinBinding.runAuthorityNetworkJoin({
			node: node as never,
			networksEngine: { joinFromStrand } as never,
			user: undefined,
			code: decoded.code,
		});
		expect(result.ok).toBe(false);
		expect(mockDecodeCadreInvitation.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(joinFromStrand).not.toHaveBeenCalled();
	});

	it('(b) createPairingInvitation(node) mints on a ready owner without touching the encoder', async () => {
		const node = {
			peerId: { toString: () => SELF },
			getMultiaddrs: () => ['/ip4/203.0.113.1/tcp/1/ws'],
			getIdentityOwnerKey: () => ({ publicKeyB64: SELF_KEY, privateKeyB64: 'priv' }),
			getControlDatabase: () => ({
				getOwnerKeys: async () => new Set([SELF_KEY]),
				ensureOwnerKey: async () => false,
				queryCadrePeers: async () => [],
			}),
			getSeedBootstrapService: () => ({ canAuthorize: () => true }),
			trustOwnerKeys: async () => undefined,
			initializeSeedBootstrap: async () => undefined,
			createCadreInvitation: async () => ({ encoded: 'enc', invitation: { invite: { key: 'invite-key', expiresAt: '2030-01-01T00:00:00' } } }),
		};
		const minted = await voterInviteBinding.createPairingInvitation(node as never);
		expect(minted).toEqual({ encoded: 'enc', inviteKey: 'invite-key', expiresAt: '2030-01-01T00:00:00' });
		expect(mockEncodeCadreInvitation).toHaveBeenCalledTimes(0);
	});

	it('(c) loadPairingCapabilityState reads the app device user exactly once', async () => {
		const state = await dashboardPairingBinding.loadPairingCapabilityState({ node: null, db: null, networkHash: null, userId: null });
		expect(mockGetDeviceUser).toHaveBeenCalledTimes(1);
		expect(state.hasNode).toBe(false);
		expect(state.signingKey).toBeNull();
	});

	it('(d) readActiveNetworkHash() reads the app key-value store', async () => {
		await AsyncStorage.setItem('recentNetworks', JSON.stringify([{ hash: 'h1' }]));
		await expect(pairMintHostBinding.readActiveNetworkHash()).resolves.toBe('h1');
	});
});

describe('B-4 cadre-core load path', () => {
	// The shared mock registry already holds the top-level cadre-core double; without a reset, an isolated
	// registry would hand that instance back and the counting factory would never run.
	beforeEach(() => {
		jest.resetModules();
	});
	afterEach(() => {
		jest.doMock(
			'@serfab/cadre-core',
			() => ({
				decodeCadreInvitation: (...a: unknown[]) => mockDecodeCadreInvitation(...a),
				encodeCadreInvitation: (...a: unknown[]) => mockEncodeCadreInvitation(...a),
				mergeSeedPeers: (...a: unknown[]) => mockMergeSeedPeers(...a),
				verifyCadrePeerVoucher: (...a: unknown[]) => mockVerifyCadrePeerVoucher(...a),
				verifyInvitationAdmission: (...a: unknown[]) => mockVerifyInvitationAdmission(...a),
			}),
			{ virtual: true },
		);
	});

	it('all four bindings and the codec load without cadre-core; one codec call loads it', () => {
		let loads = 0;
		jest.isolateModules(() => {
			jest.doMock(
				'@serfab/cadre-core',
				() => {
					loads += 1;
					return { encodeCadreInvitation: () => 'encoded', decodeCadreInvitation: () => ({}) };
				},
				{ virtual: true },
			);
			require('../authority-network-join');
			require('../voter-invite');
			require('../pair-mint-host');
			require('../dashboard-pairing');
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { lazyCadreInvitationCodec } = require('../lazy-cadre-invitation-codec') as typeof import('../lazy-cadre-invitation-codec');
			expect(loads).toBe(0);
			expect(lazyCadreInvitationCodec.encodeCadreInvitation({} as never)).toBe('encoded');
			expect(loads).toBe(1);
		});
	});

	it('the join binding reaches cadre-core only when a join step calls a verifier', async () => {
		let loads = 0;
		let verified = 0;
		let joinBinding: typeof import('../authority-network-join') | undefined;
		jest.isolateModules(() => {
			jest.doMock(
				'@serfab/cadre-core',
				() => {
					loads += 1;
					return {
						verifyCadrePeerVoucher: () => {
							verified += 1;
							return true;
						},
						verifyInvitationAdmission: () => true,
					};
				},
				{ virtual: true },
			);
			joinBinding = require('../authority-network-join');
			expect(loads).toBe(0);
		});
		const node = {
			partyId: 'p',
			peerId: { toString: () => SELF },
			getTrustedOwnerStore: () => ({ has: () => true }),
			getControlDatabase: () => ({
				queryCadrePeers: async () => [{ peerId: SELF, stampId: 's', vouchOwner: 'owner', vouchSig: 'sig', vouchUsage: null }],
				queryCadreInvites: async () => [],
				queryCadreInviteUsages: async () => [],
			}),
			wireOwnKeyIfOwner: async () => true,
		};
		const result = await joinBinding!.completeAuthorityJoin({
			node: node as never,
			networkRef: { hash: 'h', name: 'n' } as never,
			selectNetwork: async () => undefined,
			refreshOwnerTrust: async () => undefined,
		});
		expect(result).toEqual({ trustSaved: true });
		expect(verified).toBe(1);
		expect(loads).toBe(1);
	});
});
