import { ConfirmedElection, RegistrationInitiation } from "../common";

export interface AuthorityEngineStore {
		loadVotedByKey(confirmedCid: string, registrantKeys: string[]): Promise<string[]>;
		loadConfirmed(confirmedCid: string): Promise<ConfirmedElection>;
    loadSubmissionRequirements(): Promise<string[]>;
    saveRegistrantSubmission(submission: RegistrationInitiation): Promise<void>;
}
