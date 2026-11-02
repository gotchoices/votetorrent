/**
 * vote-send-flow.ts — the Send button behind the vote receipt (spike 102, applied).
 *
 * Wires `sendSavedVote` to this phone: the joined network's node (its control connection carries
 * the pool traffic), the authority's rendezvous (reached through every address the join left
 * behind, in order, until one answers; the same rendezvous for every voter who joined with that
 * code), the sealed vote record (opened with one fingerprint prompt) and the voting key (one
 * prompt per block). A reachability probe signed with a throwaway pool key runs before the
 * fingerprint prompt, so an unreachable network costs no prompt (R3, D-30). The probe stops when
 * the card leaves (the signal) or after PROBE_BUDGET_MS, whichever comes first, and dials no further
 * address after that (WR-02). An unanswered consent prompt is dismissed through the native sign cancel
 * before the next one. Every dependency is injectable so the flow is tested without a device.
 * The only logging is `vtDebug` (silent unless the __DEV__ debug switch is on): the send's start and
 * end (result kind, ballot counts, duration) and a consent abandoned before the native sign; never a record,
 * key, signature, address or error text.
 */
import {AppState} from 'react-native';
import {multiaddr} from '@multiformats/multiaddr';
import {
	ConsentAbandonedError,
	createFailoverRendezvousClient,
	createLibp2pRendezvousClient,
	createPoolIdentity,
	poolRequests,
} from '@votetorrent/vote-engine/rn';
import type {PoolRendezvousClient} from '@votetorrent/vote-engine/rn';
import {cancelPendingSign} from '@votetorrent/attestation-native';
import type {SecretWrapPrompt, SignDeviceKeyDigestOptions} from '@votetorrent/attestation-native';
import {revealVoteReceipt} from './vote-receipt';
import type {VoteRecordEnvelope} from './vote-record-vault';
import {readJoinBootstrap} from './join-bootstrap';
import {resolveVoteSigningProducer} from './attestation-producer';
import type {AttestationProducer} from './attestation-producer';
import {digestBytesFromBase64Url} from './vote-casting';
import {VOTE_SENDING_PORT_ENGINE} from './vote-sending-port';
import {sendSavedVote} from './vote-sending';
import type {BallotSendStatus, SendSavedVoteResult, VoteSendingPort} from './vote-sending';
import {readVoteSent, recordVoteSent} from './vote-sent-store';
import {vtDebug} from './vt-debug';

export type VoteSendFlowResult =
	| {kind: 'done', ballots: Array<{ballotId: string, status: BallotSendStatus}>}
	| {kind: 'no-network' | 'no-rendezvous' | 'rendezvous-unreachable' | 'canceled' | 'biometric-unavailable' | 'unreadable' | 'failed'}
	| {kind: 'voting-closed' | 'election-key-missing' | 'window-unreadable'}

export interface VoteSendFlowDeps {
	electionId: string
	envelope: VoteRecordEnvelope
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	/** the running CadreNode, or null before it boots */
	node: {getControlNode(): unknown} | null
	recordPrompt: SecretWrapPrompt
	consentPrompt: SecretWrapPrompt
	nowMs: () => number
	onStatus?: (ballotId: string, status: BallotSendStatus) => void
	signal?: AbortSignal
	producer?: AttestationProducer
	readRendezvousAddrs?: () => Promise<string[]>
	toDialTarget?: (addr: string) => unknown
	send?: typeof sendSavedVote
	/** dismisses the consent prompt that is showing (default: attestation-native's cancelPendingSign); test seam */
	cancelSign?: () => Promise<unknown>
	/**
	 * whether a consent prompt can be shown now; test seam. Default: the app is not in the background. iOS reports
	 * 'inactive' while a Face ID sheet (our own prompt) is up, so 'inactive' counts as able to prompt; only
	 * 'background' does not (UAT 65 Run 6: an 'active'-only check held a pool back during the vault Face ID).
	 */
	canPrompt?: () => boolean
	/** test seam: the probe's overall budget (default PROBE_BUDGET_MS) */
	probeBudgetMs?: number
}

/** The reachability probe gives up after this long in total, however many addresses are left. */
export const PROBE_BUDGET_MS = 20_000;

/**
 * Run `call` until it answers (true), throws (false), `signal` aborts or `budgetMs` passes (false).
 * On abort or budget, `stop` is aborted, so the clients refuse to dial any further address; the
 * call still in flight is left to finish on its own and its result is ignored.
 */
