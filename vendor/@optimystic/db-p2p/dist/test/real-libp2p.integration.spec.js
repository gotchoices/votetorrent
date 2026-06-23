import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
// Real-libp2p integration smoke tests. Exercises the production transport wiring
// (createLibp2pNode + RestorationCoordinator + Libp2pKeyPeerNetwork) end-to-end
// over actual TCP so transport-level regressions that mocks cannot catch (ticket-4
// "solo node / no listen addrs / dial-self hang" class) fail loudly here.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 so default `npm test` stays fast. Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p
// Windows (PowerShell):
//   $env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p
const NETWORK_NAME = 'real-libp2p-it';
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
async function pendCommitGet(repo, blockId, actionId, rev) {
    const pendResult = await repo.pend({
        actionId,
        transforms: makeTransforms(blockId),
        policy: 'c'
    });
    expect(pendResult.success, `pend(${blockId})`).to.equal(true);
    const commitResult = await repo.commit({
        actionId,
        tailId: blockId,
        rev,
        blockIds: [blockId]
    });
    expect(commitResult.success, `commit(${blockId})`).to.equal(true);
    const getResult = await repo.get({ blockIds: [blockId] });
    expect(getResult[blockId]?.block?.header.id, `get(${blockId})`).to.equal(blockId);
    return getResult;
}
function pickLocalTcpMultiaddr(node) {
    const addrs = node.getMultiaddrs().map(a => a.toString());
    const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
        ?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
    if (!local)
        throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
    return local;
}
async function waitForPeers(node, minPeers, timeoutMs) {
    if (node.getPeers().length >= minPeers)
        return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            node.removeEventListener('peer:connect', check);
            reject(new Error(`Timeout waiting for ${minPeers} peers after ${timeoutMs}ms`));
        }, timeoutMs);
        const check = () => {
            if (node.getPeers().length >= minPeers) {
                clearTimeout(timer);
                node.removeEventListener('peer:connect', check);
                resolve();
            }
        };
        node.addEventListener('peer:connect', check);
    });
}
describe('Real libp2p integration', function () {
    // Individual ops should finish in seconds; boot + arachnode init dominates.
    this.timeout(30_000);
    before(function () {
        if (!process.env.OPTIMYSTIC_INTEGRATION)
            this.skip();
    });
    let nodes = [];
    async function spawnNode(overrides = {}) {
        const node = await createLibp2pNode({
            port: 0,
            networkName: NETWORK_NAME,
            bootstrapNodes: [],
            fretProfile: 'edge',
            clusterSize: 1,
            clusterPolicy: {
                allowDownsize: true,
                sizeTolerance: 1.0
            },
            arachnode: { enableRingZulu: true },
            ...overrides
        });
        nodes.push(node);
        return node;
    }
    afterEach(async () => {
        const toStop = nodes;
        nodes = [];
        await Promise.allSettled(toStop.map(n => n.stop()));
    });
    it('solo node, empty bootstrap, no listen addrs (ticket-4 reproducer)', async function () {
        this.timeout(15_000);
        const node = await spawnNode({ listenAddrs: [] });
        const repo = node.coordinatedRepo;
        expect(repo, 'coordinatedRepo').to.exist;
        await pendCommitGet(repo, 'optimystic/schema', 'schema-a1', 1);
    });
    it('solo node, default TCP listen addr (port: 0)', async function () {
        this.timeout(15_000);
        const node = await spawnNode();
        const repo = node.coordinatedRepo;
        await pendCommitGet(repo, 'optimystic/schema', 'schema-default-a1', 1);
    });
    it('two-node mesh over TCP', async function () {
        this.timeout(20_000);
        const a = await spawnNode();
        const bootstrapAddr = pickLocalTcpMultiaddr(a);
        const b = await spawnNode({
            bootstrapNodes: [bootstrapAddr],
            fretProfile: 'core'
        });
        await waitForPeers(b, 1, 5_000);
        const aRepo = a.coordinatedRepo;
        const bRepo = b.coordinatedRepo;
        const blockId = 'two-node-block';
        const pendResult = await aRepo.pend({
            actionId: 'two-a1',
            transforms: makeTransforms(blockId),
            policy: 'c'
        });
        expect(pendResult.success, 'A.pend').to.equal(true);
        const commitResult = await aRepo.commit({
            actionId: 'two-a1',
            tailId: blockId,
            rev: 1,
            blockIds: [blockId]
        });
        expect(commitResult.success, 'A.commit').to.equal(true);
        const bResult = await bRepo.get({ blockIds: [blockId] });
        // B either has the block via replication/restore OR a defined empty-state entry —
        // the smoke test here is "no hang and no transport error", which a successful return satisfies.
        expect(bResult[blockId], 'B.get returns an entry for the block').to.exist;
    });
    it('three-node mesh with one peer dropped at boot', async function () {
        this.timeout(25_000);
        const a = await spawnNode({
            clusterSize: 2,
            clusterPolicy: {
                allowDownsize: true,
                sizeTolerance: 1.0,
                superMajorityThreshold: 0.51
            }
        });
        const bootstrapAddr = pickLocalTcpMultiaddr(a);
        const b = await spawnNode({
            bootstrapNodes: [bootstrapAddr],
            clusterSize: 2,
            clusterPolicy: {
                allowDownsize: true,
                sizeTolerance: 1.0,
                superMajorityThreshold: 0.51
            },
            fretProfile: 'core'
        });
        const c = await spawnNode({
            bootstrapNodes: [bootstrapAddr],
            clusterSize: 2,
            clusterPolicy: {
                allowDownsize: true,
                sizeTolerance: 1.0,
                superMajorityThreshold: 0.51
            },
            fretProfile: 'core'
        });
        // Drop C immediately to simulate peer that vanishes during join.
        await c.stop();
        // Remove from nodes[] so afterEach does not double-stop.
        nodes = nodes.filter(n => n !== c);
        await waitForPeers(b, 1, 5_000);
        const aRepo = a.coordinatedRepo;
        const bRepo = b.coordinatedRepo;
        const blockId = 'three-node-dropped';
        const pendResult = await aRepo.pend({
            actionId: 'drop-a1',
            transforms: makeTransforms(blockId),
            policy: 'c'
        });
        expect(pendResult.success, 'A.pend with C dropped').to.equal(true);
        const commitResult = await aRepo.commit({
            actionId: 'drop-a1',
            tailId: blockId,
            rev: 1,
            blockIds: [blockId]
        });
        expect(commitResult.success, 'A.commit with C dropped').to.equal(true);
        const bResult = await bRepo.get({ blockIds: [blockId] });
        expect(bResult[blockId], 'B.get after C dropped').to.exist;
    });
    it('cold-restart over real transport with shared storage', async function () {
        this.timeout(20_000);
        const storage = new MemoryRawStorage();
        const privateKey = await generateKeyPair('Ed25519');
        const node1 = await spawnNode({
            listenAddrs: [],
            storage,
            privateKey
        });
        const repo1 = node1.coordinatedRepo;
        const blockId = 'cold-restart-block';
        const pend = await repo1.pend({
            actionId: 'cold-a1',
            transforms: makeTransforms(blockId),
            policy: 'c'
        });
        expect(pend.success, 'pre-restart pend').to.equal(true);
        const commit = await repo1.commit({
            actionId: 'cold-a1',
            tailId: blockId,
            rev: 1,
            blockIds: [blockId]
        });
        expect(commit.success, 'pre-restart commit').to.equal(true);
        await node1.stop();
        nodes = nodes.filter(n => n !== node1);
        const node2 = await spawnNode({
            listenAddrs: [],
            storage,
            privateKey
        });
        const repo2 = node2.coordinatedRepo;
        const result = await repo2.get({ blockIds: [blockId] });
        expect(result[blockId]?.block?.header.id, 'post-restart get').to.equal(blockId);
    });
});
//# sourceMappingURL=real-libp2p.integration.spec.js.map