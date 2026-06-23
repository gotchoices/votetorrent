import type { PeerId } from '@libp2p/interface';
export type KnownPeer = {
    id: PeerId;
    addrs: string[];
};
export type ResponsibilityResult = {
    inCluster: boolean;
    nearest: KnownPeer[];
};
export declare function xorDistanceBytes(a: Uint8Array, b: Uint8Array): Uint8Array;
export declare function lessThanLex(a: Uint8Array, b: Uint8Array): boolean;
export declare function sortPeersByDistance(peers: KnownPeer[], key: Uint8Array): KnownPeer[];
export declare function computeResponsibility(key: Uint8Array, self: KnownPeer, others: KnownPeer[], k: number): ResponsibilityResult;
//# sourceMappingURL=responsibility.d.ts.map