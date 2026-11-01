/**
 * vote-sending.ts — send a saved vote to the network (spike 102, applied).
 *
 * Phase 63 leaves a vote saved on the phone, signed once and sealed. Sending puts each ballot's vote
 * into a vote block other voters co-sign, through the authority's rendezvous:
 *
 *   1. the caller opens the sealed record (one fingerprint prompt) and hands it in;
 *   2. per ballot not yet sent: ask the strand first (a VoteBlockVoter row for this registrant and
 *      ballot means the vote already landed, maybe from an attempt whose answer was lost);
 *   3. encrypt the vote entry to the election key on the phone, so the voter that forms the block
 *      never sees the vote (user decision);
 *   4. run a PoolAgent: present / merge / inform through the rendezvous; when a block of at least
 *      3 forms, check it and sign consent with the voting key (one fingerprint prompt per block);
 *   5. record the block cid per ballot. Another voter's "you already voted" is only a hint: the
 *      agent waits a bounded time for this voter's own strand row, then either reports sent (the row
 *      is there) or keeps pooling without that voter. Only this phone's OWN failed commit (it formed
 *      the block and the commit named its registrant) stops a ballot as already voted; that ballot
 *      re-reads the strand once and reports sent only when its row is there (D-12, CR-01).
 *
 * Ballots pool in parallel (each has its own topic), but consent prompts are serialized through
 * vote-engine's consent queue, one at a time. A prompt not answered by the former's reply deadline is
 * dismissed through the injected `cancelSign` before the next prompt starts (Android shows only one
 * BiometricPrompt and silently drops a second one), a consent abandoned before it starts never
 * prompts, and a sign that failed without the voter declining (the OS ended the prompt, no prompt
 * could be shown, another prompt showing, a temporary lockout) is handed to the agent as an abandoned
 * consent, never a decline. A ballot whose pool is still too small when voting closes stays saved on
 * the phone, not sent. A ballot whose consent sign keeps failing with transient device trouble (more
 * than CONSENT_TRANSIENT_RETRY_CAP times) stops as a decline.
 * Nothing here touches the sealed record's storage. The only logging is `vtDebug` (silent unless the
 * __DEV__ debug switch is on): state names, timings, codes and 8-char ballot prefixes, never a key,
 * signature, ciphertext or error message text.
 */
import {
	ConsentAbandonedError,
	POOL_MIN_PROMPT_MS,
	POOL_SIGN_TIMEOUT_MS,
	PoolAgent,
	canonicalJson,
	createConsentQueue,
	createPoolIdentity,
	encryptVoteEntry,
	isConsentAbandonedError,
	type PoolAgentOptions,
	type PoolAgentStatus,
	type PoolBallot,
	type PoolContribution,
	type PoolOutcome,
	type PoolRendezvousClient,
	type FormedPoolBlock,
	type ConsentSignature,
	type ConsentCallControl,
	type PoolIdentity,
} from '@votetorrent/vote-engine/rn';
import type {VoteRecord} from './vote-record-vault';
import {idPrefix, vtDebug} from './vt-debug';

/** What sending needs from the joined network's strand; built by the engine factory, never by a screen. */
export interface VoteSendingPort {
	/** ElectionKey.JointPublicKey for this revision, or null before the key ceremony finished */
	readElectionKey(electionId: string, revision: number): Promise<string | null>
	/** the end of the voting period (Timeline.accruingVotes, epoch ms), or null when unreadable */
	readVotingClose(electionId: string, revision: number): Promise<number | null>
	/** write the block and its voter rows in one transaction; `nowMs` is this phone's clock (the schema's voting-window check trusts it) */
	commit(block: FormedPoolBlock, ballot: PoolBallot, signatures: ConsentSignature[], nowMs: number): Promise<{ok: true} | {ok: false, reason: string, duplicateRegistrants?: string[]}>
	/** the VoteBlock cid this registrant's vote on this ballot is already recorded in, or null */
	findRecordedVote(electionId: string, ballotId: string, registrantId: string): Promise<string | null>
}

