import { expect } from 'chai';
import { Tree } from '../src/collections/tree/index.js';
import { TestTransactor } from './test-transactor.js';
import { KeyRange, KeyBound } from '../src/btree/index.js';
describe('Tree', () => {
    let network;
    let tree;
    const collectionId = 'test-tree';
    beforeEach(async () => {
        network = new TestTransactor();
        tree = await Tree.createOrOpen(network, collectionId, entry => entry.key);
    });
    it('should create a tree collection', async () => {
        expect(tree).to.be.instanceOf(Tree);
    });
    it('should insert and retrieve single entry', async () => {
        const entry = {
            key: 1,
            value: 'Test value'
        };
        await tree.replace([[entry.key, entry]]);
        const retrieved = await tree.get(entry.key);
        expect(retrieved).to.deep.equal(entry);
    });
    it('should handle multiple entries in order', async () => {
        const entries = Array(5).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Insert entries
        for (const entry of entries) {
            await tree.replace([[entry.key, entry]]);
        }
        // Verify retrieval
        for (const entry of entries) {
            const retrieved = await tree.get(entry.key);
            expect(retrieved).to.deep.equal(entry);
        }
        // Verify order using iteration
        const retrievedEntries = [];
        let path = await tree.first();
        while (path.on) {
            const entry = tree.at(path);
            if (entry) {
                retrievedEntries.push(entry);
            }
            await tree.moveNext(path);
        }
        expect(retrievedEntries).to.deep.equal(entries);
    });
    it('should handle entry updates', async () => {
        const entry = {
            key: 1,
            value: 'Original value'
        };
        await tree.replace([[entry.key, entry]]);
        const updatedEntry = {
            ...entry,
            value: 'Updated value'
        };
        await tree.replace([[entry.key, updatedEntry]]);
        const retrieved = await tree.get(entry.key);
        expect(retrieved).to.deep.equal(updatedEntry);
    });
    it('should handle entry deletions', async () => {
        const entry = {
            key: 1,
            value: 'Test value'
        };
        await tree.replace([[entry.key, entry]]);
        expect(await tree.get(entry.key)).to.deep.equal(entry);
        await tree.replace([[entry.key, undefined]]);
        expect(await tree.get(entry.key)).to.be.undefined;
    });
    it('should handle range queries', async () => {
        const entries = Array(10).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Insert entries
        for (const entry of entries) {
            await tree.replace([[entry.key, entry]]);
        }
        // Test range query
        const range = new KeyRange(new KeyBound(3), // start from 3 (inclusive)
        new KeyBound(7) // end at 7 (inclusive)
        );
        const rangeEntries = [];
        for await (const path of tree.range(range)) {
            const entry = tree.at(path);
            if (entry) {
                rangeEntries.push(entry);
            }
        }
        expect(rangeEntries).to.deep.equal(entries.slice(2, 7));
    });
    it('should handle ascending and descending iteration', async () => {
        const entries = Array(5).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Insert entries
        for (const entry of entries) {
            await tree.replace([[entry.key, entry]]);
        }
        // Test ascending iteration
        const ascendingEntries = [];
        let path = await tree.first();
        for await (const iterPath of tree.ascending(path)) {
            const entry = tree.at(iterPath);
            if (entry) {
                ascendingEntries.push(entry);
            }
        }
        expect(ascendingEntries).to.deep.equal(entries);
        // Test descending iteration
        const descendingEntries = [];
        path = await tree.last();
        for await (const iterPath of tree.descending(path)) {
            const entry = tree.at(iterPath);
            if (entry) {
                descendingEntries.push(entry);
            }
        }
        expect(descendingEntries).to.deep.equal([...entries].reverse());
    });
    it('should handle batch operations', async () => {
        const entries = Array(3).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Batch insert
        await tree.replace(entries.map(entry => [entry.key, entry]));
        // Verify all entries
        for (const entry of entries) {
            const retrieved = await tree.get(entry.key);
            expect(retrieved).to.deep.equal(entry);
        }
        // Batch update
        const updatedEntries = entries.map(entry => ({
            ...entry,
            value: `Updated ${entry.value}`
        }));
        await tree.replace(updatedEntries.map(entry => [entry.key, entry]));
        // Verify updates
        for (const entry of updatedEntries) {
            const retrieved = await tree.get(entry.key);
            expect(retrieved).to.deep.equal(entry);
        }
        // Batch delete
        await tree.replace(entries.map(entry => [entry.key, undefined]));
        // Verify deletions
        for (const entry of entries) {
            const retrieved = await tree.get(entry.key);
            expect(retrieved).to.be.undefined;
        }
    });
    it('should handle complex entry objects', async () => {
        const entry = {
            key: 1,
            value: 'Test value',
            metadata: {
                tags: ['test', 'complex'],
                timestamp: Date.now(),
                nested: {
                    field1: 'value1',
                    field2: 42
                }
            }
        };
        await tree.replace([[entry.key, entry]]);
        const retrieved = await tree.get(entry.key);
        expect(retrieved).to.deep.equal(entry);
    });
    it('should handle count operations', async () => {
        const entries = Array(10).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Insert entries
        for (const entry of entries) {
            await tree.replace([[entry.key, entry]]);
        }
        // Get total count
        const totalCount = await tree.getCount();
        expect(totalCount).to.equal(entries.length);
        // Get count from middle
        const middlePath = await tree.find(5);
        const remainingCount = await tree.getCount({ path: middlePath, ascending: true });
        expect(remainingCount).to.equal(6); // Including the current entry
    });
    it('should handle navigation operations', async () => {
        const entries = Array(5).fill(0).map((_, i) => ({
            key: i + 1,
            value: `Value ${i + 1}`
        }));
        // Insert entries
        for (const entry of entries) {
            await tree.replace([[entry.key, entry]]);
        }
        // Test next/prior operations
        let path = await tree.first();
        expect(tree.at(path)?.key).to.equal(1);
        path = await tree.next(path);
        expect(tree.at(path)?.key).to.equal(2);
        path = await tree.prior(path);
        expect(tree.at(path)?.key).to.equal(1);
        // Test moveNext/movePrior operations
        await tree.moveNext(path);
        expect(tree.at(path)?.key).to.equal(2);
        await tree.movePrior(path);
        expect(tree.at(path)?.key).to.equal(1);
    });
    it('should handle path validity', async () => {
        const entry = {
            key: 1,
            value: 'Test value'
        };
        await tree.replace([[entry.key, entry]]);
        const path = await tree.find(entry.key);
        expect(tree.isValid(path)).to.be.true;
        await tree.replace([[entry.key, undefined]]);
        expect(tree.isValid(path)).to.be.false;
    });
    it('should handle multiple tree instances with same network', async () => {
        const tree2 = await Tree.createOrOpen(network, 'test-tree-2', entry => entry.key);
        const entry1 = {
            key: 1,
            value: 'Tree 1 value'
        };
        const entry2 = {
            key: 1,
            value: 'Tree 2 value'
        };
        await tree.replace([[entry1.key, entry1]]);
        await tree2.replace([[entry2.key, entry2]]);
        // Check tree 1
        const retrieved1 = await tree.get(entry1.key);
        expect(retrieved1).to.deep.equal(entry1);
        // Check tree 2
        const retrieved2 = await tree2.get(entry2.key);
        expect(retrieved2).to.deep.equal(entry2);
    });
    describe('concurrent creation', () => {
        it('should resolve concurrent Tree creation and allow post-recovery operations', async () => {
            const tree1 = await Tree.createOrOpen(network, 'concurrent-tree', e => e.key);
            const tree2 = await Tree.createOrOpen(network, 'concurrent-tree', e => e.key);
            // tree1 wins the creation race
            await tree1.replace([[1, { key: 1, value: 'from-tree1' }]]);
            // tree2 loses, should recover and be usable
            await tree2.replace([[2, { key: 2, value: 'from-tree2' }]]);
            // Both should converge
            await tree1.update();
            await tree2.update();
            const val1from1 = await tree1.get(1);
            const val2from1 = await tree1.get(2);
            const val1from2 = await tree2.get(1);
            const val2from2 = await tree2.get(2);
            expect(val1from1).to.deep.equal({ key: 1, value: 'from-tree1' });
            expect(val2from1).to.deep.equal({ key: 2, value: 'from-tree2' });
            expect(val1from2).to.deep.equal({ key: 1, value: 'from-tree1' });
            expect(val2from2).to.deep.equal({ key: 2, value: 'from-tree2' });
        });
    });
});
//# sourceMappingURL=tree.spec.js.map