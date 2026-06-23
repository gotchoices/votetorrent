import { hashKey } from 'p2p-fret';
import { peerIdFromString } from '@libp2p/peer-id';
import { BlockTransferClient } from './block-transfer-service.js';
import { createLogger } from '../logger.js';
const log = createLogger('spread-on-churn');
const textEncoder = new TextEncoder();
// ── Defaults ─────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    enabled: true,
    spreadDistance: 3,
    dynamicSpreadDistance: true,
    healthThreshold: 0.6,
    departureDebounceMs: 5000,
    expansionStep: 4,
};
// ── Monitor ──────────────────────────────────────────────────────────
export class SpreadOnChurnMonitor {
    deps;
    running = false;
    trackedBlocks = new Set();
    handlers = [];
    debounceTimer = null;
    departureTimestamps = [];
    departureTimestamp = 0;
    config;
    onConnectionClose;
    constructor(deps, config = {}) {
        this.deps = deps;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.onConnectionClose = () => this.handleDeparture();
    }
    // ── Startable ────────────────────────────────────────────────────
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.deps.libp2p.addEventListener('connection:close', this.onConnectionClose);
        log('started, tracking %d blocks', this.trackedBlocks.size);
    }
    async stop() {
        if (!this.running)
            return;
        this.running = false;
        this.deps.libp2p.removeEventListener('connection:close', this.onConnectionClose);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        log('stopped');
    }
    // ── Public API ───────────────────────────────────────────────────
    onSpread(handler) {
        this.handlers.push(handler);
    }
    trackBlock(blockId) {
        this.trackedBlocks.add(blockId);
    }
    untrackBlock(blockId) {
        this.trackedBlocks.delete(blockId);
    }
    getTrackedBlockCount() {
        return this.trackedBlocks.size;
    }
    /** Force an immediate spread check (useful for testing). */
    async checkNow() {
        return this.performSpread(Date.now());
    }
    // ── Internal ─────────────────────────────────────────────────────
    handleDeparture() {
        if (!this.running)
            return;
        if (!this.config.enabled)
            return;
        if (!this.departureTimestamp) {
            this.departureTimestamp = Date.now();
        }
        // Record for dynamic-d sliding window
        this.departureTimestamps.push(Date.now());
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            const ts = this.departureTimestamp;
            this.departureTimestamp = 0;
            if (this.running) {
                this.performSpread(ts).catch(err => {
                    log('spread error: %O', err);
                });
            }
        }, this.config.departureDebounceMs);
    }
    async performSpread(triggeredAt) {
        if (!this.config.enabled)
            return null;
        if (this.deps.partitionDetector.detectPartition()) {
            log('partition detected, suppressing spread');
            return null;
        }
        if (this.trackedBlocks.size === 0)
            return null;
        const selfId = this.deps.libp2p.peerId.toString();
        const effectiveD = this.computeEffectiveD();
        const spreadResults = [];
        for (const blockId of this.trackedBlocks) {
            const key = textEncoder.encode(blockId);
            const coord = await hashKey(key);
            // Check eligibility: only middle peers spread
            const rank = this.deps.fret.neighborDistance(selfId, coord, this.deps.clusterSize);
            if (rank >= effectiveD)
                continue;
            // Get current cohort and expansion targets
            const cohort = this.deps.fret.assembleCohort(coord, this.deps.clusterSize);
            const cohortSet = new Set(cohort);
            const expanded = this.deps.fret.expandCohort(cohort, coord, this.config.expansionStep);
            const targets = expanded.filter(id => !cohortSet.has(id) && id !== selfId);
            if (targets.length === 0)
                continue;
            // Read block data from local storage
            const result = await this.deps.repo.get({ blockIds: [blockId] });
            const blockResult = result[blockId];
            if (!blockResult?.block) {
                log('no-local-data block=%s', blockId);
                continue;
            }
            const blockData = textEncoder.encode(JSON.stringify(blockResult.block));
            // Push to each target
            const succeeded = [];
            const failed = [];
            for (const targetId of targets) {
                try {
                    const peerId = peerIdFromString(targetId);
                    const client = new BlockTransferClient(peerId, this.deps.peerNetwork, this.deps.protocolPrefix);
                    await client.pushBlocks([blockId], [blockData], 'replication');
                    succeeded.push(targetId);
                    log('push:ok block=%s target=%s', blockId, targetId);
                }
                catch (err) {
                    failed.push(targetId);
                    log('push:fail block=%s target=%s err=%s', blockId, targetId, err.message);
                }
            }
            spreadResults.push({ blockId, targets, succeeded, failed });
        }
        if (spreadResults.length === 0)
            return null;
        const event = {
            spread: spreadResults,
            effectiveD,
            triggeredAt,
        };
        this.emitEvent(event);
        return event;
    }
    computeEffectiveD() {
        const d = this.config.spreadDistance;
        if (!this.config.dynamicSpreadDistance)
            return d;
        const maxD = Math.max(d, Math.floor(this.deps.clusterSize / 2));
        const windowMs = this.config.departureDebounceMs * 4;
        const now = Date.now();
        // Prune old departure timestamps
        this.departureTimestamps = this.departureTimestamps.filter(ts => now - ts < windowMs);
        // Rapid churn: 3+ departures in window → increase d by 1
        if (this.departureTimestamps.length >= 3) {
            return Math.min(d + 1, maxD);
        }
        // Low cluster health: observed cohort shrunk relative to expected
        // We approximate observed cohort size from FRET diagnostics
        const diag = this.deps.fret.getDiagnostics?.();
        const estimate = diag?.estimate ?? diag?.n;
        if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
            const ratio = estimate / this.deps.clusterSize;
            if (ratio < this.config.healthThreshold) {
                const scaled = Math.ceil(d * (this.deps.clusterSize / estimate));
                return Math.min(scaled, maxD);
            }
        }
        return d;
    }
    emitEvent(event) {
        for (const handler of this.handlers) {
            try {
                handler(event);
            }
            catch (err) {
                log('handler error: %O', err);
            }
        }
    }
}
//# sourceMappingURL=spread-on-churn.js.map