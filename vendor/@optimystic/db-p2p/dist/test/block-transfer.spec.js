import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { BlockTransferCoordinator } from '../src/cluster/block-transfer.js';
import { BlockTransferService, buildBlockTransferProtocol } from '../src/cluster/block-transfer-service.js';
// --- Mocks ---
const makeBlock = (id) => ({
    header: { id: id, type: 'test', collectionId: 'col-1' }
});
class MockRepo {
    blocks = new Map();
    async get(blockGets) {
        const result = {};
        for (const blockId of blockGets.blockIds) {
            const block = this.blocks.get(blockId);
            if (block) {
                result[blockId] = {
                    block,
                    state: { latest: { rev: 1, actionId: 'a1' } }
                };
            }
        }
        return result;
    }
    async pend(_request) {
        return { success: true, blockIds: [], pending: [] };
    }
    async commit(_request) {
        return { success: true };
    }
    async cancel(_actionRef) { }
}
class MockRestorationCoordinator {
    restoreCalls = [];
    /** blockId → archive or undefined */
    results = new Map();
    delayMs = 0;
    async restore(blockId) {
        this.restoreCalls.push(blockId);
        if (this.delayMs > 0) {
            await new Promise(r => setTimeout(r, this.delayMs));
        }
        return this.results.get(blockId);
    }
}
class MockPeerNetwork {
    connectCalls = [];
    responses = new Map();
    shouldFail = false;
    async connect(peerId, protocol) {
        this.connectCalls.push({ peerId, protocol });
        if (this.shouldFail) {
            throw new Error('Connection failed');
        }
        // Return a mock stream
        const peerIdStr = peerId.toString();
        const response = this.responses.get(peerIdStr) ?? { blocks: {}, missing: [] };
        return createMockStream(response);
    }
}
/** Create a minimal mock stream that yields a length-prefixed JSON response */
function createMockStream(response) {
    const responseBytes = new TextEncoder().encode(JSON.stringify(response));
    let sent = false;
    return {
        send(_chunk) { },
        close: async () => { },
        [Symbol.asyncIterator]: async function* () {
            if (!sent) {
                sent = true;
                // Length prefix (varint) + data
                const len = responseBytes.length;
                const prefix = new Uint8Array([len]);
                const combined = new Uint8Array(prefix.length + responseBytes.length);
                combined.set(prefix);
                combined.set(responseBytes, prefix.length);
                yield combined;
            }
        }
    };
}
const makeArchive = (blockId) => ({
    blockId,
    revisions: {
        1: {
            action: { actionId: 'a1', transform: { insert: makeBlock(blockId) } },
            block: makeBlock(blockId)
        }
    },
    range: [1, 2]
});
const makePeerId = async () => {
    const key = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(key);
};
// --- Tests ---
describe('BlockTransferCoordinator', () => {
    let repo;
    let peerNetwork;
    let restoration;
    let partitionDetector;
    let coordinator;
    beforeEach(() => {
        repo = new MockRepo();
        peerNetwork = new MockPeerNetwork();
        restoration = new MockRestorationCoordinator();
        partitionDetector = new PartitionDetector();
        coordinator = new BlockTransferCoordinator(repo, peerNetwork, restoration, partitionDetector, '', { maxConcurrency: 2, transferTimeoutMs: 5000, maxRetries: 1 });
    });
    describe('pullBlocks', () => {
        it('pulls blocks via RestorationCoordinator on gained responsibility', async () => {
            restoration.results.set('block-1', makeArchive('block-1'));
            restoration.results.set('block-2', makeArchive('block-2'));
            const result = await coordinator.pullBlocks(['block-1', 'block-2']);
            expect(result.succeeded).to.deep.equal(['block-1', 'block-2']);
            expect(result.failed).to.deep.equal([]);
            expect(restoration.restoreCalls).to.include('block-1');
            expect(restoration.restoreCalls).to.include('block-2');
        });
        it('reports failed pulls when restoration returns undefined', async () => {
            restoration.results.set('block-1', undefined);
            const result = await coordinator.pullBlocks(['block-1']);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal(['block-1']);
        });
        it('retries failed pulls up to maxRetries', async () => {
            // First attempt fails, second succeeds
            let callCount = 0;
            restoration.restore = async (blockId) => {
                callCount++;
                if (callCount === 1)
                    return undefined;
                return makeArchive(blockId);
            };
            const result = await coordinator.pullBlocks(['block-1']);
            expect(result.succeeded).to.deep.equal(['block-1']);
            expect(callCount).to.equal(2);
        });
        it('skips transfer during partition', async () => {
            // Simulate partition by recording many failures
            for (let i = 0; i < 10; i++) {
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
            }
            restoration.results.set('block-1', makeArchive('block-1'));
            const result = await coordinator.pullBlocks(['block-1']);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal(['block-1']);
            expect(restoration.restoreCalls).to.have.length(0);
        });
    });
    describe('pushBlocks', () => {
        it('pushes blocks to new owners on lost responsibility', async () => {
            repo.blocks.set('block-1', makeBlock('block-1'));
            const ownerId = await makePeerId();
            const ownerIdStr = ownerId.toString();
            peerNetwork.responses.set(ownerIdStr, {
                blocks: { 'block-1': 'data' },
                missing: []
            });
            const newOwners = new Map([
                ['block-1', [ownerIdStr]]
            ]);
            const result = await coordinator.pushBlocks(['block-1'], newOwners);
            expect(result.succeeded).to.deep.equal(['block-1']);
            expect(result.failed).to.deep.equal([]);
        });
        it('fails push when no local data available', async () => {
            // repo has no blocks
            const ownerId = await makePeerId();
            const newOwners = new Map([
                ['block-1', [ownerId.toString()]]
            ]);
            const result = await coordinator.pushBlocks(['block-1'], newOwners);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal(['block-1']);
        });
        it('skips push when enablePush is false', async () => {
            const noPushCoordinator = new BlockTransferCoordinator(repo, peerNetwork, restoration, partitionDetector, '', { enablePush: false });
            const newOwners = new Map([
                ['block-1', ['some-peer']]
            ]);
            const result = await noPushCoordinator.pushBlocks(['block-1'], newOwners);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal([]);
        });
        it('skips push during partition', async () => {
            for (let i = 0; i < 10; i++) {
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
                partitionDetector.recordFailure(`peer-${i}`);
            }
            repo.blocks.set('block-1', makeBlock('block-1'));
            const newOwners = new Map([
                ['block-1', ['some-peer']]
            ]);
            const result = await coordinator.pushBlocks(['block-1'], newOwners);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal(['block-1']);
        });
    });
    describe('concurrency limiting', () => {
        it('does not deadlock when all concurrent tasks retry', async function () {
            // Tighter than the 10s package default: this test is a forcing function for a
            // concurrency deadlock — if the pull ever hangs, we want a fast-fail signal.
            this.timeout(5000);
            let callCount = 0;
            restoration.restore = async (blockId) => {
                callCount++;
                // First round (2 calls) fail, second round succeeds
                if (callCount <= 2)
                    return undefined;
                return makeArchive(blockId);
            };
            // maxConcurrency=2, both blocks fail on first attempt and retry
            const result = await coordinator.pullBlocks(['block-a', 'block-b']);
            expect(result.succeeded).to.have.length(2);
            expect(result.failed).to.have.length(0);
            expect(callCount).to.equal(4);
        });
        it('limits concurrent transfers to maxConcurrency', async () => {
            let maxConcurrent = 0;
            let currentConcurrent = 0;
            restoration.restore = async (blockId) => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                await new Promise(r => setTimeout(r, 50));
                currentConcurrent--;
                return makeArchive(blockId);
            };
            // Launch 6 pulls with maxConcurrency=2
            const result = await coordinator.pullBlocks([
                'block-1', 'block-2', 'block-3',
                'block-4', 'block-5', 'block-6'
            ]);
            expect(result.succeeded).to.have.length(6);
            expect(maxConcurrent).to.be.at.most(2);
        });
    });
    describe('handleRebalanceEvent', () => {
        it('processes gained and lost blocks from a rebalance event', async () => {
            restoration.results.set('block-new', makeArchive('block-new'));
            repo.blocks.set('block-old', makeBlock('block-old'));
            const ownerId = await makePeerId();
            peerNetwork.responses.set(ownerId.toString(), {
                blocks: { 'block-old': 'data' },
                missing: []
            });
            const event = {
                gained: ['block-new'],
                lost: ['block-old'],
                newOwners: new Map([['block-old', [ownerId.toString()]]]),
                triggeredAt: Date.now()
            };
            await coordinator.handleRebalanceEvent(event);
            expect(restoration.restoreCalls).to.include('block-new');
        });
        it('handles empty rebalance events', async () => {
            const event = {
                gained: [],
                lost: [],
                newOwners: new Map(),
                triggeredAt: Date.now()
            };
            // Should not throw
            await coordinator.handleRebalanceEvent(event);
        });
    });
    describe('idempotent block receipt', () => {
        it('pulling a block already present locally is a no-op via restoration', async () => {
            // RestorationCoordinator returns archive (as if block exists elsewhere)
            restoration.results.set('block-1', makeArchive('block-1'));
            const result1 = await coordinator.pullBlocks(['block-1']);
            const result2 = await coordinator.pullBlocks(['block-1']);
            expect(result1.succeeded).to.deep.equal(['block-1']);
            expect(result2.succeeded).to.deep.equal(['block-1']);
        });
    });
    describe('timeout behavior', () => {
        it('times out slow transfers', async () => {
            const slowCoordinator = new BlockTransferCoordinator(repo, peerNetwork, restoration, partitionDetector, '', { transferTimeoutMs: 50, maxRetries: 0 });
            restoration.restore = async () => {
                await new Promise(r => setTimeout(r, 200));
                return makeArchive('block-1');
            };
            const result = await slowCoordinator.pullBlocks(['block-1']);
            expect(result.succeeded).to.deep.equal([]);
            expect(result.failed).to.deep.equal(['block-1']);
        });
    });
});
describe('BlockTransferService', () => {
    it('builds correct protocol string', () => {
        expect(buildBlockTransferProtocol()).to.equal('/db-p2p/block-transfer/1.0.0');
        expect(buildBlockTransferProtocol('/test')).to.equal('/test/db-p2p/block-transfer/1.0.0');
    });
    describe('start/stop', () => {
        it('registers and unregisters protocol handler', async () => {
            const handled = [];
            const unhandled = [];
            const service = new BlockTransferService({
                registrar: {
                    handle: async (protocol) => { handled.push(protocol); },
                    unhandle: async (protocol) => { unhandled.push(protocol); }
                },
                repo: new MockRepo()
            });
            await service.start();
            expect(handled).to.deep.equal(['/db-p2p/block-transfer/1.0.0']);
            await service.stop();
            expect(unhandled).to.deep.equal(['/db-p2p/block-transfer/1.0.0']);
        });
        it('is idempotent on start/stop', async () => {
            let handleCount = 0;
            const service = new BlockTransferService({
                registrar: {
                    handle: async () => { handleCount++; },
                    unhandle: async () => { }
                },
                repo: new MockRepo()
            });
            await service.start();
            await service.start();
            expect(handleCount).to.equal(1);
            await service.stop();
            await service.stop(); // should not throw
        });
    });
});
describe('BlockTransferRequest/Response types', () => {
    it('pull request has correct shape', () => {
        const req = {
            type: 'pull',
            blockIds: ['block-1', 'block-2'],
            reason: 'rebalance'
        };
        expect(req.type).to.equal('pull');
        expect(req.blockIds).to.have.length(2);
    });
    it('push request includes blockData', () => {
        const req = {
            type: 'push',
            blockIds: ['block-1'],
            reason: 'replication',
            blockData: { 'block-1': 'base64data' }
        };
        expect(req.blockData).to.not.be.undefined;
        expect(req.blockData['block-1']).to.equal('base64data');
    });
    it('response distinguishes found and missing blocks', () => {
        const resp = {
            blocks: { 'block-1': 'data' },
            missing: ['block-2']
        };
        expect(Object.keys(resp.blocks)).to.deep.equal(['block-1']);
        expect(resp.missing).to.deep.equal(['block-2']);
    });
});
//# sourceMappingURL=block-transfer.spec.js.map