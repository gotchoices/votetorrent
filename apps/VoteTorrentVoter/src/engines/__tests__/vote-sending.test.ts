/**
 * vote-sending.test.ts — sending a saved vote (spike 102, applied). Real vote-engine pool agents,
 * a real in-process rendezvous and real P-256 consent signatures; only the strand is a fake that
 * keeps the committed blocks in memory (the SQL commit runs in vote-engine's host proof).
 */
import {p256} from '@noble/curves/nist.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToHex} from '@noble/curves/utils.js';
import {
	PoolRendezvous,
	createInMemoryRendezvousClient,
	createPoolIdentity,
	verifySigP256,
	type PoolIdentity,
	type PoolRendezvousClient,
} from '@votetorrent/vote-engine/rn';
import {ConsentAbandonedError} from '@votetorrent/vote-engine/rn';
import {CONSENT_TRANSIENT_RETRY_CAP, SYSTEM_CANCEL_BACKSTOP, classifyConsentSignFailure, sendSavedVote, statusForOutcome, type BallotSendStatus, type VoteSendingPort, type VoteSentStore} from '../vote-sending';
import type {VoteRecord} from '../vote-record-vault';

const electionSecret = secp256k1.utils.randomSecretKey();
const jointPublicKey = bytesToHex(secp256k1.getPublicKey(electionSecret, true));
const ELECTION = 'election-send-1';
const REVISION = 1;
const BALLOTS = ['ballot-a', 'ballot-b'];

function clientFor(rv: PoolRendezvous, transportPeerId: string): PoolRendezvousClient {
	return createInMemoryRendezvousClient(rv, transportPeerId);
}

/** One shared fake strand: committed voter rows per (ballot, registrant). */
function fakeStrand(closesAt: number) {
	const rows = new Map<string, string>();
	const commits: Array<{ballotId: string, size: number}> = [];
	const port: VoteSendingPort = {
		readElectionKey: async () => jointPublicKey,
		readVotingClose: async () => closesAt,
		commit: async (block, ballot, signatures) => {
			for (const s of signatures) {
				if (rows.has(`${ballot.ballotId}/${s.registrantId}`)) return {ok: false, reason: 'already voted'};
			}
			for (const s of signatures) rows.set(`${ballot.ballotId}/${s.registrantId}`, block.cid);
			commits.push({ballotId: ballot.ballotId, size: signatures.length});
			return {ok: true};
		},
		findRecordedVote: async (_e, ballotId, registrantId) => rows.get(`${ballotId}/${registrantId}`) ?? null,
	};
	return {port, rows, commits};
}

function memorySentStore(): VoteSentStore & {data: Record<string, Record<string, string>>} {
	const data: Record<string, Record<string, string>> = {};
	return {
		data,
		read: async (e) => ({...(data[e] ?? {})}),
		record: async (e, _r, b, cid) => { data[e] = {...(data[e] ?? {}), [b]: cid}; },
	};
}

function makeVoter(i: number) {
	const priv = p256.utils.randomSecretKey();
	const deviceKey = bytesToHex(p256.getPublicKey(priv, true));
	const record: VoteRecord = {
		v: 1, electionId: ELECTION, electionRevision: REVISION, savedAt: new Date().toISOString(),
		votes: BALLOTS.map(ballotId => ({
			v: 1, electionId: ELECTION, electionRevision: REVISION, ballotId, templateDigest: `template-${ballotId}`,
			answers: [{questionCode: 'q1', optionCodes: [i % 2 ? 'yes' : 'no']}], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
		})),
		voter: {
			v: 1, electionId: ELECTION, electionRevision: REVISION, registrantId: `registrant-${i}`, privateCid: `private-${i}`, publicCid: null,
			deviceKey, attestationCid: null, ballots: BALLOTS.map(b => ({ballotId: b, templateDigest: `template-${b}`})), signature: 'cd'.repeat(32),
		},
	};
	return {record, priv, deviceKey, phone: `phone-${i}`};
}

/** test seam: the consent queue's minimum prompt window, small so fast agents are not refused no-time */
const FAST_MIN_PROMPT_MS = 100;

const fastAgent = {quietMs: 300, presentIntervalMs: 50, replyTimeoutMs: 400, informAttempts: 2, signTimeoutMs: 2_000, memberTimeoutMs: 3_000, pollWaitMs: 200, formLeadMs: 0};

