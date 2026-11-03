/**
 * dashboard-pairing (D-06, D-22, D-25, D-26): the officer side of browser pairing over fake cadre
 * nodes, a counting software signer, fake owner transports and an injected clock and random source.
 * cadre-core is virtual-mocked (ESM-only, boots libp2p) with a codec that implements the real
 * invitation wire format; a parity case pins it to a real-encoder fixture. The vote-engine pieces
 * (pairingStatementDigest, encodeNetworkJoinCode, encodePairingCode, verifyPairingStatement) are
 * the REAL rn exports; the "real database" block runs them on a real test-context network.
 *
 * Host tests use software signers: the hardware Keystore path and its single prompt are proven on a
 * device only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock(
	'@serfab/cadre-core',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Buffer: B } = require('buffer');
		const PREFIX = 'sereus-invite:1.';
		return {
			encodeCadreInvitation: (inv: unknown) => PREFIX + B.from(JSON.stringify(inv), 'utf8').toString('base64url'),
			decodeCadreInvitation: (encoded: string) => {
				const trimmed = String(encoded).trim();
				if (!trimmed.startsWith(PREFIX)) throw new Error('Cadre invitation must start with the prefix');
				let parsed: { v?: unknown; ownerKeys?: unknown; members?: unknown; invite?: unknown } | null;
				try {
					parsed = JSON.parse(B.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8'));
				} catch {
					throw new Error('Cadre invitation does not decode as base64url JSON');
				}
				if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.ownerKeys) || !Array.isArray(parsed.members) || !parsed.invite) {
					throw new Error('Cadre invitation is malformed or of an unsupported version');
				}
				return parsed;
			},
		};
	},
	{ virtual: true },
);

const mockGetDeviceUser = jest.fn();
const mockGetOrCreateDeviceUser = jest.fn(() => {
	throw new Error('getOrCreateDeviceUser must never be called');
});
const mockPersistProvisioned = jest.fn(() => {
	throw new Error('persistProvisionedDeviceUser must never be called');
});
const mockGenerateSoftwareKey = jest.fn(() => {
	throw new Error('generateSoftwareKeyForDev must never be called');
});
jest.mock('../device-user', () => ({
	getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a),
	getOrCreateDeviceUser: (...a: unknown[]) => (mockGetOrCreateDeviceUser as jest.Mock)(...a),
	persistProvisionedDeviceUser: (...a: unknown[]) => (mockPersistProvisioned as jest.Mock)(...a),
	generateSoftwareKeyForDev: (...a: unknown[]) => (mockGenerateSoftwareKey as jest.Mock)(...a),
}));

import { JOIN_CODE_FIXTURES } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {
	decodeNetworkJoinCode,
	decodePairingCode,
	PAIR_MINT_REFUSAL_CODES,
	PAIR_MINT_WINDOW_MS,
} from '@votetorrent/vote-engine/rn';
import type { PairMintMintRequest, PairMintRefusalCode, PairMintReply } from '@votetorrent/vote-engine/rn';
import type { NetworkJoinAnchor } from '@votetorrent/vote-core';
import type { CadreInvitation } from '@serfab/cadre-core';
import {
	loadPairingCapabilityState,
	pairingCapability,
	pairingRefusalReason,
	PAIRING_INVITE_MAX_ADDRS,
	PAIRING_STATEMENT_LIFETIME_MS,
	requestPairingCode,
	trimInvitationMembers,
	type PairingAnchorFailure,
	type PairingCapabilityState,
	type PairingNode,
	type PairingRequestResult,
	type ReadPairingAnchor,
	type RequestPairingCodeDeps,
} from '../dashboard-pairing';
import { readPairedBrowsers } from '../paired-browsers-store';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const codec = require('@serfab/cadre-core') as {
	encodeCadreInvitation(inv: CadreInvitation): string;
	decodeCadreInvitation(encoded: string): CadreInvitation;
};

// ---------------------------------------------------------------------------------------------
// Fixtures

const SELF_PEER = '12D3KooWSe1fPeerSe1fPeerSe1fPeerSe1fPeerSe1fPeerSe1f';
const OWNER_PEER = '12D3KooWQwnerPeerQwnerPeerQwnerPeerQwnerPeerQwnerPee';
const RELAY_PEER = '12D3KooWRe1ayPeerRe1ayPeerRe1ayPeerRe1ayPeerRe1ayPee';
const OWNER_ADDR = `/ip4/192.168.1.9/tcp/4001/ws/p2p/${RELAY_PEER}/p2p-circuit/p2p/${OWNER_PEER}`;
const USER_ID = 'user-1';
const KEY_PUB = '02' + '11'.repeat(32);
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0, 750);

const fixtureDecoded = (() => {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES['v2-6-members'].text);
	if (!d.ok) throw new Error('fixture does not decode');
	return d.code;
})();
const FIXTURE_INVITATION_TEXT = fixtureDecoded.invitation;
const FIXTURE_INVITATION = codec.decodeCadreInvitation(FIXTURE_INVITATION_TEXT);
const ISSUER_KEY = (FIXTURE_INVITATION.invite as { issuerKey: string }).issuerKey;
const FIXTURE_ANCHOR: NetworkJoinAnchor = {
	networkHash: fixtureDecoded.networkHash,
	name: fixtureDecoded.name,
	genesis: fixtureDecoded.genesis,
	digest: fixtureDecoded.digest,
};
const NET = FIXTURE_ANCHOR.networkHash;

/** The fixture invitation as a single-use mint (the owner host mints `uses: 1`). */
function singleUse(over: { invite?: Record<string, unknown>; top?: Record<string, unknown> } = {}): CadreInvitation {
	return {
		...FIXTURE_INVITATION,
		...(over.top ?? {}),
		invite: { ...FIXTURE_INVITATION.invite, totalUses: 1, ...(over.invite ?? {}) },
	} as CadreInvitation;
}

