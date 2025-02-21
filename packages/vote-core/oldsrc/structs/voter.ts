import type { DeviceSignature } from "./device-signature.js";

export type Voter = {
    /** Cid of the public registration record */
    publicCid: string,

		/** Cid of the private registration record */
		privateCid: string,

    /** Voter's signature of the templateCid and this record*/
    signature: DeviceSignature,
}

export type VoterWithKey = { registrantKey: string; voter: Voter; };
