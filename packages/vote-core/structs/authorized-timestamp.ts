/** Represents an authorized timestamp from a cryptographic timestamp authority (TSA). */
export interface AuthorizedTimestamp {
    timestamp: string; // ISO 8601 format
    signature: string; // Base64 encoded signature
    tsaCertificate: string; // Base64 encoded TSA certificate
    algorithm: string; // Signature algorithm, e.g., "SHA256withRSA"
    policyId?: string; // Optional: TSA's policy ID under which the timestamp was issued
    serialNumber?: string; // Optional: Serial number of the timestamp token

		nonce: string; // Nonce used in the timestamp request, for matching response to request
    hashedDigest: string; // Base64 encoded hash of the original digest sent to the authority
}
