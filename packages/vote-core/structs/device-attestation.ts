
export interface DeviceAttestation {
    publicKey: string; // Public key of the device
    deviceId: string; // Unique identifier for the device, or the app install in the case of iOS
    location?: { lat: number; lon: number; };
    attestationStatement?: string; // Encoded attestation statement from the device
    attestationTime: number; // Unix Time when attestation was performed
    certificateChain: string[]; // Array of certificates used in the attestation
    platformDetails?: iOSDetails | AndroidDetails;
}
// Detailed interfaces for platform-specific details
interface iOSDetails {
    type: 'iOS';
    secureEnclavePublicKey: string; // Public key specifically for iOS Secure Enclave
    deviceCheckToken?: string; // Optional token from Apple's DeviceCheck API
}
interface AndroidDetails {
    type: 'Android';
    safetyNetAttestation: string; // Base64-encoded response from Android's SafetyNet
    keystorePublicKey: string; // Public key from Android Keystore
    nonce: string; // Nonce used in the attestation request
}