function signWith(priv: Uint8Array, probe?: {active: number, maxActive: number}) {
	return async (digest: string) => {
		if (probe) { probe.active++; probe.maxActive = Math.max(probe.maxActive, probe.active); }
		await new Promise(r => setTimeout(r, 20));
		const bytes = Uint8Array.from(atob(digest.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
		const sig = bytesToHex(p256.sign(bytes, priv)); // noble v2 defaults: prehash, low-S, compact — the native signer's contract
		if (probe) probe.active--;
		return sig;
	};
}

describe('sendSavedVote (spike 102)', () => {
	jest.setTimeout(30_000);

	it('three voters send both ballots: one block of three per ballot, every ballot recorded as sent', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 60_000);
		const voters = [0, 1, 2].map(makeVoter);
		const probes = voters.map(() => ({active: 0, maxActive: 0}));
		const stores = voters.map(() => memorySentStore());
		const statuses: Array<Array<[string, BallotSendStatus]>> = voters.map(() => []);
		const signals: unknown[] = [];
		const results = await Promise.all(voters.map((v, i) => sendSavedVote({
			port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: (d: string, signal?: AbortSignal) => { signals.push(signal instanceof AbortSignal ? signal.aborted : 'no signal'); return signWith(v.priv, probes[i])(d); },
			nowMs: () => Date.now(), agentOptions: fastAgent, minPromptMs: FAST_MIN_PROMPT_MS,
			onStatus: (b, s) => statuses[i]!.push([b, s]),
		})));
		rv.close();
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
		}
		for (const s of stores) expect(Object.keys(s.data[ELECTION] ?? {}).sort()).toEqual(BALLOTS);
		// one prompt at a time per phone, even with two ballots pooling at once
		for (const p of probes) expect(p.maxActive).toBe(1);
		// every voter saw itself confirm before it was sent
		for (const st of statuses) expect(st.some(([, s]) => s.phase === 'confirming')).toBe(true);
		// each consent sign gets its call's abort signal (WR-04), live while it is asked
		expect(signals.length).toBeGreaterThanOrEqual(6);
		expect(signals.every(a => a === false)).toBe(true);
	});

	it('a consent prompt that never settles does not block the voter\'s other prompts', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 12_000);
		const voters = [0, 1, 2].map(makeVoter);
		const stores = voters.map(() => memorySentStore());
		const agent = {...fastAgent, signTimeoutMs: 1_500, replyTimeoutMs: 300, quietMs: 300};
		let stall: ReturnType<typeof setTimeout> | undefined;
		const stalled = new Promise<'stalled'>(r => { stall = setTimeout(() => r('stalled'), 20_000); });
		const all = await Promise.race([stalled, Promise.all(voters.map((v, i) => {
			const real = signWith(v.priv);
			let calls = 0;
			const sign = (digest: string) => (i === 1 && ++calls === 1) ? new Promise<string>(() => {}) : real(digest);
			return sendSavedVote({
				port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
				signConsent: sign, nowMs: () => Date.now(), agentOptions: agent, minPromptMs: FAST_MIN_PROMPT_MS,
			});
		}))]);
		clearTimeout(stall);
		rv.close();
		expect(all).not.toBe('stalled');
		const results = all === 'stalled' ? [] : all;
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
		}
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
	});

	it('the consent signature a voter gives verifies with the schema\'s own P-256 check', async () => {
		const v = makeVoter(9);
		const digest = 'A'.repeat(43);
		const sig = await signWith(v.priv)(digest);
		expect(verifySigP256(digest, sig, v.deviceKey)).toBe(true);
	});

	it('a vote already recorded on the strand is not pooled again', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 60_000);
		const v = makeVoter(4);
		for (const b of BALLOTS) strand.rows.set(`${b}/${v.record.voter.registrantId}`, `cid-${b}`);
		const store = memorySentStore();
		const sign = jest.fn();
		const result = await sendSavedVote({
			port: strand.port, sentStore: store, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: sign, nowMs: () => Date.now(), agentOptions: fastAgent, minPromptMs: FAST_MIN_PROMPT_MS,
		});
		rv.close();
		expect(result).toEqual({ok: true, ballots: [{ballotId: 'ballot-a', status: {phase: 'sent', cid: 'cid-ballot-a'}}, {ballotId: 'ballot-b', status: {phase: 'sent', cid: 'cid-ballot-b'}}]});
		expect(sign).not.toHaveBeenCalled();
		expect(rv.stats.present).toBe(0);
		expect(store.data[ELECTION]).toEqual({'ballot-a': 'cid-ballot-a', 'ballot-b': 'cid-ballot-b'});
	});

	it('a lone voter is never sent (minimum 3): it stays not sent when voting closes', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 1_500);
		const v = makeVoter(5);
		const result = await sendSavedVote({
			port: strand.port, sentStore: memorySentStore(), record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: signWith(v.priv), nowMs: () => Date.now(), agentOptions: fastAgent, minPromptMs: FAST_MIN_PROMPT_MS,
		});
		rv.close();
		expect(strand.commits).toEqual([]);
		expect(result).toEqual({ok: true, ballots: BALLOTS.map(ballotId => ({ballotId, status: {phase: 'not-sent', reason: 'voting-closed'}}))});
	});

	it('refuses before pooling when voting has closed or the election key is not published', async () => {
		const v = makeVoter(6);
		const base = {sentStore: memorySentStore(), record: v.record, rendezvous: clientFor(new PoolRendezvous(), v.phone), signConsent: jest.fn(), nowMs: () => Date.now()};
		const closed = fakeStrand(Date.now() - 1);
		expect(await sendSavedVote({...base, port: closed.port})).toEqual({ok: false, reason: 'voting-closed'});
		const noKey = fakeStrand(Date.now() + 60_000);
		expect(await sendSavedVote({...base, port: {...noKey.port, readElectionKey: async () => null}})).toEqual({ok: false, reason: 'election-key-missing'});
		expect(await sendSavedVote({...base, port: {...noKey.port, readVotingClose: async () => null}})).toEqual({ok: false, reason: 'window-unreadable'});
	});
});

