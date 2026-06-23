import type { CreatePeerResult, MemberRegistration, MemberRegistrationResult } from './types.js';
/**
 * Interface for verifying member signatures for strand joining
 */
export interface MemberVerifier {
    /**
     * Verify that the signature is valid for the given member registration
     * @param registration The member registration data
     * @param signature The signature to verify
     * @returns true if signature is valid
     */
    verifyMember(registration: MemberRegistration, signature: string): Promise<boolean>;
    /**
     * Check if the member key is authorized to join the strand
     * (e.g., was invited via FormationInvite)
     */
    isAuthorizedToJoin(strandId: string, memberKey: string): Promise<boolean>;
}
/**
 * Interface for registering members in a strand
 */
export interface MemberRegistry {
    /**
     * Register a member in the strand's member list
     */
    registerMember(strandId: string, memberKey: string, peerIds: string[]): Promise<void>;
    /**
     * Check if a member is already registered in the strand
     */
    isMemberRegistered(strandId: string, memberKey: string): Promise<boolean>;
}
/**
 * Enrollment API for creating peer identities and managing strand membership
 *
 * Peer Creation:
 *   `createCadrePeer()` generates an Ed25519 keypair for a new node.
 *   For cadre peer authorization, use the Seed Bootstrap API instead.
 *
 * Member Registration:
 *   Accept invitations to join strands as a member.
 */
export declare class EnrollmentService {
    private readonly memberVerifier?;
    private readonly memberRegistry?;
    constructor(options?: {
        memberVerifier?: MemberVerifier;
        memberRegistry?: MemberRegistry;
    });
    /**
     * Create a new cadre peer identity
     *
     * Generates a new Ed25519 keypair for a cadre node.
     * The private key should be stored securely by the node.
     * The PeerId can be used with the Seed Bootstrap API for authorization.
     */
    createCadrePeer(): Promise<CreatePeerResult>;
    /**
     * Register a member into a strand.
     *
     * Called by an invited party to accept an invitation and join as a member.
     * The signature proves ownership of the member key.
     *
     * @param registration The member registration data (strandId, key, peerIds)
     * @param signature Signature over the registration proving key ownership
     * @returns Success/failure with optional reason
     */
    registerMember(registration: MemberRegistration, signature: string): Promise<MemberRegistrationResult>;
    /**
     * Validate a member registration without actually registering
     * Useful for pre-flight checks
     */
    validateMemberRegistration(registration: MemberRegistration, signature: string): Promise<{
        valid: boolean;
        reason?: string;
    }>;
}
