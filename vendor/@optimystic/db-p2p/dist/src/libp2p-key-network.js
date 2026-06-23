import { toString as u8ToString } from 'uint8arrays';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { hashKey } from 'p2p-fret';
import { createLogger, verbose } from './logger.js';
/**
 * Error codes surfaced by {@link Libp2pKeyPeerNetwork.findCoordinator}. Callers
 * (notably the batch-retry logic in `NetworkTransactor`) can inspect `.code`
 * to distinguish between "transient — try again with different excludes" and
 * "terminal — stop retrying".
 */
export const FIND_COORDINATOR_ERROR_CODES = {
    /**
     * Last-resort self-coordination was blocked by the self-coordination guard
     * (e.g. partition detected, suspicious shrinkage). Retrying is unlikely to help.
     */
    SELF_COORDINATION_BLOCKED: 'SELF_COORDINATION_BLOCKED',
    /**
     * Self-coordination was already attempted and self is now excluded. On a solo
     * or bootstrap node with no other peers, this means retries are exhausted and
     * the original error from the prior attempt should be surfaced instead.
     */
    SELF_COORDINATION_EXHAUSTED: 'SELF_COORDINATION_EXHAUSTED',
    /** No peer (including self) is an eligible coordinator. */
    NO_COORDINATOR_AVAILABLE: 'NO_COORDINATOR_AVAILABLE'
};
export class FindCoordinatorError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'FindCoordinatorError';
        this.code = code;
    }
}
export class Libp2pKeyPeerNetwork {
    libp2p;
    clusterSize;
    reputation;
    selfCoordinationConfig;
    networkHighWaterMark = 1;
    lastConnectedTime = Date.now();
    consecutiveIsolatedSessions = 0;
    networkMode;
    persistence;
    constructor(libp2p, clusterSize = 16, selfCoordinationConfig, networkMode, persistence, reputation) {
        this.libp2p = libp2p;
        this.clusterSize = clusterSize;
        this.reputation = reputation;
        this.selfCoordinationConfig = {
            gracePeriodMs: selfCoordinationConfig?.gracePeriodMs ?? 30_000,
            shrinkageThreshold: selfCoordinationConfig?.shrinkageThreshold ?? 0.5,
            allowSelfCoordination: selfCoordinationConfig?.allowSelfCoordination ?? true
        };
        this.networkMode = networkMode ?? 'forming';
        this.persistence = persistence;
        this.setupConnectionTracking();
    }
    // coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
    coordinatorCache = new Map();
    static MAX_CACHE_ENTRIES = 1000;
    log = createLogger('libp2p-key-network');
    toCacheKey(key) { return u8ToString(key, 'base64url'); }
    /**
     * Set up connection event tracking to update high water mark and last connected time.
     */
    setupConnectionTracking() {
        this.libp2p.addEventListener('connection:open', () => {
            this.updateNetworkObservations();
        });
    }
    /**
     * Update network high water mark and last connected time.
     * Called on new connections.
     */
    updateNetworkObservations() {
        const connections = this.libp2p.getConnections?.() ?? [];
        if (connections.length > 0) {
            this.lastConnectedTime = Date.now();
            this.consecutiveIsolatedSessions = 0;
        }
        try {
            const fret = this.getFret();
            const estimate = fret.getNetworkSizeEstimate();
            if (estimate.size_estimate > this.networkHighWaterMark) {
                this.networkHighWaterMark = estimate.size_estimate;
                this.log('network-hwm-updated mark=%d confidence=%f', this.networkHighWaterMark, estimate.confidence);
            }
        }
        catch {
            // FRET not available - use connection count as fallback
            const connectionCount = this.libp2p.getConnections?.().length ?? 0;
            const observedSize = connectionCount + 1; // +1 for self
            if (observedSize > this.networkHighWaterMark) {
                this.networkHighWaterMark = observedSize;
                this.log('network-hwm-updated mark=%d (from connections)', this.networkHighWaterMark);
            }
        }
        this.persistState();
    }
    async initFromPersistedState() {
        if (!this.persistence)
            return;
        const state = await this.persistence.load();
        if (!state)
            return;
        this.networkHighWaterMark = state.networkHighWaterMark;
        this.lastConnectedTime = state.lastConnectedTimestamp;
        this.consecutiveIsolatedSessions = state.consecutiveIsolatedSessions;
        if (state.fretTable) {
            try {
                this.getFret().importTable(state.fretTable);
            }
            catch (err) {
                this.log('init:fret-import-skipped %o', err);
            }
        }
        // If HWM > 1 but FRET table is empty/self-only, increment isolated sessions
        if (state.networkHighWaterMark > 1) {
            const fretEntryCount = state.fretTable?.entries?.length ?? 0;
            if (fretEntryCount <= 1) {
                this.consecutiveIsolatedSessions++;
                this.log('init:isolated-session count=%d hwm=%d', this.consecutiveIsolatedSessions, this.networkHighWaterMark);
            }
        }
    }
    canRetryImprove(fretNeighborIds) {
        if (this.networkMode !== 'forming')
            return true;
        if (this.networkHighWaterMark > 1)
            return true;
        const onlySelf = fretNeighborIds.length <= 1
            && (fretNeighborIds.length === 0 || fretNeighborIds[0] === this.libp2p.peerId.toString());
        return !onlySelf;
    }
    persistState() {
        if (!this.persistence)
            return;
        const state = {
            version: 1,
            networkHighWaterMark: this.networkHighWaterMark,
            lastConnectedTimestamp: this.lastConnectedTime,
            consecutiveIsolatedSessions: this.consecutiveIsolatedSessions,
        };
        try {
            const fret = this.getFret();
            state.fretTable = fret.exportTable();
        }
        catch { /* FRET not available */ }
        void this.persistence.save(state).catch(err => this.log('persist-state-failed %o', err));
    }
    /**
     * Determine if self-coordination should be allowed based on network observations.
     *
     * Principle: If we've ever seen a larger network, assume our connectivity is the problem,
     * not the network shrinking.
     */
    shouldAllowSelfCoordination() {
        // Check global disable
        if (!this.selfCoordinationConfig.allowSelfCoordination) {
            return { allow: false, reason: 'disabled' };
        }
        // Case 1: New/bootstrap node (never seen larger network)
        if (this.networkHighWaterMark <= 1) {
            return { allow: true, reason: 'bootstrap-node' };
        }
        // Case 1b: Repeated isolation across sessions — decay HWM to allow eventual self-coordination
        if (this.consecutiveIsolatedSessions >= 3) {
            this.log('self-coord-allowed: hwm-decayed sessions=%d', this.consecutiveIsolatedSessions);
            return { allow: true, reason: 'hwm-decay', warn: true };
        }
        // Case 2: Check for partition via FRET
        try {
            const fret = this.getFret();
            if (fret.detectPartition()) {
                this.log('self-coord-blocked: partition-detected');
                return { allow: false, reason: 'partition-detected' };
            }
            // Case 3: Suspicious network shrinkage (>threshold drop)
            const estimate = fret.getNetworkSizeEstimate();
            const shrinkage = 1 - (estimate.size_estimate / this.networkHighWaterMark);
            if (shrinkage > this.selfCoordinationConfig.shrinkageThreshold) {
                this.log('self-coord-blocked: suspicious-shrinkage current=%d hwm=%d shrinkage=%f', estimate.size_estimate, this.networkHighWaterMark, shrinkage);
                return { allow: false, reason: 'suspicious-shrinkage' };
            }
        }
        catch {
            // FRET not available - be conservative
            const connections = this.libp2p.getConnections?.() ?? [];
            if (this.networkHighWaterMark > 1 && connections.length === 0) {
                // We've seen peers before but have none now - suspicious
                const timeSinceConnection = Date.now() - this.lastConnectedTime;
                if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
                    this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
                    return { allow: false, reason: 'grace-period-not-elapsed' };
                }
            }
        }
        // Case 4: Recently connected (grace period not elapsed)
        const timeSinceConnection = Date.now() - this.lastConnectedTime;
        if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
            const connections = this.libp2p.getConnections?.() ?? [];
            // Only block if we have no connections but did recently
            if (connections.length === 0) {
                this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
                return { allow: false, reason: 'grace-period-not-elapsed' };
            }
        }
        // Case 5: Extended isolation with gradual shrinkage - allow with warning
        this.log('self-coord-allowed: extended-isolation (warn)');
        return { allow: true, reason: 'extended-isolation', warn: true };
    }
    recordCoordinator(key, peerId, ttlMs = 30 * 60 * 1000) {
        const k = this.toCacheKey(key);
        const now = Date.now();
        for (const [ck, entry] of this.coordinatorCache) {
            if (entry.expires <= now)
                this.coordinatorCache.delete(ck);
        }
        this.coordinatorCache.set(k, { id: peerId, expires: now + ttlMs });
        while (this.coordinatorCache.size > Libp2pKeyPeerNetwork.MAX_CACHE_ENTRIES) {
            const firstKey = this.coordinatorCache.keys().next().value;
            if (firstKey == null)
                break;
            this.coordinatorCache.delete(firstKey);
        }
    }
    getCachedCoordinator(key) {
        const k = this.toCacheKey(key);
        const hit = this.coordinatorCache.get(k);
        if (hit && hit.expires > Date.now())
            return hit.id;
        if (hit)
            this.coordinatorCache.delete(k);
        return undefined;
    }
    connect(peerId, protocol, options) {
        const conns = (this.libp2p.getConnections?.(peerId) ?? []);
        // Filter to only-open connections so a closing/closed entry that libp2p
        // hasn't yet evicted from its index doesn't get picked up here.
        const open = conns.find(c => c?.status === 'open' && typeof c?.newStream === 'function');
        if (open) {
            // runOnLimitedConnection: true is required to open a stream over a
            // circuit-relay (limited) connection — the steady-state path for
            // browsers and NATed peers. Without it, the warm relay connection
            // from a prior dialProtocol cannot be reused on subsequent RPCs.
            return open.newStream([protocol], {
                signal: options?.signal,
                runOnLimitedConnection: true,
                negotiateFully: false
            });
        }
        // Forward the caller's AbortSignal so a per-peer dial deadline (enforced
        // upstream by ProtocolClient.processMessage) can actually cancel a stuck
        // dial — without this, libp2p falls back to its built-in dial timeout
        // (default ~30s) and the caller's tighter deadline is decorative.
        const dialOptions = { runOnLimitedConnection: true, negotiateFully: false, signal: options?.signal };
        return this.libp2p.dialProtocol(peerId, [protocol], dialOptions);
    }
    getFret() {
        const svc = this.libp2p.services?.fret;
        if (svc == null)
            throw new Error('FRET service is not registered on this libp2p node');
        return svc;
    }
    async getNeighborIdsForKey(key, wants) {
        const fret = this.getFret();
        const coord = await hashKey(key);
        const both = fret.getNeighbors(coord, 'both', wants);
        return Array.from(new Set(both)).slice(0, wants);
    }
    async findCoordinator(key, _options) {
        const t0 = Date.now();
        const excludedSet = new Set((_options?.excludedPeers ?? []).map(p => p.toString()));
        const keyStr = this.toCacheKey(key).substring(0, 12);
        this.log('findCoordinator:start key=%s excluded=%o', keyStr, Array.from(excludedSet).map(s => s.substring(0, 12)));
        // honor cache if not excluded
        const cached = this.getCachedCoordinator(key);
        if (cached != null && !excludedSet.has(cached.toString())) {
            this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'cache');
            return cached;
        }
        // Retry logic: connections can be temporarily down, so retry a few times with delay
        const maxRetries = 3;
        const retryDelayMs = 500;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Get currently connected peers for filtering
            const connected = (this.libp2p.getConnections?.() ?? []).map((c) => c.remotePeer);
            const connectedSet = new Set(connected.map(p => p.toString()));
            this.log('findCoordinator:connected-peers key=%s count=%d peers=%o attempt=%d', keyStr, connected.length, connected.map(p => p.toString().substring(0, 12)), attempt);
            // prefer FRET neighbors that are also connected, pick first non-excluded
            let ids = [];
            try {
                ids = await this.getNeighborIdsForKey(key, this.clusterSize);
                this.log('findCoordinator:fret-neighbors key=%s candidates=%d', keyStr, ids.length);
                if (verbose)
                    this.log('findCoordinator:fret-candidates key=%s ids=%o connected=%o', keyStr, ids, Array.from(connectedSet));
                // Filter to only connected FRET neighbors, excluding banned peers
                const connectedFretIds = ids
                    .filter(id => (connectedSet.has(id) || id === this.libp2p.peerId.toString())
                    && !excludedSet.has(id)
                    && !(this.reputation?.isBanned(id)))
                    .sort((a, b) => (this.reputation?.getScore(a) ?? 0) - (this.reputation?.getScore(b) ?? 0));
                this.log('findCoordinator:fret-connected key=%s count=%d peers=%o', keyStr, connectedFretIds.length, connectedFretIds.map(s => s.substring(0, 12)));
                const pick = connectedFretIds[0];
                if (pick) {
                    const pid = peerIdFromString(pick);
                    this.recordCoordinator(key, pid);
                    this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'fret');
                    return pid;
                }
            }
            catch (err) {
                this.log('findCoordinator getNeighborIdsForKey failed - %o', err);
            }
            // fallback: prefer any existing connected peer that's not excluded or banned
            const connectedPick = connected
                .filter(p => !excludedSet.has(p.toString()) && !(this.reputation?.isBanned(p.toString())))
                .sort((a, b) => (this.reputation?.getScore(a.toString()) ?? 0) - (this.reputation?.getScore(b.toString()) ?? 0))[0];
            if (connectedPick) {
                this.recordCoordinator(key, connectedPick);
                this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'connected-fallback');
                return connectedPick;
            }
            // If no connections and not the last attempt, wait and retry
            if (connected.length === 0 && attempt < maxRetries - 1) {
                if (!this.canRetryImprove(ids)) {
                    this.log('findCoordinator:retry-futile key=%s mode=%s hwm=%d', keyStr, this.networkMode, this.networkHighWaterMark);
                    break;
                }
                this.log('findCoordinator:no-connections-retry key=%s attempt=%d delay=%dms', keyStr, attempt, retryDelayMs);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                continue;
            }
        }
        // last resort: prefer self only if not excluded and guard allows
        const self = this.libp2p.peerId;
        if (!excludedSet.has(self.toString())) {
            const decision = this.shouldAllowSelfCoordination();
            if (!decision.allow) {
                this.log('findCoordinator:self-coord-blocked key=%s reason=%s', keyStr, decision.reason);
                throw new FindCoordinatorError(FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_BLOCKED, `Self-coordination blocked: ${decision.reason}. No coordinator available for key.`);
            }
            if (decision.warn) {
                this.log('findCoordinator:self-selected-warn key=%s coordinator=%s reason=%s', keyStr, self.toString().substring(0, 12), decision.reason);
            }
            else {
                this.log('findCoordinator:self-selected key=%s coordinator=%s reason=%s', keyStr, self.toString().substring(0, 12), decision.reason);
            }
            this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'self');
            return self;
        }
        // Self is excluded. On a solo/bootstrap node (HWM<=1 and no other connected/FRET peers),
        // this means the caller already tried self and the retry has nowhere to go — surface a
        // distinct error so retry logic stops and the original first-attempt cause is preserved.
        const isSoloBootstrap = this.networkHighWaterMark <= 1;
        if (isSoloBootstrap) {
            this.log('findCoordinator:self-exhausted-solo key=%s self=%s', keyStr, self.toString().substring(0, 12));
            throw new FindCoordinatorError(FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED, 'Self-coordination exhausted on solo/bootstrap node (self already attempted). ' +
                'The original first-attempt error describes the actual failure cause.');
        }
        this.log('findCoordinator:all-excluded key=%s self=%s', keyStr, self.toString().substring(0, 12));
        throw new FindCoordinatorError(FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE, 'No coordinator available for key (all candidates excluded)');
    }
    getConnectedAddrsByPeer() {
        const conns = this.libp2p.getConnections();
        const byPeer = {};
        for (const c of conns) {
            const id = c.remotePeer.toString();
            const addr = c.remoteAddr?.toString?.();
            if (addr)
                (byPeer[id] ??= []).push(addr);
        }
        return byPeer;
    }
    parseMultiaddrs(addrs) {
        const out = [];
        for (const a of addrs) {
            try {
                multiaddr(a);
                out.push(a);
            }
            catch (err) {
                console.warn('invalid multiaddr from connection', a, err);
            }
        }
        return out;
    }
    async findCluster(key) {
        const t0 = Date.now();
        const fret = this.getFret();
        const coord = await hashKey(key);
        const cohort = fret.assembleCohort(coord, this.clusterSize);
        const keyStr = this.toCacheKey(key).substring(0, 12);
        this.log('findCluster:start key=%s', keyStr);
        // Include self in the cohort
        const ids = Array.from(new Set([...cohort, this.libp2p.peerId.toString()]));
        const connectedByPeer = this.getConnectedAddrsByPeer();
        const connectedPeerIds = Object.keys(connectedByPeer);
        this.log('findCluster key=%s fretCohort=%d connected=%d', keyStr, cohort.length, connectedPeerIds.length);
        if (verbose)
            this.log('findCluster:detail key=%s cohortPeers=%o connectedPeers=%o', keyStr, ids, connectedPeerIds);
        const peers = {};
        for (const idStr of ids) {
            if (idStr === this.libp2p.peerId.toString()) {
                const raw = this.libp2p.peerId.publicKey?.raw ?? new Uint8Array();
                peers[idStr] = { multiaddrs: this.libp2p.getMultiaddrs().map(ma => ma.toString()), publicKey: u8ToString(raw, 'base64url') };
                continue;
            }
            const strings = connectedByPeer[idStr] ?? [];
            const remotePeerId = peerIdFromString(idStr);
            const raw = remotePeerId.publicKey?.raw ?? new Uint8Array();
            peers[idStr] = { multiaddrs: this.parseMultiaddrs(strings), publicKey: u8ToString(raw, 'base64url') };
        }
        this.log('findCluster:done key=%s ms=%d peers=%d', keyStr, Date.now() - t0, Object.keys(peers).length);
        return peers;
    }
}
//# sourceMappingURL=libp2p-key-network.js.map