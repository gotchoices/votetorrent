export interface VoterDigest {
    solicitationDigest: string,
    registrationKey: string,
}

export interface Voter {
    registrationKey: string,
    signature: string,
    attestationSignature?: string,   // Device OS signature of signature
    biometricSignature?: string,     // Enclave signature of VoterDigest
}