export interface VoteSentStore {
	read(electionId: string, revision: number): Promise<Record<string, string>>
	record(electionId: string, revision: number, ballotId: string, cid: string): Promise<void>
}

export type BallotSendStatus =
	| {phase: 'waiting', size: number}
	| {phase: 'joined', size: number}
	| {phase: 'confirming'}
	| {phase: 'sent', cid: string}
	| {phase: 'not-sent', reason: 'voting-closed' | 'stopped' | 'failed' | 'already-voted'}

export interface SendSavedVoteDeps {
	port: VoteSendingPort
	sentStore: VoteSentStore
	record: VoteRecord
	/** a transport to the authority's rendezvous */
	rendezvous: PoolRendezvousClient
	/**
	 * sign a consent digest with the voting key; one fingerprint prompt. `signal` aborts when the pool
	 * abandons this consent: a signer that has not reached the native prompt yet should not raise it.
	 */
	signConsent: (digest: string, signal?: AbortSignal) => Promise<string>
	nowMs: () => number
	onStatus?: (ballotId: string, status: BallotSendStatus) => void
	signal?: AbortSignal
	/** dismiss the native consent prompt that is showing; resolves after it is gone; never rejects for "nothing pending" */
	cancelSign?: () => Promise<unknown>
	/** test seam: the consent queue's minimum prompt window (default POOL_MIN_PROMPT_MS) */
	minPromptMs?: number
	/** whether a consent prompt can be shown now (the app is in the foreground); handed to the pool agent */
	canPrompt?: () => boolean
	/** test seam: agent timing overrides */
	agentOptions?: Partial<PoolAgentOptions>
	/** test seam: the throwaway pool identity for a ballot (default: a fresh one per ballot) */
	poolIdentity?: (ballotId: string) => PoolIdentity
}

export type SendSavedVoteResult =
	| {ok: true, ballots: Array<{ballotId: string, status: BallotSendStatus}>}
	| {ok: false, reason: 'election-key-missing' | 'voting-closed' | 'window-unreadable'}

function toStatus(s: PoolAgentStatus): BallotSendStatus | null {
	switch (s.phase) {
		case 'pooling': return {phase: 'waiting', size: s.size};
		case 'member': return {phase: 'joined', size: s.size};
		case 'signing': return {phase: 'confirming'};
		default: return null;
	}
}

/**
 * Map a finished pool agent to the ballot's status. An agent stops 'already-voted' only when this
 * phone formed the block and its own commit named this voter as a duplicate (a peer's claim never
 * stops it, CR-01). It is re-checked against the strand once: a readable row means sent, anything
 * else is not-sent.
 */
export async function statusForOutcome(outcome: PoolOutcome, recheckRecordedVote: () => Promise<string | null>): Promise<BallotSendStatus> {
	if (outcome.status === 'committed') return {phase: 'sent', cid: outcome.cid};
	// widened: the dist type this app compiles against may not list 'already-voted' yet
	const reason: string = outcome.reason;
	if (reason === 'deadline') return {phase: 'not-sent', reason: 'voting-closed'};
	if (reason === 'already-voted') {
		const cid = await recheckRecordedVote().catch(() => null);
		return cid !== null ? {phase: 'sent', cid} : {phase: 'not-sent', reason: 'already-voted'};
	}
	return {phase: 'not-sent', reason: 'stopped'};
}

/**
 * Native sign codes for a consent the voter did not decline and that says nothing about the device:
 * the app could not show the prompt or the OS took it away. SYSTEM_CANCELED: the OS ended the prompt
 * (screen lock, incoming call, app switch; Android ERROR_CANCELED, iOS systemCancel/appCancel).
 * NO_ACTIVITY: the app had no activity able to host a prompt (backgrounded). ABORTED: the pool
 * abandoned the consent before the native sign was reached. Released and never counted toward
 * CONSENT_TRANSIENT_RETRY_CAP: the voter cannot cause them by declining, and they clear when the app
 * is back in the foreground.
 */
export const ABANDONED_CONSENT_SIGN_CODES: readonly string[] = ['SYSTEM_CANCELED', 'NO_ACTIVITY', 'ABORTED'];