function mintedReply(inv: CadreInvitation = singleUse()): PairMintReply & { t: 'minted' } {
	return {
		t: 'minted',
		v: 1,
		invitation: codec.encodeCadreInvitation(inv),
		inviteKey: inv.invite.key,
		expiresAt: '2026-11-03T10:15:00',
	};
}

function fakeNode(over: Partial<PairingNode> & { ownerKeys?: string[] } = {}): PairingNode & { control: object } {
	const control = { name: 'control-node', getConnections: () => [] };
	const ownerKeys = over.ownerKeys ?? [ISSUER_KEY];
	return {
		control,
		peerId: { toString: () => SELF_PEER },
		partyId: 'votetorrent',
		getControlNode: () => control,
		listOwnerKeys: async () => ownerKeys.map((key) => ({ key, trusted: true })),
		getControlDatabase: () => ({
			queryCadrePeers: async () => [{ peerId: OWNER_PEER, publicKey: ISSUER_KEY, updatedAt: 1 }],
		}),
		resolvePeerAddrs: async (p: string) => (p === OWNER_PEER ? [OWNER_ADDR] : []),
		...over,
	};
}

function countingSigner(opts: { userId?: string; keyPub?: string; sig?: (n: number) => string } = {}) {
	const digests: Uint8Array[] = [];
	const fn = jest.fn(async (digest: Uint8Array) => {
		digests.push(digest);
		const n = digests.length;
		return {
			signerUserId: opts.userId ?? USER_ID,
			signerKey: opts.keyPub ?? KEY_PUB,
			signature: opts.sig ? opts.sig(n) : n.toString(16).padStart(2, '0').repeat(64),
		};
	});
	return Object.assign(fn, { digests });
}

const okAnchor: ReadPairingAnchor = async () => ({ ok: true, anchor: FIXTURE_ANCHOR });
const FAKE_DIGEST = new Uint8Array(32).fill(7);

