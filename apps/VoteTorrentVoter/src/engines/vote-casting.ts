/**
 * vote-casting.ts — binding over the Submit gate and castVote, which moved to
 * `packages/workflows/src/voter/vote-casting.ts` (phase 67 plan 22). This path stays so imports
 * (`ReviewSubmitScreen`, `vote-send-flow`, the device probe), `jest.mock` paths and the gates keep
 * working; the source gates read the shared file. This is the ONE place the app supplies its vote
 * casting seams: the vote-signing producer resolver (real in every build), the record store and the
 * record vault (which holds the record wrap provider). No workflow logic lives here.
 */
import { castVote as sharedCastVote, evaluateVoteEligibility as sharedEvaluateVoteEligibility } from '@votetorrent/workflows/voter'
import type { CastVoteDeps, CastVoteResult, VoteCastingSeams, VoteEligibility, VoteEligibilityDeps } from '@votetorrent/workflows/voter'
import { resolveVoteSigningProducer } from './attestation-producer'
import { buildVoteMarker, guard, VoteStoreWriteError, writeVoteRecord } from './vote-record-store'
import { sealVoteRecord, VoteRecordUnavailableError } from './vote-record-vault'

export { VOTE_INELIGIBLE_REASONS, digestBytesFromBase64Url, resolveVoteSelections } from '@votetorrent/workflows/voter'
export type {
	CastVoteDeps,
	CastVoteFailure,
	CastVoteFailureStage,
	CastVoteResult,
	CastVoteSaved,
	CastVoteSignFailureReason,
	VoteEligibility,
	VoteEligibilityDeps,
	VoteEligible,
	VoteIneligible,
	VoteIneligibleReason,
	VoteQuestionRef,
	VoteSelectionResult,
	VoteSelections,
	VotingIdentity,
} from '@votetorrent/workflows/voter'

/** The app's seams, built fresh per call so module mocks and spies on the app modules stay effective. */
function appVoteCastingSeams (): VoteCastingSeams {
	return {
		resolveVoteSigningProducer: (override) => resolveVoteSigningProducer(override),
		recordStore: {
			guard: (electionId, currentRevision) => guard(electionId, currentRevision),
			buildVoteMarker: (record) => buildVoteMarker(record),
			writeVoteRecord: (envelope, marker) => writeVoteRecord(envelope, marker),
			VoteStoreWriteError,
		},
		recordVault: {
			sealVoteRecord: (record, options) => sealVoteRecord(record, options),
			VoteRecordUnavailableError,
		},
	}
}

export function evaluateVoteEligibility (deps: VoteEligibilityDeps): Promise<VoteEligibility> {
	return sharedEvaluateVoteEligibility(deps, appVoteCastingSeams())
}

export function castVote (deps: CastVoteDeps): Promise<CastVoteResult> {
	return sharedCastVote(deps, appVoteCastingSeams())
}