/**
 * A fake native signer modelled on Run 3 (androidx.biometric 1.1.0): a sign started while another is
 * pending is silently dropped (never settles). The FIRST sign ever is the unanswered prompt: it stays
 * pending until cancelled. cancel() rejects the pending sign with CANCELED and resolves true.
 */
function swallowingNative(priv: Uint8Array) {
	const real = signWith(priv);
	const stats = {cancelCalls: 0, swallowed: 0, maxActive: 0, active: 0, signs: 0};
	let pending: ((e: Error) => void) | null = null;
	const sign = (digest: string): Promise<string> => {
		if (pending !== null) { stats.swallowed++; return new Promise<string>(() => {}); }
		stats.signs++;
		stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
		if (stats.signs === 1) {
			return new Promise<string>((_resolve, reject) => {
				pending = (e) => { pending = null; stats.active--; reject(e); };
			});
		}
		pending = () => undefined;
		return real(digest).then((sig) => { pending = null; stats.active--; return sig; });
	};
	const cancel = async (): Promise<boolean> => {
		stats.cancelCalls++;
		if (pending === null) return false;
		const reject = pending;
		reject(Object.assign(new Error('canceled'), {code: 'CANCELED'}));
		pending = null;
		await new Promise(r => setTimeout(r, 50));
		return true;
	};
	return {sign, cancel, stats};
}

