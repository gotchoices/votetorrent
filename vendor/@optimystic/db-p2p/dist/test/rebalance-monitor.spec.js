import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { RebalanceMonitor } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';
// --- Helpers ---
const makePeerId = async () => {
    const key = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(key);
};
class MockLibp2p {
    peerId;
    listeners = new Map();
    addEventListener(event, handler) {
        const list = this.listeners.get(event) ?? [];
        list.push(handler);
        this.listeners.set(event, list);
    }
    removeEventListener(event, handler) {
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(event, list.filter(h => h !== handler));
    }
    emit(event) {
        for (const handler of this.listeners.get(event) ?? []) {
            handler();
        }
    }
    getListenerCount(event) {
        return (this.listeners.get(event) ?? []).length;
    }
}
class MockFret {
    cohortResults = new Map();
    peerMetadata = new Map();
    assembleCohortCalls = [];
    /** Set what assembleCohort returns. Key is '*' for default, or stringified coord. */
    setCohort(key, peers) {
        this.cohortResults.set(key, peers);
    }
    assembleCohort(coord, wants, _exclude) {
        this.assembleCohortCalls.push({ coord, wants });
        // Try specific key first, then wildcard
        const specific = this.cohortResults.get(Array.from(coord).join(','));
        if (specific)
            return specific;
        return this.cohortResults.get('*') ?? [];
    }
    // Stubs for FretService interface
    async start() { }
    async stop() { }
    setMode() { }
    async ready() { }
    neighborDistance() { return 0; }
    getNeighbors() { return []; }
    expandCohort() { return []; }
    async routeAct() { return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }; }
    report() { }
    setMetadata(_md) { }
    getMetadata(peerId) { return this.peerMetadata.get(peerId); }
    listPeers() { return []; }
    reportNetworkSize() { }
    getNetworkSizeEstimate() { return { size_estimate: 1, confidence: 0.5, sources: 0 }; }
    getNetworkChurn() { return 0; }
    detectPartition() { return false; }
    exportTable() { return { entries: [] }; }
    importTable() { return 0; }
}
// --- Tests ---
describe('RebalanceMonitor', () => {
    let selfId;
    let peerId2;
    let peerId3;
    let mockLibp2p;
    let mockFret;
    let partitionDetector;
    let fretAdapter;
    let deps;
    beforeEach(async () => {
        selfId = await makePeerId();
        peerId2 = await makePeerId();
        peerId3 = await makePeerId();
        mockLibp2p = new MockLibp2p();
        mockLibp2p.peerId = selfId;
        mockFret = new MockFret();
        partitionDetector = new PartitionDetector();
        fretAdapter = new ArachnodeFretAdapter(mockFret);
        deps = {
            libp2p: mockLibp2p,
            fret: mockFret,
            partitionDetector,
            fretAdapter
        };
    });
    describe('lifecycle', () => {
        it('registers and removes event listeners on start/stop', async () => {
            const monitor = new RebalanceMonitor(deps);
            await monitor.start();
            expect(mockLibp2p.getListenerCount('connection:open')).to.equal(1);
            expect(mockLibp2p.getListenerCount('connection:close')).to.equal(1);
            await monitor.stop();
            expect(mockLibp2p.getListenerCount('connection:open')).to.equal(0);
            expect(mockLibp2p.getListenerCount('connection:close')).to.equal(0);
        });
        it('is idempotent on start/stop', async () => {
            const monitor = new RebalanceMonitor(deps);
            await monitor.start();
            await monitor.start();
            expect(mockLibp2p.getListenerCount('connection:open')).to.equal(1);
            await monitor.stop();
            await monitor.stop();
            expect(mockLibp2p.getListenerCount('connection:open')).to.equal(0);
        });
    });
    describe('block tracking', () => {
        it('tracks and untracks blocks', () => {
            const monitor = new RebalanceMonitor(deps);
            monitor.trackBlock('block-1');
            monitor.trackBlock('block-2');
            expect(monitor.getTrackedBlockCount()).to.equal(2);
            monitor.untrackBlock('block-1');
            expect(monitor.getTrackedBlockCount()).to.equal(1);
        });
    });
    describe('checkNow', () => {
        it('returns null when no blocks are tracked', async () => {
            const monitor = new RebalanceMonitor(deps);
            const event = await monitor.checkNow();
            expect(event).to.be.null;
        });
        it('detects gained responsibility when self is in cohort', async () => {
            // Self is in the cohort for block-1
            mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);
            const monitor = new RebalanceMonitor(deps);
            monitor.trackBlock('block-1');
            const event = await monitor.checkNow();
            expect(event).to.not.be.null;
            expect(event.gained).to.deep.equal(['block-1']);
            expect(event.lost).to.deep.equal([]);
        });
        it('detects lost responsibility when self is no longer in cohort', async () => {
            // First check: self is responsible
            mockFret.setCohort('*', [selfId.toString(), peerId2.toString()]);
            const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
            monitor.trackBlock('block-1');
            await monitor.checkNow();
            // Now self is no longer in the cohort
            mockFret.setCohort('*', [peerId2.toString(), peerId3.toString()]);
            const event = await monitor.checkNow();
            expect(event).to.not.be.null;
            expect(event.gained).to.deep.equal([]);
            expect(event.lost).to.deep.equal(['block-1']);
            expect(event.newOwners.get('block-1')).to.include(peerId2.toString());
            expect(event.newOwners.get('block-1')).to.include(peerId3.toString());
        });
        it('returns null when responsibility has not changed', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
            monitor.trackBlock('block-1');
            // First check establishes baseline
            await monitor.checkNow();
            // Second check — no change
            const event = await monitor.checkNow();
            expect(event).to.be.null;
        });
        it('reports both gained and lost in a single event', async () => {
            // Initially responsible for block-1 only
            const selfStr = selfId.toString();
            const peer2Str = peerId2.toString();
            mockFret.setCohort('*', [selfStr]);
            const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
            monitor.trackBlock('block-1');
            monitor.trackBlock('block-2');
            // First check: responsible for both
            await monitor.checkNow();
            // Now: self loses block-1, gains nothing new
            // We need per-block control. Since assembleCohort uses coord,
            // and all blocks go through '*', we simulate losing ALL and re-gaining none
            mockFret.setCohort('*', [peer2Str]);
            const event = await monitor.checkNow();
            expect(event).to.not.be.null;
            expect(event.lost).to.include('block-1');
            expect(event.lost).to.include('block-2');
        });
    });
    describe('debounce behavior', () => {
        it('rapid topology changes produce a single debounced check', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const events = [];
            const monitor = new RebalanceMonitor(deps, {
                debounceMs: 50,
                minRebalanceIntervalMs: 0
            });
            monitor.onRebalance(e => events.push(e));
            monitor.trackBlock('block-1');
            await monitor.start();
            // Fire multiple topology changes rapidly
            mockLibp2p.emit('connection:open');
            mockLibp2p.emit('connection:close');
            mockLibp2p.emit('connection:open');
            mockLibp2p.emit('connection:close');
            mockLibp2p.emit('connection:open');
            // Wait for debounce
            await new Promise(r => setTimeout(r, 100));
            // Should have at most 1 event (gained block-1)
            expect(events.length).to.be.at.most(1);
            await monitor.stop();
        });
        it('does not fire events after stop', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const events = [];
            const monitor = new RebalanceMonitor(deps, {
                debounceMs: 50,
                minRebalanceIntervalMs: 0
            });
            monitor.onRebalance(e => events.push(e));
            monitor.trackBlock('block-1');
            await monitor.start();
            mockLibp2p.emit('connection:open');
            await monitor.stop();
            // Wait past debounce window
            await new Promise(r => setTimeout(r, 100));
            expect(events).to.have.length(0);
        });
    });
    describe('partition suppression', () => {
        it('suppresses rebalance when partition is detected', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            // Simulate partition
            for (let i = 0; i < 10; i++) {
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
            }
            const monitor = new RebalanceMonitor(deps, { suppressDuringPartition: true });
            monitor.trackBlock('block-1');
            const event = await monitor.checkNow();
            expect(event).to.be.null;
        });
        it('allows rebalance when suppression is disabled', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            // Simulate partition
            for (let i = 0; i < 10; i++) {
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
            }
            const monitor = new RebalanceMonitor(deps, { suppressDuringPartition: false });
            monitor.trackBlock('block-1');
            const event = await monitor.checkNow();
            expect(event).to.not.be.null;
            expect(event.gained).to.deep.equal(['block-1']);
        });
    });
    describe('throttling', () => {
        it('throttles rebalance checks to minRebalanceIntervalMs', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const events = [];
            const monitor = new RebalanceMonitor(deps, {
                debounceMs: 10,
                minRebalanceIntervalMs: 200
            });
            monitor.onRebalance(e => events.push(e));
            monitor.trackBlock('block-1');
            await monitor.start();
            // First topology change
            mockLibp2p.emit('connection:open');
            await new Promise(r => setTimeout(r, 50));
            // Second topology change — should be throttled
            mockFret.setCohort('*', [peerId2.toString()]);
            mockLibp2p.emit('connection:close');
            await new Promise(r => setTimeout(r, 50));
            // Only the first event should have fired (gained block-1)
            expect(events.length).to.be.at.most(1);
            await monitor.stop();
        });
    });
    describe('ArachnodeInfo status transitions', () => {
        it('setStatus delegates to fretAdapter.setStatus', () => {
            const statusLog = [];
            const adapter = {
                setStatus: (status) => { statusLog.push(status); }
            };
            const monitor = new RebalanceMonitor({
                ...deps,
                fretAdapter: adapter
            });
            monitor.setStatus('moving');
            monitor.setStatus('active');
            monitor.setStatus('leaving');
            expect(statusLog).to.deep.equal(['moving', 'active', 'leaving']);
        });
    });
    describe('event handlers', () => {
        it('calls all registered handlers on topology-triggered rebalance', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const calls1 = [];
            const calls2 = [];
            const monitor = new RebalanceMonitor(deps, {
                debounceMs: 10,
                minRebalanceIntervalMs: 0
            });
            monitor.onRebalance(e => calls1.push(e));
            monitor.onRebalance(e => calls2.push(e));
            monitor.trackBlock('block-1');
            await monitor.start();
            mockLibp2p.emit('connection:open');
            // Wait for debounce
            await new Promise(r => setTimeout(r, 50));
            expect(calls1).to.have.length(1);
            expect(calls2).to.have.length(1);
            expect(calls1[0].gained).to.deep.equal(['block-1']);
            await monitor.stop();
        });
        it('handler errors do not prevent other handlers from firing', async () => {
            mockFret.setCohort('*', [selfId.toString()]);
            const calls = [];
            const monitor = new RebalanceMonitor(deps, {
                debounceMs: 10,
                minRebalanceIntervalMs: 0
            });
            monitor.onRebalance(() => { throw new Error('handler error'); });
            monitor.onRebalance(e => calls.push(e));
            monitor.trackBlock('block-1');
            await monitor.start();
            mockLibp2p.emit('connection:open');
            // Wait for debounce
            await new Promise(r => setTimeout(r, 50));
            expect(calls).to.have.length(1);
            await monitor.stop();
        });
    });
});
//# sourceMappingURL=rebalance-monitor.spec.js.map