export function buildKnownPeers(libp2p) {
    const self = {
        id: libp2p.peerId,
        addrs: libp2p.getMultiaddrs().map(ma => ma.toString())
    };
    const connections = libp2p.getConnections();
    const byPeer = {};
    for (const c of connections) {
        const pid = c.remotePeer;
        const key = pid.toString();
        const entry = byPeer[key] ?? (byPeer[key] = { id: pid, addrs: new Set() });
        const addrStr = c.remoteAddr?.toString?.();
        if (addrStr)
            entry.addrs.add(addrStr);
    }
    const others = Object.values(byPeer).map(e => ({ id: e.id, addrs: Array.from(e.addrs) }));
    return [self, ...others];
}
//# sourceMappingURL=libp2p-known-peers.js.map