function baseDeps(over: RequestPairingCodeDeps = {}): RequestPairingCodeDeps {
	let seed = 0;
	return {
		nowMs: () => NOW,
		randomBytes: (n: number) => {
			seed += 1;
			return Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed * 31) & 0xff);
		},
		pairingStatementDigest: jest.fn(async () => FAKE_DIGEST),
		...over,
	};
}

type Args = Parameters<typeof requestPairingCode>[0];

function args(over: Partial<Args> = {}): Args {
	return {
		node: fakeNode(),
		db: {} as Args['db'],
		signer: countingSigner(),
		networkHash: NET,
		userId: USER_ID,
		keyPub: KEY_PUB,
		readAnchor: okAnchor,
		localMint: jest.fn(async () => mintedReply()),
		deps: baseDeps(),
		...over,
	};
}

function membersOf(code: string): string[] {
	const inner = decodeNetworkJoinCode(decodePairingCode(code).joinCode);
	if (!inner.ok) throw new Error('inner join code does not decode');
	return codec.decodeCadreInvitation(inner.code.invitation).members;
}

function okCode(r: PairingRequestResult): string {
	if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
	return r.code;
}

beforeEach(async () => {
	await AsyncStorage.clear();
	mockGetDeviceUser.mockReset();
	mockGetOrCreateDeviceUser.mockClear();
	mockPersistProvisioned.mockClear();
	mockGenerateSoftwareKey.mockClear();
});

// ---------------------------------------------------------------------------------------------

describe('codec mock parity', () => {
	it('decoding the real-encoder fixture invitation and re-encoding it gives the identical text', () => {
		expect(codec.encodeCadreInvitation(codec.decodeCadreInvitation(FIXTURE_INVITATION_TEXT))).toBe(FIXTURE_INVITATION_TEXT);
		expect(FIXTURE_INVITATION.members).toHaveLength(6);
	});
});

describe('constants', () => {
	it('statement lifetime is the owner mint window less one minute; 4 addresses', () => {
		expect(PAIRING_STATEMENT_LIFETIME_MS).toBe(PAIR_MINT_WINDOW_MS - 60_000);
		expect(PAIRING_INVITE_MAX_ADDRS).toBe(4);
	});
});

describe('pairingCapability (Cap)', () => {
	const base: PairingCapabilityState = {
		hasNode: true,
		networkHash: 'n',
		inviteCapability: 'ready',
		isCurrentOfficer: true,
		signingKey: { key: KEY_PUB, type: 'P' },
	};
	it.each<[Partial<PairingCapabilityState>, string]>([
		[{}, 'ready-owner'],
		[{ inviteCapability: 'not-owner' }, 'ready-officer'],
		[{ inviteCapability: 'needs-owner-setup' }, 'ready-officer'],
		[{ hasNode: false }, 'no-network'],
		[{ networkHash: null }, 'no-network'],
		[{ inviteCapability: 'unavailable' }, 'no-network'],
		[{ isCurrentOfficer: false }, 'not-officer'],
		[{ isCurrentOfficer: false, signingKey: null }, 'not-officer'],
		[{ signingKey: null }, 'no-signing-key'],
		[{ signingKey: { key: KEY_PUB, type: 'M' } }, 'no-signing-key'],
		[{ hasNode: false, isCurrentOfficer: false }, 'no-network'],
	])('%j -> %s', (over, want) => {
		expect(pairingCapability({ ...base, ...over })).toBe(want);
	});

	it('loadPairingCapabilityState reads, never throws, never provisions', async () => {
		mockGetDeviceUser.mockResolvedValue({ id: USER_ID, activeKeys: [{ key: KEY_PUB, type: 'P' }] });
		const s1 = await loadPairingCapabilityState({
			node: {},
			db: {},
			networkHash: 'n',
			userId: USER_ID,
			deps: { voterInviteCapability: async () => 'not-owner', isCurrentPairingOfficer: async () => true, nowMs: () => NOW },
		});
		expect(s1).toEqual({
			hasNode: true,
			networkHash: 'n',
			inviteCapability: 'not-owner',
			isCurrentOfficer: true,
			signingKey: { key: KEY_PUB, type: 'P' },
		});
		expect(pairingCapability(s1)).toBe('ready-officer');

		// Every input throws: each reads as its failing value.
		mockGetDeviceUser.mockRejectedValue(new Error('io'));
		const s2 = await loadPairingCapabilityState({
			node: {},
			db: {},
			networkHash: 'n',
			userId: USER_ID,
			deps: {
				voterInviteCapability: async () => {
					throw new Error('x');
				},
				isCurrentPairingOfficer: async () => {
					throw new Error('x');
				},
			},
		});
		expect(s2).toEqual({ hasNode: true, networkHash: 'n', inviteCapability: 'unavailable', isCurrentOfficer: false, signingKey: null });

		// The real voterInviteCapability on a node whose reads throw, no node, no db, another device user.
		mockGetDeviceUser.mockResolvedValue({ id: 'someone-else', activeKeys: [{ key: KEY_PUB, type: 'P' }] });
		const s3 = await loadPairingCapabilityState({ node: { getIdentityOwnerKey: () => { throw new Error('x'); } }, db: null, networkHash: null, userId: USER_ID });
		expect(s3).toEqual({ hasNode: true, networkHash: null, inviteCapability: 'unavailable', isCurrentOfficer: false, signingKey: null });
		const s4 = await loadPairingCapabilityState({ node: null, db: null, networkHash: 'n', userId: null });
		expect(s4.hasNode).toBe(false);
		expect(pairingCapability(s4)).toBe('no-network');

		expect(mockGetOrCreateDeviceUser).not.toHaveBeenCalled();
		expect(mockPersistProvisioned).not.toHaveBeenCalled();
		expect(mockGenerateSoftwareKey).not.toHaveBeenCalled();
	});
});

