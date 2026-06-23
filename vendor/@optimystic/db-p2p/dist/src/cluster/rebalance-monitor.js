import { hashKey } from 'p2p-fret';
import { createLogger } from '../logger.js';
const log = createLogger('rebalance-monitor');
const textEncoder = new TextEncoder();
export class RebalanceMonitor {
    deps;
    running = false;
    trackedBlocks = new Set();
    responsibilitySnapshot = new Map();
    handlers = [];
    debounceTimer = null;
    lastRebalanceAt = 0;
    pendingTopologyChange = false;
    topologyChangeTimestamp = 0;
    debounceMs;
    minRebalanceIntervalMs;
    suppressDuringPartition;
    onConnectionOpen;
    onConnectionClose;
    constructor(deps, config = {}) {
        this.deps = deps;
        this.debounceMs = config.debounceMs ?? 5000;
        this.minRebalanceIntervalMs = config.minRebalanceIntervalMs ?? 60000;
        this.suppressDuringPartition = config.suppressDuringPartition ?? true;
        this.onConnectionOpen = () => this.handleTopologyChange();
        this.onConnectionClose = () => this.handleTopologyChange();
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.deps.libp2p.addEventListener('connection:open', this.onConnectionOpen);
        this.deps.libp2p.addEventListener('connection:close', this.onConnectionClose);
        log('started, tracking %d blocks', this.trackedBlocks.size);
    }
    async stop() {
        if (!this.running)
            return;
        this.running = false;
        this.deps.libp2p.removeEventListener('connection:open', this.onConnectionOpen);
        this.deps.libp2p.removeEventListener('connection:close', this.onConnectionClose);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingTopologyChange = false;
        log('stopped');
    }
    onRebalance(handler) {
        this.handlers.push(handler);
    }
    trackBlock(blockId) {
        this.trackedBlocks.add(blockId);
    }
    untrackBlock(blockId) {
        this.trackedBlocks.delete(blockId);
        this.responsibilitySnapshot.delete(blockId);
    }
    getTrackedBlockCount() {
        return this.trackedBlocks.size;
    }
    async checkNow() {
        return this.performRebalanceCheck(Date.now());
    }
    handleTopologyChange() {
        if (!this.running)
            return;
        if (!this.pendingTopologyChange) {
            this.topologyChangeTimestamp = Date.now();
        }
        this.pendingTopologyChange = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.pendingTopologyChange = false;
            this.maybeRebalance();
        }, this.debounceMs);
    }
    async maybeRebalance() {
        if (!this.running)
            return;
        const now = Date.now();
        const elapsed = now - this.lastRebalanceAt;
        if (elapsed < this.minRebalanceIntervalMs) {
            log('throttled, %dms since last rebalance', elapsed);
            return;
        }
        const event = await this.performRebalanceCheck(this.topologyChangeTimestamp || now);
        if (event) {
            this.emitEvent(event);
        }
    }
    async performRebalanceCheck(triggeredAt) {
        if (this.suppressDuringPartition && this.deps.partitionDetector.detectPartition()) {
            log('partition detected, suppressing rebalance');
            return null;
        }
        if (this.trackedBlocks.size === 0) {
            this.lastRebalanceAt = Date.now();
            return null;
        }
        const selfId = this.deps.libp2p.peerId.toString();
        const gained = [];
        const lost = [];
        const newOwners = new Map();
        for (const blockId of this.trackedBlocks) {
            const key = textEncoder.encode(blockId);
            const coord = await hashKey(key);
            // Get the current cohort — assembleCohort returns peer IDs sorted by distance
            const cohort = this.deps.fret.assembleCohort(coord, this.getCohortSize());
            const isResponsible = cohort.includes(selfId);
            const wasResponsible = this.responsibilitySnapshot.get(blockId) ?? false;
            if (isResponsible && !wasResponsible) {
                gained.push(blockId);
            }
            else if (!isResponsible && wasResponsible) {
                lost.push(blockId);
                // The cohort members are the new owners
                newOwners.set(blockId, cohort.filter(id => id !== selfId));
            }
            this.responsibilitySnapshot.set(blockId, isResponsible);
        }
        this.lastRebalanceAt = Date.now();
        if (gained.length === 0 && lost.length === 0) {
            return null;
        }
        log('rebalance check: gained=%d lost=%d', gained.length, lost.length);
        return { gained, lost, newOwners, triggeredAt };
    }
    getCohortSize() {
        const diag = this.deps.fret.getDiagnostics?.();
        const estimate = diag?.estimate ?? diag?.n;
        if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
            return Math.max(1, Math.min(3, Math.ceil(Math.sqrt(estimate))));
        }
        return 3;
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
    /**
     * Update ArachnodeInfo status through the fret adapter.
     */
    setStatus(status) {
        this.deps.fretAdapter.setStatus(status);
    }
}
//# sourceMappingURL=rebalance-monitor.js.map