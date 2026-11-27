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
 * The steps live in `packages/workflows/src/voter/run-vote-send.ts` (phase 67 plan 22); this file
 * supplies the phone's defaults (AppState, the native sign cancel, the receipt reveal, the join
 * bootstrap read, the sent-vote store, multiaddr) and the debug sink.
 * The only logging is `vtDebug` (silent unless the __DEV__ debug switch is on): the send's start and
 * end (result kind, ballot counts, duration) and a consent abandoned before the native sign; never a record,
 * key, signature, address or error text.
 */
import {AppState} from 'react-native';
import {multiaddr} from '@multiformats/multiaddr';
import type {PoolMatchmakingPorts} from '@votetorrent/vote-engine/rn';
import {runVoteSend} from '@votetorrent/workflows/voter';
import type {RunVoteSendResult} from '@votetorrent/workflows/voter';
import {cancelPendingSign} from '@votetorrent/attestation-native';
import type {SecretWrapPrompt} from '@votetorrent/attestation-native';
import {revealVoteReceipt} from './vote-receipt';
import type {VoteRecordEnvelope} from './vote-record-vault';
import {readJoinBootstrap} from './join-bootstrap';
import {resolveVoteSigningProducer} from './attestation-producer';
import type {AttestationProducer} from './attestation-producer';
import {VOTE_SENDING_PORT_ENGINE} from './vote-sending-port';
import {sendSavedVote} from './vote-sending';
import type {BallotSendStatus, VoteSendingPort} from './vote-sending';
import {readVoteSent, recordVoteSent} from './vote-sent-store';
import {idPrefix, vtDebug} from './vt-debug';

export type VoteSendFlowResult = RunVoteSendResult
export {PROBE_BUDGET_MS} from '@votetorrent/workflows/voter';

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
	/**
	 * Optimystic matchmaking for the current network's strand (VoterAppProvider.getPoolMatchmaking), read once
	 * when sending starts. Null or absent: pools are found through the rendezvous alone.
	 */
	getMatchmaking?: () => PoolMatchmakingPorts | null
}

export function runVoteSendFlow(deps: VoteSendFlowDeps): Promise<VoteSendFlowResult> {
	return runVoteSend({
		node: deps.node,
		readRendezvousAddrs: deps.readRendezvousAddrs ?? readJoinBootstrap,
		toDialTarget: deps.toDialTarget ?? ((a: string) => multiaddr(a)),
		openRecord: () => revealVoteReceipt(deps.electionId, deps.envelope, deps.recordPrompt),
		getPort: () => deps.getEngine<VoteSendingPort>(VOTE_SENDING_PORT_ENGINE),
		signingProducer: () => resolveVoteSigningProducer(deps.producer),
		consentPrompt: deps.consentPrompt,
		sentStore: {read: readVoteSent, record: recordVoteSent},
		send: deps.send ?? sendSavedVote,
		cancelSign: deps.cancelSign ?? cancelPendingSign,
		canPrompt: deps.canPrompt ?? (() => AppState.currentState !== 'background'),
		getMatchmaking: deps.getMatchmaking,
		nowMs: deps.nowMs,
		onStatus: deps.onStatus,
		signal: deps.signal,
		probeBudgetMs: deps.probeBudgetMs,
	}, {vtDebug: (tag, event, detail) => vtDebug(tag, event, detail), idPrefix: (id) => idPrefix(id)});
}
