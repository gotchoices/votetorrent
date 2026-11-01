/**
 * vote-send-flow.test.ts — the Send button's wiring (spike 102, R3): it refuses before any prompt
 * when the phone has no network or no rendezvous, tries EVERY joined address in order until one
 * answers (a failover client over lazily built per-address clients), probes with a throwaway pool
 * key before the first fingerprint prompt, reports the distinct `rendezvous-unreachable` kind when
 * nothing answers, opens the sealed record once, signs consent with the voting key through the
 * producer (handing it the pool's abandon signal, WR-01), and maps every failure to a closed kind.
 */
jest.mock('@votetorrent/attestation-native', () => ({cancelPendingSign: jest.fn(async () => false)}));
jest.mock('../vote-receipt', () => ({revealVoteReceipt: jest.fn()}));
jest.mock('@votetorrent/vote-engine/rn', () => ({
	createLibp2pRendezvousClient: jest.fn(),
	createPoolIdentity: jest.fn(() => ({peerId: 'probe-pool-id'})),
	poolRequests: {
		poll: jest.fn((identity: {peerId: string}, waitMs: number, now: number) => ({t: 'poll', waitMs, as: identity.peerId, ts: now, sig: 'test'})),
	},
	// the REAL failover, from the vote-engine source (type-only imports, so Babel strips them)
	createFailoverRendezvousClient: jest.fn(
		jest.requireActual('../../../../../packages/vote-engine/src/pool/pool-failover').createFailoverRendezvousClient,
	),
	ConsentAbandonedError: jest.requireActual('../../../../../packages/vote-engine/src/pool/consent-queue').ConsentAbandonedError,
}));
jest.mock('../vote-sending', () => ({sendSavedVote: jest.fn()}));
jest.mock('../vote-casting', () => ({digestBytesFromBase64Url: jest.fn(() => new Uint8Array(32).fill(7))}));
jest.mock('../attestation-producer', () => ({resolveVoteSigningProducer: jest.fn((p: unknown) => p)}));

import {cancelPendingSign} from '@votetorrent/attestation-native';
import {revealVoteReceipt} from '../vote-receipt';
import {createFailoverRendezvousClient, createLibp2pRendezvousClient, createPoolIdentity, poolRequests} from '@votetorrent/vote-engine/rn';
import {sendSavedVote} from '../vote-sending';
import {runVoteSendFlow} from '../vote-send-flow';
import type {VoteSendFlowDeps} from '../vote-send-flow';
// the REAL consent queue, from the vote-engine source (the rn entry is mocked above)
const {createConsentQueue} = jest.requireActual('../../../../../packages/vote-engine/src/pool/consent-queue') as typeof import('../../../../../packages/vote-engine/src/pool/consent-queue');

const prompt = {title: 't', subtitle: 's', negativeButton: 'n'};
const control = {dialProtocol: jest.fn(), handle: jest.fn()};
const FIRST = 'dial:/ip4/1.2.3.4/tcp/1/ws/p2p/first';
const SECOND = 'dial:/ip4/5.6.7.8/tcp/1/ws/p2p/second';
let clients: Record<string, {call: jest.Mock}>;
const record = {v: 1, electionId: 'e1', electionRevision: 1, savedAt: '', votes: [], voter: {}};

function deps(over: Partial<VoteSendFlowDeps> = {}): VoteSendFlowDeps {
	return {
		electionId: 'e1',
		envelope: {} as never,
		getEngine: jest.fn(async () => ({port: true})) as never,
		node: {getControlNode: () => control},
		recordPrompt: prompt,
		consentPrompt: {...prompt, title: 'consent'},
		nowMs: () => 1,
		producer: {signDeviceKeyDigest: jest.fn(async () => ({signature: 'sig-hex', signerKey: 'k'}))} as never,
		readRendezvousAddrs: async () => ['/ip4/1.2.3.4/tcp/1/ws/p2p/first', '/ip4/5.6.7.8/tcp/1/ws/p2p/second'],
		toDialTarget: (a) => `dial:${a}`,
		...over,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	clients = {
		[FIRST]: {call: jest.fn(async () => ({t: 'envelopes', list: []}))},
		[SECOND]: {call: jest.fn(async () => ({t: 'envelopes', list: []}))},
	};
	(createLibp2pRendezvousClient as jest.Mock).mockImplementation((_c: unknown, target: unknown) => clients[target as string]);
	(revealVoteReceipt as jest.Mock).mockResolvedValue({kind: 'ok', record});
	(sendSavedVote as jest.Mock).mockResolvedValue({ok: true, ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}]});
});

