import { expect } from 'chai';
import { StorageMonitor } from '../src/storage/storage-monitor.js';
/**
 * Builds a minimal `IRawStorage` stub. All persistence-shaped methods throw to
 * make accidental usage loud — `StorageMonitor` only consults
 * `getApproximateBytesUsed`, so the rest are unreachable in this suite.
 */
function makeStorage(overrides = {}) {
    const reject = () => { throw new Error('not implemented in test stub'); };
    return {
        getMetadata: reject,
        saveMetadata: reject,
        getRevision: reject,
        saveRevision: reject,
        listRevisions: reject,
        getPendingTransaction: reject,
        savePendingTransaction: reject,
        deletePendingTransaction: reject,
        listPendingTransactions: reject,
        getTransaction: reject,
        saveTransaction: reject,
        getMaterializedBlock: reject,
        saveMaterializedBlock: reject,
        promotePendingTransaction: reject,
        ...overrides
    };
}
describe('StorageMonitor', () => {
    describe('getCapacity (no overrides)', () => {
        it('reflects the storage backend\'s reported bytes used', async () => {
            const totalBytes = 1024 * 1024;
            const reportedUsed = 256 * 1024;
            const storage = makeStorage({
                getApproximateBytesUsed: async () => reportedUsed
            });
            const monitor = new StorageMonitor(storage, { totalBytes });
            const capacity = await monitor.getCapacity();
            expect(capacity.total).to.equal(totalBytes);
            expect(capacity.used).to.equal(reportedUsed);
            expect(capacity.available).to.equal(totalBytes - reportedUsed);
        });
        it('treats backends without getApproximateBytesUsed as zero used', async () => {
            const storage = makeStorage(); // no getApproximateBytesUsed
            const monitor = new StorageMonitor(storage);
            const capacity = await monitor.getCapacity();
            expect(capacity.used).to.equal(0);
            expect(capacity.available).to.equal(capacity.total);
        });
        it('clamps used bytes to the configured total', async () => {
            const totalBytes = 1000;
            const storage = makeStorage({
                getApproximateBytesUsed: async () => 5000 // overshoot
            });
            const monitor = new StorageMonitor(storage, { totalBytes });
            const capacity = await monitor.getCapacity();
            expect(capacity.used).to.equal(totalBytes);
            expect(capacity.available).to.equal(0);
        });
        it('floors negative reports at zero', async () => {
            const totalBytes = 1000;
            const storage = makeStorage({
                getApproximateBytesUsed: async () => -100
            });
            const monitor = new StorageMonitor(storage, { totalBytes });
            const capacity = await monitor.getCapacity();
            expect(capacity.used).to.equal(0);
            expect(capacity.available).to.equal(totalBytes);
        });
    });
    describe('getCapacity (with overrides)', () => {
        it('honors usedBytes override and ignores the backend', async () => {
            let backendCalled = false;
            const storage = makeStorage({
                getApproximateBytesUsed: async () => {
                    backendCalled = true;
                    return 999_999;
                }
            });
            const monitor = new StorageMonitor(storage, {
                totalBytes: 1000,
                usedBytes: 250
            });
            const capacity = await monitor.getCapacity();
            expect(capacity.total).to.equal(1000);
            expect(capacity.used).to.equal(250);
            expect(capacity.available).to.equal(750);
            expect(backendCalled).to.equal(false);
        });
        it('honors availableBytes override', async () => {
            const storage = makeStorage();
            const monitor = new StorageMonitor(storage, {
                totalBytes: 1000,
                availableBytes: 600
            });
            const capacity = await monitor.getCapacity();
            expect(capacity.available).to.equal(600);
            expect(capacity.used).to.equal(400);
        });
    });
});
//# sourceMappingURL=storage-monitor.spec.js.map