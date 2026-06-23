import { expect } from 'chai';
import { Tree, NetworkTransactor } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { RepoClient } from '../src/repo/client.js';
describe('Fresh-node DDL (real libp2p, clusterSize=1, arachnode)', function () {
    // Real libp2p node boot + TCP listener + arachnode/ring-zulu init is the slow part;
    // individual ops should finish in seconds but overall setup dominates the budget.
    this.timeout(30_000);
    let node;
    let transactor;
    beforeEach(async () => {
        node = await createLibp2pNode({
            port: 0,
            networkName: 'fresh-ddl-test',
            bootstrapNodes: [],
            fretProfile: 'edge',
            clusterSize: 1,
            clusterPolicy: {
                allowDownsize: true,
                sizeTolerance: 1.0
            },
            arachnode: {
                enableRingZulu: true
            }
        });
        const coordinatedRepo = node.coordinatedRepo;
        if (!coordinatedRepo)
            throw new Error('coordinatedRepo not created');
        const keyNetwork = new Libp2pKeyPeerNetwork(node);
        const protocolPrefix = `/optimystic/fresh-ddl-test`;
        const getRepo = (peerId) => {
            if (peerId.toString() === node.peerId.toString())
                return coordinatedRepo;
            return RepoClient.create(peerId, keyNetwork, protocolPrefix);
        };
        transactor = new NetworkTransactor({
            timeoutMs: 10_000,
            abortOrCancelTimeoutMs: 5_000,
            keyNetwork: keyNetwork,
            getRepo: getRepo
        });
    });
    afterEach(async () => {
        await node?.stop();
    });
    it('fresh Tree.createOrOpen + tree.replace on a solo libp2p node', async () => {
        const tree = await Tree.createOrOpen(transactor, 'solo-libp2p-tree', entry => entry.key);
        const entry = { key: 1, value: 'first' };
        // Expected failure on main (per ticket): `Error: Cannot add to non-existent chain`.
        await tree.replace([[entry.key, entry]]);
        const retrieved = await tree.get(entry.key);
        expect(retrieved).to.deep.equal(entry);
    });
});
//# sourceMappingURL=fresh-node-ddl-libp2p.spec.js.map