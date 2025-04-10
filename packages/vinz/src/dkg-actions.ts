import type { KeyholderCommitments, EncryptedShare, FinalShareData, RevealedShare } from './internal-types.js';

export enum DKGActionType {
    PostCommitments = 'PC',
    PostShares = 'PS',
    VerifyShares = 'VS',
    // Global actions (potentially triggered by any node observing state)
    CalculatePublicKey = 'CK',
    // Post-DKG action
    RevealShare = 'RS',
    // No action needed
    NoAction = 'NA',
}

// --- Action Payloads (Results of Keyholder computations) ---

export interface PostCommitmentsPayload {
    commitments: KeyholderCommitments;
}

export interface PostSharesPayload {
    shares: EncryptedShare[]; // Shares *from* this participant
}

export interface VerifySharesPayload {
    // Contains the outcome of the verification by this participant
    verified: boolean;
    reason?: string;
}

export interface RevealSharePayload {
    // Contains the final share this participant is revealing
    finalShareData: FinalShareData;
}

// --- Update Payloads (Represent the mutation to apply to shared state) ---

export interface CommitmentsUpdate {
    type: DKGActionType.PostCommitments;
    participantId: string;
    payload: PostCommitmentsPayload;
}

export interface SharesUpdate {
    type: DKGActionType.PostShares;
    participantId: string;
    payload: PostSharesPayload;
}

export interface VerificationUpdate {
    type: DKGActionType.VerifyShares;
    participantId: string;
    payload: VerifySharesPayload;
}

export interface RevealShareUpdate {
     type: DKGActionType.RevealShare;
     participantId: string;
     payload: RevealSharePayload;
}

// --- Action Determination Result ---

// What the keyholder logic determines needs to happen next
export type DeterminedAction =
    | { type: DKGActionType.PostCommitments }
    | { type: DKGActionType.PostShares }
    | { type: DKGActionType.VerifyShares }
    // Revealing shares is triggered externally based on need, not state progression
    // Calculate Public Key is a global action based on state, not per-keyholder decision
    | { type: DKGActionType.NoAction; reason?: string };
