// packages/proofs/src/dkg-terms.ts
import { Buffer } from 'buffer'; // Need Buffer for string conversion
import { hashBytes } from './helpers.js';

/** Defines the immutable parameters for a DKG instance. */
export interface DKGTerms {
    n: number;
    threshold: number;
    participantIds: string[]; // Sorted list recommended for consistent hashing
}

/** Creates a deterministic hash for the DKG terms. */
export async function calculateTermsHash(terms: DKGTerms): Promise<string> {
    // Ensure participantIds are sorted for consistent hashing
    const sortedIds = [...terms.participantIds].sort();
    const nBytes = Buffer.from(terms.n.toString(16).padStart(8, '0'), 'hex'); // Simple encoding
    const tBytes = Buffer.from(terms.threshold.toString(16).padStart(8, '0'), 'hex');
    const idsBytes = Buffer.from(sortedIds.join('|'), 'utf8'); // Simple encoding

    const hash = await hashBytes(nBytes, tBytes, idsBytes);
    return Buffer.from(hash).toString('hex');
}

/** Helper to create terms and calculate hash */
export async function createDKGTerms(n: number, threshold: number): Promise<{ terms: DKGTerms, termsHash: string }> {
     if (threshold > n || threshold < 1) {
        throw new Error("Invalid threshold: must be 1 <= threshold <= n");
    }
    const participantIds = Array.from({ length: n }, (_, i) => `keyholder-${i + 1}`);
    // Ensure sorted during creation
    participantIds.sort();
    const terms: DKGTerms = { n, threshold, participantIds };
    const termsHash = await calculateTermsHash(terms);
    return { terms, termsHash };
}