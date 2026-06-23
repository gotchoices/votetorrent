import type { Libp2p } from '@libp2p/interface';
import type { OpenInvitation, FormStrandResult, ValidateFormationResult, StrandFormationDisclosure } from './types.js';
import { type StrandFormationManagerConfig } from './strand-formation-manager.js';
import { type FormationResultMessage } from './strand-formation-protocol.js';
/**
 * Interface for validating formation disclosures
 */
export interface DisclosureValidator {
    /**
     * Validate the disclosure provided by an initiator
     * @param token The invitation token
     * @param disclosure The disclosure object from the initiator
     * @returns Whether the disclosure is acceptable
     */
    validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
}
/**
 * Discriminated result of resolving the host strand an invite binds to (responder side):
 *
 * - `unbound`: the invite carries no `StrandId` → the responder-provisions path (provision
 *   a NEW strand; legacy/open).
 * - `bound`: the invite names a host strand AND that strand row is present on this responder
 *   → provision-then-record (record consent against it, return it + its membership key).
 * - `missing`: the invite names a host strand but the row is ABSENT on this responder (e.g.
 *   not yet converged) → the manager rejects cleanly rather than recording usage against a
 *   non-existent strand, which would fail the deferred `FormationUsage.StrandExists` CHECK at
 *   commit and drop the result frame.
 *
 * Replaces the older `{ strandId, memberPrivateKey } | null` shape, which conflated `bound`
 * and `missing` (both produced a non-null result whenever the invite had a `StrandId`).
 */
export type ResolvedHostStrand = {
    kind: 'unbound';
} | {
    kind: 'bound';
    strandId: string;
    memberPrivateKey: string | null;
} | {
    kind: 'missing';
    strandId: string;
};
/**
 * Interface for recording formation usage
 */
export interface FormationUsageRecorder {
    /**
     * Record that a formation invite was used
     */
    recordUsage(token: string, initiatorKey: string, strandId: string): Promise<void>;
    /**
     * Check if a token has already been used (for single-use invites)
     */
    isTokenUsed(token: string): Promise<boolean>;
    /**
     * Check if a token is valid and not expired
     */
    isTokenValid(token: string): Promise<{
        valid: boolean;
        invitation?: OpenInvitation;
    }>;
    /**
     * Resolve the host strand an invite binds to, classifying it as unbound / bound /
     * missing (see {@link ResolvedHostStrand}). Optional: a recorder that does not bind
     * strands omits it, and {@link StrandFormationManager} treats every invite as `unbound`
     * and falls back to its provisioner. Keeping resolution behind this interface keeps the
     * manager DB-agnostic and unit-testable with an in-memory fake.
     */
    resolveStrand?(token: string): Promise<ResolvedHostStrand>;
    /**
     * Provision a NEW strand for an UNBOUND invite and record consent against it
     * ATOMICALLY (single `FormationUsage` row → single-use enforced on the next redemption).
     * Optional: a recorder that only supports provision-then-record omits it, and the
     * manager falls back to its {@link StrandProvisioner}. Mirrors the create-strand-by-consent
     * path the schema's `Strand.Authorized` `FormationUsage` branch authorizes. Returns the
     * minted strand id plus its membership key (null for an open responder-provisioned strand).
     */
    provisionAndRecord?(token: string, initiatorKey: string, sAppId: string): Promise<{
        strandId: string;
        memberPrivateKey: string | null;
    }>;
}
/**
 * Interface for strand provisioning during formation
 */
export interface StrandProvisioner {
    /**
     * Provision a new strand after formation is validated
     */
    provisionStrand(sAppId: string, initiatorKey: string, responderKey: string): Promise<{
        strandId: string;
    }>;
}
/**
 * Interface for signing formation approvals
 */
export interface FormationSigner {
    /**
     * Sign a formation approval
     */
    signFormation(token: string, disclosure: StrandFormationDisclosure): Promise<{
        validationKey: string;
        validationSignature: string;
    }>;
}
/**
 * Interface for validating the responder's formation result on the initiator side.
 *
 * Symmetric to {@link DisclosureValidator} (which runs responder→initiator): it lets
 * the initiator verify the responder's disclosed identity, cadre, and provisioned
 * strand against the invitation/disclosure it used to form the strand. The manager
 * owns one dialer session per `formStrand` call, so the per-session invitation +
 * disclosure context is local — no hook-signature gymnastics needed.
 */
