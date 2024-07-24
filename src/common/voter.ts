import { DeviceSignature } from "./device-signature";

export interface VoterDigest {
		/** Signature of the confirmed election - ensures that the voter is voting on the correct and confirmed election. */
    confirmedSignature: string,
		/** Roll entry key for the registered voter */
    registrantCid: string,
}

export interface Voter {
    /** Roll entry key for the registered voter */
    registrantKey: string,
    /** Voter's signature of the confirmed election */
    signature: DeviceSignature,
}
