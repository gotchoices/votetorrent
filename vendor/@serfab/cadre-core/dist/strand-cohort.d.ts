import type { StrandMode } from './types.js';
/**
 * A single CadrePeer membership row, as returned by
 * `ControlDatabase.queryCadrePeers()`.
 */
export interface CohortPeerRow {
    peerId: string;
    /** Comma-joined list of multiaddr strings; `''` when no addrs were recorded. */
    multiaddr: string | null;
}
/**
 * Cohort-derived discovery seed for a strand's libp2p node.
 */
export interface CohortSeed {
    /** Dialable multiaddr strings for cohort peers other than self (deduplicated). */
    bootstrapNodes: string[];
    /** True when at least one CadrePeer row other than self exists (even if it has no dialable addr). */
    hasOtherPeers: boolean;
}
/**
 * Derive a strand's bootstrap seed from the control network's CadrePeer rows.
 * Excludes `selfPeerId`, splits each comma-joined `Multiaddr` field, and drops
 * empty fragments. `hasOtherPeers` reflects membership presence, NOT dialability,
 * so a cohort whose addrs are not yet known still selects `networked` mode.
 */
export declare function deriveCohortSeed(peers: CohortPeerRow[], selfPeerId: string | undefined): CohortSeed;
/**
 * Choose the strand mode. An explicit mode (from `addStrand`) always wins. When
 * omitted (the `handleStrandAdded` discovery path, or an `addStrand` caller that
 * leaves it unset), infer: `bootstrap` for a solo/first node (no other peers),
 * `networked` once the cohort has other members.
 */
export declare function selectStrandMode(explicitMode: StrandMode | undefined, hasOtherPeers: boolean): StrandMode;