describe('anchor port', () => {
	it.each<PairingAnchorFailure>(['admin-revised', 'not-open', 'unreadable'])('a resolved %s failure passes through with no prompt', async (failure) => {
		const signer = countingSigner();
		const localMint = jest.fn();
		const readAnchor = jest.fn(async () => ({ ok: false as const, anchor: failure }));
		const r = await requestPairingCode(args({ signer, localMint, readAnchor }));
		expect(r).toEqual({ ok: false, reason: 'build-failed', anchor: failure });
		expect(readAnchor).toHaveBeenCalledTimes(1);
		expect(signer).not.toHaveBeenCalled();
		expect(localMint).not.toHaveBeenCalled();
	});

	it('a rejecting port is build-failed/unreadable; another network is build-failed; no prompt', async () => {
		const signer = countingSigner();
		const r1 = await requestPairingCode(
			args({
				signer,
				readAnchor: async () => {
					throw Object.assign(new Error('genesis rows'), { code: 'genesis-unreadable' });
				},
			}),
		);
		expect(r1).toEqual({ ok: false, reason: 'build-failed', anchor: 'unreadable' });
		const r2 = await requestPairingCode(args({ signer, readAnchor: async () => ({ ok: true, anchor: { ...FIXTURE_ANCHOR, networkHash: 'other' } }) }));
		expect(r2).toEqual({ ok: false, reason: 'build-failed' });
		expect(signer).not.toHaveBeenCalled();
	});

	it('the port is read once per attempt, before the signer', async () => {
		const order: string[] = [];
		const readAnchor = jest.fn(async () => {
			order.push('anchor');
			return { ok: true as const, anchor: FIXTURE_ANCHOR };
		});
		const signer = countingSigner();
		signer.mockImplementation(async () => {
			order.push('sign');
			return { signerUserId: USER_ID, signerKey: KEY_PUB, signature: 'ab'.repeat(64) };
		});
		okCode(await requestPairingCode(args({ readAnchor, signer })));
		expect(order).toEqual(['anchor', 'sign']);
	});
});