describe('sendSavedVote native cancel (UAT 65 gap 1, Android shape)', () => {
	jest.setTimeout(40_000);
	const agent = {...fastAgent, signTimeoutMs: 1_500, replyTimeoutMs: 300, quietMs: 300};

	/**
	 * Pool identities per ballot, sorted by peer id: pools order by (size desc, peer id asc), so the
	 * lowest id becomes the former (the engine spec's sortedVoters approach). `busyRole` puts voter 1
	 * at the lowest id ('former') or the highest ('member') on every ballot.
	 */
	function identitiesFor(busyRole: 'former' | 'member'): Array<(ballotId: string) => PoolIdentity> {
		const perBallot = new Map(BALLOTS.map(b => [b, [0, 1, 2].map(() => createPoolIdentity()).sort((x, y) => (x.peerId < y.peerId ? -1 : 1))]));
		const slot = busyRole === 'former' ? [1, 0, 2] : [0, 2, 1];
		return [0, 1, 2].map(i => (ballotId: string) => perBallot.get(ballotId)![slot[i]!]!);
	}

	async function run(opts: {closeMs: number, guardMs: number, withCancel: boolean, firstSign: 'swallow' | 'busy', busyRole?: 'former' | 'member', busyCode?: string, busyTimes?: number}) {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + opts.closeMs);
		const voters = [0, 1, 2].map(makeVoter);
		const stores = voters.map(() => memorySentStore());
		const native = swallowingNative(voters[1]!.priv);
		let busyDelivered = 0;
		let busyLeft = opts.busyTimes ?? 1;
		const real1 = signWith(voters[1]!.priv);
		// which consent voter 1's busy reject answered: the queue calls onStart (logged by the agent as
		// 'own-consent-start' for the former, 'consent-start' for a member) right before the sign
		let lastStart1 = '';
		let busyAt = '';
		const busySign = async (digest: string) => {
			if (busyLeft > 0) { busyLeft--; busyDelivered++; busyAt = lastStart1; throw Object.assign(new Error('busy'), {code: opts.busyCode ?? 'PROMPT_BUSY'}); }
			return real1(digest);
		};
		const identities = opts.busyRole !== undefined ? identitiesFor(opts.busyRole) : undefined;
		// The lowest id starts first, so the other two see its pool before either can merge into the
		// other (a pool of 2 outranks a lone lower id).
		const formerIndex = opts.busyRole === 'former' ? 1 : 0;
		const startDelay = (i: number) => (identities !== undefined && i !== formerIndex ? new Promise(r => setTimeout(r, agent.quietMs)) : Promise.resolve());
		const log = (i: number) => (e: string) => { if (i === 1 && (e === 'own-consent-start' || e === 'consent-start')) lastStart1 = e; };
		const ac = new AbortController();
		let stall: ReturnType<typeof setTimeout> | undefined;
		const stalled = new Promise<'stalled'>(r => { stall = setTimeout(() => r('stalled'), opts.guardMs); });
		const all = await Promise.race([stalled, Promise.all(voters.map(async (v, i) => { await startDelay(i); return sendSavedVote({
			port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: i === 1 ? (opts.firstSign === 'swallow' ? native.sign : busySign) : signWith(v.priv),
			cancelSign: i === 1 && opts.withCancel ? native.cancel : undefined,
			minPromptMs: FAST_MIN_PROMPT_MS, nowMs: () => Date.now(), signal: ac.signal,
			// the plain topic only (no specific-then-general ladder), so every voter sees every pool at once
			agentOptions: {...agent, log: log(i), ...(identities !== undefined ? {ladder: false} : {})},
			poolIdentity: identities?.[i],
		}); }))]);
		clearTimeout(stall);
		ac.abort();
		rv.close();
		return {all, strand, native, busyDelivered, busyAt};
	}

	it('a swallowed second sign: both ballots end sent only because cancel is called', async () => {
		const {all, strand, native} = await run({closeMs: 12_000, guardMs: 20_000, withCancel: true, firstSign: 'swallow'});
		expect(all).not.toBe('stalled');
		const results = all === 'stalled' ? [] : all;
		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
		}
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
		expect(native.stats.cancelCalls).toBeGreaterThanOrEqual(1);
		expect(native.stats.swallowed).toBe(0);
		expect(native.stats.maxActive).toBe(1);
	});

	it('the same swallowing native without cancelSign leaves that voter unsent', async () => {
		const {all, native} = await run({closeMs: 8_000, guardMs: 11_000, withCancel: false, firstSign: 'swallow'});
		expect(native.stats.swallowed).toBeGreaterThanOrEqual(1);
		if (all !== 'stalled') {
			const r = all[1]!;
			if (r.ok) expect(r.ballots.some(b => b.status.phase === 'sent')).toBe(false);
		}
	});

	// D-112: PROMPT_BUSY means nothing was shown, so it is a consent not given, never a decline; the
	// same for a BIOMETRIC_ERROR (no prompt could be hosted or started), a temporary LOCKOUT (WR-07), the
	// OS ending the prompt (SYSTEM_CANCELED: screen lock, call, app switch; CR-01) and no activity to
	// host it (NO_ACTIVITY). The role is fixed (WR-05): as the former, a decline would stop the ballot
	// 'not-sent: stopped' (CR-01).
	it.each([
		['PROMPT_BUSY', 'former'],
		['PROMPT_BUSY', 'member'],
		['BIOMETRIC_ERROR', 'former'],
		['LOCKOUT', 'former'],
		['SYSTEM_CANCELED', 'former'],
		['NO_ACTIVITY', 'former'],
	] as const)('a %s reject on the %s\'s consent is not a decline: every ballot ends sent', async (busyCode, busyRole) => {
		const {all, strand, busyDelivered, busyAt} = await run({closeMs: 12_000, guardMs: 20_000, withCancel: false, firstSign: 'busy', busyRole, busyCode});
		// the busy reject answered the consent of the role under test
		expect(busyAt).toBe(busyRole === 'former' ? 'own-consent-start' : 'consent-start');
		expect(all).not.toBe('stalled');
		const results = all === 'stalled' ? [] : all;
		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status)).toEqual(BALLOTS.map(() => expect.objectContaining({phase: 'sent'})));
		}
		expect(busyDelivered).toBe(1);
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
	});

	// CR-01 / WR-02: the OS ending the prompt (or no activity to host it) is never counted toward the
	// transient retry cap: a former backgrounded through more formations than the cap still sends.
	it.each(['SYSTEM_CANCELED', 'NO_ACTIVITY'] as const)('a former whose sign rejects %s more often than the cap is not stopped: every ballot ends sent', async (busyCode) => {
		// both ballots' consents draw from these rejects; 2 * cap + 1 puts more than the cap on one ballot
		const busyTimes = 2 * CONSENT_TRANSIENT_RETRY_CAP + 1;
		const {all, strand, busyDelivered} = await run({closeMs: 30_000, guardMs: 38_000, withCancel: false, firstSign: 'busy', busyRole: 'former', busyCode, busyTimes});
		expect(all).not.toBe('stalled');
		const results = all === 'stalled' ? [] : all;
		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status)).toEqual(BALLOTS.map(() => expect.objectContaining({phase: 'sent'})));
		}
		expect(busyDelivered).toBe(busyTimes);
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
	});
});

