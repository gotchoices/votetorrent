/**
 * Native cadre-core strand-formation transport.
 *
 * Mirrors the non-deprecated `seed-bootstrap.ts` protocol service: a dedicated
 * libp2p protocol id, length-prefixed JSON frames, and small single-purpose
 * session helpers. It replaces the deprecated `@serfab/strand-proto` transport,
 * carrying the caller's REAL invitation token + disclosure and BOTH parties'
 * real cadre peer addresses end-to-end (no `{ partyId: sessionId }` / `cadre-*.local`
 * placeholders), and validating the responder's result on the initiator side.
 *
 * Provisioning flow (`responderCreates`, 2 messages): the responder provisions (or, for
 * provision-then-record, resolves + records consent against) the strand and returns the
 * result on approval.
 *
 * Cadre-disclosure timing (see docs/strand-proto.md "Security & Privacy"): the
 * responder reveals its own party id + cadre addresses — and, for a closed strand
 * returned via provision-then-record, that strand's membership key — ONLY after the
 * token and disclosure validate; a rejection discloses none of them.
 */
import type { Libp2p } from '@libp2p/interface';
import type { StrandFormationDisclosure } from './types.js';
/** Protocol id for the native formation transport (parallel to `/sereus/seed/1.0.0`). */
export declare const FORMATION_PROTOCOL = "/sereus/formation/1.0.0";
export type FormationParty = 'initiator' | 'responder';
export interface FormationStrandInfo {
    strandId: string;
    createdBy: FormationParty;
}
export interface FormationDbConnectionInfo {
    endpoint: string;
    credentialsRef: string;
}
export interface FormationProvisionResult {
    strand: FormationStrandInfo;
    /**
     * The strand's membership key (closed-strand read-gating secret), delivered to a
     * validated invitee for provision-then-record formation. Disclosed only AFTER token
     * + disclosure validation, exactly like the responder identity/cadre — a rejected or
     * already-used token discloses neither identity nor key. Absent for open strands.
     */
    memberPrivateKey?: string;
    dbConnectionInfo: FormationDbConnectionInfo;
}
/**
 * Outcome of the responder's provisioning hook.
 *
 * Distinct from a bare {@link FormationProvisionResult} so the hook can REJECT a
 * formation AFTER token + disclosure validation — e.g. a bound invite naming a host
 * strand this responder has not yet converged on, or a concurrent-redemption collision.
 * Without this channel such cases threw inside provisioning, the stream closed with no
 * result frame, and the initiator saw a read-error/timeout instead of a clean
 * `approved: false`. A rejection still discloses NO responder identity/cadre.
 */
export type ResponderProvisionOutcome = {
    approved: true;
    result: FormationProvisionResult;
} | {
    approved: false;
    reason: string;
};
/** Initiator → Responder: carries the real token + disclosure + initiator cadre. */
export interface FormationContactMessage {
    /** The real invitation token. */
    token: string;
    /** Initiator's member key (peer id). */
    partyId: string;
    /** The real disclosure, carried verbatim. */
    disclosure: StrandFormationDisclosure;
    /** Initiator's real multiaddrs. */
    cadrePeerAddrs: string[];
}
/** Responder → Initiator: responder identity/cadre disclosed only after validation. */
export interface FormationResultMessage {
    approved: boolean;
    /** Present iff `approved === false`. */
    reason?: string;
    /** Responder's real party id (disclosed only after validation). */
    partyId?: string;
    /** Responder's real multiaddrs (omitted on rejection). */
    cadrePeerAddrs?: string[];
    /** The provisioned strand/db result (always present on approval). */
    provisionResult?: FormationProvisionResult;
}
/**
 * Structural check on a `responderCreates` result: the responder must have approved,
 * disclosed a non-empty real identity + cadre (not the deprecated `cadre-*.local`
 * placeholders), and returned a strand vouched for by the responder party with a real id.
 *
 * `createdBy: 'responder'` means "the responder party vouches for / returns this strand."
 * Under provision-then-record that strand was minted authority-signed earlier (not created
 * in-session), but it is still the responder party returning its own strand, so the marker
 * — and this structural validator — stay unchanged.
 *
 * The behavioral floor for the initiator: a responder that returns an arbitrary/empty
 * `strandId` or omits its disclosed identity is rejected, not silently accepted.
 */
export declare function isValidResponderCreatesResult(response: FormationResultMessage): boolean;
export interface FormationListenerOptions {
    /** Validate the invitation token; returns whether it is valid. */
    validateToken(token: string): Promise<{
        valid: boolean;
    }>;
    /** Validate the initiator's disclosure with the REAL token + disclosure. */
    validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
    /**
     * Provision (or, for provision-then-record, resolve + record consent against) the
     * strand (`responderCreates`) for the given initiator. The REAL token is threaded
     * in so the hook can map it to the bound host strand and its membership key.
     *
     * Returns a {@link ResponderProvisionOutcome}: the hook may REJECT post-validation
     * (e.g. an unconverged host strand) and the listener turns that into a clean,
     * non-disclosing `approved: false` reply rather than dropping the result frame.
     */
    provisionStrand(token: string, initiatorPartyId: string, disclosure: StrandFormationDisclosure): Promise<ResponderProvisionOutcome>;
    /** Responder identity, disclosed only AFTER token + disclosure validation passes. */
    getResponderIdentity(): {
        partyId: string;
        cadrePeerAddrs: string[];
    };
    sessionTimeoutMs?: number;
    stepTimeoutMs?: number;
    maxConcurrentSessions?: number;
}
/**
 * Responder side of the native formation protocol. Registers a libp2p handler and
 * drives each inbound stream through token + disclosure validation, provisioning,
 * and result delivery — enforcing the cadre-disclosure timing rule (responder cadre
 * is revealed only after validation; rejections disclose nothing).
 */
export declare class FormationListener {
    private readonly options;
    private readonly sessionTimeoutMs;
    private readonly stepTimeoutMs;
    private readonly maxConcurrentSessions;
    private readonly registered;
    private activeSessions;
    private sessionCounter;
    constructor(options: FormationListenerOptions);
    /** Number of in-flight inbound sessions. */
    get activeCount(): number;
    register(node: Libp2p, protocolId?: string): void;
    unregister(node: Libp2p, protocolId?: string): void;
    private handleStream;
    private runSession;
}
export interface FormationDialOptions {
    /** The contact message to send (real token, partyId, disclosure, initiator cadre). */
    contact: FormationContactMessage;
    /** Responder multiaddrs to dial. */
    responderAddrs: string[];
    /** Validate the responder's result; a false return aborts the formation. */
    validateResponse(response: FormationResultMessage): Promise<boolean>;
    sessionTimeoutMs?: number;
    stepTimeoutMs?: number;
    protocolId?: string;
}
/**
 * Initiator side of the native formation protocol. Dials the responder, sends the
 * contact (carrying the real disclosure/token/cadre), validates the responder's
 * result, and returns the strand the responder provisioned.
 */
export declare function dialFormation(node: Libp2p, options: FormationDialOptions): Promise<FormationProvisionResult>;
