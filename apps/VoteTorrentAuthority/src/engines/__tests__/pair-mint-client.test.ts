/**
 * pair-mint-client (D-22, D-26): owner lookup over fake cadre nodes, and the failover client's
 * no-resend rule with a jest.fn transport and an injected clock. cadre-core is not imported by the
 * module under test, so no mock is needed. Every test runs under a console capture and must make
 * zero console calls.
 */
import {
	createPairMintFailoverClient,
	findOwnerTargets,
	PAIR_MINT_ADDRS_PER_OWNER,
	PAIR_MINT_MAX_TARGETS,
	PAIR_MINT_TARGET_TIMEOUT_MS,
	PAIR_MINT_TOTAL_BUDGET_MS,
	PairMintCancelledError,
	PairMintNoReplyError,
	PairMintUnreachableError,
	type DialTarget,
	type PairMintClientNode,
} from '../pair-mint-client';
import { captureConsole, type ConsoleCapture } from '../__fixtures__/console-leak';
import type { PairMintMintRequest, PairMintReply } from '@votetorrent/vote-engine/rn';

const SELF = '12D3KooWSelfSelfSelfSelfSelfSelfSelfSelfSelfSelfSelf';
const OWNER_A = '12D3KooWOwnerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER_B = '12D3KooWOwnerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER_C = '12D3KooWOwnerCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const MEMBER = '12D3KooWMemberMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const UNTRUSTED = '12D3KooWUntrustedUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU';
const RELAY = '12D3KooWRelayRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR';

const KEY = (p: string): string => `key-${p.slice(-6)}`;
const circuit = (peer: string, n = 1): string => `/ip4/192.168.1.${n}/tcp/4001/ws/p2p/${RELAY}/p2p-circuit/p2p/${peer}`;

interface FakeOpts {
	ownerKeys?: Array<{ key: string; trusted: boolean }>;
	rows?: Array<{ peerId: string; publicKey: string | null; updatedAt: number }>;
	records?: Record<string, unknown[]>;
	connections?: Array<{ remotePeer: { toString(): string }; remoteAddr: { toString(): string } }>;
	noDb?: boolean;
	listThrows?: boolean;
	queryThrows?: boolean;
	resolveThrows?: string[];
}

function fakeNode(o: FakeOpts = {}): PairMintClientNode & { control: unknown } {
	const control = {
		getConnections: () => o.connections ?? [],
	};
	return {
		control,
		peerId: { toString: () => SELF },
		getControlNode: () => control,
		listOwnerKeys: async () => {
			if (o.listThrows) throw new Error('boom');
			return (
				o.ownerKeys ?? [
					{ key: KEY(OWNER_A), trusted: true },
					{ key: KEY(OWNER_B), trusted: true },
					{ key: KEY(OWNER_C), trusted: true },
					{ key: KEY(SELF), trusted: true },
					{ key: KEY(UNTRUSTED), trusted: false },
				]
			);
		},
		getControlDatabase: () =>
			o.noDb
				? null
				: {
						queryCadrePeers: async () => {
							if (o.queryThrows) throw new Error('boom');
							return (
								o.rows ?? [
									{ peerId: OWNER_A, publicKey: KEY(OWNER_A), updatedAt: 100 },
									{ peerId: OWNER_B, publicKey: KEY(OWNER_B), updatedAt: 300 },
									{ peerId: SELF, publicKey: KEY(SELF), updatedAt: 999 },
									{ peerId: MEMBER, publicKey: null, updatedAt: 500 },
									{ peerId: UNTRUSTED, publicKey: KEY(UNTRUSTED), updatedAt: 800 },
								]
							);
						},
				  },
		resolvePeerAddrs: async (peerId: string) => {
			if (o.resolveThrows?.includes(peerId)) throw new Error('boom');
			return o.records?.[peerId] ?? [];
		},
	};
}

const REQUEST: PairMintMintRequest = {
	t: 'mint',
	v: 1,
	networkHash: 'net-hash',
	userId: 'user-1',
	nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
	expiresAt: '2026-11-03T10:14:00',
	requesterPeerId: SELF,
	keyPub: '02' + 'ab'.repeat(32),
	sig: 'cd'.repeat(64),
};

