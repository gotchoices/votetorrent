/**
 * Adapter that provides Arachnode-specific methods on top of FRET's generic metadata.
 *
 * FRET remains a pure DHT, while this adapter layers Arachnode semantics.
 */
export class ArachnodeFretAdapter {
    fret;
    static ARACHNODE_KEY = 'arachnode';
    constructor(fret) {
        this.fret = fret;
    }
    /**
     * Set this node's Arachnode ring membership.
     */
    setArachnodeInfo(info) {
        this.fret.setMetadata({
            [ArachnodeFretAdapter.ARACHNODE_KEY]: info
        });
    }
    /**
     * Get Arachnode info for a specific peer.
     */
    getArachnodeInfo(peerId) {
        const metadata = this.fret.getMetadata(peerId);
        return metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY];
    }
    /**
     * Get my own Arachnode info.
     */
    getMyArachnodeInfo() {
        const myPeerId = this.fret.node?.peerId?.toString();
        if (!myPeerId)
            return undefined;
        return this.getArachnodeInfo(myPeerId);
    }
    /**
     * Find all peers at a specific ring depth.
     */
    findPeersAtRing(ringDepth) {
        const peers = this.fret.listPeers();
        return peers
            .filter(peer => {
            const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY];
            return arachnode?.ringDepth === ringDepth;
        })
            .map(peer => peer.id);
    }
    /**
     * Find all known storage rings (unique ring depths).
     */
    getKnownRings() {
        const peers = this.fret.listPeers();
        const rings = new Set();
        for (const peer of peers) {
            const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY];
            if (arachnode?.ringDepth !== undefined) {
                rings.add(arachnode.ringDepth);
            }
        }
        return Array.from(rings).sort((a, b) => a - b);
    }
    /**
     * Get statistics about discovered rings.
     */
    getRingStats() {
        const peers = this.fret.listPeers();
        const ringMap = new Map();
        for (const peer of peers) {
            const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY];
            if (arachnode) {
                const existing = ringMap.get(arachnode.ringDepth) ?? { count: 0, totalCapacity: 0 };
                ringMap.set(arachnode.ringDepth, {
                    count: existing.count + 1,
                    totalCapacity: existing.totalCapacity + arachnode.capacity.available
                });
            }
        }
        return Array.from(ringMap.entries())
            .map(([ringDepth, stats]) => ({
            ringDepth,
            peerCount: stats.count,
            avgCapacity: stats.totalCapacity / stats.count
        }))
            .sort((a, b) => a.ringDepth - b.ringDepth);
    }
    /**
     * Update the status field of this node's ArachnodeInfo.
     * No-op if no ArachnodeInfo has been set yet.
     */
    setStatus(status) {
        const current = this.getMyArachnodeInfo();
        if (current) {
            this.setArachnodeInfo({ ...current, status });
        }
    }
    /**
     * Access the underlying FRET service.
     */
    getFret() {
        return this.fret;
    }
}
//# sourceMappingURL=arachnode-fret-adapter.js.map