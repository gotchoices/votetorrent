import { DeviceSignature } from "./device-signature";

export interface Voter {
    /** Cid of the public registration record */
    publicCid: string,

		/** Cid of the private registration record */
		privateCid: string,

    /** Voter's signature of the templateCid and this record*/
    signature: DeviceSignature,
}

export type VoterWithKey = { registrantKey: string; voter: Voter; };
