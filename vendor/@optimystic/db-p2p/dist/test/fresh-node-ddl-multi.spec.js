import { expect } from 'chai';
import { Tree } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors } from '../src/testing/mesh-harness.js';
const transactorFor = (transactors, peerIdStr) => {
    const t = transactors.get(peerIdStr);
    if (!t)
        throw new Error(`No transactor for peer ${peerIdStr}`);
    return t;
};
describe('Fresh-node DDL (multi-node, real production stack)', function () {
    describe('Scenario A — 3-node cold-start, DDL on A / SELECT on B and C', function () {
        // Multi-node consensus is slower than solo; 10s keeps any hang from
        // stalling CI forever while still being comfortably above normal runtime.
        this.timeout(10_000);
        let mesh;
        let transactors;
        beforeEach(async () => {
            mesh = await createMesh(3, {
                responsibilityK: 3,
                clusterSize: 3,
                superMajorityThreshold: 0.67
            });
            transactors = buildNetworkTransactors(mesh);
        });
        it('DDL on A round-trips to SELECT on B and C', async () => {
            const treeId = 'multi-3-ddl-select';
            const keyFn = (entry) => entry.key;
            const value = { key: 1, value: 'from-A' };
            const nodeA = mesh.nodes[0];
            const nodeB = mesh.nodes[1];
            const nodeC = mesh.nodes[2];
            // 1. First DDL/DML ever on the mesh — driven by node A.
            const treeA = await Tree.createOrOpen(transactorFor(transactors, nodeA.peerId.toString()), treeId, keyFn);
            await treeA.replace([[value.key, value]]);
            // 2. Fresh SELECT from node B — must see A's write.
            const treeB = await Tree.createOrOpen(transactorFor(transactors, nodeB.peerId.toString()), treeId, keyFn);
            expect(await treeB.get(value.key)).to.deep.equal(value);
            // 3. Same SELECT from node C — confirms all three replicas converged.
            const treeC = await Tree.createOrOpen(transactorFor(transactors, nodeC.peerId.toString()), treeId, keyFn);
            expect(await treeC.get(value.key)).to.deep.equal(value);
        });
    });
    describe('Scenario B — 5-node cold-start with one peer down at boot', function () {
        // 15s: 5-node consensus + super-majority math across 4 reachable peers
        // costs more round-trips than the 3-node case.
        this.timeout(15_000);
        let mesh;
        let transactors;
        beforeEach(async () => {
            mesh = await createMesh(5, {
                responsibilityK: 5,
                clusterSize: 5,
                superMajorityThreshold: 0.6
            });
            // Mark peer 4 unreachable before the first transaction ever runs —
            // super-majority of 5 at 0.6 = 3 required, 4 reachable peers still satisfy it.
            mesh.failures.failingPeers = new Set([mesh.nodes[4].peerId.toString()]);
            transactors = buildNetworkTransactors(mesh);
        });
        it('DDL on A completes with peer E unreachable; SELECT on B sees the write', async () => {
            const treeId = 'multi-5-cold-start';
            const keyFn = (entry) => entry.key;
            const value = { key: 42, value: 'despite-E-down' };
            const nodeA = mesh.nodes[0];
            const nodeB = mesh.nodes[1];
            const treeA = await Tree.createOrOpen(transactorFor(transactors, nodeA.peerId.toString()), treeId, keyFn);
            await treeA.replace([[value.key, value]]);
            const treeB = await Tree.createOrOpen(transactorFor(transactors, nodeB.peerId.toString()), treeId, keyFn);
            expect(await treeB.get(value.key)).to.deep.equal(value);
        });
    });
});
//# sourceMappingURL=fresh-node-ddl-multi.spec.js.map