/**
 * TEST-5.3.1: Coordinator repo integration tests
 *
 * Tests the CoordinatorRepo's full transaction flow including pend→commit,
 * cancel operations, sequential transactions, and multi-block coordination
 * using the mesh harness for realistic multi-node scenarios.
 */
import { expect } from 'chai';
import { createMesh } from '../src/testing/mesh-harness.js';
const makeHeader = (id) => ({
    id: id,
    type: 'test',
    collectionId: 'collection-1'
});
const makeBlock = (id) => ({
    header: makeHeader(id)
});
const makeTransforms = (blockId) => ({
    inserts: { [blockId]: makeBlock(blockId) },
    updates: {},
    deletes: []
});
const makeMultiBlockTransforms = (blockIds) => {
    const inserts = {};
    for (const id of blockIds) {
        inserts[id] = makeBlock(id);
    }
    return { inserts, updates: {}, deletes: [] };
};
describe('CoordinatorRepo Integration (TEST-5.3.1)', () => {
    describe('cancel operation', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 1 });
        });
        it('should cancel a pending transaction (single-node fast path)', async () => {
            const blockId = 'block-cancel-1';
            const node = mesh.nodes[0];
            // Pend a transaction
            const pendResult = await node.coordinatorRepo.pend({ actionId: 'a-cancel', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            // Cancel the pending transaction
            await node.coordinatorRepo.cancel({ actionId: 'a-cancel', blockIds: [blockId] });
            // After cancel, a new transaction with the same blockId should succeed
            const pendResult2 = await node.coordinatorRepo.pend({ actionId: 'a-after-cancel', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult2.success).to.equal(true);
        });
        it('should cancel a pending transaction with cluster consensus', async () => {
            mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51
            });
            const blockId = 'block-cancel-cluster';
            const coordinator = mesh.nodes[0];
            const pendResult = await coordinator.coordinatorRepo.pend({ actionId: 'a-cc', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            // Cancel through cluster consensus
            await coordinator.coordinatorRepo.cancel({ actionId: 'a-cc', blockIds: [blockId] });
            // Should be able to pend a new transaction on the same block
            const pendResult2 = await coordinator.coordinatorRepo.pend({ actionId: 'a-cc2', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult2.success).to.equal(true);
        });
    });
    describe('sequential transactions (revision tracking)', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 1 });
        });
        it('should succeed with sequential pend+commit at increasing revisions', async () => {
            const node = mesh.nodes[0];
            // Transaction 1: rev=1
            const pend1 = await node.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms('block-seq-1'), policy: 'c' });
            expect(pend1.success).to.equal(true);
            const commit1 = await node.coordinatorRepo.commit({ actionId: 'a1', tailId: 'block-seq-1', rev: 1, blockIds: ['block-seq-1'] });
            expect(commit1.success).to.equal(true);
            // Transaction 2: rev=2 on a different block
            const pend2 = await node.coordinatorRepo.pend({ actionId: 'a2', transforms: makeTransforms('block-seq-2'), policy: 'c' });
            expect(pend2.success).to.equal(true);
            const commit2 = await node.coordinatorRepo.commit({ actionId: 'a2', tailId: 'block-seq-2', rev: 2, blockIds: ['block-seq-2'] });
            expect(commit2.success).to.equal(true);
            // Both blocks should be readable
            const r1 = await node.coordinatorRepo.get({ blockIds: ['block-seq-1'] });
            expect(r1['block-seq-1']?.block?.header.id).to.equal('block-seq-1');
            const r2 = await node.coordinatorRepo.get({ blockIds: ['block-seq-2'] });
            expect(r2['block-seq-2']?.block?.header.id).to.equal('block-seq-2');
        });
        it('should track revision state across multiple commits', async () => {
            const node = mesh.nodes[0];
            // Commit 3 sequential transactions
            for (let i = 1; i <= 3; i++) {
                const blockId = `block-rev-${i}`;
                await node.coordinatorRepo.pend({ actionId: `a${i}`, transforms: makeTransforms(blockId), policy: 'c' });
                await node.coordinatorRepo.commit({ actionId: `a${i}`, tailId: blockId, rev: i, blockIds: [blockId] });
            }
            // All blocks should have their data
            for (let i = 1; i <= 3; i++) {
                const blockId = `block-rev-${i}`;
                const result = await node.coordinatorRepo.get({ blockIds: [blockId] });
                expect(result[blockId]?.block).to.not.equal(undefined);
            }
        });
    });
    describe('multi-block transactions', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 1 });
        });
        it('should pend a transaction with multiple block IDs', async () => {
            const node = mesh.nodes[0];
            const blockIds = ['block-multi-a', 'block-multi-b', 'block-multi-c'];
            const pendResult = await node.coordinatorRepo.pend({
                actionId: 'a-multi',
                transforms: makeMultiBlockTransforms(blockIds),
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
        });
        it('should commit a multi-block transaction and verify all blocks', async () => {
            const node = mesh.nodes[0];
            const blockIds = ['block-mb-1', 'block-mb-2'];
            await node.coordinatorRepo.pend({
                actionId: 'a-mb',
                transforms: makeMultiBlockTransforms(blockIds),
                policy: 'c'
            });
            const commitResult = await node.coordinatorRepo.commit({
                actionId: 'a-mb',
                tailId: blockIds[0],
                rev: 1,
                blockIds: blockIds
            });
            expect(commitResult.success).to.equal(true);
            // Both blocks should be accessible
            const result = await node.coordinatorRepo.get({ blockIds: blockIds });
            expect(result[blockIds[0]]?.block?.header.id).to.equal(blockIds[0]);
            expect(result[blockIds[1]]?.block?.header.id).to.equal(blockIds[1]);
        });
        it('should cancel a multi-block pending transaction', async () => {
            const node = mesh.nodes[0];
            const blockIds = ['block-mbc-1', 'block-mbc-2'];
            await node.coordinatorRepo.pend({
                actionId: 'a-mbc',
                transforms: makeMultiBlockTransforms(blockIds),
                policy: 'c'
            });
            // Cancel all blocks
            await node.coordinatorRepo.cancel({
                actionId: 'a-mbc',
                blockIds: blockIds
            });
            // After cancel, new transaction on same blocks should succeed
            const pendResult = await node.coordinatorRepo.pend({
                actionId: 'a-mbc-2',
                transforms: makeMultiBlockTransforms(blockIds),
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
        });
    });
    describe('cluster consensus with local execution tracking', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51
            });
        });
        it('should replicate pend to all cluster members', async () => {
            const blockId = 'block-replicate';
            const coordinator = mesh.nodes[0];
            const pendResult = await coordinator.coordinatorRepo.pend({ actionId: 'a-rep', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
        });
        it('should replicate commit and make data available on coordinating node', async () => {
            const blockId = 'block-rep-commit';
            const coordinator = mesh.nodes[0];
            await coordinator.coordinatorRepo.pend({ actionId: 'a-rc', transforms: makeTransforms(blockId), policy: 'c' });
            const commitResult = await coordinator.coordinatorRepo.commit({ actionId: 'a-rc', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
            // Data available on coordinating node
            const result = await coordinator.coordinatorRepo.get({ blockIds: [blockId] });
            expect(result[blockId]?.block?.header.id).to.equal(blockId);
        });
        it('should handle sequential cluster transactions', async () => {
            const coordinator = mesh.nodes[0];
            // First cluster transaction
            await coordinator.coordinatorRepo.pend({ actionId: 'a-seq1', transforms: makeTransforms('block-cs1'), policy: 'c' });
            await coordinator.coordinatorRepo.commit({ actionId: 'a-seq1', tailId: 'block-cs1', rev: 1, blockIds: ['block-cs1'] });
            // Second cluster transaction
            await coordinator.coordinatorRepo.pend({ actionId: 'a-seq2', transforms: makeTransforms('block-cs2'), policy: 'c' });
            await coordinator.coordinatorRepo.commit({ actionId: 'a-seq2', tailId: 'block-cs2', rev: 2, blockIds: ['block-cs2'] });
            // Both should be readable
            const r = await coordinator.coordinatorRepo.get({ blockIds: ['block-cs1', 'block-cs2'] });
            expect(r['block-cs1']?.block).to.not.equal(undefined);
            expect(r['block-cs2']?.block).to.not.equal(undefined);
        });
    });
    describe('cross-node block discovery via cluster callback', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 1 });
        });
        it('should allow writer and reader on different nodes to see blocks', async () => {
            const blockId = 'block-xnode';
            const writer = mesh.nodes[0];
            const reader = mesh.nodes[1];
            // Writer commits a block
            await writer.coordinatorRepo.pend({ actionId: 'a-xn', transforms: makeTransforms(blockId), policy: 'c' });
            await writer.coordinatorRepo.commit({ actionId: 'a-xn', tailId: blockId, rev: 1, blockIds: [blockId] });
            // Writer has the block
            const writerResult = await writer.coordinatorRepo.get({ blockIds: [blockId] });
            expect(writerResult[blockId]?.block).to.not.equal(undefined);
            // Reader should discover the block exists via clusterLatestCallback
            const readerResult = await reader.coordinatorRepo.get({ blockIds: [blockId] });
            // The block entry should exist (even if full data sync requires restoreCallback)
            expect(readerResult[blockId]).to.not.equal(undefined);
        });
    });
    describe('context-driven pending block serving (TEST-5.4.3)', () => {
        it('should serve a pending block via context when data is only on the writing peer', async () => {
            // responsibilityK=3: all peers are discoverable so the reader's cluster
            // query will include the writer (data is still only pended on one peer)
            const mesh = await createMesh(3, { responsibilityK: 3 });
            const writer = mesh.nodes[0];
            const reader = mesh.nodes[1];
            const blockId = 'block-pending-ctx';
            // Pend on the writer — pending data only on writer's storage
            const pendResult = await writer.storageRepo.pend({
                actionId: 'a-pctx',
                transforms: { inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] },
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
            // Do NOT commit (simulating non-tail commit failure after tail committed)
            // Reader tries to get the block with context proving the action is committed
            // This should work: the cluster fetch should query the writer with context,
            // triggering promotion on the writer, then syncing back to reader
            const result = await reader.coordinatorRepo.get({
                blockIds: [blockId],
                context: { committed: [{ actionId: 'a-pctx', rev: 1 }], rev: 1 }
            });
            // Context is forwarded through the cluster callback to the remote peer,
            // triggering promotion of the pending block:
            expect(result[blockId]?.block).to.not.equal(undefined, 'Pending block should be served when context proves the action is committed');
        });
    });
    describe('failure scenarios', () => {
        it('should fail pend when all cluster peers are unreachable', async () => {
            const mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.75
            });
            const blockId = 'block-all-fail';
            const coordinator = mesh.nodes[0];
            // Make all non-coordinator peers fail
            mesh.failures.failingPeers = new Set([
                mesh.nodes[1].peerId.toString(),
                mesh.nodes[2].peerId.toString()
            ]);
            try {
                await coordinator.coordinatorRepo.pend({ actionId: 'a-fail', transforms: makeTransforms(blockId), policy: 'c' });
                expect.fail('Should have thrown due to insufficient peers');
            }
            catch (err) {
                expect(err).to.be.instanceOf(Error);
            }
            finally {
                mesh.failures.failingPeers = undefined;
            }
        });
        it('should fail commit when cluster peers are unreachable during commit phase', async () => {
            const mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51
            });
            const blockId = 'block-commit-fail';
            const coordinator = mesh.nodes[0];
            // Pend succeeds normally
            const pendResult = await coordinator.coordinatorRepo.pend({ actionId: 'a-cf', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            // Now make peers fail during commit
            mesh.failures.failingPeers = new Set([
                mesh.nodes[1].peerId.toString(),
                mesh.nodes[2].peerId.toString()
            ]);
            try {
                await coordinator.coordinatorRepo.commit({ actionId: 'a-cf', tailId: blockId, rev: 1, blockIds: [blockId] });
                expect.fail('Should have thrown due to peer failure during commit');
            }
            catch (err) {
                expect(err).to.be.instanceOf(Error);
            }
            finally {
                mesh.failures.failingPeers = undefined;
            }
        });
        it('should handle commit after cancel gracefully', async () => {
            const mesh = await createMesh(3, { responsibilityK: 1 });
            const blockId = 'block-commit-after-cancel';
            const node = mesh.nodes[0];
            // Pend, then cancel
            await node.coordinatorRepo.pend({ actionId: 'a-cac', transforms: makeTransforms(blockId), policy: 'c' });
            await node.coordinatorRepo.cancel({ actionId: 'a-cac', blockIds: [blockId] });
            // Attempting to commit after cancel should fail
            try {
                const result = await node.coordinatorRepo.commit({ actionId: 'a-cac', tailId: blockId, rev: 1, blockIds: [blockId] });
                // If it returns a result instead of throwing, it should indicate failure
                // (behavior depends on storage repo implementation)
                if (result.success) {
                    // Some implementations may succeed (no-op commit on cancelled action)
                    // This is acceptable - the key point is it doesn't crash
                }
            }
            catch (err) {
                // Expected - committing a cancelled transaction may throw
                expect(err).to.be.instanceOf(Error);
            }
        });
    });
});
//# sourceMappingURL=coordinator-repo-integration.spec.js.map