describe('runVoteSendFlow (spike 102)', () => {
	it('opens the record once, dials the first joined address and returns the ballots', async () => {
		const d = deps();
		expect(await runVoteSendFlow(d)).toEqual({kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}]});
		expect(revealVoteReceipt).toHaveBeenCalledTimes(1);
		expect(revealVoteReceipt).toHaveBeenCalledWith('e1', d.envelope, prompt);
		expect(createLibp2pRendezvousClient).toHaveBeenCalledTimes(1);
		expect(createLibp2pRendezvousClient).toHaveBeenCalledWith(control, FIRST);
		expect(clients[SECOND]!.call).not.toHaveBeenCalled();
		expect((sendSavedVote as jest.Mock).mock.calls[0][0].record).toBe(record);
	});

	it('signs consent with the voting key and the consent prompt', async () => {
		const d = deps();
		await runVoteSendFlow(d);
		const signConsent = (sendSavedVote as jest.Mock).mock.calls[0][0].signConsent as (digest: string, signal?: AbortSignal) => Promise<string>;
		expect(await signConsent('A'.repeat(43))).toBe('sig-hex');
		expect((d.producer as unknown as {signDeviceKeyDigest: jest.Mock}).signDeviceKeyDigest).toHaveBeenCalledWith(expect.any(Uint8Array), {prompt: d.consentPrompt, signal: undefined});
		// the pool's abandon signal reaches the producer (WR-01)
		const ac = new AbortController();
		await signConsent('A'.repeat(43), ac.signal);
		expect((d.producer as unknown as {signDeviceKeyDigest: jest.Mock}).signDeviceKeyDigest).toHaveBeenLastCalledWith(expect.any(Uint8Array), {prompt: d.consentPrompt, signal: ac.signal});
	});

	it('passes attestation-native\'s cancelPendingSign to sending by default', async () => {
		await runVoteSendFlow(deps());
		expect((sendSavedVote as jest.Mock).mock.calls[0][0].cancelSign).toBe(cancelPendingSign);
	});

	it('an injected cancelSign is the one that reaches sending', async () => {
		const fake = jest.fn(async () => true);
		await runVoteSendFlow(deps({cancelSign: fake}));
		expect((sendSavedVote as jest.Mock).mock.calls[0][0].cancelSign).toBe(fake);
		expect(fake).not.toHaveBeenCalled();
	});

	it('a busy signer\'s reject reaches the agent unchanged', async () => {
		const busy = Object.assign(new Error('busy'), {code: 'PROMPT_BUSY'});
		const d = deps({producer: {signDeviceKeyDigest: jest.fn(async () => { throw busy; })} as never});
		await runVoteSendFlow(d);
		const signConsent = (sendSavedVote as jest.Mock).mock.calls[0][0].signConsent as (digest: string) => Promise<string>;
		await expect(signConsent('A'.repeat(43))).rejects.toBe(busy);
	});

	it('a consent abandoned while the device-key lookup is pending never reaches the native sign (WR-01)', async () => {
		// A producer honouring the SignDeviceKeyDigestOptions.signal contract: the first sign awaits the
		// device-key lookup, then checks the signal right before the native call (ABORTED, no native call).
		let lookupDone!: () => void;
		const lookup = new Promise<void>((resolve) => { lookupDone = resolve; });
		const nativeSign = jest.fn(async () => ({signatureHex: 'sig-hex'}));
		const producer = {
			signDeviceKeyDigest: jest.fn(async (_bytes: Uint8Array, options?: {signal?: AbortSignal}) => {
				await lookup;
				if (options?.signal?.aborted === true) throw Object.assign(new Error('aborted'), {name: 'AbortError', code: 'ABORTED'});
				const r = await nativeSign();
				return {signature: r.signatureHex, signerKey: 'k'};
			}),
		};
		await runVoteSendFlow(deps({producer: producer as never}));
		const signConsent = (sendSavedVote as jest.Mock).mock.calls[0][0].signConsent as (digest: string, signal?: AbortSignal) => Promise<string>;
		// the real queue, wired the way sendSavedVote wires it: the call's signal is the signer's signal
		let own: Promise<string> | undefined;
		const queue = createConsentQueue((digest: string, signal?: AbortSignal) => (own = signConsent(digest, signal)), {cancel: async () => false});
		const ac = new AbortController();
		const caller = queue.withControl({signal: ac.signal}, 'A'.repeat(43), ac.signal);
		const callerSettled = caller.then(() => 'resolved', (err: unknown) => err);
		// the queue started the signer synchronously; its lookup is still pending
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1);
		expect(own).toBeDefined();
		const ownSettled = own!.then(() => 'resolved', (err: unknown) => err);
		ac.abort();
		lookupDone();
		expect(await callerSettled).toMatchObject({name: 'ConsentAbandonedError', reason: 'abandoned'});
		expect(await ownSettled).toMatchObject({name: 'ConsentAbandonedError', reason: 'abandoned'});
		expect(nativeSign).not.toHaveBeenCalled();
		// a live call signs as before
		expect(await queue.withControl({signal: new AbortController().signal}, 'A'.repeat(43), new AbortController().signal)).toBe('sig-hex');
		expect(nativeSign).toHaveBeenCalledTimes(1);
	});

	it('a producer that rejects ABORTED is an abandoned consent (WR-01)', async () => {
		const aborted = Object.assign(new Error('aborted'), {name: 'AbortError', code: 'ABORTED'});
		const d = deps({producer: {signDeviceKeyDigest: jest.fn(async () => { throw aborted; })} as never});
		await runVoteSendFlow(d);
		const signConsent = (sendSavedVote as jest.Mock).mock.calls[0][0].signConsent as (digest: string, signal?: AbortSignal) => Promise<string>;
		await expect(signConsent('A'.repeat(43))).rejects.toMatchObject({name: 'ConsentAbandonedError', reason: 'abandoned'});
	});

	it('refuses before any prompt with no network or no rendezvous', async () => {
		expect(await runVoteSendFlow(deps({node: null}))).toEqual({kind: 'no-network'});
		expect(await runVoteSendFlow(deps({node: {getControlNode: () => null}}))).toEqual({kind: 'no-network'});
		expect(await runVoteSendFlow(deps({readRendezvousAddrs: async () => []}))).toEqual({kind: 'no-rendezvous'});
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('maps a cancelled record prompt, a send refusal and a throw to closed kinds', async () => {
		(revealVoteReceipt as jest.Mock).mockResolvedValueOnce({kind: 'canceled'});
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'canceled'});
		expect(sendSavedVote).not.toHaveBeenCalled();
		(sendSavedVote as jest.Mock).mockResolvedValueOnce({ok: false, reason: 'voting-closed'});
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'voting-closed'});
		(sendSavedVote as jest.Mock).mockRejectedValueOnce(new Error('boom: raw'));
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'failed'});
	});
});