describe('trimInvitationMembers', () => {
	it('keeps 4, circuit first in original order, other fields identical', () => {
		const c = (i: number) => `/ip4/1.1.1.${i}/tcp/1/ws/p2p/${RELAY_PEER}/p2p-circuit/p2p/${OWNER_PEER}`;
		const d = (i: number) => `/ip4/2.2.2.${i}/tcp/1/ws/p2p/${OWNER_PEER}`;
		const inv = { ...FIXTURE_INVITATION, members: [d(1), c(1), d(2), c(2), c(3), d(3)] } as CadreInvitation;
		const out = trimInvitationMembers(inv);
		expect(out.members).toEqual([c(1), c(2), c(3), d(1)]);
		expect(out.partyId).toBe(inv.partyId);
		expect(out.invitePrivateKey).toBe(inv.invitePrivateKey);
		expect(out.invite).toBe(inv.invite);
		expect(out.ownerKeys).toBe(inv.ownerKeys);
		expect(inv.members).toHaveLength(6); // input untouched
		const small = { ...FIXTURE_INVITATION, members: [d(1), c(1)] } as CadreInvitation;
		expect(trimInvitationMembers(small).members).toEqual([c(1), d(1)]);
		expect(trimInvitationMembers(small, 1).members).toEqual([c(1)]);
		// Key order is kept, so a re-encode differs only in the member list.
		expect(Object.keys(trimInvitationMembers(inv))).toEqual(Object.keys(inv));
	});
});

