/** Represents an authorized timestamp from a cryptographic timestamp authority (TSA). */
export interface AuthorizedTimestamp {
    timestamp: string; // ISO 8601 format
    signature: string; // Base64 encoded signature
    tsaCertificate: string; // Base64 encoded TSA certificate
    algorithm: string; // Signature algorithm, e.g., "SHA256withRSA"
}
