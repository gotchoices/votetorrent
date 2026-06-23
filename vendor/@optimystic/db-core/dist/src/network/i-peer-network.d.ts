import type { AbortOptions, PeerId, Stream } from "./types.js";
export type IPeerNetwork = {
    /**
     * Dial a peer and establish a protocol stream
     */
    connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;
};
//# sourceMappingURL=i-peer-network.d.ts.map