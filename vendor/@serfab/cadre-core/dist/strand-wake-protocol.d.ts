/**
 * Control-network push-wake transport.
 *
 * Lets a same-cadre peer — typically an always-on server that participates in a
 * strand and sees new activity — signal a hibernating cadre peer to bring that
 * strand online, pull pending activity, and re-hibernate. Push-wake travels the
 * **control network** (the per-party network connecting this party's own cadre
 * nodes), which is the only network a hibernating peer keeps connected.
 *
 * Modeled directly on `seed-bootstrap.ts`: a dedicated libp2p protocol id,
 * 4-byte big-endian length-prefixed JSON frames, `node.handle` for the receiver,
 * `node.dialProtocol` for the sender, and the same minimal `LibP2PStream` shim.
 * The exchange is a single request → single ack on one stream (like seed
 * delivery), so each side reads to EOF and decodes one frame via the shared
 * {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** the control network already restricts membership —
 * only this party's cadre peers connect (schema-gated `CadrePeer`). A wake is
 * low-risk: it only causes the receiver to spend resources coming online for a
 * strand it already participates in. So the receiver verifies the remote peer is
 * a `CadrePeer` member (via the injected `isMember` gate) and requires no
 * signature beyond control-network membership. A richer per-request signature is
 * deliberately out of scope for v1.
 */
import type { Libp2p } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { StrandInstance, WakeRequest, WakeAck } from './types.js';
/** Protocol id for control-network push-wake (parallel to `/sereus/seed/1.0.0`). */
export declare const WAKE_PROTOCOL = "/sereus/strand-wake/1.0.0";
/**
 * Dependencies the {@link StrandWakeService} receiver needs from its host
 * (`CadreNode`), injected so the service is testable without a full node.
 */
export interface StrandWakeServiceOptions {
    /** Membership gate: is the remote peer a `CadrePeer` member of this cadre? */
    isMember(remotePeerId: string): Promise<boolean>;
    /** Look up a local strand instance by id (undefined if not participated in). */
    getStrand(strandId: string): StrandInstance | undefined;
    /**
     * Trigger the local wake path for a hibernating/idle strand. Wired to
     * `CadreNode.wakeStrand` (→ `HibernationManager` → `resumeStrand`), whose
     * resume coalescing prevents a push-wake racing a concurrent check-in.
     */
    wake(strandId: string): Promise<void>;
}
/**
 * Receiver side of the push-wake protocol. Registers a `WAKE_PROTOCOL` handler
 * on the control node and, for each inbound {@link WakeRequest}, gates on cadre
 * membership, then resumes the named strand if it is hibernating/idle and we
 * participate in it — replying with a {@link WakeAck}.
 */
export declare class StrandWakeService {
    private readonly options;
    private node;
    constructor(options: StrandWakeServiceOptions);
    /** Register the wake protocol handler on the control node. */
    initialize(node: Libp2p): void;
    /** Unregister the handler and release the node reference. */
    shutdown(): Promise<void>;
    /**
     * Read the inbound request, decide + execute the wake, and write the ack. A
     * malformed/oversized frame (or any handler error) is reported as a
     * non-accepting ack rather than a dropped stream.
     */
    private handleStream;
    /**
     * Decide and execute the wake for a decoded request. Exposed (not private) so
     * the decision matrix can be unit-tested directly.
     *
     * - Non-member sender → rejected (`accepted: false`).
     * - Unknown / not-participated strand → rejected.
     * - Hibernating or idle strand → resumed via the wake path, then `accepted`.
     * - Already-live strand → no-op, `accepted` with current status.
     */
    processWakeRequest(request: WakeRequest, remotePeerId: string): Promise<WakeAck>;
}
/** Options for {@link dialWake}. */
export interface DialWakeOptions {
    /** Per-dial timeout in ms (default {@link DEFAULT_WAKE_TIMEOUT_MS}). */
    timeoutMs?: number;
    /** Override the protocol id (defaults to {@link WAKE_PROTOCOL}). */
    protocolId?: string;
}
/**
 * Sender side: dial a target's control-network address(es), send a
 * {@link WakeRequest} over `WAKE_PROTOCOL`, and return the peer's {@link WakeAck}.
 *
 * Tries each candidate address in order (signaling/relay first, as produced by
 * `CadreNode.resolvePeerAddrs`) until one dials, so a NAT'd peer is reachable via
 * its circuit-relay address. Throws if no address is dialable.
 */
export declare function dialWake(node: Libp2p, addrs: Multiaddr[], request: WakeRequest, options?: DialWakeOptions): Promise<WakeAck>;