/**
 * Native sign codes for transient device trouble: released like an abandoned consent, but counted
 * toward CONSENT_TRANSIENT_RETRY_CAP, because a failure that never clears would otherwise re-form the
 * pool until voting closes. PROMPT_BUSY: another prompt was already showing (D-112). BIOMETRIC_ERROR:
 * a platform error (the native catch-all: a timeout, the hardware unavailable). LOCKOUT: the
 * temporary biometric lockout (Android ERROR_LOCKOUT, about 30 s after five failed reads). iOS
 * biometryLockout reaches JS as LOCKOUT_PERMANENT (it needs the passcode) and is a decline.
 */
export const TRANSIENT_CONSENT_SIGN_CODES: readonly string[] = ['PROMPT_BUSY', 'BIOMETRIC_ERROR', 'LOCKOUT'];

/**
 * How a rejected consent sign reaches the pool agent.
 * - 'abandoned' (released, keeps pooling, not counted): an abandoned consent (ConsentAbandonedError),
 *   or a code in ABANDONED_CONSENT_SIGN_CODES.
 * - 'transient' (released, keeps pooling, counted): a code in TRANSIENT_CONSENT_SIGN_CODES; past
 *   CONSENT_TRANSIENT_RETRY_CAP it is passed on as a decline.
 * - 'declined' (a decline stops the former's ballot; a member refuses): the voter's CANCELED (the
 *   voter dismissed the prompt), and every other code. That includes the permanent ones
 *   (LOCKOUT_PERMANENT, KEY_INVALIDATED, KEY_INVALIDATED_REASSOCIATE, DEVICE_KEY_INVALIDATED,
 *   NO_BIOMETRICS_ENROLLED, NO_KEY_PROVISIONED, NO_DEVICE_CREDENTIAL) and any unknown code:
 *   re-pooling cannot fix them and would only raise prompt after prompt until voting closes, so the
 *   send stops and its failure line shows.
 */
export function classifyConsentSignFailure(err: unknown): 'abandoned' | 'transient' | 'declined' {
	if (isConsentAbandonedError(err)) return 'abandoned';
	const code = (err as {code?: unknown} | null)?.code;
	if (typeof code !== 'string') return 'declined';
	if (ABANDONED_CONSENT_SIGN_CODES.includes(code)) return 'abandoned';
	if (TRANSIENT_CONSENT_SIGN_CODES.includes(code)) return 'transient';
	return 'declined';
}

/**
 * How many transient consent-sign failures (a code in TRANSIENT_CONSENT_SIGN_CODES) one ballot may
 * have in one send before the next one is treated as a decline (CR-01 follow-up). BIOMETRIC_ERROR is
 * also the native catch-all (a timeout, the hardware unavailable), so a failure that never clears
 * would otherwise make a former release and re-form its pool again and again, spending the other
 * voters' prompts and time until voting closes. Three releases are enough for a busy prompt or a
 * temporary lockout to clear; the fourth failure takes the existing decline path (the former's ballot
 * stops 'not-sent: stopped' with the existing copy; a member refuses). The 'abandoned' class (the OS
 * ended the prompt, the app could not host one, or the pool itself let the consent go) is never
 * counted: the voter did not decline and the device is not at fault.
 *
 * The budget is per ballot and shared by the member and former roles of that ballot: deliberate, as
 * transient failures are rare and the cap only has to bound them, not tell the roles apart.
 */
export const CONSENT_TRANSIENT_RETRY_CAP = 3;

/**
 * A backstop for the uncounted SYSTEM_CANCELED / NO_ACTIVITY failures of one ballot (review round 4).
 * The pool agent no longer forms or prompts while the app is in the background (canPrompt), so these
 * should be rare; but a device that reports the voter's Back dismissal as the system-cancel error, or
 * a phone whose prompt the OS keeps taking away in the foreground, would otherwise re-form forever.
 * Past this many, the next one is passed on as a decline.
 */
