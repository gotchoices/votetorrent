import type { DKGTerms, KeyholderCommitments, EncryptedShare, FinalShareData, RevealedShare } from './internal-types.js';

/** State specific to a single participant, posted by them. */
export interface ParticipantContributionState {
    termsHash: string; // Hash of the DKGTerms this state corresponds to
    participantId: string;
    commitments?: KeyholderCommitments; // Posted in phase 1
    distributedShares?: EncryptedShare[]; // Posted in phase 2 (shares *from* this participant)
}

/** State reflecting the verification outcome *for* a participant. */
export interface ParticipantVerificationState {
    termsHash: string; // Hash of the DKGTerms
    participantId: string;
    verified: boolean | undefined; // Result of Phase 3 verification
    reason?: string; // Optional reason if verified == false
}

/** State common to the whole DKG process. */
export interface CommonDKGState {
    termsHash: string; // Hash of the DKGTerms
    // Phase 4 output
    compositePublicKey: Uint8Array | null;
    // Shares revealed for decryption (post-DKG)
    // Map keyholderId -> RevealedShare
    revealedSharesForDecryption: Record<string, RevealedShare>;
}

/** Represents a read-only view of the entire DKG state, assembled from parts. */
export interface DKGStateView {
    terms: Readonly<DKGTerms>;
    termsHash: string;
    participantContributions: Readonly<Record<string, Readonly<ParticipantContributionState>>>;
    participantVerifications: Readonly<Record<string, Readonly<ParticipantVerificationState>>>;
    commonState: Readonly<CommonDKGState>;
}

/** Helper to initialize participant state */
export function initParticipantContributionState(termsHash: string, participantId: string): ParticipantContributionState {
    return { termsHash, participantId };
}

/** Helper to initialize participant verification state */
export function initParticipantVerificationState(termsHash: string, participantId: string): ParticipantVerificationState {
    // Default to undefined until explicitly set to true or false during verification
    // @ts-ignore // Allow undefined initially, although the type might expect boolean
    return { termsHash, participantId, verified: undefined };
}

/** Helper to initialize common state */
export function initCommonDKGState(termsHash: string): CommonDKGState {
    return {
        termsHash,
        compositePublicKey: null,
        revealedSharesForDecryption: {}
    };
}
