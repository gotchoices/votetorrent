import { AuthorizedTimestamp } from "./authorized-timestamp";
import { DeviceSignature } from "./device-signature";

export interface Identification {
    type: string,
    value: string,
    expiration?: string,
    image?: string,
}

export interface Registrant {
    /** The public key that will be used for cryptographic operations, generated and stored within the secure enclave or keystore of the device. */
    cid: string,

    /** TSA timestamp of registration */
    registrationTimestamp: AuthorizedTimestamp,

    /** Secured signature from the device */
    signature: DeviceSignature,

    /** Location of the registration, not necessarily where the device that registered was */
    location: {
        /** Latitude of the registration */
        lat: number,
        /** Longitude of the registration */
        lon: number,
    }

    physicalAddress: Record<string, string>,

    mailingAddress: Record<string, string>,

    identification: Identification[],

    privateDetails: Record<string, unknown>,
}