export const SYSTEM_CANCEL_BACKSTOP = 5;
const BACKSTOPPED_CONSENT_SIGN_CODES: readonly string[] = ['SYSTEM_CANCELED', 'NO_ACTIVITY'];

function errorCode(err: unknown): string {
	const code = (err as {code?: unknown} | null)?.code;
	if (typeof code === 'string') return code;
	return err instanceof Error ? err.name : typeof err;
}

/** A pool-agent reason is logged only when it is a plain token ('deadline', 'aborted'); free text (a commit's SQL error) never is. */
function poolLogDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
	if (detail === undefined) return {};
	const reason = detail.reason;
	return typeof reason === 'string' && !/^[a-z][a-z0-9-]{0,31}$/.test(reason) ? {...detail, reason: '<text>'} : detail;
}

export async function sendSavedVote(deps: SendSavedVoteDeps): Promise<SendSavedVoteResult> {
	const {record, port} = deps;
	const {electionId, electionRevision: revision} = record;
	const jointPublicKey = await port.readElectionKey(electionId, revision);
	if (jointPublicKey === null) return {ok: false, reason: 'election-key-missing'};
	const closesAt = await port.readVotingClose(electionId, revision);
	if (closesAt === null) return {ok: false, reason: 'window-unreadable'};
	if (deps.nowMs() >= closesAt) return {ok: false, reason: 'voting-closed'};

	const sent = await deps.sentStore.read(electionId, revision);
	const startedAt = deps.nowMs();
	// The engine treats any rejection of the former's own consent other than an abandoned one as a
	// decline that stops the ballot (CR-01), so a failure the voter did not cause is handed on as an
	// abandoned consent: the pool is released and pooling goes on (classifyConsentSignFailure). An
	// 'abandoned' failure (system cancel, no activity, aborted) is never counted; a 'transient' one is,
	// at most CONSENT_TRANSIENT_RETRY_CAP times per ballot (member and former share the budget); after
	// that the failure is passed on as a decline.
	const transientFailures = new Map<string, number>();
	const systemCancels = new Map<string, number>();
	const consentSign = async (digest: string, signal: AbortSignal | undefined, ballotId: string): Promise<string> => {
		try {
			return await deps.signConsent(digest, signal);
		} catch (err) {
			const ballot = idPrefix(ballotId);
			if (isConsentAbandonedError(err)) {
				vtDebug('send', 'consent-abandoned', {ballot, reason: (err as {reason?: unknown}).reason as string | undefined});
				throw err;
			}
			const code = errorCode(err);
			const cls = classifyConsentSignFailure(err);
			if (cls === 'abandoned') {
				if (BACKSTOPPED_CONSENT_SIGN_CODES.includes(code)) {
					const n = (systemCancels.get(ballotId) ?? 0) + 1;
					systemCancels.set(ballotId, n);
					if (n > SYSTEM_CANCEL_BACKSTOP) {
						vtDebug('send', 'consent-sign-failed', {ballot, code, class: 'decline', n, backstop: true});
						throw err;
					}
				}
				vtDebug('send', 'consent-sign-failed', {ballot, code, class: 'abandoned'});
				throw new ConsentAbandonedError('abandoned');
			}
			if (cls === 'transient') {
				const n = (transientFailures.get(ballotId) ?? 0) + 1;
				transientFailures.set(ballotId, n);
				if (n <= CONSENT_TRANSIENT_RETRY_CAP) {
					vtDebug('send', 'consent-sign-failed', {ballot, code, class: 'transient', n});
					throw new ConsentAbandonedError('abandoned');
				}
				vtDebug('send', 'consent-sign-failed', {ballot, code, class: 'decline', n, capped: true});
				throw err;
			}
			vtDebug('send', 'consent-sign-failed', {ballot, code, class: 'decline'});
			throw err;
		}
	};
	const consentQueue = createConsentQueue(consentSign, {
		holdMs: deps.agentOptions?.signTimeoutMs ?? POOL_SIGN_TIMEOUT_MS,
		cancel: deps.cancelSign,
		minPromptMs: deps.minPromptMs ?? POOL_MIN_PROMPT_MS,
		now: deps.nowMs,
		// debug only (silent unless the __DEV__ switch is on): prompt start, skip, abandon, cancel, settle
		log: (event, detail) => vtDebug('queue', event, detail),
	});
	// The call's own abort signal reaches the signer, so a consent abandoned before its prompt starts
	// is never raised (WR-04). The ballot id rides along for the per-ballot retry cap.
	const signConsentFor = (ballotId: string) => (digest: string, ctl?: ConsentCallControl) => consentQueue.withControl(ctl, digest, ctl?.signal, ballotId);
	const report = (ballotId: string, status: BallotSendStatus) => {
		vtDebug('send', 'status', {
			ballot: idPrefix(ballotId),
			phase: status.phase,
			reason: status.phase === 'not-sent' ? status.reason : undefined,
			size: status.phase === 'waiting' || status.phase === 'joined' ? status.size : undefined,
			ms: deps.nowMs() - startedAt,
		});
		deps.onStatus?.(ballotId, status);
	};

	const ballots = await Promise.all(record.votes.map(async (vote): Promise<{ballotId: string, status: BallotSendStatus}> => {
		const ballotId = vote.ballotId;
		const done = (status: BallotSendStatus) => { report(ballotId, status); return {ballotId, status}; };
		if (sent[ballotId] !== undefined) return done({phase: 'sent', cid: sent[ballotId]!});
		const already = await port.findRecordedVote(electionId, ballotId, record.voter.registrantId).catch(() => null);
		if (already !== null) {
			await deps.sentStore.record(electionId, revision, ballotId, already).catch(() => undefined);
			return done({phase: 'sent', cid: already});
		}
		const ballot: PoolBallot = {electionKey: {electionId, revision, jointPublicKey}, ballotId, templateDigest: vote.templateDigest};
		// A throwaway pool identity per ballot: the voters this phone pools with never learn its network
		// identity, and each ballot's pool gets its own mailbox at the rendezvous.
		const identity = deps.poolIdentity?.(ballotId) ?? createPoolIdentity();
		let contribution: PoolContribution;
		try {
			contribution = {
				member: identity.peerId,
				voteCiphertext: encryptVoteEntry(ballot.electionKey, ballotId, canonicalJson(vote)),
				voterEntry: record.voter,
			};
		} catch {
			return done({phase: 'not-sent', reason: 'failed'});
		}
		const agent = new PoolAgent({
			identity,
			rendezvous: deps.rendezvous,
			ballot,
			contribution,
			signConsent: signConsentFor(ballotId),
			commit: (block, signatures) => port.commit(block, ballot, signatures, deps.nowMs()),
			findRecordedVote: () => port.findRecordedVote(electionId, ballotId, record.voter.registrantId),
			deadlineAt: closesAt,
			now: deps.nowMs,
			onStatus: (s) => { const mapped = toStatus(s); if (mapped !== null) report(ballotId, mapped); },
			// debug only (silent unless the __DEV__ switch is on); a test's agentOptions.log replaces it
			log: (event, detail) => vtDebug('pool', event, {ballot: idPrefix(ballotId), ...poolLogDetail(detail)}),
			...(deps.canPrompt !== undefined ? {canPrompt: deps.canPrompt} : {}),
			...deps.agentOptions,
		});
		let outcome: PoolOutcome;
		try {
			outcome = await agent.run(deps.signal);
		} catch (err) {
			vtDebug('send', 'agent-threw', {ballot: idPrefix(ballotId), class: errorCode(err)});
			return done({phase: 'not-sent', reason: 'failed'});
		}
		const status = await statusForOutcome(outcome, () => port.findRecordedVote(electionId, ballotId, record.voter.registrantId));
		// An already-voted stop with nothing readable is not recorded as sent: the vote stays saved and
		// the next send re-checks the strand first, then re-pools.
		if (status.phase === 'sent') await deps.sentStore.record(electionId, revision, ballotId, status.cid).catch(() => undefined);
		return done(status);
	}));
	return {ok: true, ballots};
}
