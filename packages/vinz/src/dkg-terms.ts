// packages/proofs/src/dkg-terms.ts
import { TextEncoder } from 'util'; // Use standard TextEncoder
import { hashBytes } from './helpers.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'; // For encoding

/** Defines the immutable parameters for a DKG instance. */
export interface DKGTerms {
	threshold: number;
	participantIds: string[]; // Sorted list recommended for consistent hashing
}

/** Terms sealed by a hash - a DKGDeal is immutable */
export interface DKGDeal {
	readonly terms: Readonly<DKGTerms>;
	readonly termsHash: string;
}

/** Creates a deterministic hash for the DKG terms. */
export async function calculateTermsHash(terms: DKGTerms): Promise<string> {
	// Encode numbers as fixed-size Uint32 (4 bytes, Big Endian)
	const numBuffer = new ArrayBuffer(8); // 4 bytes for n, 4 for threshold
	const numView = new DataView(numBuffer);
	numView.setUint32(0, terms.participantIds.length, false); // Offset 0, value n, Big Endian
	numView.setUint32(4, terms.threshold, false); // Offset 4, value threshold, Big Endian
	const nBytes = new Uint8Array(numBuffer, 0, 4);
	const tBytes = new Uint8Array(numBuffer, 4, 4);

	// Encode IDs string using TextEncoder
	const idsBytes = new TextEncoder().encode(terms.participantIds.join('|'));

	const hash = await hashBytes(nBytes, tBytes, idsBytes);
	// Convert hash bytes to base64url string using uint8arrays
	return uint8ArrayToString(hash, 'base64url');
}

/** Helper to generate n participants and return a DKGDeal */
export async function genDKGTerms(n: number, threshold: number): Promise<DKGDeal> {
	// How many characters to pad each ID with
	const padding = n.toString().length;
	// Pad each ID with the appropriate number of zeros
	const participantIds = Array.from({ length: n }, (_, i) => i.toString().padStart(padding, '0'));
	return createDKGTerms(threshold, participantIds);
}

/** Helper to create terms object and calculate its hash, returning a deal */
export async function createDKGTerms(threshold: number, proposedIds: string[]): Promise<DKGDeal> {
	// Ensure participants are unique and sorted during creation
	const participantIds = [...new Set(proposedIds)].sort();
	if (participantIds.length === 0) {
		throw new Error("Must be at least one participant");
	}
	// Ensure threshold is valid
	if (threshold > participantIds.length || threshold < 1) {
		throw new Error("Invalid threshold: must be 1 <= threshold <= n");
	}
	const terms: DKGTerms = { threshold, participantIds };
	const termsHash = await calculateTermsHash(terms);
	// Return the combined deal object
	return { terms, termsHash };
}
