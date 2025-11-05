import type {
	Ballot,
	BallotDetails,
	BallotSummary,
	ElectionDetails,
	ElectionRevisionInit,
	KeyholderInvite,
} from './models.js';

export type IElectionEngine = {
	getBallotDetails(id: string): Promise<BallotDetails>;
	getBallots(): Promise<BallotSummary[]>;
	getElectionDetails(): Promise<ElectionDetails>;
	inviteKeyholder(
		keyholder: KeyholderInvite,
		electionId: string
	): Promise<void>;
	proposeBallot(ballot: Ballot): Promise<void>;
	proposeRevision(revision: ElectionRevisionInit): Promise<void>;
	revokeKeyholder(
		keyholder: KeyholderInvite,
		electionId: string
	): Promise<void>;
};