describe('requestPairingCode flows', () => {
	it('F1 non-owner: one signature over pairingStatementDigest, the request matches the code, dialled from the control node', async () => {
		const node = fakeNode();
		const signer = countingSigner();
		const sent: PairMintMintRequest[] = [];
		const request = jest.fn(async (_c: unknown, _t: unknown, req: PairMintMintRequest) => {
			sent.push(req);
			return mintedReply();
		});
		const digestFn = jest.fn(async () => FAKE_DIGEST);
		const r = await requestPairingCode(
			args({ node, signer, localMint: undefined, deps: baseDeps({ request: request as never, pairingStatementDigest: digestFn }) }),
		);
		const code = okCode(r);
		expect(signer).toHaveBeenCalledTimes(1);
		expect(signer.digests[0]).toBe(FAKE_DIGEST);
		const { statement } = decodePairingCode(code);
		expect(digestFn).toHaveBeenCalledTimes(1);
		expect((digestFn.mock.calls[0] as unknown[])[1]).toEqual({
			networkHash: NET,
			userId: USER_ID,
			nonce: statement.nonce,
			expiresAt: statement.expiresAt,
			requesterPeerId: SELF_PEER,
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toBe(node.control);
		expect(String(request.mock.calls[0][1])).toBe(OWNER_ADDR);
		expect(sent[0]).toEqual({
			t: 'mint',
			v: 1,
			networkHash: NET,
			userId: USER_ID,
			nonce: statement.nonce,
			expiresAt: statement.expiresAt,
			requesterPeerId: statement.requesterPeerId,
			keyPub: statement.keyPub,
			sig: statement.sig,
		});
		expect(statement.requesterPeerId).toBe(SELF_PEER);
		expect(code.startsWith('vtpair1.')).toBe(true);
		expect(membersOf(code)).toHaveLength(4);
	});

	it('F2 owner: localMint once; nothing dialled and no owner lookup', async () => {
		const localMint = jest.fn(async () => mintedReply());
		const finder = jest.fn(async () => []);
		const request = jest.fn();
		okCode(await requestPairingCode(args({ localMint, deps: baseDeps({ findOwnerTargets: finder, request: request as never }) })));
		expect(localMint).toHaveBeenCalledTimes(1);
		expect(finder).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it('F3 Retry: fresh nonce and signature each attempt; never a retry inside an attempt', async () => {
		const signer = countingSigner();
		const deps = { ...baseDeps(), randomBytes: undefined };
		const r1 = await requestPairingCode(args({ signer, deps }));
		const r2 = await requestPairingCode(args({ signer, deps }));
		expect(signer).toHaveBeenCalledTimes(2);
		const s1 = decodePairingCode(okCode(r1)).statement;
		const s2 = decodePairingCode(okCode(r2)).statement;
		expect(s1.nonce).not.toBe(s2.nonce);
		expect(s1.sig).not.toBe(s2.sig);

		// A refusal: one request, one signature.
		const refusedSigner = countingSigner();
		const refusing = jest.fn(async () => ({ t: 'refused', v: 1, code: 'replayed' }) as PairMintReply);
		const two = jest.fn(async () => [
			{ peerId: OWNER_PEER, addr: OWNER_ADDR, source: 'record' as const },
			{ peerId: OWNER_PEER, addr: OWNER_ADDR + '/x', source: 'record' as const },
		]);
		const rr = await requestPairingCode(
			args({ signer: refusedSigner, localMint: undefined, deps: baseDeps({ request: refusing as never, findOwnerTargets: two }) }),
		);
		expect(rr).toEqual({ ok: false, reason: 'build-failed', refusal: 'replayed' });
		expect(refusing).toHaveBeenCalledTimes(1);
		expect(refusedSigner).toHaveBeenCalledTimes(1);

		// requestSent: true: never resent to the second target.
		const sentSigner = countingSigner();
		const lost = jest.fn(async () => {
			throw Object.assign(new Error('timeout'), { requestSent: true });
		});
		const rl = await requestPairingCode(args({ signer: sentSigner, localMint: undefined, deps: baseDeps({ request: lost as never, findOwnerTargets: two }) }));
		expect(rl).toEqual({ ok: false, reason: 'owner-unreachable', requestSent: true });
		expect(lost).toHaveBeenCalledTimes(1);
		expect(sentSigner).toHaveBeenCalledTimes(1);
	});

	it('F4 no prompt for failures known before signing', async () => {
		const signer = countingSigner();
		const localMint = jest.fn(async () => mintedReply());
		const noControl = fakeNode({ getControlNode: () => null });
		expect(await requestPairingCode(args({ signer, localMint, node: noControl }))).toEqual({ ok: false, reason: 'build-failed' });
		const noPeer = fakeNode({ peerId: undefined });
		expect(await requestPairingCode(args({ signer, localMint, node: noPeer }))).toEqual({ ok: false, reason: 'build-failed' });
		expect(await requestPairingCode(args({ signer, localMint, readAnchor: async () => ({ ok: false, anchor: 'not-open' }) }))).toEqual({
			ok: false,
			reason: 'build-failed',
			anchor: 'not-open',
		});
		const noOwners = fakeNode({ ownerKeys: [] });
		expect(await requestPairingCode(args({ signer, localMint: undefined, node: noOwners }))).toEqual({ ok: false, reason: 'owner-unreachable' });
		const ac = new AbortController();
		ac.abort();
		expect(await requestPairingCode(args({ signer, localMint, signal: ac.signal }))).toEqual({ ok: false, reason: 'cancelled' });
		expect(signer).not.toHaveBeenCalled();
		expect(localMint).not.toHaveBeenCalled();

		// A concurrent call while one is in flight: cancelled at once, no second prompt.
		let release: (r: PairMintReply) => void = () => undefined;
		const slowMint = jest.fn(() => new Promise<PairMintReply>((resolve) => { release = resolve; }));
		const busySigner = countingSigner();
		const first = requestPairingCode(args({ signer: busySigner, localMint: slowMint }));
		const second = await requestPairingCode(args({ signer: busySigner, localMint: slowMint }));
		expect(second).toEqual({ ok: false, reason: 'cancelled' });
		for (let i = 0; i < 50 && slowMint.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
		expect(slowMint).toHaveBeenCalledTimes(1);
		release(mintedReply());
		okCode(await first);
		expect(busySigner).toHaveBeenCalledTimes(1);
		// The flag is released: the next attempt runs.
		okCode(await requestPairingCode(args()));
	});

	it('F5 every refusal code maps into the closed set and carries the code', async () => {
		const expected: Record<string, string> = {
			'not-officer': 'not-allowed',
			'bad-signature': 'not-allowed',
			expired: 'not-allowed',
			'rate-limited': 'not-allowed',
			'switched-off': 'switched-off',
			'not-reachable': 'not-reachable',
			'not-owner': 'owner-unreachable',
			replayed: 'build-failed',
			'requester-mismatch': 'build-failed',
			malformed: 'build-failed',
			'unknown-pairing': 'build-failed',
		};
		for (const code of PAIR_MINT_REFUSAL_CODES as readonly PairMintRefusalCode[]) {
			expect(Object.prototype.hasOwnProperty.call(expected, code)).toBe(true);
			expect(pairingRefusalReason(code)).toBe(expected[code]);
			const r = await requestPairingCode(args({ localMint: async () => ({ t: 'refused', v: 1, code }) }));
			expect(r).toEqual({ ok: false, reason: expected[code], refusal: code });
		}
		const removed = await requestPairingCode(args({ localMint: async () => ({ t: 'removed', v: 1, peerId: OWNER_PEER }) }));
		expect(removed).toEqual({ ok: false, reason: 'build-failed' });

		const remote = (request: unknown, extra: Partial<Args> = {}) =>
			requestPairingCode(args({ localMint: undefined, deps: baseDeps({ request: request as never }), ...extra }));
		expect(await remote(jest.fn(async () => { throw Object.assign(new Error('dial'), { requestSent: false }); }))).toEqual({
			ok: false,
			reason: 'owner-unreachable',
		});
		expect(await remote(jest.fn(async () => { throw Object.assign(new Error('t'), { requestSent: true }); }))).toEqual({
			ok: false,
			reason: 'owner-unreachable',
			requestSent: true,
		});
		const ac = new AbortController();
		const hanging = jest.fn(() => {
			setTimeout(() => ac.abort(), 0);
			return new Promise<PairMintReply>(() => undefined);
		});
		expect(await remote(hanging, { signal: ac.signal })).toEqual({ ok: false, reason: 'cancelled' });
		// A throwing localMint is build-failed.
		expect(await requestPairingCode(args({ localMint: async () => { throw new Error('host'); } }))).toEqual({ ok: false, reason: 'build-failed' });
	});

	it('F6 the minted reply is validated', async () => {
		const run = (reply: PairMintReply, node = fakeNode()) => requestPairingCode(args({ node, localMint: async () => reply }));
		const bad = { ok: false, reason: 'build-failed' };
		expect(await run(mintedReply(singleUse({ invite: { totalUses: 2 } })))).toEqual(bad);
		expect(await run(mintedReply(singleUse({ invite: { totalUses: 1000 } })))).toEqual(bad);
		expect(await run(mintedReply(singleUse({ invite: { peerId: OWNER_PEER } })))).toEqual(bad);
		expect(await run({ ...mintedReply(), inviteKey: 'another-key' })).toEqual(bad);
		expect(await run(mintedReply(singleUse({ top: { partyId: 'other-party' } })))).toEqual(bad);
		expect(await run(mintedReply(), fakeNode({ ownerKeys: ['someone-else'] }))).toEqual(bad);
		expect(await run(mintedReply(singleUse({ top: { ownerKeys: [ISSUER_KEY, 'stranger-key'] } })))).toEqual(bad);
		expect(await run({ ...mintedReply(), invitation: 'sereus-invite:1.@@@' })).toEqual(bad);
		expect(await run({ ...mintedReply(), invitation: 'not an invitation' })).toEqual(bad);
		expect(await run(mintedReply(), fakeNode({ partyId: undefined }))).toEqual(bad);
		expect(await run(mintedReply(singleUse({ top: { members: [] } })))).toEqual({ ok: false, reason: 'not-reachable' });
		// The anchor's network must be the requested one (checked before any prompt).
		const signer = countingSigner();
		expect(
			await requestPairingCode(args({ signer, readAnchor: async () => ({ ok: true, anchor: { ...FIXTURE_ANCHOR, networkHash: 'elsewhere' } }) })),
		).toEqual(bad);
		expect(signer).not.toHaveBeenCalled();
		expect(await readPairedBrowsers()).toEqual([]);
	});

	it('F7 signer: a coded rejection passes through unchanged; others and mismatched signatures are build-failed with nothing sent', async () => {
		const coded = Object.assign(new Error('no key'), { code: 'NO_KEY_PROVISIONED' });
		const localMint = jest.fn(async () => mintedReply());
		const s1 = jest.fn(async () => {
			throw coded;
		});
		await expect(requestPairingCode(args({ signer: s1, localMint }))).rejects.toBe(coded);
		const s2 = jest.fn(async () => {
			throw new Error('plain');
		});
		expect(await requestPairingCode(args({ signer: s2, localMint }))).toEqual({ ok: false, reason: 'build-failed' });
		expect(await requestPairingCode(args({ signer: countingSigner({ userId: 'other-user' }), localMint }))).toEqual({
			ok: false,
			reason: 'build-failed',
		});
		expect(await requestPairingCode(args({ signer: countingSigner({ keyPub: '03' + '22'.repeat(32) }), localMint }))).toEqual({
			ok: false,
			reason: 'build-failed',
		});
		expect(localMint).not.toHaveBeenCalled();
		// After the passthrough the in-flight flag was released.
		okCode(await requestPairingCode(args()));
	});

	it('F8 the pairing is recorded before the result resolves; a store failure gives no code', async () => {
		let releaseStore: () => void = () => undefined;
		const record = jest.fn(() => new Promise<void>((resolve) => { releaseStore = resolve; }));
		let settled = false;
		const pending = requestPairingCode(args({ label: 'Office laptop', deps: baseDeps({ recordPairedBrowser: record }) })).then((r) => {
			settled = true;
			return r;
		});
		for (let i = 0; i < 50 && record.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
		expect(record).toHaveBeenCalledTimes(1);
		await new Promise((r) => setTimeout(r, 5));
		expect(settled).toBe(false);
		releaseStore();
		const r = await pending;
		const code = okCode(r);
		const { statement } = decodePairingCode(code);
		const reply = mintedReply();
		expect(record.mock.calls[0]).toEqual([
			{
				nonce: statement.nonce,
				userId: USER_ID,
				networkHash: NET,
				inviteKey: reply.inviteKey,
				mintedAt: NOW,
				expiresAt: statement.expiresAt,
				label: 'Office laptop',
			},
		]);

		// No label -> null, through the real store.
		okCode(await requestPairingCode(args()));
		const stored = await readPairedBrowsers();
		expect(stored).toHaveLength(1);
		expect(stored[0].label).toBeNull();

		const failing = jest.fn(async () => {
			throw new Error('disk');
		});
		const rf = await requestPairingCode(args({ deps: baseDeps({ recordPairedBrowser: failing }) }));
		expect(rf).toEqual({ ok: false, reason: 'build-failed' });
		expect('code' in rf).toBe(false);
	});

	it('F9 nonce and expiry shapes', async () => {
		const rb = jest.fn((n: number) => Uint8Array.from({ length: n }, (_, i) => 250 - i));
		const r = await requestPairingCode(args({ deps: baseDeps({ randomBytes: rb }) }));
		if (!r.ok) throw new Error('expected ok');
		expect(rb).toHaveBeenCalledWith(16);
		expect(r.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
		const { Buffer: B } = require('buffer');
		expect(r.nonce).toBe(B.from(rb.mock.results[0].value).toString('base64url'));
		expect(r.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		expect(r.expiresAt).toBe(new Date(Math.floor((NOW + PAIRING_STATEMENT_LIFETIME_MS) / 1000) * 1000).toISOString().slice(0, 19));
		expect(r.expiresAt).toBe('2026-11-03T10:14:00');
		expect(decodePairingCode(r.code).statement.expiresAt).toBe(r.expiresAt);
	});
});
