export interface RollEntry {
    /** The public key that will be used for cryptographic operations, generated and stored within the secure enclave or keystore of the device. */
    key: string,
    /** Unix timestamp of registration */
    registrationDateTime: number,
    signature: string,
    attestationStatement?: string,  // Encoded attestation statement from the device
    platformDetails?: iOSDetails | AndroidDetails;
}

// Detailed interfaces for platform-specific details
interface iOSDetails {
    secureEnclavePublicKey: string;  // Public key specifically for iOS Secure Enclave
    deviceCheckToken?: string;       // Optional token from Apple's DeviceCheck API
}

interface AndroidDetails {
    safetyNetAttestation: string;    // Response from Android's SafetyNet
    keystorePublicKey: string;       // Public key from Android Keystore
}