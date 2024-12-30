import { RegistrantDetails, TraceFunc, RegistrationInitiation } from "./structs/index.js";
import { AuthorityEngineStore } from "./index.js";

export class RegistrationEngine {
    constructor(
        private readonly store: AuthorityEngineStore,
        private readonly trace?: TraceFunc
    ) { }

    async beginRegistration(): Promise<RegistrationInitiation> {
        this.trace?.("beginRegistration", "starting registration process");
        const submission: RegistrationInitiation = {
            registrantCid: generateCid(),
            nonce: crypto.randomBytes(16).toString("base64"),
            requirements: await this.store.loadSubmissionRequirements(),
        };
        await this.store.saveRegistrantSubmission(submission);
        this.trace?.("beginRegistration", `submission: ${JSON.stringify(submission)}`);
        return submission;
    }

    async register(registrant: RegistrantDetails) {
        this.trace?.("register", `registrant: ${JSON.stringify(registrant)}`);
        // re-load submission
        const submission = await this.store.loadRegistrantSubmission(registrant.registrantCid);

        // validate attestation and other details
        // validate against submission
				// acquire timestamp from TSA
        // store rejection or acceptance
        // return result
    }

    async getRegistrantPublic(registrantCid: string): Promise<RegistrantDetails> {
    }

    async getRegistrantPrivate(registrantCid: string, userCid: string): Promise<RegistrantDetails> {
    }
}
