export type RegistrationInitiation = {
    registrantCid: string;
    nonce: string;
    /** Set of Registrant members that are required. */
    requirements: string[]; // e.g. ["names.first", "attestation", "email"]
}
