import type { SID } from '../common';
import type {
	BallotDetails,
	BallotInit,
	BallotSummary,
	ElectionDetails,
	ElectionRevisionInit,
	KeyholderInvitationContent,
} from './models.js';

export type IElectionEngine = {
	getBallotDetails(sid: SID): Promise<BallotDetails>;
	getBallots(): Promise<BallotSummary[]>;
	getElectionDetails(): Promise<ElectionDetails>;
	inviteKeyholder(
		keyholder: KeyholderInvitationContent,
		electionSid: SID
	): Promise<void>;
	proposeBallot(ballot: BallotInit): Promise<void>;
	proposeRevision(revision: ElectionRevisionInit): Promise<void>;
	revokeKeyholder(
		keyholder: KeyholderInvitationContent,
		electionSid: SID
	): Promise<void>;
};
