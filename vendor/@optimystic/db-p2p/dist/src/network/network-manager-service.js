import { peerIdFromString } from '@libp2p/peer-id';
import { hashKey } from 'p2p-fret';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { PenaltyReason } from '../reputation/types.js';
import { RebalanceMonitor } from '../cluster/rebalance-monitor.js';
import { SpreadOnChurnMonitor } from '../cluster/spread-on-churn.js';
export class NetworkManagerService {
    components;
    running = false;
    log;
    cfg;
    readyPromise = null;
    coordinatorCache = new Map();
    clusterCache = new Map();
    lastEstimate = null;
    reputation;
    libp2pRef;
    rebalanceMonitor;
    spreadOnChurnMonitor;
    constructor(components, init = {}) {
        this.components = components;
        this.log = components.logger.forComponent('db-p2p:network-manager');
        this.cfg = {
            clusterSize: init.clusterSize ?? 1,
            seedKeys: init.seedKeys ?? [],
            estimation: init.estimation ?? { samples: 8, kth: 5, timeoutMs: 1000, ttlMs: 60_000 },
            readiness: init.readiness ?? { minPeers: 1, maxWaitMs: 2000 },
            cacheTTLs: init.cacheTTLs ?? { coordinatorMs: 30 * 60_000, clusterMs: 5 * 60_000 },
            expectedRemotes: init.expectedRemotes ?? false,
            allowClusterDownsize: init.allowClusterDownsize ?? true,
            clusterSizeTolerance: init.clusterSizeTolerance ?? 0.5
        };
    }
    setLibp2p(libp2p) {
        this.libp2pRef = libp2p;
    }
    setReputation(reputation) {
        this.reputation = reputation;
    }
    /**
     * Initialize the rebalance monitor. Call after libp2p, FRET, and adapter are available.
     */
    initRebalanceMonitor(partitionDetector, fretAdapter, config) {
        const libp2p = this.getLibp2p();
        const fret = this.getFret();
        if (!libp2p || !fret) {
            throw new Error('Cannot init RebalanceMonitor: libp2p or FRET not available');
        }
        this.rebalanceMonitor = new RebalanceMonitor({ libp2p, fret, partitionDetector, fretAdapter }, config);
        return this.rebalanceMonitor;
    }
    getRebalanceMonitor() {
        return this.rebalanceMonitor;
    }
    /**
     * Initialize the spread-on-churn monitor. Call after libp2p, FRET are available.
     * Caller provides repo and peerNetwork (not held by NetworkManagerService directly).
     */
    initSpreadOnChurnMonitor(partitionDetector, repo, peerNetwork, clusterSize, config) {
        const libp2p = this.getLibp2p();
        const fret = this.getFret();
        if (!libp2p || !fret) {
            throw new Error('Cannot init SpreadOnChurnMonitor: libp2p or FRET not available');
        }
        this.spreadOnChurnMonitor = new SpreadOnChurnMonitor({ libp2p, fret, partitionDetector, repo, peerNetwork, clusterSize }, config);
        return this.spreadOnChurnMonitor;
    }
    getSpreadOnChurnMonitor() {
        return this.spreadOnChurnMonitor;
    }
    getLibp2p() {
        return this.libp2pRef ?? this.components.libp2p;
    }
    getFret() {
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            return undefined;
        }
        return libp2p.services?.fret;
    }
    get [Symbol.toStringTag]() { return '@libp2p/network-manager'; }
    async start() {
        if (this.running)
            return;
        this.running = true;
        // Do not call ready() here; libp2p components may not be fully set yet.
        // Consumers (e.g., CLI) should invoke ready() after node.start().
    }
    async stop() {
        if (this.rebalanceMonitor) {
            await this.rebalanceMonitor.stop();
        }
        if (this.spreadOnChurnMonitor) {
            await this.spreadOnChurnMonitor.stop();
        }
        this.running = false;
    }
    async ready() {
        if (this.readyPromise)
            return this.readyPromise;
        this.readyPromise = (async () => {
            const results = await Promise.allSettled((this.cfg.seedKeys ?? []).map(k => this.seedKey(k)));
            const failures = results.filter(r => r.status === 'rejected');
            if (failures.length > 0) {
                this.log('Failed to seed %d keys', failures.length);
            }
            await new Promise(r => setTimeout(r, 50));
        })();
        return this.readyPromise;
    }
    async seedKey(key) {
        const fret = this.getFret();
        if (!fret) {
            throw new Error('FRET service not available for seeding keys');
        }
        const coord = await hashKey(key);
        fret.getNeighbors(coord, 'both', 1);
    }
    toCacheKey(key) {
        return u8ToString(key, 'base64url');
    }
    getKnownPeers() {
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            return [];
        }
        const selfId = libp2p.peerId;
        const storePeers = libp2p.peerStore?.getPeers?.() ?? [];
        const connPeers = (libp2p.getConnections?.() ?? []).map((c) => c.remotePeer);
        const all = [...storePeers.map(p => p.id), ...connPeers];
        const uniq = all.filter((p, i) => all.findIndex(x => x.toString() === p.toString()) === i);
        return uniq.filter((pid) => pid.toString() !== selfId.toString());
    }
    getStatus() {
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 };
        }
        const peers = libp2p.peerStore?.getPeers?.() ?? [];
        const remotes = peers.filter(p => p.id.toString() !== libp2p.peerId.toString()).length;
        if (remotes === 0) {
            return { mode: this.cfg.expectedRemotes ? 'degraded' : 'alone', connections: 0 };
        }
        return { mode: 'healthy', connections: remotes };
    }
    async awaitHealthy(minRemotes, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const libp2p = this.getLibp2p();
            if (libp2p) {
                // Require actual active connections, not just peerStore knowledge
                const connections = libp2p.getConnections?.() ?? [];
                const connectedPeers = new Set(connections.map((c) => c.remotePeer.toString()));
                if (connectedPeers.size >= minRemotes) {
                    this.log('awaitHealthy: satisfied with %d connections', connectedPeers.size);
                    return true;
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        // Final check
        const libp2p = this.getLibp2p();
        if (libp2p) {
            const connections = libp2p.getConnections?.() ?? [];
            const connectedPeers = new Set(connections.map((c) => c.remotePeer.toString()));
            const satisfied = connectedPeers.size >= minRemotes;
            this.log('awaitHealthy: timeout - %d connections (needed %d)', connectedPeers.size, minRemotes);
            return satisfied;
        }
        return false;
    }
    /**
     * Record a misbehaving peer. Delegates to IPeerReputation if available.
     */
    reportBadPeer(peerId, reason = PenaltyReason.ConnectionFailure) {
        this.reputation?.reportPeer(peerId.toString(), reason);
    }
    isBlacklisted(peerId) {
        return this.reputation?.isBanned(peerId.toString()) ?? false;
    }
    recordCoordinator(key, peerId) {
        const k = this.toCacheKey(key);
        this.coordinatorCache.set(k, { id: peerId, expires: Date.now() + this.cfg.cacheTTLs.coordinatorMs });
    }
    /**
     * Find the nearest peer to the provided content key using FRET,
     * falling back to self if FRET is unavailable.
     */
    async findNearestPeerToKey(key) {
        const fret = this.getFret();
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            throw new Error('Libp2p not initialized');
        }
        if (fret) {
            const coord = await hashKey(key);
            const neighbors = fret.getNeighbors(coord, 'both', 1);
            if (neighbors.length > 0) {
                const pidStr = neighbors[0];
                if (pidStr) {
                    const pid = peerIdFromString(pidStr);
                    if (!this.isBlacklisted(pid)) {
                        return pid;
                    }
                }
            }
        }
        // Fallback: choose among self + connected peers + known peers by distance to key
        const connected = (libp2p.getConnections?.() ?? []).map((c) => c.remotePeer);
        const candidates = [libp2p.peerId, ...connected, ...this.getKnownPeers()]
            .filter((p, i, arr) => arr.findIndex(x => x.toString() === p.toString()) === i)
            .filter(p => !this.isBlacklisted(p));
        if (candidates.length === 0) {
            return libp2p.peerId;
        }
        const best = candidates.reduce((best, cur) => this.lexLess(this.xor(best.toMultihash().bytes, key), this.xor(cur.toMultihash().bytes, key)) ? best : cur, candidates[0]);
        return best;
    }
    /**
     * Compute cluster using FRET's assembleCohort for content-addressed peer selection.
     */
    async getCluster(key) {
        const ck = this.toCacheKey(key);
        const cached = this.clusterCache.get(ck);
        if (cached && cached.expires > Date.now()) {
            return cached.ids;
        }
        const fret = this.getFret();
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            throw new Error('Libp2p not initialized');
        }
        if (fret) {
            const coord = await hashKey(key);
            const diag = fret.getDiagnostics?.() ?? {};
            const estimate = typeof diag.estimate === 'number' ? diag.estimate : (typeof diag.n === 'number' ? diag.n : undefined);
            const targetSize = Math.max(1, Math.min(this.cfg.clusterSize, Number.isFinite(estimate) ? estimate : this.cfg.clusterSize));
            const cohortIds = fret.assembleCohort(coord, targetSize);
            const ids = cohortIds
                .map(idStr => {
                try {
                    return peerIdFromString(idStr);
                }
                catch (error) {
                    this.log('Invalid peer ID in cohort: %s, %o', idStr, error);
                    return null;
                }
            })
                .filter((pid) => pid !== null && !this.isBlacklisted(pid));
            if (ids.length > 0) {
                this.clusterCache.set(ck, { ids, expires: Date.now() + this.cfg.cacheTTLs.clusterMs });
                this.lastEstimate = estimate != null ? { estimate, samples: diag.samples ?? 0, updated: Date.now() } : this.lastEstimate;
                return ids;
            }
        }
        // Fallback: peer-centric clustering if FRET unavailable
        const anchor = await this.findNearestPeerToKey(key);
        const anchorMh = anchor.toMultihash().bytes;
        const connected = (libp2p.getConnections?.() ?? []).map((c) => c.remotePeer);
        const candidates = [anchor, libp2p.peerId, ...connected, ...this.getKnownPeers()]
            .filter((p, idx, arr) => !this.isBlacklisted(p) && arr.findIndex(x => x.toString() === p.toString()) === idx);
        const sorted = candidates.sort((a, b) => this.lexLess(this.xor(a.toMultihash().bytes, anchorMh), this.xor(b.toMultihash().bytes, anchorMh)) ? -1 : 1);
        const K = Math.min(this.cfg.clusterSize, sorted.length);
        const ids = sorted.slice(0, K);
        this.clusterCache.set(ck, { ids, expires: Date.now() + this.cfg.cacheTTLs.clusterMs });
        return ids;
    }
    async getCoordinator(key) {
        const ck = this.toCacheKey(key);
        const hit = this.coordinatorCache.get(ck);
        if (hit) {
            if (hit.expires > Date.now()) {
                return hit.id;
            }
            else {
                this.coordinatorCache.delete(ck);
            }
        }
        const cluster = await this.getCluster(key);
        const libp2p = this.getLibp2p();
        if (!libp2p) {
            throw new Error('Libp2p not initialized');
        }
        // Prefer non-banned, non-deprioritized peers; fall back to deprioritized before self
        const candidate = cluster
            .filter(p => !this.isBlacklisted(p))
            .sort((a, b) => (this.reputation?.getScore(a.toString()) ?? 0) - (this.reputation?.getScore(b.toString()) ?? 0))[0] ?? libp2p.peerId;
        this.recordCoordinator(key, candidate);
        return candidate;
    }
    xor(a, b) {
        const len = Math.max(a.length, b.length);
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            const ai = a[a.length - 1 - i] ?? 0;
            const bi = b[b.length - 1 - i] ?? 0;
            out[len - 1 - i] = ai ^ bi;
        }
        return out;
    }
    lexLess(a, b) {
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i++) {
            const av = a[i] ?? 0;
            const bv = b[i] ?? 0;
            if (av < bv)
                return true;
            if (av > bv)
                return false;
        }
        return false;
    }
}
export function networkManagerService(init = {}) {
    return (components) => new NetworkManagerService(components, init);
}
//# sourceMappingURL=network-manager-service.js.map