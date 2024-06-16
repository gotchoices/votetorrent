import { AuthorizedTimestamp } from "./authorized-timestamp";
import { DeviceAttestation } from "./device-attestation";
import { DeviceSignature } from "./device-signature";
import { RegistrationInterview } from "./registration-interview";

export interface Identification {
    type: string,
    value: string,
    expiration?: string,
    image?: string,
}

export interface RegistrantDetails {
    registrantCid: string,

    attestation?: DeviceAttestation,

    identities?: Record<string, string>,

    names?: Record<string, string>,          // e.g. "first": "John", "middle": "Q", "last": "Public"

    email?: string,

    phones?: Record<string, string>,         // e.g. "home": "555-555-1234", "mobile": "555-555-5678"

    /** Link to the person's photos */
    images?: Record<string, string>,         // e.g. "headshot": "https://example.com/profile.jpg"

    interview?: RegistrationInterview,

    /** Date of birth */
    birthdate?: string,                      // In ISO format e.g. "1970-01-01"

    /** Location of the residence, different in general from where the registration occurred from */
    residenceLocation?: { lat: number, lon: number }

    residenceAddress?: Record<string, string>,

    mailingAddress?: Record<string, string>,

    identification?: Identification[],

    privateData?: Record<string, unknown>,

    affiliations?: Record<string, string>,   // e.g. "Party": "Republican"

    groupings?: Record<string, string>,      // e.g. "Precinct": "1234", "District": "5"

    /** Secured signature from the device */
    signature: string,              // Base64-encoded signature of the authority's digest and the registrant details
}