describe('every joined address (R3, D-30)', () => {
	const order = (m: unknown) => (m as jest.Mock).mock.invocationCallOrder[0]!;

	it('fails over to the next address and then sticks to it', async () => {
		clients[FIRST]!.call.mockRejectedValue(new Error('dial failed'));
		expect((await runVoteSendFlow(deps())).kind).toBe('done');
		expect(createLibp2pRendezvousClient).toHaveBeenLastCalledWith(control, SECOND);
		const rendezvous = (sendSavedVote as jest.Mock).mock.calls[0][0].rendezvous as {call: (r: unknown) => Promise<unknown>};
		await rendezvous.call({t: 'poll'});
		expect(clients[FIRST]!.call).toHaveBeenCalledTimes(1);
		expect(clients[SECOND]!.call).toHaveBeenCalledTimes(2);
	});

	it('reports rendezvous-unreachable before any prompt when no address answers', async () => {
		clients[FIRST]!.call.mockRejectedValue(new Error('a'));
		clients[SECOND]!.call.mockRejectedValue(new Error('b'));
		const d = deps();
		expect(await runVoteSendFlow(d)).toEqual({kind: 'rendezvous-unreachable'});
		expect(revealVoteReceipt).not.toHaveBeenCalled();
		expect(d.getEngine).not.toHaveBeenCalled();
		expect((d.producer as unknown as {signDeviceKeyDigest: jest.Mock}).signDeviceKeyDigest).not.toHaveBeenCalled();
		expect(sendSavedVote).not.toHaveBeenCalled();
	});

	it('probes with a throwaway pool key before the first prompt', async () => {
		const d = deps();
		await runVoteSendFlow(d);
		expect(createPoolIdentity).toHaveBeenCalledTimes(1);
		const identity = (createPoolIdentity as jest.Mock).mock.results[0]!.value;
		expect(poolRequests.poll).toHaveBeenCalledWith(identity, 0, 1);
		expect(order(poolRequests.poll)).toBeLessThan(order(revealVoteReceipt));
		expect((d.producer as unknown as {signDeviceKeyDigest: jest.Mock}).signDeviceKeyDigest).not.toHaveBeenCalled();
		expect(createFailoverRendezvousClient).toHaveBeenCalledTimes(1);
	});

	it('counts an error reply as reached: continues and never builds the second address', async () => {
		clients[FIRST]!.call.mockResolvedValue({t: 'error', reason: 'not allowed'});
		expect((await runVoteSendFlow(deps())).kind).toBe('done');
		expect(revealVoteReceipt).toHaveBeenCalledTimes(1);
		expect(createLibp2pRendezvousClient).toHaveBeenCalledTimes(1);
	});

	it('skips an address whose dial target cannot be built; none left is no-rendezvous with no prompt', async () => {
		const d = deps({toDialTarget: (a) => { if (a.includes('first')) throw new Error('bad'); return `dial:${a}`; }});
		expect((await runVoteSendFlow(d)).kind).toBe('done');
		expect(createLibp2pRendezvousClient).toHaveBeenCalledTimes(1);
		expect(createLibp2pRendezvousClient).toHaveBeenCalledWith(control, SECOND);
		jest.clearAllMocks();
		expect(await runVoteSendFlow(deps({toDialTarget: () => { throw new Error('bad'); }}))).toEqual({kind: 'no-rendezvous'});
		expect(createLibp2pRendezvousClient).not.toHaveBeenCalled();
		expect(poolRequests.poll).not.toHaveBeenCalled();
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('an aborted probe that throws is canceled, not unreachable, and dials no further address (WR-02)', async () => {
		const controller = new AbortController();
		clients[FIRST]!.call.mockImplementation(async () => {
			controller.abort();
			throw new Error('dial failed');
		});
		expect(await runVoteSendFlow(deps({signal: controller.signal}))).toEqual({kind: 'canceled'});
		expect(clients[SECOND]!.call).not.toHaveBeenCalled();
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('a card that leaves while a dial hangs is canceled at once; the remaining addresses are never dialed (WR-02)', async () => {
		const controller = new AbortController();
		clients[FIRST]!.call.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('dial failed')), 150)));
		setTimeout(() => controller.abort(), 10);
		const startedAt = Date.now();
		expect(await runVoteSendFlow(deps({signal: controller.signal}))).toEqual({kind: 'canceled'});
		expect(Date.now() - startedAt).toBeLessThan(120);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(clients[SECOND]!.call).not.toHaveBeenCalled();
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('the probe has an overall budget: past it, unreachable, and no further address is dialed (WR-02)', async () => {
		clients[FIRST]!.call.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('dial failed')), 150)));
		const startedAt = Date.now();
		expect(await runVoteSendFlow(deps({probeBudgetMs: 40}))).toEqual({kind: 'rendezvous-unreachable'});
		expect(Date.now() - startedAt).toBeLessThan(120);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(clients[SECOND]!.call).not.toHaveBeenCalled();
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('a signal already aborted before the probe is canceled with no dial', async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await runVoteSendFlow(deps({signal: controller.signal}))).toEqual({kind: 'canceled'});
		expect(clients[FIRST]!.call).not.toHaveBeenCalled();
	});

	it('returns canceled without a prompt when the card leaves during the probe', async () => {
		const controller = new AbortController();
		clients[FIRST]!.call.mockImplementation(async () => {
			controller.abort();
			return {t: 'envelopes', list: []};
		});
		expect(await runVoteSendFlow(deps({signal: controller.signal}))).toEqual({kind: 'canceled'});
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});
});
