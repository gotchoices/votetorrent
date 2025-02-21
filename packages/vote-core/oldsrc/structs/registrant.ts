import type { AuthorizedTimestamp } from "./authorized-timestamp.js";
import type { DeviceAttestation } from "./device-attestation.js";
import type { DeviceSignature } from "./device-signature.js";
import type { RegistrationInterview } from "./registration-interview.js";


export interface Identification {
    type: string,
    value: string,
    expiration?: string,
    image?: string,
}

export type RegistrantDetails = {
		/** Hash key (of body) and identifier for registrant details */
    cid: string,

		/** Voter ID - same for public and private records */
		id: string,

		timestamps: AuthorizedTimestamp[],

    attestation?: DeviceAttestation,

    /** Secured signature from the device */
    signature?: DeviceSignature,

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
}

export type Registrant = {
		/** Voter ID - is a public key and also in public and private records for hashing */
		key: string,

		publicKey: string,

		/** The revision number for the current (latest) revision */
		currentRevision: number,
}

export interface RegistrantRevision {
		cid: string,

		replacesCid: string | undefined,

		registrantKey: string,

		/** Monotonically increasing revision number (starting at 1) */
		revision: number,

		/** The visibility of the registrant - determines what information is in the public and private records */
		visibility: "public" | "private" | "restricted",

		public: RegistrantDetails,

		/** Private portion of the registrant - Encrypted RegistrantDetails */
		private: string,

		/** Authority's signature of public details */
		publicSignature: string,

		/** Authority's signature of private details */
		privateSignature: string,
}
