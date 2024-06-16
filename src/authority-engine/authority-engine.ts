import { RegistrantDetails, TraceFunc, RegistrationSubmission } from "../common";

export class AuthorityEngine {
    constructor(
        private readonly store: AuthorityEngineStore,
        private readonly trace?: TraceFunc
    ) { }

    async beginRegistration(): Promise<RegistrationSubmission> {
        this.trace?.("beginRegistration", "starting registration process");
        const submission: RegistrationSubmission = {
            registrantCid: generateCid(),
            nonce: crypto.randomBytes(16).toString("hex"),
            requirements: await this.store.loadSubmissionRequirements(),
        };
        await this.store.saveRegistrantSubmission(submission);
        this.trace?.("beginRegistration", `submission: ${JSON.stringify(submission)}`);
        return submission;
    }

    async register(registrant: RegistrantDetails) {
        this.trace?.("register", `registrant: ${JSON.stringify(registrant)}`);
        // re-load submission
        // validate against submission
        // store rejection or acceptance
        // return result
    }
}