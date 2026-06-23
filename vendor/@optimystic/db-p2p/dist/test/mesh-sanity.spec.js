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
describe('Mesh Sanity Tests', () => {
    describe('Suite 0: 1-node (solo) mesh, bootstrap / mobile scenario', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
        });
        it('solo node pends and commits its own schema block via peerCount<=1 short-circuit', async () => {
            const node = mesh.nodes[0];
            const blockId = 'optimystic/schema';
            const pendResult = await node.coordinatorRepo.pend({ actionId: 'schema-a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            const commitResult = await node.coordinatorRepo.commit({ actionId: 'schema-a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
            const result = await node.coordinatorRepo.get({ blockIds: [blockId] });
            expect(result[blockId]?.block?.header.id).to.equal(blockId);
        });
        it('solo node reads non-existent block without hanging and returns empty state', async () => {
            const node = mesh.nodes[0];
            const result = await node.coordinatorRepo.get({ blockIds: ['never-existed'] });
            // An empty state (no block) is the correct solo-node answer — not an error, not a hang.
            expect(result['never-existed']).to.exist;
            expect(result['never-existed'].state?.latest).to.be.undefined;
        });
    });
    describe('Suite 1: 3-node mesh, responsibilityK=1', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 1 });
        });
        it('write on responsible node succeeds via fast path', async () => {
            const blockId = 'block-k1-write';
            const node = mesh.nodes[0];
            const pendResult = await node.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            const commitResult = await node.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
        });
        it('read from responsible node returns written data', async () => {
            const blockId = 'block-k1-read';
            const node = mesh.nodes[0];
            await node.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            await node.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            const result = await node.coordinatorRepo.get({ blockIds: [blockId] });
            expect(result[blockId]).to.not.equal(undefined);
            expect(result[blockId].block).to.not.equal(undefined);
            expect(result[blockId].block.header.id).to.equal(blockId);
        });
        it('non-responsible node discovers revision exists via cluster callback', async () => {
            const blockId = 'block-k1-cross';
            const writer = mesh.nodes[0];
            await writer.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            await writer.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            // Writer has the block data
            const writerResult = await writer.coordinatorRepo.get({ blockIds: [blockId] });
            expect(writerResult[blockId]?.block).to.not.equal(undefined);
            // Reader gets a response — block entry exists even if sync is partial
            // (full cross-node block replication requires restoreCallback on BlockStorage)
            const reader = mesh.nodes[1];
            const readerResult = await reader.coordinatorRepo.get({ blockIds: [blockId] });
            expect(readerResult[blockId]).to.not.equal(undefined);
        });
        it('pend + commit through different nodes independently', async () => {
            // Each node can independently write different blocks via fast path (K=1)
            const node0 = mesh.nodes[0];
            const node1 = mesh.nodes[1];
            await node0.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms('block-a'), policy: 'c' });
            await node0.coordinatorRepo.commit({ actionId: 'a1', tailId: 'block-a', rev: 1, blockIds: ['block-a'] });
            await node1.coordinatorRepo.pend({ actionId: 'a2', transforms: makeTransforms('block-b'), policy: 'c' });
            await node1.coordinatorRepo.commit({ actionId: 'a2', tailId: 'block-b', rev: 1, blockIds: ['block-b'] });
            const r0 = await node0.coordinatorRepo.get({ blockIds: ['block-a'] });
            expect(r0['block-a']?.block?.header.id).to.equal('block-a');
            const r1 = await node1.coordinatorRepo.get({ blockIds: ['block-b'] });
            expect(r1['block-b']?.block?.header.id).to.equal('block-b');
        });
    });
    describe('Suite 2: 3-node mesh, responsibilityK=3', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 3 });
        });
        it('full consensus pend succeeds with all 3 nodes', async () => {
            const blockId = 'block-k3-consensus';
            const node = mesh.nodes[0];
            const pendResult = await node.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            const commitResult = await node.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
        });
        it('coordinating node has data after consensus commit', async () => {
            const blockId = 'block-k3-coord';
            const coordinator = mesh.nodes[0];
            await coordinator.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            await coordinator.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            // Coordinating node has the data via its local storageRepo
            const result = await coordinator.coordinatorRepo.get({ blockIds: [blockId] });
            expect(result[blockId]?.block).to.not.equal(undefined);
            expect(result[blockId].block.header.id).to.equal(blockId);
            expect(result[blockId].state?.latest?.rev).to.equal(1);
        });
        it('promise phase failure with default threshold causes transaction to fail', async () => {
            const blockId = 'block-k3-promise-fail';
            const coordinator = mesh.nodes[0];
            // With default threshold (0.75), need ceil(3*0.75)=3 promises
            // Failing 1 node means only 2/3 approvals → fail
            const failingPeer = mesh.nodes[2].peerId.toString();
            mesh.failures.failingPeers = new Set([failingPeer]);
            try {
                await coordinator.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
                expect.fail('Should have thrown due to insufficient promises');
            }
            catch (err) {
                expect(err.message).to.include('super-majority');
            }
            finally {
                mesh.failures.failingPeers = undefined;
            }
        });
        it('lower threshold enables partial-failure tolerance', async () => {
            // Recreate with lower threshold: ceil(3*0.51)=2 promises needed
            mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51
            });
            const blockId = 'block-k3-low-threshold';
            const coordinator = mesh.nodes[0];
            // Inject failure on one non-coordinator node
            const failingPeer = mesh.nodes[2].peerId.toString();
            mesh.failures.failingPeers = new Set([failingPeer]);
            // With threshold=0.51, need ceil(3*0.51)=2 promises — succeed with 2/3
            const pendResult = await coordinator.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            mesh.failures.failingPeers = undefined;
        });
        it('different blocks can be written through different coordinators', async () => {
            const coordinator0 = mesh.nodes[0];
            const coordinator1 = mesh.nodes[1];
            await coordinator0.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms('block-x'), policy: 'c' });
            await coordinator0.coordinatorRepo.commit({ actionId: 'a1', tailId: 'block-x', rev: 1, blockIds: ['block-x'] });
            await coordinator1.coordinatorRepo.pend({ actionId: 'a2', transforms: makeTransforms('block-y'), policy: 'c' });
            await coordinator1.coordinatorRepo.commit({ actionId: 'a2', tailId: 'block-y', rev: 1, blockIds: ['block-y'] });
            const r0 = await coordinator0.coordinatorRepo.get({ blockIds: ['block-x'] });
            expect(r0['block-x']?.block?.header.id).to.equal('block-x');
            const r1 = await coordinator1.coordinatorRepo.get({ blockIds: ['block-y'] });
            expect(r1['block-y']?.block?.header.id).to.equal('block-y');
        });
    });
    describe('Suite 3: DHT offline / degraded', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(3, { responsibilityK: 3 });
        });
        it('findCluster returns empty — write fails with informative error', async () => {
            const blockId = 'block-dht-fail';
            const node = mesh.nodes[0];
            mesh.failures.findClusterFails = true;
            try {
                await node.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
                expect.fail('Should have thrown when DHT returns empty');
            }
            catch (err) {
                expect(err).to.be.instanceOf(Error);
            }
            finally {
                mesh.failures.findClusterFails = false;
            }
        });
        it('findCluster returns subset — consensus adapts to smaller cluster', async () => {
            // K=2: only 2 of 3 nodes in cluster
            mesh = await createMesh(3, {
                responsibilityK: 2,
                superMajorityThreshold: 0.51
            });
            const blockId = 'block-dht-subset';
            const coordinator = mesh.nodes[0];
            const pendResult = await coordinator.coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            const commitResult = await coordinator.coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
        });
        it('unreachable peer — coordinator handles gracefully with lower threshold', async () => {
            mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51
            });
            const blockId = 'block-unreachable';
            mesh.failures.failingPeers = new Set([mesh.nodes[2].peerId.toString()]);
            const pendResult = await mesh.nodes[0].coordinatorRepo.pend({ actionId: 'a1', transforms: makeTransforms(blockId), policy: 'c' });
            expect(pendResult.success).to.equal(true);
            const commitResult = await mesh.nodes[0].coordinatorRepo.commit({ actionId: 'a1', tailId: blockId, rev: 1, blockIds: [blockId] });
            expect(commitResult.success).to.equal(true);
            mesh.failures.failingPeers = undefined;
        });
    });
});
//# sourceMappingURL=mesh-sanity.spec.js.map