
export interface RegistrationSubmission {
    registrantCid: string;
    nonce: string;
    /** Set of RegistrantDetails members that are required. */
    requirements: string[]; // e.g. ["names.first", "attestation", "email"]
}
