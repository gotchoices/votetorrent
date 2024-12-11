import { VoteBlock, Template, Receipt, RegistrationInitiation, Vote, Voter } from "../common";

export interface AuthorityEngineStore {
	loadVotesByNonce(ballotCid: string, nonces: string[]): Promise<Record<string, (Vote | undefined)>>;
	loadBlock(cid: string): Promise<{ block: VoteBlock, receipt: Receipt }>;
	loadVotersByKey(ballotCid: string, registrantKeys: string[]): Promise<Record<string, (Voter | undefined)>>;
	loadBallot(ballotCid: string): Promise<Template>;
	loadSubmissionRequirements(): Promise<string[]>;
	saveRegistrantSubmission(submission: RegistrationInitiation): Promise<void>;
	saveVotesAndReceipt(cid: string, ballotCid: string, voters: Record<string, Voter>, votes: Record<string, Vote>, receipt: Receipt): Promise<void>;
	saveBlockReceipt(cid: string, ballotCid: string, receipt: Receipt): Promise<void>;
}