export interface FormationResponseValidator {
    /** Validate the responder's result against the invitation/disclosure used to form the strand. */
    validateResponse(ctx: {
        invitation: OpenInvitation;
        disclosure: StrandFormationDisclosure;
        response: FormationResultMessage;
    }): Promise<boolean>;
}
/**
 * Built-in structural {@link FormationResponseValidator}.
 *
 * `validateResponse` rejects when the responder did not approve, omitted a disclosed
 * identity, returned no/placeholder cadre addresses, or returned a missing/empty or
 * non-responder-created strand (see {@link isValidResponderCreatesResult}).
 * Apps can supply a stricter validator via {@link StrandSolicitationServiceOptions}.
 */
export declare function createDefaultFormationResponseValidator(): FormationResponseValidator;
export interface StrandSolicitationServiceOptions {
    disclosureValidator?: DisclosureValidator;
    formationUsageRecorder?: FormationUsageRecorder;
    strandProvisioner?: StrandProvisioner;
    formationSigner?: FormationSigner;
    /** Validates the responder's result on the initiator side (defaults to a structural check) */
    formationResponseValidator?: FormationResponseValidator;
    /** Party ID for this node (used in protocol messages) */
    partyId?: string;
    /** Cadre peer addresses for this node */
    cadrePeerAddrs?: string[];
    /** Configuration for the formation manager */
    formationConfig?: StrandFormationManagerConfig;
}
/**
 * Strand Solicitation API for forming strands via open invitations.
 *
 * This service handles the high-level API defined in api.md:
 * - formStrand(invitation, disclosure, node) - called by initiator
 * - validateStrandFormation(token, disclosure) - called by responder
 *
 * When a libp2p node is provided, the underlying protocol is handled by the
 * native cadre-core formation transport via StrandFormationManager.
 */
export declare class StrandSolicitationService {
    private readonly disclosureValidator?;
    private readonly formationUsageRecorder?;
    private readonly strandProvisioner?;
    private readonly formationSigner?;
    private readonly formationResponseValidator?;
    private readonly partyId;
    private readonly cadrePeerAddrs;
    private formationManager?;
    private readonly formationConfig?;
    constructor(options?: StrandSolicitationServiceOptions);
    /**
     * Get or create the StrandFormationManager.
     * Lazily initialized to allow configuration after construction.
     */
    private getFormationManager;
    /**
     * Register as a responder on a libp2p node.
     * This enables the node to handle incoming strand formation requests.
     */
    registerResponder(node: Libp2p): void;
    /**
     * Unregister as a responder from a libp2p node.
     */
    unregisterResponder(node: Libp2p): void;
    /**
     * Form a strand with a responder via an open invitation.
     *
     * Called by the initiator (the party who received an out-of-band invitation).
     * This generates a member key, contacts the responder's cadre, and negotiates
     * strand formation.
     *
     * @param invitation The open invitation (or just token for legacy API)
     * @param disclosure Identity/context information to share with the responder
     * @param node Optional libp2p node for real protocol handling
     * @returns The member key and strand info if successful
     */
    formStrand(invitation: OpenInvitation | string, disclosure: StrandFormationDisclosure, node?: Libp2p): Promise<FormStrandResult>;
    /**
     * Validate a strand formation request.
     *
     * Called by the responder (the party who created the open invitation) when
     * an initiator contacts them to form a strand. Validates the disclosure
     * and returns a signed approval.
     *
     * @param token The invitation token being used
     * @param disclosure The disclosure from the initiator
     * @returns Validation key and signature if approved
     * @throws If validation fails or token is invalid
     */
    validateStrandFormation(token: string, disclosure: StrandFormationDisclosure): Promise<ValidateFormationResult>;
    /**
     * Create an open invitation for others to form strands with this party.
     *
     * @param sAppId The sApp to use for formed strands
     * @param expirationMs How long the invitation is valid (ms from now)
     * @param bootstrap Bootstrap addresses for contacting this party's cadre
     * @returns The open invitation to share out-of-band
     */
    createOpenInvitation(sAppId: string, expirationMs: number, bootstrap: string[]): Promise<OpenInvitation>;
    /**
     * Record that a formation was completed successfully.
     * Called after strand provisioning to track usage.
     */
    recordFormationComplete(token: string, initiatorKey: string, strandId: string): Promise<void>;
}