// CR-01 follow-up: BIOMETRIC_ERROR is also the native catch-all, so a sign that fails that way for
// ever must not make the former release and re-form its pool until voting closes. The first
// CONSENT_TRANSIENT_RETRY_CAP failures re-pool; the next one is a decline, which stops the former.
describe('sendSavedVote transient consent-sign retry cap', () => {
	jest.setTimeout(40_000);
	const agent = {...fastAgent, signTimeoutMs: 1_500, replyTimeoutMs: 300, quietMs: 300};

	it('the cap is 3', () => {
		expect(CONSENT_TRANSIENT_RETRY_CAP).toBe(3);
	});

	it.each([
		['BIOMETRIC_ERROR', CONSENT_TRANSIENT_RETRY_CAP + 1],
		['LOCKOUT', CONSENT_TRANSIENT_RETRY_CAP + 1],
		['PROMPT_BUSY', CONSENT_TRANSIENT_RETRY_CAP + 1],
		// review round 4: the uncounted system cancels have their own, larger backstop
		['SYSTEM_CANCELED', SYSTEM_CANCEL_BACKSTOP + 1],
		['NO_ACTIVITY', SYSTEM_CANCEL_BACKSTOP + 1],
	] as const)('a former whose sign always rejects %s ends not-sent stopped after exactly %i sign attempts', async (failCode, expectedAttempts) => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 20_000);
		// one ballot, so every sign attempt of voter 1 belongs to the same ballot
		const voters = [0, 1, 2].map(makeVoter).map(v => ({...v, record: {...v.record, votes: v.record.votes.filter(b => b.ballotId === 'ballot-a')}}));
		const stores = voters.map(() => memorySentStore());
		// sorted by peer id: the lowest id becomes the former, and voter 1 gets it
		const ids = [0, 1, 2].map(() => createPoolIdentity()).sort((x, y) => (x.peerId < y.peerId ? -1 : 1));
		const slot = [1, 0, 2];
		let attempts = 0;
		const failing = async (): Promise<string> => {
			attempts++;
			throw Object.assign(new Error('transient'), {code: failCode});
		};
		const others = new AbortController();
		let stall: ReturnType<typeof setTimeout> | undefined;
		const stalled = new Promise<'stalled'>(r => { stall = setTimeout(() => r('stalled'), 30_000); });
		const runs = voters.map(async (v, i) => {
			if (i !== 1) await new Promise(r => setTimeout(r, agent.quietMs));
			return sendSavedVote({
				port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
				signConsent: i === 1 ? failing : signWith(v.priv),
				minPromptMs: FAST_MIN_PROMPT_MS, nowMs: () => Date.now(),
				signal: i === 1 ? undefined : others.signal,
				agentOptions: {...agent, ladder: false},
				poolIdentity: () => ids[slot[i]!]!,
			});
		});
		const first = await Promise.race([stalled, runs[1]!]);
		// the other two have nobody left to pool with: stop them rather than wait for the close
		others.abort();
		const all = await Promise.race([stalled, Promise.all(runs)]);
		clearTimeout(stall);
		rv.close();
		expect(first).not.toBe('stalled');
		expect(all).not.toBe('stalled');
		expect(first).toEqual({ok: true, ballots: [{ballotId: 'ballot-a', status: {phase: 'not-sent', reason: 'stopped'}}]});
		expect(attempts).toBe(expectedAttempts);
		expect(strand.commits).toEqual([]);
		expect(stores[1]!.data[ELECTION]).toBeUndefined();
	});
});

