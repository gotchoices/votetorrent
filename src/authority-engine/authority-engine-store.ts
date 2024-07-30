import { Block, ConfirmedElection, Receipt, RegistrationInitiation, Vote, Voter } from "../common";

export interface AuthorityEngineStore {
	loadVotesByNonce(confirmedCid: string, nonces: string[]): Promise<(Vote | undefined)[]>;
	loadBlock(cid: string): Promise<{ block: Block, receipt: Receipt }>;
	loadVotersByKey(confirmedCid: string, registrantKeys: string[]): Promise<(Voter | undefined)[]>;
	loadConfirmed(confirmedCid: string): Promise<ConfirmedElection>;
	loadSubmissionRequirements(): Promise<string[]>;
	saveRegistrantSubmission(submission: RegistrationInitiation): Promise<void>;
	saveBlockReceipt(cid: string, confirmedCid: string, receipt: Receipt): Promise<void>;
	saveVotesAndReceipt(cid: string, confirmedCid: string, voters: Voter[], votes: Vote[], receipt: Receipt): Promise<void>;
}
