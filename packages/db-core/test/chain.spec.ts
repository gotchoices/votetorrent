import { expect } from 'aegir/chai'
import { Chain, EntriesPerBlock, entryAt } from '../src/chain/chain.js';
import { TestBlockStore } from './test-block-store.js';
import type { ChainDataNode } from '../src/chain/chain-nodes.js';

describe('Chain', () => {
    let store: TestBlockStore;
    let chain: Chain<string>;

    beforeEach(async () => {
        store = new TestBlockStore();
        chain = await Chain.create<string>(store);
    });

    describe('creation', () => {
        it('should create an empty chain', async () => {
            const tail = await chain.getTail();
            const head = await chain.getHead();
            expect(tail).to.exist;
            expect(head).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            const headBlock = head!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.have.length(0);
            expect(headBlock.entries).to.have.length(0);
            expect(head!.block.header.id).to.equal(tail!.block.header.id);
        });

        it('should create with custom id', async () => {
            const customId = 'custom-chain';
            const customChain = await Chain.create<string>(store, { newId: customId });
            expect(customChain.id).to.equal(customId);
        });
    });

    describe('empty chain operations', () => {
        it('should handle operations on empty chain', async () => {
            // Test empty chain iteration
            const entries: string[] = [];
            const startPath = await chain.getHead();
            if (startPath) {
                for await (const path of chain.select(startPath)) {
                    const entry = entryAt(path);
                    entries.push(entry!);
                }
            }
            expect(entries).to.have.length(0);

            // Test empty chain backward iteration
            const reverseEntries: string[] = [];
            const endPath = await chain.getTail();
            if (endPath) {
                for await (const path of chain.select(endPath, false)) {
                    const entry = entryAt(path);
                    reverseEntries.push(entry!);
                }
            }
            expect(reverseEntries).to.have.length(0);

            // Test pop on empty chain
            const popped = await chain.pop(1);
            expect(popped).to.have.length(0);

            // Test dequeue on empty chain
            const dequeued = await chain.dequeue(1);
            expect(dequeued).to.have.length(0);
        });
    });

    describe('add', () => {
        it('should add single entry', async () => {
            await chain.add('test1');
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });

        it('should add multiple entries in same block', async () => {
            await chain.add('test1', 'test2', 'test3');
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2', 'test3']);
        });

        it('should create new block when current block is full', async () => {
            const entries = Array.from({ length: EntriesPerBlock + 1 }, (_, i) => `test${i}`);
            await chain.add(...entries);

            let path = await chain.getTail();
            expect(path).to.exist;
            const tailBlock = path!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.have.length(1);
            expect(tailBlock.priorId).to.exist;

            const priorBlock = await store.tryGet(tailBlock.priorId!) as ChainDataNode<string>;
            expect(priorBlock?.entries).to.have.length(EntriesPerBlock);
        });
    });

    describe('pop', () => {
        beforeEach(async () => {
            await chain.add('test1', 'test2', 'test3');
        });

        it('should pop single entry from tail', async () => {
            const popped = await chain.pop(1);
            expect(popped).to.deep.equal(['test3']);
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2']);
        });

        it('should pop multiple entries', async () => {
            const popped = await chain.pop(2);
            expect(popped).to.deep.equal(['test2', 'test3']);
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });

        it('should handle popping more entries than available', async () => {
            const popped = await chain.pop(5);
            expect(popped).to.deep.equal(['test1', 'test2', 'test3']);
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail!.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal([]);
        });
    });

    describe('dequeue', () => {
        beforeEach(async () => {
            await chain.add('test1', 'test2', 'test3');
        });

        it('should dequeue single entry from head', async () => {
            const dequeued = await chain.dequeue(1);
            expect(dequeued).to.deep.equal(['test1']);
            const head = await chain.getHead();
            expect(head).to.exist;
            const headBlock = head!.block as ChainDataNode<string>;
            expect(headBlock.entries).to.deep.equal(['test2', 'test3']);
        });

        it('should dequeue multiple entries', async () => {
            const dequeued = await chain.dequeue(2);
            expect(dequeued).to.deep.equal(['test1', 'test2']);
            const head = await chain.getHead();
            expect(head).to.exist;
            const headBlock = head!.block as ChainDataNode<string>;
            expect(headBlock.entries).to.deep.equal(['test3']);
        });

        it('should handle dequeueing more entries than available', async () => {
            const dequeued = await chain.dequeue(5);
            expect(dequeued).to.deep.equal(['test1', 'test2', 'test3']);
            const head = await chain.getHead();
            expect(head).to.exist;
            const headBlock = head!.block as ChainDataNode<string>;
            expect(headBlock.entries).to.deep.equal([]);
        });
    });

    describe('iteration', () => {
        beforeEach(async () => {
            await chain.add('test1', 'test2', 'test3');
        });

        it('should iterate forward through entries', async () => {
            const entries: string[] = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                entries.push(entry!);
            }
            expect(entries).to.deep.equal(['test1', 'test2', 'test3']);
        });

        it('should iterate backward through entries', async () => {
            const entries: string[] = [];
            for await (const path of chain.select(undefined, false)) {
                const entry = entryAt(path);
                entries.push(entry!);
            }
            expect(entries).to.deep.equal(['test3', 'test2', 'test1']);
        });

        it('should iterate from specific starting point', async () => {
            const head = await chain.getHead();
            expect(head).to.exist;
            const entries: string[] = [];
            for await (const path of chain.select(head)) {
                const entry = entryAt(path);
                entries.push(entry!);
            }
            expect(entries).to.deep.equal(['test1', 'test2', 'test3']);
        });
    });

    describe('navigation', () => {
        beforeEach(async () => {
            await chain.add('test1', 'test2', 'test3', 'test4');
        });

        it('should navigate to next entry', async () => {
            const head = await chain.getHead();
            expect(head).to.exist;
            const next = await chain.next(head!);
            expect(next).to.exist;
            const nextBlock = next!.block as ChainDataNode<string>;
            expect(nextBlock.entries[next!.index]).to.equal('test2');
        });

        it('should navigate to previous entry', async () => {
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const prev = await chain.prev(tail!);
            expect(prev).to.exist;
            const prevBlock = prev!.block as ChainDataNode<string>;
            expect(prevBlock.entries[prev!.index]).to.equal('test3');
        });
    });

    describe('cross-block operations', () => {
        it('should handle operations across multiple blocks', async () => {
            // Fill more than one block
            const entries = Array.from({ length: 50 }, (_, i) => `test${i}`);
            await chain.add(...entries);

            // Test dequeuing across blocks
            const dequeued = await chain.dequeue(40);
            expect(dequeued).to.have.length(40);
            expect(dequeued[0]).to.equal('test0');
            expect(dequeued[39]).to.equal('test39');

            // Test remaining entries
            const remaining = [];
            for await (const path of chain.select(undefined)) {
                const block = path.block as ChainDataNode<string>;
                remaining.push(block.entries[path.index]);
            }
            expect(remaining).to.have.length(10);
            expect(remaining[0]).to.equal('test40');
            expect(remaining[9]).to.equal('test49');
        });

        it('should iterate forward across multiple blocks', async () => {
            // Create chain with 100 entries (will span at least 4 blocks)
            const entries = Array.from({ length: 100 }, (_, i) => `entry${i}`);
            await chain.add(...entries);

            // Test forward iteration from start
            const forwardEntries: string[] = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                forwardEntries.push(entry!);
            }

            expect(forwardEntries).to.have.length(100);
            expect(forwardEntries[0]).to.equal('entry0');
            expect(forwardEntries[31]).to.equal('entry31'); // End of first block
            expect(forwardEntries[32]).to.equal('entry32'); // Start of second block
            expect(forwardEntries[99]).to.equal('entry99');

            // Test forward iteration from middle of a block
            const head = await chain.getHead();
            expect(head).to.exist;
            let midPoint = head!;
            for (let i = 0; i < 45; i++) {
                const next = await chain.next(midPoint);
                if (!next) break;
                midPoint = next;
            }

            const partialForward: string[] = [];
            for await (const path of chain.select(midPoint)) {
                const entry = entryAt(path);
                partialForward.push(entry!);
            }

            expect(partialForward).to.have.length(55);
            expect(partialForward[0]).to.equal('entry45');
            expect(partialForward[54]).to.equal('entry99');
        });

        it('should iterate backward across multiple blocks', async () => {
            // Create chain with 100 entries (will span at least 4 blocks)
            const entries = Array.from({ length: 100 }, (_, i) => `entry${i}`);
            await chain.add(...entries);

            // Test backward iteration from end
            const backwardEntries: string[] = [];
            for await (const path of chain.select(undefined, false)) {
                const entry = entryAt(path);
                backwardEntries.push(entry!);
            }

            expect(backwardEntries).to.have.length(100);
            expect(backwardEntries[0]).to.equal('entry99');
            expect(backwardEntries[31]).to.equal('entry68'); // End of last full block
            expect(backwardEntries[32]).to.equal('entry67'); // Start of previous block
            expect(backwardEntries[99]).to.equal('entry0');

            // Test backward iteration from middle of a block
            const tail = await chain.getTail();
            expect(tail).to.exist;
            let midPoint = tail!;
            for (let i = 0; i < 45; i++) {
                const prev = await chain.prev(midPoint);
                if (!prev) break;
                midPoint = prev;
            }

            const partialBackward: string[] = [];
            for await (const path of chain.select(midPoint, false)) {
                const entry = entryAt(path);
                partialBackward.push(entry!);
            }

            expect(partialBackward).to.have.length(55);
            expect(partialBackward[0]).to.equal('entry54');
            expect(partialBackward[54]).to.equal('entry0');
        });

        it('should navigate across block boundaries', async () => {
            // Create chain with entries that will span multiple blocks
            const entries = Array.from({ length: 100 }, (_, i) => `entry${i}`);
            await chain.add(...entries);

            // Get head and navigate forward across block boundary
            const head = await chain.getHead();
            expect(head).to.exist;
            let current = head!;

            // Navigate to end of first block
            for (let i = 0; i < 31; i++) {
                const next = await chain.next(current);
                if (!next) break;
                current = next;
                const entry = entryAt(current);
                expect(entry).to.equal(`entry${i + 1}`);
            }

            // Cross block boundary
            const nextPath = await chain.next(current);
            expect(nextPath).to.exist;
            current = nextPath!;
            let entry = entryAt(current);
            expect(entry).to.equal('entry32');

            // Get tail and navigate backward across block boundary
            const tail = await chain.getTail();
            expect(tail).to.exist;
            current = tail!;

            // Navigate to start of last block
            for (let i = 98; i > 67; i--) {
                const prev = await chain.prev(current);
                if (!prev) break;
                current = prev;
                entry = entryAt(current);
                expect(entry).to.equal(`entry${i}`);
            }

            // Cross block boundary backwards
            const prevPath = await chain.prev(current);
            expect(prevPath).to.exist;
            current = prevPath!;
            entry = entryAt(current);
            expect(entry).to.equal('entry67');
        });

        it('should handle pop operations across multiple blocks', async () => {
            // Create chain with entries that will span multiple blocks
            const entries = Array.from({ length: 100 }, (_, i) => `entry${i}`);
            await chain.add(...entries);

            // Pop entries that span multiple blocks
            const popped = await chain.pop(50);
            expect(popped).to.have.length(50);
            expect(popped[0]).to.equal('entry50');
            expect(popped[49]).to.equal('entry99');

            // Verify remaining entries
            const remaining: string[] = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                remaining.push(entry!);
            }

            expect(remaining).to.have.length(50);
            expect(remaining[0]).to.equal('entry0');
            expect(remaining[49]).to.equal('entry49');
        });

        it('should handle dequeue operations across multiple blocks', async () => {
            // Create chain with entries that will span multiple blocks
            const entries = Array.from({ length: 100 }, (_, i) => `entry${i}`);
            await chain.add(...entries);

            // Dequeue entries that span multiple blocks
            const dequeued = await chain.dequeue(50);
            expect(dequeued).to.have.length(50);
            expect(dequeued[0]).to.equal('entry0');
            expect(dequeued[49]).to.equal('entry49');

            // Verify remaining entries
            const remaining: string[] = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                remaining.push(entry!);
            }

            expect(remaining).to.have.length(50);
            expect(remaining[0]).to.equal('entry50');
            expect(remaining[49]).to.equal('entry99');
        });
    });
});
