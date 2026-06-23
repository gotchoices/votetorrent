import type { Libp2p } from '@libp2p/interface';
import type { OpenInvitation, FormStrandResult, StrandFormationDisclosure } from './types.js';
import type { DisclosureValidator, FormationUsageRecorder, StrandProvisioner, FormationResponseValidator } from './strand-solicitation.js';
/**
 * Configuration for StrandFormationManager
 */
export interface StrandFormationManagerConfig {
    /** Session timeout in milliseconds */
    sessionTimeoutMs?: number;
    /** Step timeout in milliseconds */
    stepTimeoutMs?: number;
    /** Maximum concurrent sessions */
    maxConcurrentSessions?: number;
    /** Enable debug logging */
    enableDebugLogging?: boolean;
    /** Protocol ID override */
    protocolId?: string;
}
/**
 * Options for creating a StrandFormationManager
 */
export interface StrandFormationManagerOptions {
    /** Validates disclosures from initiators (responder side) */
    disclosureValidator?: DisclosureValidator;
    /** Records and validates token usage (responder side) */
    formationUsageRecorder?: FormationUsageRecorder;
    /** Provisions strands after validation (responder side) */
    strandProvisioner?: StrandProvisioner;
    /** Validates the responder's result (initiator side); defaults to a structural check */
    formationResponseValidator?: FormationResponseValidator;
    /** This party's ID for identification */
    partyId: string;
    /** This party's cadre peer addresses */
    cadrePeerAddrs?: string[];
    /** Configuration options */
    config?: StrandFormationManagerConfig;
}
/**
 * StrandFormationManager drives the native cadre-core formation transport
 * (`strand-formation-protocol.ts`) from cadre-core's strand-solicitation interfaces.
 *
 * Responder side: a {@link FormationListener} wires the inbound protocol to
 * {@link FormationUsageRecorder} (token), {@link DisclosureValidator} (identity),
 * and {@link StrandProvisioner} (provisioning), disclosing this party's real
 * identity + cadre only after validation.
 *
 * Initiator side: {@link formStrand} dials the responder carrying the real
 * disclosure/token/cadre, then validates the responder's result via the
 * {@link FormationResponseValidator} (or a built-in structural check).
 */
export declare class StrandFormationManager {
    private readonly disclosureValidator?;
    private readonly formationUsageRecorder?;
    private readonly strandProvisioner?;
    private readonly formationResponseValidator?;
    private readonly partyId;
    private readonly cadrePeerAddrs;
    private readonly config;
    private readonly listener;
    private readonly registeredNodes;
    private dialerSessions;
    constructor(options: StrandFormationManagerOptions);
    /**
     * Register this manager as a protocol handler on a libp2p node.
     * Call this on the control network node to handle incoming formation requests.
     */
    registerResponder(node: Libp2p, protocolId?: string): void;
    /**
     * Unregister the protocol handler from a libp2p node.
     */
    unregisterResponder(node: Libp2p, protocolId?: string): void;
    /**
     * Form a strand with a responder via an open invitation (initiator side).
     *
     * Builds a contact message carrying the real token + disclosure + this party's
     * real cadre addresses, dials the responder over the native protocol, and
     * validates the responder's result before returning.
     */
    formStrand(invitation: OpenInvitation, disclosure: StrandFormationDisclosure, node: Libp2p): Promise<FormStrandResult>;
    /**
     * Get the number of active sessions
     */
    getActiveSessionCounts(): {
        listeners: number;
        dialers: number;
    };
    private validateToken;
    private validateDisclosure;
    /**
     * Responder-side provisioning. Routes on how the invite resolves
     * ({@link ResolvedHostStrand}), and can REJECT post-validation by returning a
     * {@link ResponderProvisionOutcome} with `approved: false` — `runSession` turns that
     * into a clean, non-disclosing reply instead of a dropped result frame.
     *
     * - **bound** (host strand present): provision-then-record — write the single
     *   `FormationUsage` consent row against the pre-existing strand (record-only) and
     *   return it + its membership key (a read-gating secret disclosed only here, behind the
     *   token + disclosure validation `runSession` already enforced).
     * - **missing** (invite names a host strand absent on this responder, e.g. unconverged):
     *   reject cleanly + retryably, writing NO usage row — recording usage here would fail the
     *   deferred `StrandExists` CHECK at commit and drop the frame.
     * - **unbound** (no binding): the responder-provisions fallback — see {@link provisionUnbound}.
     *
     * Defense-in-depth: known provisioning/redeem failures (notably the concurrent
     * `(Token, UseNumber)` PK collision when two redemptions of one unbound single-use invite
     * race) are caught and mapped to a logged, retry-suggesting rejection rather than a thrown
     * insert + a silently-closed stream. The LOG-before-reject keeps this a deliberate
     * internal-error→protocol-rejection conversion (AGENTS.md: don't eat exceptions silently),
     * not control-flow-by-exception.
     */
    private provisionAsResponder;
    /**
     * Responder-provisions fallback (invite binds no host strand). Precedence:
     *
     * 1. `recorder.provisionAndRecord` present (a real DB recorder) → atomic create-strand +
     *    record-consent, so the unbound redemption is single-use just like the bound path.
     *    Returns the new strand (+ key, null for an open responder-provisioned strand).
     * 2. else `strandProvisioner` present → the legacy/mock contract: provision a bare strand,
     *    NO inline usage write (those callers record usage explicitly via
     *    `recordFormationComplete`, or assert transport invariants only). Threads the invite's
     *    REAL `sAppId`.
     * 3. else → a structural placeholder (no recorder + no provisioner ⇒ no single-use semantics
     *    exist to enforce).
     *
     * Plan tradeoff — option (a) "record usage on the fallback" over (b) "remove the fallback":
     * (a) closes the single-use hole with a targeted atomic create+record and leaves the
     * `StrandProvisioner` mock-transport tests untouched; (b) would delete the provisioner
     * surface and churn ~6 unit + ~6 integration sites for ZERO production benefit (production
     * — `cadre-web.ts` / `cadre-phone.ts` — always publishes strand-BOUND invites and treats
     * the responder-provisions placeholder as failure). The broader "should this fallback exist
     * at all?" question lives in backlog `formation-initiatorcreates-cover-or-remove`.
     */
    private provisionUnbound;
    /** Wrap a provision result as an approving {@link ResponderProvisionOutcome}. */
    private approve;
    /**
     * The invite's authoritative `sAppId` for the responder-provisions fallback, read back
     * from the recorder's `isTokenValid` invitation (the real `FormationInvite.sAppId`).
     * Empty string when no recorder is wired or the invitation omits it.
     */
    private resolveInviteSAppId;
    private validateResponse;
}
/**
 * Create a StrandFormationManager with the given options
 */
export declare function createStrandFormationManager(options: StrandFormationManagerOptions): StrandFormationManager;
