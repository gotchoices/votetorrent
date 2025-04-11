// Re-export DKGTerms for convenience if needed elsewhere
export type { DKGTerms } from './dkg-terms.js';

// Types previously defined within threshold.ts or dkg-state.ts

/** Public commitments made by a keyholder */
export type KeyholderCommitments = {
	id: string;
	idNum: bigint;
	commitments: Uint8Array[]; // [G*c0, G*c1, ..., G*ct-1]
};

/** Represents a share P_i(j) sent from keyholder i to keyholder j */
export type EncryptedShare = {
	sourceId: string;
	targetId: string;
	encryptedShare: bigint; // Simulate encryption
};

/** Represents the final computed share S_j held by keyholder j */
export type FinalShareData = {
	id: string;
	idNum: bigint;
	finalShare: bigint; // S_j = sum_i(P_i(j))
};

/** Represents a revealed share ready for reconstruction */
export type RevealedShare = {
	idNum: bigint;
	share: Uint8Array; // The raw bytes of the finalShare
};
