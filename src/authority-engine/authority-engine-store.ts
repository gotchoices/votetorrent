export interface AuthorityEngineStore {
    loadSubmissionRequirements(): Promise<SubmissionRequirement[]>;
    saveRegistrantSubmission(submission: RegistrantSubmission): Promise<void>;
}