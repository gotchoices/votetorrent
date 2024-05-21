import { DeviceSignature } from "./device-signature";

export interface VoterDigest {
    solicitationDigest: string,
    rollKey: string,
}

export interface Voter {
    /** Roll entry key for the registered voter */
    rollKey: string,
    /** Voter's signature of the election, signed against rollKey */
    signature: DeviceSignature,
}