const MINTED: PairMintReply = { t: 'minted', v: 1, invitation: 'sereus-invite:1.x', inviteKey: 'ik', expiresAt: '2026-11-03T10:15:00' };
const REFUSED: PairMintReply = { t: 'refused', v: 1, code: 'switched-off' };

function sentErr(requestSent: boolean): Error & { requestSent: boolean } {
	return Object.assign(new Error(`transport failed at ${circuit(OWNER_A)}`), { requestSent });
}

function targets(n: number): DialTarget[] {
	const out: DialTarget[] = [];
	for (let i = 0; i < n; i++) out.push({ peerId: `peer${i}`, addr: `addr-${i}`, source: 'record' });
	return out;
}

let capture: ConsoleCapture;
beforeEach(() => {
	capture = captureConsole();
});
afterEach(() => {
	const calls = capture.calls();
	capture.restore();
	expect(calls).toHaveLength(0);
});

describe('findOwnerTargets (D-22)', () => {
	it('C1 trusted live owners only, self excluded, connected first then newest, per-owner and total caps, dedupe', async () => {
		const many = (peer: string): string[] => [1, 2, 3, 4, 5].map((n) => circuit(peer, n));
		const node = fakeNode({
			records: { [OWNER_A]: many(OWNER_A), [OWNER_B]: many(OWNER_B), [UNTRUSTED]: [circuit(UNTRUSTED)], [SELF]: [circuit(SELF)] },
			connections: [{ remotePeer: { toString: () => OWNER_A }, remoteAddr: { toString: () => circuit(OWNER_A, 9) } }],
		});
		const out = await findOwnerTargets(node, { readJoinBootstrap: async () => [] });
		expect(out.map((t) => t.peerId)).toEqual([OWNER_A, OWNER_A, OWNER_A, OWNER_B, OWNER_B, OWNER_B]);
		expect(out.every((t) => t.source === 'record')).toBe(true);
		expect(out.filter((t) => t.peerId === OWNER_A)).toHaveLength(PAIR_MINT_ADDRS_PER_OWNER);
		expect(out.some((t) => t.peerId === SELF || t.peerId === UNTRUSTED || t.peerId === MEMBER)).toBe(false);

		// Without the connection, the newest updatedAt (B=300) goes first.
		const n2 = fakeNode({ records: { [OWNER_A]: many(OWNER_A), [OWNER_B]: many(OWNER_B) } });
		const out2 = await findOwnerTargets(n2, { readJoinBootstrap: async () => [] });
		expect(out2[0].peerId).toBe(OWNER_B);

		// Total cap and dedupe across owners.
		const rows = [];
		const records: Record<string, unknown[]> = {};
		const keys = [];
		for (let i = 0; i < 6; i++) {
			const p = `12D3KooWOwner${i}${'x'.repeat(39)}`;
			rows.push({ peerId: p, publicKey: `k${i}`, updatedAt: i });
			keys.push({ key: `k${i}`, trusted: true });
			records[p] = [`/dup/p2p/${p}`, `/dup/p2p/${p}`, `/b/p2p/${p}`];
		}
		const n3 = fakeNode({ rows, ownerKeys: keys, records });
		const out3 = await findOwnerTargets(n3, { readJoinBootstrap: async () => [] });
		expect(out3).toHaveLength(PAIR_MINT_MAX_TARGETS);
		expect(new Set(out3.map((t) => String(t.addr))).size).toBe(out3.length);
	});

	it('C2 no record address: live connection addr ending /p2p/<owner>, else join-bootstrap for that owner; a throwing target is skipped', async () => {
		const connAddr = circuit(OWNER_A, 7);
		const node = fakeNode({
			connections: [
				{ remotePeer: { toString: () => OWNER_A }, remoteAddr: { toString: () => connAddr } },
				// B's live address does not end in its own peer id: not used.
				{ remotePeer: { toString: () => OWNER_B }, remoteAddr: { toString: () => `/ip4/10.0.0.1/tcp/1/p2p/${RELAY}` } },
			],
		});
		const bad = circuit(OWNER_B, 3);
		const out = await findOwnerTargets(node, {
			readJoinBootstrap: async () => [circuit(OWNER_B, 1), circuit(MEMBER, 2), bad, circuit(OWNER_B, 4)],
			toDialTarget: (a: string) => {
				if (a === bad) throw new Error('bad addr');
				return { ma: a, toString: () => a };
			},
		});
		// Both owners are connected, so the newer row (B, updatedAt 300) goes first.
		expect(out.map((t) => [t.peerId, t.source, String(t.addr)])).toEqual([
			[OWNER_B, 'join-bootstrap', circuit(OWNER_B, 1)],
			[OWNER_B, 'join-bootstrap', circuit(OWNER_B, 4)],
			[OWNER_A, 'connection', connAddr],
		]);
		// A resolvePeerAddrs throw reads as no record.
		const n2 = fakeNode({ resolveThrows: [OWNER_A, OWNER_B], records: {} });
		const out2 = await findOwnerTargets(n2, { readJoinBootstrap: async () => [circuit(OWNER_A, 1)], toDialTarget: (a) => a });
		expect(out2).toEqual([{ peerId: OWNER_A, addr: circuit(OWNER_A, 1), source: 'join-bootstrap' }]);
	});

	it('C3 a failed read gives [] and never throws', async () => {
		await expect(findOwnerTargets(fakeNode({ listThrows: true }))).resolves.toEqual([]);
		await expect(findOwnerTargets(fakeNode({ noDb: true }))).resolves.toEqual([]);
		await expect(findOwnerTargets(fakeNode({ queryThrows: true }))).resolves.toEqual([]);
		const broken = { ...fakeNode(), getControlNode: () => { throw new Error('x'); } } as PairMintClientNode;
		await expect(findOwnerTargets(broken, { readJoinBootstrap: async () => { throw new Error('x'); } })).resolves.toEqual([]);
	});
});

