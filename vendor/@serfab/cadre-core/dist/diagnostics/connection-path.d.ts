/**
 * connection-path.ts — classify each open libp2p connection as relayed
 * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
 * "stuck on relay" condition.
 *
 * This is the **canonical** implementation. The web reference app keeps a
 * deliberate, documented duplicate at
 * `packages/reference-app-web/src/lib/connection-path.ts` (it does not depend on
 * `@serfab/cadre-core`). Keep the function signatures and classification table
 * identical across both copies so a future shared micro-package would be a
 * drop-in.
 *
 * The whole signal is a pure function over `node.getConnections()` + a settle
 * window + `Date.now()`. A connection's path is derivable from its `remoteAddr`
 * multiaddr string alone — no I/O, no events, no stateful observer.
 */
export type ConnectionPathKind = 'relayed' | 'direct';
export type ConnectionTransport = 'circuit-relay' | 'webrtc' | 'webrtc-direct' | 'websocket' | 'tcp' | 'unknown';
export interface ConnectionPath {
    /** remotePeer.toString() */
    peerId: string;
    remoteAddr: string;
    kind: ConnectionPathKind;
    transport: ConnectionTransport;
    direction: 'inbound' | 'outbound';
    /** connection.timeline.open ?? null */
    openedAtMs: number | null;
    /** now - openedAtMs */
    ageMs: number | null;
    /** relayed && age > settleWindow && no direct conn to same peer */
    stuckOnRelay: boolean;
}
export interface ConnectionPathSummary {
    total: number;
    relayed: number;
    direct: number;
    stuckOnRelay: number;
    byTransport: Record<ConnectionTransport, number>;
    /** best-effort; null when libp2p exposes no byte counter (see classifier docs) */
    bytesOverRelay: number | null;
    paths: ConnectionPath[];
    settleWindowMs: number;
}
/**
 * The minimal connection shape the classifier needs. The stock libp2p
 * `Connection` (from `@libp2p/interface`) satisfies this structurally, and
 * tests can build small synthetic objects against it.
 */
export interface ConnectionLike {
    remotePeer?: {
        toString(): string;
    };
    remoteAddr?: {
        toString(): string;
    };
    direction?: 'inbound' | 'outbound';
    timeline?: {
        open?: number;
    };
}
export declare const DEFAULT_SETTLE_WINDOW_MS = 10000;
interface TransportClass {
    kind: ConnectionPathKind;
    transport: ConnectionTransport;
}
/**
 * Classify a remote multiaddr string into a (kind, transport) pair. Order
 * matters — first match wins:
 *
 * | multiaddr contains            | kind    | transport      |
 * |-------------------------------|---------|----------------|
 * | `/webrtc-direct`              | direct  | webrtc-direct  |
 * | `/webrtc`                     | direct  | webrtc         |
 * | `/p2p-circuit` (no webrtc)    | relayed | circuit-relay  |
 * | `/ws` (or `/wss`)             | direct  | websocket      |
 * | `/tcp` (and none of the above)| direct  | tcp            |
 * | _none_                        | direct  | unknown        |
 *
 * Note the ordering: a browser-to-browser WebRTC connection is dialed *over* a
 * relay for SDP signalling and js-libp2p keeps the circuit prefix in the
 * connection's remoteAddr — a successful hole-punch reads as
 * `…/p2p-circuit/webrtc/p2p/…`, i.e. it contains BOTH `/p2p-circuit` and
 * `/webrtc`. Its data path is nevertheless **direct**, so the WebRTC checks
 * must come *before* `/p2p-circuit`. Only a connection with no transport after
 * `/p2p-circuit` (`…/p2p-circuit/p2p/…`) is genuinely relay-carried.
 */
export declare function classifyTransport(remoteAddr: string): TransportClass;
/** Pure per-connection classifier over the connection's remoteAddr. */
export declare function classifyConnectionPath(conn: ConnectionLike): TransportClass;
/** An all-zero summary, used when no node/connections are available. */
export declare function emptyConnectionPathSummary(settleWindowMs?: number): ConnectionPathSummary;
/**
 * Build a {@link ConnectionPathSummary} from the node's current connections.
 *
 * `stuckOnRelay` per connection is `relayed && ageMs != null && ageMs >
 * settleWindowMs && no direct connection to the same peer` — the relay-only
 * silent-failure condition (WebRTC negotiation failed, the connection quietly
 * stays on the relay). The direct-peer set is the set of `peerId`s that have at
 * least one `direct` connection, so a peer mid-upgrade (a relayed circuit conn
 * *and* a direct webrtc conn at once) is correctly not flagged.
 */
export declare function summarizeConnectionPaths(conns: Iterable<ConnectionLike> | null | undefined, settleWindowMs?: number): ConnectionPathSummary;
export {};
