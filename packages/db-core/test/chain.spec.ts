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
            const tailBlock = tail.block as ChainDataNode<string>;
            const headBlock = head.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.have.length(0);
            expect(headBlock.entries).to.have.length(0);
            expect(head.block.header.id).to.equal(tail.block.header.id);
        });

        it('should create with custom id', async () => {
            const customId = 'custom-chain';
            const customChain = await Chain.create<string>(store, { newId: customId });
            expect(customChain.id).to.equal(customId);
        });
    });

    describe('add', () => {
        it('should add single entry', async () => {
            await chain.add('test1');
            const tail = await chain.getTail();
            const tailBlock = tail.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });

        it('should add multiple entries in same block', async () => {
            await chain.add('test1', 'test2', 'test3');
            const tail = await chain.getTail();
            const tailBlock = tail.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2', 'test3']);
        });

        it('should create new block when current block is full', async () => {
            const entries = Array.from({ length: EntriesPerBlock + 1 }, (_, i) => `test${i}`);
            await chain.add(...entries);

            let path = await chain.getTail();
            const tailBlock = path.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.have.length(1);
            expect(tailBlock.nextId).to.exist;

            const nextBlock = await store.tryGet(tailBlock.nextId!) as ChainDataNode<string>;
            expect(nextBlock?.entries).to.have.length(EntriesPerBlock);
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
            const tailBlock = tail.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1', 'test2']);
        });

        it('should pop multiple entries', async () => {
            const popped = await chain.pop(2);
            expect(popped).to.deep.equal(['test2', 'test3']);
            const tail = await chain.getTail();
            const tailBlock = tail.block as ChainDataNode<string>;
            expect(tailBlock.entries).to.deep.equal(['test1']);
        });

        it('should handle popping more entries than available', async () => {
            const popped = await chain.pop(5);
            expect(popped).to.deep.equal(['test1', 'test2', 'test3']);
            const tail = await chain.getTail();
            const tailBlock = tail.block as ChainDataNode<string>;
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
            const headBlock = head.block as ChainDataNode<string>;
            expect(headBlock.entries).to.deep.equal(['test2', 'test3']);
        });

        it('should dequeue multiple entries', async () => {
            const dequeued = await chain.dequeue(2);
            expect(dequeued).to.deep.equal(['test1', 'test2']);
            const head = await chain.getHead();
            const headBlock = head.block as ChainDataNode<string>;
            expect(headBlock.entries).to.deep.equal(['test3']);
        });

        it('should handle dequeueing more entries than available', async () => {
            const dequeued = await chain.dequeue(5);
            expect(dequeued).to.deep.equal(['test1', 'test2', 'test3']);
            const head = await chain.getHead();
            const headBlock = head.block as ChainDataNode<string>;
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
            await chain.add('test1', 'test2', 'test3');
        });

        it('should navigate to next entry', async () => {
            const head = await chain.getHead();
            const next = await chain.next(head);
            const nextBlock = next.block as ChainDataNode<string>;
            expect(nextBlock.entries[next.index]).to.equal('test2');
        });

        it('should navigate to previous entry', async () => {
            const tail = await chain.getTail();
            const prev = await chain.prev(tail);
            const prevBlock = prev.block as ChainDataNode<string>;
            expect(prevBlock.entries[prev.index]).to.equal('test2');
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
            for await (const path of chain.select(undefined, false)) {
                const block = path.block as ChainDataNode<string>;
                remaining.push(block.entries[path.index]);
            }
            expect(remaining).to.have.length(10);
            expect(remaining[0]).to.equal('test40');
            expect(remaining[9]).to.equal('test49');
        });
    });
});
