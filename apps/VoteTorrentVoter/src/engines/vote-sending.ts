/**
 * vote-sending.ts — binding over the saved-vote send, which moved to
 * `packages/workflows/src/voter/vote-sending.ts` (phase 67 plan 22). This path stays so imports
 * (`vote-send-flow`, `SendVoteCard`, `engine-factory`), `jest.mock` paths and tests keep working. This
 * is the ONE place the app supplies its debug sink (`vtDebug` / `idPrefix`, silent in release). No
 * workflow logic lives here.
 */
import {sendSavedVote as sharedSendSavedVote} from '@votetorrent/workflows/voter';
import type {SendSavedVoteDeps, SendSavedVoteResult} from '@votetorrent/workflows/voter';
import {idPrefix, vtDebug} from './vt-debug';

export {
	ABANDONED_CONSENT_SIGN_CODES,
	CONSENT_TRANSIENT_RETRY_CAP,
	SYSTEM_CANCEL_BACKSTOP,
	TRANSIENT_CONSENT_SIGN_CODES,
	classifyConsentSignFailure,
	statusForOutcome,
} from '@votetorrent/workflows/voter';
export type {BallotSendStatus, SendSavedVoteDeps, SendSavedVoteResult, VoteSendingPort, VoteSentStore} from '@votetorrent/workflows/voter';

export function sendSavedVote(deps: SendSavedVoteDeps): Promise<SendSavedVoteResult> {
	return sharedSendSavedVote(deps, {vtDebug: (tag, event, detail) => vtDebug(tag, event, detail), idPrefix: (id) => idPrefix(id)});
}
