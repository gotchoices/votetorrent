export interface DeviceSignature {
    signature: string,
    deviceId?: string,               // Unique identifier for the device
    location?: { lat: number, lon: number },
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