import { expect } from 'chai';
import { processBatches } from '../src/utility/batch-coordinator.js';
/** Minimal stub PeerId that satisfies equality/toString comparisons used in processBatches. */
function makePeerId(id) {
    return { toString: () => id, equals: (o) => o?.toString?.() === id };
}
describe('batch-coordinator.processBatches (solo-node error preservation)', () => {
    it('preserves original first-attempt batch error even when retry findCoordinator throws', async () => {
        const selfId = makePeerId('self-peer');
        const blockId = 'solo-block';
        const batches = [
            { peerId: selfId, blockId, payload: 'payload', excludedPeers: [] }
        ];
        const originalErr = new Error('FIRST_ATTEMPT_FAILURE: pend timed out waiting for restoration');
        const retryErr = Object.assign(new Error('Self-coordination exhausted on solo/bootstrap node (self already attempted).'), { code: 'SELF_COORDINATION_EXHAUSTED' });
        let processCalls = 0;
        let findCoordinatorCalls = 0;
        await processBatches(batches, async () => { processCalls++; throw originalErr; }, () => [blockId], (payload) => payload, Date.now() + 5000, async (_bid, _opts) => {
            findCoordinatorCalls++;
            // Simulate solo-bootstrap: self now excluded → retry-exhausted.
            throw retryErr;
        });
        // Process was attempted once; findCoordinator was consulted for retry.
        expect(processCalls).to.equal(1);
        expect(findCoordinatorCalls).to.equal(1);
        // batch.request must preserve the original error — NOT the retry-exhausted error.
        const batch = batches[0];
        expect(batch.request).to.exist;
        expect(batch.request.isError).to.be.true;
        expect(batch.request.error).to.equal(originalErr);
        expect(batch.request.error.message).to.include('FIRST_ATTEMPT_FAILURE');
    });
    it('propagates original error when retry path produces a successful new batch', async () => {
        const selfId = makePeerId('self-peer');
        const otherId = makePeerId('other-peer');
        const blockId = 'b1';
        const batches = [
            { peerId: selfId, blockId, payload: 'p', excludedPeers: [] }
        ];
        const originalErr = new Error('first-failure');
        let callsFor = [];
        await processBatches(batches, async (b) => {
            callsFor.push(b.peerId.toString());
            if (b.peerId.toString() === 'self-peer')
                throw originalErr;
            return 'ok';
        }, () => [blockId], (payload) => payload, Date.now() + 5000, async (_bid, opts) => {
            // On retry, hand back a different peer so retries work
            const excluded = new Set(opts.excludedPeers.map(p => p.toString()));
            if (excluded.has('self-peer'))
                return otherId;
            return selfId;
        });
        // Original batch carries original error
        expect(batches[0].request.error).to.equal(originalErr);
        // Retry batch(es) attached via subsumedBy should have succeeded
        const retries = batches[0].subsumedBy ?? [];
        expect(retries.length).to.be.greaterThan(0);
        expect(retries[0].request?.response).to.equal('ok');
    });
});
//# sourceMappingURL=batch-coordinator.spec.js.map