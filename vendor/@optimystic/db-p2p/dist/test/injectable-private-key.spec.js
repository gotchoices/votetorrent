import { expect } from 'chai';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { createLibp2pNode } from '../src/libp2p-node.js';
describe('Injectable private key', () => {
    it('two nodes with the same private key have the same peer ID', async () => {
        const key = await generateKeyPair('Ed25519');
        const serialized = privateKeyToProtobuf(key);
        const restored = privateKeyFromProtobuf(serialized);
        const node1 = await createLibp2pNode({
            bootstrapNodes: [],
            networkName: 'test-inject-key',
            privateKey: key
        });
        const node2 = await createLibp2pNode({
            bootstrapNodes: [],
            networkName: 'test-inject-key',
            privateKey: restored
        });
        try {
            expect(node1.peerId.toString()).to.equal(node2.peerId.toString());
            expect(node1.peerId.toString()).to.equal(peerIdFromPrivateKey(key).toString());
        }
        finally {
            await node1.stop();
            await node2.stop();
        }
    });
    it('two nodes without a private key have different peer IDs', async () => {
        const node1 = await createLibp2pNode({
            bootstrapNodes: [],
            networkName: 'test-no-key'
        });
        const node2 = await createLibp2pNode({
            bootstrapNodes: [],
            networkName: 'test-no-key'
        });
        try {
            expect(node1.peerId.toString()).to.not.equal(node2.peerId.toString());
        }
        finally {
            await node1.stop();
            await node2.stop();
        }
    });
});
//# sourceMappingURL=injectable-private-key.spec.js.map