describe('classifyConsentSignFailure (CR-01, WR-02, WR-07)', () => {
	const coded = (code: unknown) => Object.assign(new Error('x'), {code});
	it.each([
		// abandoned, never counted: the voter did not decline and the app could not show the prompt
		['SYSTEM_CANCELED', 'abandoned'],
		['NO_ACTIVITY', 'abandoned'],
		['ABORTED', 'abandoned'],
		// transient device trouble: released, counted toward CONSENT_TRANSIENT_RETRY_CAP
		['PROMPT_BUSY', 'transient'],
		['BIOMETRIC_ERROR', 'transient'],
		['LOCKOUT', 'transient'],
		// a decline: the voter dismissed the prompt, a permanent failure, or an unknown code
		['CANCELED', 'declined'],
		['LOCKOUT_PERMANENT', 'declined'],
		['KEY_INVALIDATED', 'declined'],
		['KEY_INVALIDATED_REASSOCIATE', 'declined'],
		['DEVICE_KEY_INVALIDATED', 'declined'],
		['NO_BIOMETRICS_ENROLLED', 'declined'],
		['NO_KEY_PROVISIONED', 'declined'],
		['NO_DEVICE_CREDENTIAL', 'declined'],
		['SOMETHING_NEW', 'declined'],
	])('%s -> %s', (code, expected) => {
		expect(classifyConsentSignFailure(coded(code))).toBe(expected);
	});
	it('an abandoned consent stays abandoned; no code, a non-string code or a non-object is a decline', () => {
		expect(classifyConsentSignFailure(new ConsentAbandonedError('abandoned'))).toBe('abandoned');
		expect(classifyConsentSignFailure({name: 'ConsentAbandonedError'})).toBe('abandoned');
		expect(classifyConsentSignFailure(new Error('plain'))).toBe('declined');
		expect(classifyConsentSignFailure(coded(5))).toBe('declined');
		expect(classifyConsentSignFailure(null)).toBe('declined');
		expect(classifyConsentSignFailure('PROMPT_BUSY')).toBe('declined');
	});
});

