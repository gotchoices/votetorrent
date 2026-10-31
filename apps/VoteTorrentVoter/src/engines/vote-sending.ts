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
 * prompts, and a signer that reports another prompt showing counts as a consent not given. A ballot
 * whose pool is still too small when voting closes stays saved on the phone, not sent. Nothing here logs or touches the sealed record's
 * storage.
 */
import {
	POOL_MIN_PROMPT_MS,
	POOL_SIGN_TIMEOUT_MS,
	PoolAgent,
	canonicalJson,
	createConsentQueue,
	createPoolIdentity,
	encryptVoteEntry,
	type PoolAgentOptions,
	type PoolAgentStatus,
	type PoolBallot,
	type PoolContribution,
	type PoolOutcome,
	type PoolRendezvousClient,
	type FormedPoolBlock,
	type ConsentSignature,
	type ConsentCallControl,
} from '@votetorrent/vote-engine/rn';
import type {VoteRecord} from './vote-record-vault';

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
	/** sign a consent digest with the voting key; one fingerprint prompt */
	signConsent: (digest: string) => Promise<string>
	nowMs: () => number
	onStatus?: (ballotId: string, status: BallotSendStatus) => void
	signal?: AbortSignal
	/** dismiss the native consent prompt that is showing; resolves after it is gone; never rejects for "nothing pending" */
	cancelSign?: () => Promise<unknown>
	/** test seam: the consent queue's minimum prompt window (default POOL_MIN_PROMPT_MS) */
	minPromptMs?: number
	/** test seam: agent timing overrides */
	agentOptions?: Partial<PoolAgentOptions>
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

export async function sendSavedVote(deps: SendSavedVoteDeps): Promise<SendSavedVoteResult> {
	const {record, port} = deps;
	const {electionId, electionRevision: revision} = record;
	const jointPublicKey = await port.readElectionKey(electionId, revision);
	if (jointPublicKey === null) return {ok: false, reason: 'election-key-missing'};
	const closesAt = await port.readVotingClose(electionId, revision);
	if (closesAt === null) return {ok: false, reason: 'window-unreadable'};
	if (deps.nowMs() >= closesAt) return {ok: false, reason: 'voting-closed'};

	const sent = await deps.sentStore.read(electionId, revision);
	const consentQueue = createConsentQueue(deps.signConsent, {
		holdMs: deps.agentOptions?.signTimeoutMs ?? POOL_SIGN_TIMEOUT_MS,
		cancel: deps.cancelSign,
		minPromptMs: deps.minPromptMs ?? POOL_MIN_PROMPT_MS,
		now: deps.nowMs,
	});
	const signConsent = (digest: string, ctl?: ConsentCallControl) => consentQueue.withControl(ctl, digest);
	const report = (ballotId: string, status: BallotSendStatus) => deps.onStatus?.(ballotId, status);

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
		const identity = createPoolIdentity();
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
			signConsent,
			commit: (block, signatures) => port.commit(block, ballot, signatures, deps.nowMs()),
			findRecordedVote: () => port.findRecordedVote(electionId, ballotId, record.voter.registrantId),
			deadlineAt: closesAt,
			now: deps.nowMs,
			onStatus: (s) => { const mapped = toStatus(s); if (mapped !== null) report(ballotId, mapped); },
			...deps.agentOptions,
		});
		let outcome: PoolOutcome;
		try {
			outcome = await agent.run(deps.signal);
		} catch {
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