async function probe(call: () => Promise<unknown>, stop: AbortController, signal: AbortSignal | undefined, budgetMs: number): Promise<boolean> {
	const halt = () => stop.abort();
	if (signal?.aborted === true) halt();
	if (stop.signal.aborted) return false;
	signal?.addEventListener('abort', halt);
	const timer = setTimeout(halt, budgetMs);
	try {
		const attempt = call().then(() => true, () => false);
		const stopped = new Promise<boolean>((resolve) => {
			stop.signal.addEventListener('abort', () => resolve(false));
		});
		return await Promise.race([attempt, stopped]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', halt);
	}
}

export async function runVoteSendFlow(deps: VoteSendFlowDeps): Promise<VoteSendFlowResult> {
	const startedAt = deps.nowMs();
	vtDebug('send', 'flow-start', {node: deps.node !== null});
	const result = await runVoteSendFlowSteps(deps).catch((err: unknown): never => {
		vtDebug('send', 'flow-threw', {class: err instanceof Error ? err.name : typeof err, ms: deps.nowMs() - startedAt});
		throw err;
	});
	if (result.kind === 'done') {
		vtDebug('send', 'flow-end', {
			kind: 'done',
			ok: result.ballots.every(b => b.status.phase === 'sent'),
			ballots: result.ballots.length,
			sent: result.ballots.filter(b => b.status.phase === 'sent').length,
			notSent: result.ballots.filter(b => b.status.phase === 'not-sent').length,
			ms: deps.nowMs() - startedAt,
		});
	} else {
		vtDebug('send', 'flow-end', {kind: result.kind, ok: false, ms: deps.nowMs() - startedAt});
	}
	return result;
}

async function runVoteSendFlowSteps(deps: VoteSendFlowDeps): Promise<VoteSendFlowResult> {
	const control = deps.node?.getControlNode() ?? null;
	if (control === null || control === undefined) return {kind: 'no-network'};
	const addrs = await (deps.readRendezvousAddrs ?? readJoinBootstrap)();
	if (addrs.length === 0) return {kind: 'no-rendezvous'};

	// Every address, in order. An address whose dial target cannot be built is skipped, never repaired.
	const toTarget = deps.toDialTarget ?? ((a: string) => multiaddr(a));
	const targets: unknown[] = [];
	for (const addr of addrs) {
		try {
			targets.push(toTarget(addr));
		} catch {
			// skipped
		}
	}
	if (targets.length === 0) return {kind: 'no-rendezvous'};
	// Stopped when the card leaves or the budget runs out: once stopped, no address is dialed again.
	// A probe that answered never stops it, so the clients below serve sending unchanged.
	const probeStop = new AbortController();
	// One lazily built client per address: an address that is never needed is never built.
	const clients: PoolRendezvousClient[] = targets.map((target) => {
		let built: PoolRendezvousClient | null = null;
		return {
			call: (request, extraWaitMs) => {
				if (probeStop.signal.aborted) return Promise.reject(new Error('probe stopped'));
				built ??= createLibp2pRendezvousClient(control as Parameters<typeof createLibp2pRendezvousClient>[0], target);
				return built.call(request, extraWaitMs);
			},
		};
	});
	const rendezvous = createFailoverRendezvousClient(clients);
	// Reachability probe: a poll signed by a throwaway pool key (never the device key, no prompt).
	// Any reply, even an error reply, means a rendezvous answered; only a throw means none did.
	const probeAt = deps.nowMs();
	const reached = await probe(() => rendezvous.call(poolRequests.poll(createPoolIdentity(), 0, deps.nowMs())), probeStop, deps.signal, deps.probeBudgetMs ?? PROBE_BUDGET_MS);
	vtDebug('send', 'probe', {reached, addrs: targets.length, ms: deps.nowMs() - probeAt});
	// Canceled whenever the card left, whatever the probe's result.
	if (deps.signal?.aborted === true) return {kind: 'canceled'};
	if (!reached) return {kind: 'rendezvous-unreachable'};

	const opened = await revealVoteReceipt(deps.electionId, deps.envelope, deps.recordPrompt);
	vtDebug('send', 'record-open', {kind: opened.kind});
	if (opened.kind !== 'ok') return {kind: opened.kind === 'canceled' || opened.kind === 'biometric-unavailable' || opened.kind === 'unreadable' ? opened.kind : 'failed'};

	let port: VoteSendingPort;
	try {
		port = await deps.getEngine<VoteSendingPort>(VOTE_SENDING_PORT_ENGINE);
	} catch {
		return {kind: 'no-network'};
	}
	const producer = resolveVoteSigningProducer(deps.producer);
	const signConsent = async (digest: string, signal?: AbortSignal): Promise<string> => {
		const bytes = digestBytesFromBase64Url(digest);
		// WR-01: the pool's abandon signal goes to the producer, which checks it after its own awaits
		// (the device-key lookup on the first sign) and right before the native call. A consent the pool
		// abandoned while that lookup was pending then rejects ABORTED and never raises a prompt (no
		// orphan prompt holding the gate). A check here could never fire: the queue starts the signer
		// synchronously and drops calls abandoned while queued. The bridge hop itself is still open;
		// closing it, and making the queue's cancel match only its own sign, needs a per-sign native token.
		const options: SignDeviceKeyDigestOptions = {prompt: deps.consentPrompt, signal};
		try {
			const signed = await producer.signDeviceKeyDigest(bytes, options);
			return signed.signature;
		} catch (err) {
			if ((err as {code?: unknown} | null)?.code === 'ABORTED') {
				vtDebug('send', 'consent-abandoned-before-native');
				throw new ConsentAbandonedError('abandoned');
			}
			throw err;
		}
	};
	let result: SendSavedVoteResult;
	try {
		result = await (deps.send ?? sendSavedVote)({
			port,
			sentStore: {read: readVoteSent, record: recordVoteSent},
			record: opened.record,
			rendezvous,
			signConsent,
			cancelSign: deps.cancelSign ?? cancelPendingSign,
			canPrompt: deps.canPrompt ?? (() => AppState.currentState !== 'background'),
			nowMs: deps.nowMs,
			onStatus: deps.onStatus,
			signal: deps.signal,
		});
	} catch {
		return {kind: 'failed'};
	}
	if (!result.ok) {
		return {kind: result.reason};
	}
	return {kind: 'done', ballots: result.ballots};
}