// 'already-voted' reaches here only from this phone's OWN failed commit as the block's former; a
// peer's already-voted claim is a hint the agent checks and never stops on (CR-01).
describe('statusForOutcome (R1 already voted, own commit)', () => {
	const committed = {status: 'committed', cid: 'c1', blockId: 'b', size: 3, formedByMe: true} as const;
	const stopped = (reason: string) => ({status: 'stopped', reason}) as never;

	it('maps committed, deadline and aborted without re-reading the strand', async () => {
		const recheck = jest.fn(async () => 'never');
		expect(await statusForOutcome(committed, recheck)).toEqual({phase: 'sent', cid: 'c1'});
		expect(await statusForOutcome(stopped('deadline'), recheck)).toEqual({phase: 'not-sent', reason: 'voting-closed'});
		expect(await statusForOutcome(stopped('aborted'), recheck)).toEqual({phase: 'not-sent', reason: 'stopped'});
		expect(recheck).not.toHaveBeenCalled();
	});

	it('already-voted with a readable row is sent with that cid, re-read exactly once', async () => {
		const recheck = jest.fn(async () => 'cid-x');
		expect(await statusForOutcome(stopped('already-voted'), recheck)).toEqual({phase: 'sent', cid: 'cid-x'});
		expect(recheck).toHaveBeenCalledTimes(1);
	});

	it('already-voted with no readable row, or a failing read, is not-sent already-voted', async () => {
		expect(await statusForOutcome(stopped('already-voted'), async () => null)).toEqual({phase: 'not-sent', reason: 'already-voted'});
		expect(await statusForOutcome(stopped('already-voted'), async () => { throw new Error('strand down'); })).toEqual({phase: 'not-sent', reason: 'already-voted'});
	});
});

// 65-01 truth 7, end to end: one voter's vote is already on the strand under another block, but the
// row is not readable from this phone yet (replication lag). Its pool's commit names it a duplicate.
describe('sendSavedVote (R1 already voted, end to end)', () => {
	jest.setTimeout(30_000);

	function laggedStrand(closesAt: number, dupRegistrant: string, rowBecomesReadable: boolean) {
		const strand = fakeStrand(closesAt);
		let refused = false;
		const port: VoteSendingPort = {
			...strand.port,
			commit: async (block, ballot, signatures, nowMs) => {
				if (signatures.some(s => s.registrantId === dupRegistrant)) {
					refused = true;
					return {ok: false, reason: 'already voted', duplicateRegistrants: [dupRegistrant]};
				}
				return strand.port.commit(block, ballot, signatures, nowMs);
			},
			findRecordedVote: async (e, ballotId, registrantId) => {
				if (registrantId === dupRegistrant) return rowBecomesReadable && refused ? `cid-elsewhere-${ballotId}` : null;
				return strand.port.findRecordedVote(e, ballotId, registrantId);
			},
		};
		return {...strand, port};
	}

	async function runFour(rowBecomesReadable: boolean) {
		const rv = new PoolRendezvous();
		const voters = [10, 11, 12, 13].map(makeVoter);
		const dup = voters[3]!.record.voter.registrantId;
		const strand = laggedStrand(Date.now() + 9_000, dup, rowBecomesReadable);
		const stores = voters.map(() => memorySentStore());
		const results = await Promise.all(voters.map((v, i) => sendSavedVote({
			port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: signWith(v.priv), nowMs: () => Date.now(), agentOptions: fastAgent, minPromptMs: FAST_MIN_PROMPT_MS,
		})));
		rv.close();
		return {results, stores, strand};
	}

	it('with no readable row the duplicate is not-sent and its sent store stays unwritten; the other three send', async () => {
		const {results, stores, strand} = await runFour(false);
		for (const i of [0, 1, 2]) {
			const r = results[i]!;
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
			expect(Object.keys(stores[i]!.data[ELECTION] ?? {}).sort()).toEqual(BALLOTS);
		}
		const dup = results[3]!;
		expect(dup.ok).toBe(true);
		if (dup.ok) {
			for (const b of dup.ballots) {
				expect(b.status.phase).toBe('not-sent');
				expect(['already-voted', 'voting-closed']).toContain((b.status as {reason: string}).reason);
			}
		}
		expect(stores[3]!.data[ELECTION]).toBeUndefined();
		for (const b of BALLOTS) expect(strand.commits.filter(c => c.ballotId === b)).toEqual([{ballotId: b, size: 3}]);
	});

	it('when the row becomes readable during the check, the duplicate reports sent and records that cid', async () => {
		const {results, stores} = await runFour(true);
		const dup = results[3]!;
		expect(dup.ok).toBe(true);
		if (dup.ok) expect(dup.ballots).toEqual(BALLOTS.map(ballotId => ({ballotId, status: {phase: 'sent', cid: `cid-elsewhere-${ballotId}`}})));
		expect(stores[3]!.data[ELECTION]).toEqual(Object.fromEntries(BALLOTS.map(b => [b, `cid-elsewhere-${b}`])));
		for (const i of [0, 1, 2]) {
			const r = results[i]!;
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
		}
	});
});
