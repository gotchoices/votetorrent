import { DeviceSignature } from "./device-signature";

export interface RollEntry {
    /** The public key that will be used for cryptographic operations, generated and stored within the secure enclave or keystore of the device. */
    key: string,
    // TODO: Timestamp Authority Signatures rather than trusting the authority's date/time?
    /** Unix timestamp of registration */
    registrationDateTime: number,
    /** Secured signature from the device */
    signature: DeviceSignature,
}
