import { expect } from 'chai';
import { Chain, EntriesPerBlock, entryAt } from '../src/chain/chain.js';
import { TestBlockStore } from './test-block-store.js';
import { ChainHeaderBlockType } from '../src/chain/chain-nodes.js';
describe('Chain', () => {
    let store;
    let chain;
    beforeEach(async () => {
        store = new TestBlockStore();
        chain = await Chain.create(store);
    });
    describe('creation', () => {
        it('should create an empty chain', async () => {
            const tail = await chain.getTail();
            const head = await chain.getHead();
            expect(tail).to.exist;
            expect(head).to.exist;
            const tailBlock = tail.block;
            const headBlock = head.block;
            expect(tailBlock.entries).to.have.length(0);
            expect(headBlock.entries).to.have.length(0);
            expect(head.block.header.id).to.equal(tail.block.header.id);
        });
        it('should create with custom id', async () => {
            const customId = 'custom-chain';
            const customChain = await Chain.create(store, { newId: customId });
            expect(customChain.id).to.equal(customId);
        });
        it('should create with existingHeaderId, reusing a pre-inserted block', async () => {
            // Insert an upstream header block first
            const existingBlock = { header: store.createBlockHeader('UH'), label: 'upstream' };
            store.insert(existingBlock);
            const existingId = existingBlock.header.id;
            const chainFromExisting = await Chain.create(store, { existingHeaderId: existingId });
            expect(chainFromExisting.id).to.equal(existingId);
            // Verify the existing block got headId/tailId applied
            const headerBlock = await store.tryGet(existingId);
            expect(headerBlock.headId).to.exist;
            expect(headerBlock.tailId).to.exist;
            expect(headerBlock.headId).to.equal(headerBlock.tailId);
            // Upstream fields should be preserved
            expect(headerBlock.label).to.equal('upstream');
        });
        it('should support full chain operations on a chain created with existingHeaderId', async () => {
            const existingBlock = { header: store.createBlockHeader(ChainHeaderBlockType) };
            store.insert(existingBlock);
            const chainFromExisting = await Chain.create(store, { existingHeaderId: existingBlock.header.id });
            await chainFromExisting.add('a', 'b', 'c');
            const entries = [];
            for await (const path of chainFromExisting.select()) {
                entries.push(entryAt(path));
            }
            expect(entries).to.deep.equal(['a', 'b', 'c']);
            const popped = await chainFromExisting.pop(1);
            expect(popped).to.deep.equal(['c']);
            const dequeued = await chainFromExisting.dequeue(1);
            expect(dequeued).to.deep.equal(['a']);
        });
        it('should throw when existingHeaderId references a non-existent block', async () => {
            try {
                await Chain.create(store, { existingHeaderId: 'nonexistent' });
                expect.fail('should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('not found');
            }
        });
    });
    describe('empty chain operations', () => {
        it('should handle operations on empty chain', async () => {
            // Test empty chain iteration
            const entries = [];
            const startPath = await chain.getHead();
            if (startPath) {
                for await (const path of chain.select(startPath)) {
                    const entry = entryAt(path);
                    entries.push(entry);
                }
            }
            expect(entries).to.have.length(0);
            // Test empty chain backward iteration
            const reverseEntries = [];
            const endPath = await chain.getTail();
            if (endPath) {
                for await (const path of chain.select(endPath, false)) {
                    const entry = entryAt(path);
                    reverseEntries.push(entry);
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
            const tailBlock = tail.block;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });
        it('should add multiple entries in same block', async () => {
            await chain.add('test1', 'test2', 'test3');
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail.block;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2', 'test3']);
        });
        it('should create new block when current block is full', async () => {
            const entries = Array.from({ length: EntriesPerBlock + 1 }, (_, i) => `test${i}`);
            await chain.add(...entries);
            let path = await chain.getTail();
            expect(path).to.exist;
            const tailBlock = path.block;
            expect(tailBlock.entries).to.have.length(1);
            expect(tailBlock.priorId).to.exist;
            const priorBlock = await store.tryGet(tailBlock.priorId);
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
            const tailBlock = tail.block;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2']);
        });
        it('should pop multiple entries', async () => {
            const popped = await chain.pop(2);
            expect(popped).to.deep.equal(['test2', 'test3']);
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail.block;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });
        it('should handle popping more entries than available', async () => {
            const popped = await chain.pop(5);
            expect(popped).to.deep.equal(['test1', 'test2', 'test3']);
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const tailBlock = tail.block;
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
            const headBlock = head.block;
            expect(headBlock.entries).to.deep.equal(['test2', 'test3']);
        });
        it('should dequeue multiple entries', async () => {
            const dequeued = await chain.dequeue(2);
            expect(dequeued).to.deep.equal(['test1', 'test2']);
            const head = await chain.getHead();
            expect(head).to.exist;
            const headBlock = head.block;
            expect(headBlock.entries).to.deep.equal(['test3']);
        });
        it('should handle dequeueing more entries than available', async () => {
            const dequeued = await chain.dequeue(5);
            expect(dequeued).to.deep.equal(['test1', 'test2', 'test3']);
            const head = await chain.getHead();
            expect(head).to.exist;
            const headBlock = head.block;
            expect(headBlock.entries).to.deep.equal([]);
        });
    });
    describe('iteration', () => {
        beforeEach(async () => {
            await chain.add('test1', 'test2', 'test3');
        });
        it('should iterate forward through entries', async () => {
            const entries = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                entries.push(entry);
            }
            expect(entries).to.deep.equal(['test1', 'test2', 'test3']);
        });
        it('should iterate backward through entries', async () => {
            const entries = [];
            for await (const path of chain.select(undefined, false)) {
                const entry = entryAt(path);
                entries.push(entry);
            }
            expect(entries).to.deep.equal(['test3', 'test2', 'test1']);
        });
        it('should iterate from specific starting point', async () => {
            const head = await chain.getHead();
            expect(head).to.exist;
            const entries = [];
            for await (const path of chain.select(head)) {
                const entry = entryAt(path);
                entries.push(entry);
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
            const next = await chain.next(head);
            expect(next).to.exist;
            const nextBlock = next.block;
            expect(nextBlock.entries[next.index]).to.equal('test2');
        });
        it('should navigate to previous entry', async () => {
            const tail = await chain.getTail();
            expect(tail).to.exist;
            const prev = await chain.prev(tail);
            expect(prev).to.exist;
            const prevBlock = prev.block;
            expect(prevBlock.entries[prev.index]).to.equal('test3');
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
                const block = path.block;
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
            const forwardEntries = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                forwardEntries.push(entry);
            }
            expect(forwardEntries).to.have.length(100);
            expect(forwardEntries[0]).to.equal('entry0');
            expect(forwardEntries[31]).to.equal('entry31'); // End of first block
            expect(forwardEntries[32]).to.equal('entry32'); // Start of second block
            expect(forwardEntries[99]).to.equal('entry99');
            // Test forward iteration from middle of a block
            const head = await chain.getHead();
            expect(head).to.exist;
            let midPoint = head;
            for (let i = 0; i < 45; i++) {
                const next = await chain.next(midPoint);
                if (!next)
                    break;
                midPoint = next;
            }
            const partialForward = [];
            for await (const path of chain.select(midPoint)) {
                const entry = entryAt(path);
                partialForward.push(entry);
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
            const backwardEntries = [];
            for await (const path of chain.select(undefined, false)) {
                const entry = entryAt(path);
                backwardEntries.push(entry);
            }
            expect(backwardEntries).to.have.length(100);
            expect(backwardEntries[0]).to.equal('entry99');
            expect(backwardEntries[31]).to.equal('entry68'); // End of last full block
            expect(backwardEntries[32]).to.equal('entry67'); // Start of previous block
            expect(backwardEntries[99]).to.equal('entry0');
            // Test backward iteration from middle of a block
            const tail = await chain.getTail();
            expect(tail).to.exist;
            let midPoint = tail;
            for (let i = 0; i < 45; i++) {
                const prev = await chain.prev(midPoint);
                if (!prev)
                    break;
                midPoint = prev;
            }
            const partialBackward = [];
            for await (const path of chain.select(midPoint, false)) {
                const entry = entryAt(path);
                partialBackward.push(entry);
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
            let current = head;
            // Navigate to end of first block
            for (let i = 0; i < 31; i++) {
                const next = await chain.next(current);
                if (!next)
                    break;
                current = next;
                const entry = entryAt(current);
                expect(entry).to.equal(`entry${i + 1}`);
            }
            // Cross block boundary
            const nextPath = await chain.next(current);
            expect(nextPath).to.exist;
            current = nextPath;
            let entry = entryAt(current);
            expect(entry).to.equal('entry32');
            // Get tail and navigate backward across block boundary
            const tail = await chain.getTail();
            expect(tail).to.exist;
            current = tail;
            // Navigate to start of last block
            for (let i = 98; i > 67; i--) {
                const prev = await chain.prev(current);
                if (!prev)
                    break;
                current = prev;
                entry = entryAt(current);
                expect(entry).to.equal(`entry${i}`);
            }
            // Cross block boundary backwards
            const prevPath = await chain.prev(current);
            expect(prevPath).to.exist;
            current = prevPath;
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
            const remaining = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                remaining.push(entry);
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
            const remaining = [];
            for await (const path of chain.select()) {
                const entry = entryAt(path);
                remaining.push(entry);
            }
            expect(remaining).to.have.length(50);
            expect(remaining[0]).to.equal('entry50');
            expect(remaining[49]).to.equal('entry99');
        });
    });
    // TEST-3.2.1: Chain resilience and edge case tests
    describe('resilience tests (TEST-3.2.1)', () => {
        it('should maintain integrity through interleaved add and dequeue', async () => {
            // Track all entries added (FIFO order) and total dequeued
            const allAdded = [];
            const allDequeued = [];
            for (let batch = 0; batch < 5; batch++) {
                const entries = Array.from({ length: 20 }, (_, i) => `batch${batch}-entry${i}`);
                await chain.add(...entries);
                allAdded.push(...entries);
                const dequeued = await chain.dequeue(10);
                expect(dequeued).to.have.length(10);
                allDequeued.push(...dequeued);
            }
            // Dequeued items should match FIFO order of added items
            expect(allDequeued).to.deep.equal(allAdded.slice(0, 50));
            // Verify remaining 50 entries match the tail of what was added
            const remaining = [];
            for await (const path of chain.select()) {
                remaining.push(entryAt(path));
            }
            expect(remaining).to.deep.equal(allAdded.slice(50));
        });
        it('should maintain integrity through interleaved add and pop', async () => {
            for (let batch = 0; batch < 5; batch++) {
                const entries = Array.from({ length: 20 }, (_, i) => `batch${batch}-entry${i}`);
                await chain.add(...entries);
                const popped = await chain.pop(10);
                expect(popped).to.have.length(10);
                expect(popped[9]).to.equal(`batch${batch}-entry19`);
            }
            const remaining = [];
            for await (const path of chain.select()) {
                remaining.push(entryAt(path));
            }
            expect(remaining).to.have.length(50);
        });
        it('should handle drain and refill cycle', async () => {
            // Fill
            await chain.add(...Array.from({ length: 100 }, (_, i) => `fill1-${i}`));
            // Drain completely
            const drained = await chain.dequeue(100);
            expect(drained).to.have.length(100);
            // Verify empty
            const emptyEntries = [];
            for await (const path of chain.select()) {
                emptyEntries.push(entryAt(path));
            }
            expect(emptyEntries).to.have.length(0);
            // Refill
            await chain.add(...Array.from({ length: 50 }, (_, i) => `fill2-${i}`));
            const refilled = [];
            for await (const path of chain.select()) {
                refilled.push(entryAt(path));
            }
            expect(refilled).to.have.length(50);
            expect(refilled[0]).to.equal('fill2-0');
            expect(refilled[49]).to.equal('fill2-49');
        });
        it('should maintain bidirectional navigation after mixed operations', async () => {
            await chain.add(...Array.from({ length: 100 }, (_, i) => `entry${i}`));
            await chain.dequeue(30);
            await chain.pop(20);
            // Forward
            const forward = [];
            for await (const path of chain.select()) {
                forward.push(entryAt(path));
            }
            expect(forward).to.have.length(50);
            expect(forward[0]).to.equal('entry30');
            expect(forward[49]).to.equal('entry79');
            // Backward
            const backward = [];
            for await (const path of chain.select(undefined, false)) {
                backward.push(entryAt(path));
            }
            expect(backward).to.deep.equal([...forward].reverse());
        });
    });
});
//# sourceMappingURL=chain.spec.js.map