describe('createPairMintFailoverClient (D-26)', () => {
	it('C4 fails over on requestSent false; any reply is returned at once', async () => {
		const request = jest.fn().mockRejectedValueOnce(sentErr(false)).mockResolvedValueOnce(REFUSED).mockResolvedValue(MINTED);
		const client = createPairMintFailoverClient({ c: 1 }, targets(3), { request });
		await expect(client.call(REQUEST)).resolves.toBe(REFUSED);
		expect(request).toHaveBeenCalledTimes(2);
		const r2 = jest.fn().mockResolvedValue(MINTED);
		await expect(createPairMintFailoverClient({}, targets(3), { request: r2 }).call(REQUEST)).resolves.toBe(MINTED);
		expect(r2).toHaveBeenCalledTimes(1);
	});

	it('C5 requestSent true rejects PairMintNoReplyError and the second target is never called', async () => {
		const calls: string[] = [];
		const request = jest.fn(async (_c: unknown, addr: unknown) => {
			calls.push(String(addr));
			throw sentErr(true);
		});
		const err = await createPairMintFailoverClient({}, targets(2), { request }).call(REQUEST).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PairMintNoReplyError);
		expect((err as PairMintNoReplyError).requestSent).toBe(true);
		expect(calls.filter((a) => a === 'addr-1')).toHaveLength(0);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('C6 every target failing before send, or no target, rejects PairMintUnreachableError', async () => {
		const request = jest.fn().mockRejectedValue(sentErr(false));
		const e1 = await createPairMintFailoverClient({}, targets(3), { request }).call(REQUEST).catch((e: unknown) => e);
		expect(e1).toBeInstanceOf(PairMintUnreachableError);
		expect((e1 as PairMintUnreachableError).requestSent).toBe(false);
		expect(request).toHaveBeenCalledTimes(3);
		const r2 = jest.fn();
		const e2 = await createPairMintFailoverClient({}, [], { request: r2 }).call(REQUEST).catch((e: unknown) => e);
		expect(e2).toBeInstanceOf(PairMintUnreachableError);
		expect(r2).not.toHaveBeenCalled();
		// A plain error with no requestSent property counts as not sent.
		const r3 = jest.fn().mockRejectedValueOnce(new Error('dial')).mockResolvedValue(MINTED);
		await expect(createPairMintFailoverClient({}, targets(2), { request: r3 }).call(REQUEST)).resolves.toBe(MINTED);
	});

	it('C7 abort before a target, abort mid-call, and the total budget', async () => {
		const ac = new AbortController();
		ac.abort();
		const r1 = jest.fn();
		await expect(createPairMintFailoverClient({}, targets(2), { request: r1 }).call(REQUEST, { signal: ac.signal })).rejects.toBeInstanceOf(
			PairMintCancelledError,
		);
		expect(r1).not.toHaveBeenCalled();

		const ac2 = new AbortController();
		let release: (v: PairMintReply) => void = () => undefined;
		const r2 = jest.fn(() => new Promise<PairMintReply>((resolve) => { release = resolve; }));
		const pending = createPairMintFailoverClient({}, targets(3), { request: r2 }).call(REQUEST, { signal: ac2.signal });
		await Promise.resolve();
		ac2.abort();
		await expect(pending).rejects.toBeInstanceOf(PairMintCancelledError);
		release(MINTED); // the abandoned call's later result is ignored
		await Promise.resolve();
		expect(r2).toHaveBeenCalledTimes(1);

		let now = 0;
		const r3 = jest.fn(async () => {
			now += 30_000;
			throw sentErr(false);
		});
		const e3 = await createPairMintFailoverClient({}, targets(5), { request: r3, nowMs: () => now, totalBudgetMs: 60_000 })
			.call(REQUEST)
			.catch((e: unknown) => e);
		expect(e3).toBeInstanceOf(PairMintUnreachableError);
		expect(r3).toHaveBeenCalledTimes(2);
	});

	it('C8 each call gets the control node, the addr, the request unchanged and the target timeout; messages carry no address', async () => {
		const control = { the: 'control' };
		const request = jest.fn().mockRejectedValueOnce(sentErr(false)).mockResolvedValue(MINTED);
		const t = [
			{ peerId: OWNER_A, addr: circuit(OWNER_A), source: 'record' as const },
			{ peerId: OWNER_B, addr: circuit(OWNER_B), source: 'record' as const },
		];
		await createPairMintFailoverClient(control, t, { request, targetTimeoutMs: 1234 }).call(REQUEST);
		expect(request.mock.calls[0]).toEqual([control, t[0].addr, REQUEST, { timeoutMs: 1234 }]);
		expect(request.mock.calls[1][0]).toBe(control);
		expect(request.mock.calls[1][2]).toBe(REQUEST);
		const r2 = jest.fn().mockResolvedValue(MINTED);
		await createPairMintFailoverClient(control, t, { request: r2 }).call(REQUEST);
		expect(r2.mock.calls[0][3]).toEqual({ timeoutMs: PAIR_MINT_TARGET_TIMEOUT_MS });
		expect(PAIR_MINT_TARGET_TIMEOUT_MS).toBe(20_000);
		expect(PAIR_MINT_TOTAL_BUDGET_MS).toBe(60_000);

		const errors: Error[] = [];
		errors.push(await createPairMintFailoverClient(control, t, { request: jest.fn().mockRejectedValue(sentErr(true)) }).call(REQUEST).catch((e) => e));
		errors.push(await createPairMintFailoverClient(control, t, { request: jest.fn().mockRejectedValue(sentErr(false)) }).call(REQUEST).catch((e) => e));
		const ac = new AbortController();
		ac.abort();
		errors.push(await createPairMintFailoverClient(control, t, { request: jest.fn() }).call(REQUEST, { signal: ac.signal }).catch((e) => e));
		expect(errors.map((e) => e.name)).toEqual(['PairMintNoReplyError', 'PairMintUnreachableError', 'PairMintCancelledError']);
		for (const e of errors) {
			for (const needle of [OWNER_A, OWNER_B, RELAY, '/ip4/', '/p2p/']) expect(e.message).not.toContain(needle);
			expect((e as { cause?: unknown }).cause).toBeUndefined();
		}
	});
});
