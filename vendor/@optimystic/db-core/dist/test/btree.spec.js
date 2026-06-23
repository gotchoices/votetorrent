import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);
import { BTree } from '../src/btree/index.js';
import { createActor } from '../src/utility/actor.js';
import { TestBlockStore } from './test-block-store.js';
describe('BTree', () => {
    let store;
    let btree;
    beforeEach(() => {
        store = new TestBlockStore();
        btree = BTree.create(store, (s, rootId) => {
            let storedRootId = rootId;
            return {
                get: async () => (await s.tryGet(storedRootId)),
                set: async (node) => { storedRootId = node.header.id; },
                getId: async () => storedRootId
            };
        });
    });
    it('should insert and retrieve values', async () => {
        // Insert some values
        await btree.insert(5);
        await btree.insert(3);
        await btree.insert(7);
        // Verify we can retrieve them
        expect(await btree.get(5)).to.equal(5);
        expect(await btree.get(3)).to.equal(3);
        expect(await btree.get(7)).to.equal(7);
        expect(await btree.get(4)).to.be.undefined;
    });
    it('should handle sequential inserts', async () => {
        const count = 100;
        for (let i = 0; i < count; i++) {
            await btree.insert(i);
        }
        // Verify all values are present
        for (let i = 0; i < count; i++) {
            expect(await btree.get(i)).to.equal(i);
        }
    });
    it('should support iteration', async () => {
        const values = [5, 3, 7, 1, 9];
        for (const value of values) {
            await btree.insert(value);
        }
        const path = await btree.first();
        const results = [];
        while (path.on) {
            const value = btree.at(path);
            if (value !== undefined) {
                results.push(value);
            }
            await btree.moveNext(path);
        }
        expect(results).to.deep.equal([1, 3, 5, 7, 9]);
    });
    it('should delete values', async () => {
        await btree.insert(5);
        await btree.insert(3);
        await btree.insert(7);
        const path = await btree.find(3);
        expect(path.on).to.be.true;
        await btree.deleteAt(path);
        expect(path.on).to.be.false;
        expect(await btree.get(3)).to.be.undefined;
        expect(await btree.get(5)).to.equal(5);
        expect(await btree.get(7)).to.equal(7);
    });
    it('should handle empty tree operations', async () => {
        expect(await btree.get(1)).to.be.undefined;
        const firstPath = await btree.first();
        expect(firstPath.on).to.be.false;
        const lastPath = await btree.last();
        expect(lastPath.on).to.be.false;
        const findPath = await btree.find(5);
        expect(findPath.on).to.be.false;
    });
    it('should maintain sorted order after multiple insertions', async () => {
        await btree.insert(3);
        await btree.insert(1);
        await btree.insert(2);
        const values = [];
        const path = await btree.first();
        while (path.on) {
            const value = btree.at(path);
            if (value !== undefined) {
                values.push(value);
            }
            await btree.moveNext(path);
        }
        expect(values).to.deep.equal([1, 2, 3]);
    });
    it('should handle single-item ranges', async () => {
        await btree.insert(2);
        const path = await btree.find(2);
        expect(path.on).to.be.true;
        expect(btree.at(path)).to.equal(2);
        await btree.moveNext(path);
        expect(path.on).to.be.false;
        await btree.movePrior(path);
        expect(path.on).to.be.true;
        expect(btree.at(path)).to.equal(2);
    });
    it('should handle updates correctly', async () => {
        await btree.insert(1);
        await btree.insert(2);
        await btree.insert(3);
        const path = await btree.find(2);
        expect(path.on).to.be.true;
        // Update existing value
        await btree.updateAt(path, 4);
        expect(await btree.get(2)).to.be.undefined;
        expect(await btree.get(4)).to.equal(4);
        // Try updating non-existent value
        const notFoundPath = await btree.find(2);
        expect(notFoundPath.on).to.be.false;
    });
    it('should handle large sequential deletes', async () => {
        // Insert 100 items
        for (let i = 0; i < 100; i++) {
            await btree.insert(i);
            // Verify each insert worked correctly
            expect(await btree.get(i)).to.equal(i, `Failed to verify insert of ${i}`);
        }
        // Delete from end with better error tracking
        for (let i = 99; i >= 50; i--) {
            const path = await btree.find(i);
            expect(path.on).to.be.true;
            try {
                await btree.deleteAt(path);
            }
            catch (e) {
                console.error(`Failed to delete ${i}:`, e);
                // Log the block store state
                store.logBlockIds();
                throw e;
            }
            // Verify deletion worked
            expect(await btree.get(i)).to.be.undefined;
            // Verify adjacent values still exist
            if (i > 0) {
                expect(await btree.get(i - 1)).to.equal(i - 1, `Adjacent value ${i - 1} missing after deleting ${i}`);
            }
        }
        // Verify remaining items with more granular checks
        for (let i = 0; i < 50; i++) {
            try {
                expect(await btree.get(i)).to.equal(i, `Missing value ${i}`);
            }
            catch (e) {
                console.error(`Failed to verify value ${i}:`, e);
                throw e;
            }
        }
    });
    it('should handle interleaved inserts and deletes', async () => {
        // Insert initial items
        for (let i = 0; i < 10; i++) {
            await btree.insert(i * 2); // Insert evens: 0,2,4,6,8...
        }
        // Interleave inserts and deletes
        for (let i = 0; i < 5; i++) {
            // Delete even
            const delPath = await btree.find(i * 2);
            await btree.deleteAt(delPath);
            // Insert odd
            await btree.insert(i * 2 + 1);
        }
        // Verify final state
        for (let i = 0; i < 5; i++) {
            expect(await btree.get(i * 2)).to.be.undefined; // Evens deleted
            expect(await btree.get(i * 2 + 1)).to.equal(i * 2 + 1); // Odds inserted
        }
    });
    it('should handle boundary conditions in node splits', async () => {
        // Insert ascending to force splits
        const count = 100;
        for (let i = 0; i < count; i++) {
            await btree.insert(i);
        }
        // Insert between existing values to test split edge cases
        for (let i = 0; i < count - 1; i++) {
            await btree.insert(i + 0.5);
        }
        // Verify all values present
        for (let i = 0; i < count - 1; i++) {
            expect(await btree.get(i)).to.equal(i);
            expect(await btree.get(i + 0.5)).to.equal(i + 0.5);
        }
    });
    it('should maintain consistency during concurrent operations', async () => {
        // The following would fail without an actor proxy because the tree is not thread-safe by design.
        const safeBtree = createActor(btree);
        // Insert initial data
        for (let i = 0; i < 10; i++) {
            await safeBtree.insert(i);
        }
        // Perform concurrent operations
        await Promise.all([
            safeBtree.insert(20),
            safeBtree.insert(30),
            safeBtree.insert(40)
        ]);
        // Verify tree is still consistent
        expect(await safeBtree.get(20)).to.equal(20);
        expect(await safeBtree.get(30)).to.equal(30);
        expect(await safeBtree.get(40)).to.equal(40);
    });
    // TEST-3.1.1: B-tree stress tests for large datasets
    describe('stress tests (TEST-3.1.1)', () => {
        it('should handle 500 random-order inserts', async () => {
            const values = Array.from({ length: 500 }, (_, i) => i);
            // Fisher-Yates shuffle
            for (let i = values.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [values[i], values[j]] = [values[j], values[i]];
            }
            for (const v of values) {
                await btree.insert(v);
            }
            for (let i = 0; i < 500; i++) {
                expect(await btree.get(i)).to.equal(i);
            }
            // Verify sorted iteration
            const collected = [];
            const path = await btree.first();
            while (path.on) {
                collected.push(btree.at(path));
                await btree.moveNext(path);
            }
            expect(collected).to.deep.equal(Array.from({ length: 500 }, (_, i) => i));
        });
        it('should handle delete of every other element in a large tree', async () => {
            for (let i = 0; i < 500; i++) {
                await btree.insert(i);
            }
            // Delete all even values
            for (let i = 0; i < 500; i += 2) {
                const path = await btree.find(i);
                expect(path.on).to.be.true;
                await btree.deleteAt(path);
            }
            // Verify only odd values remain
            for (let i = 0; i < 500; i++) {
                if (i % 2 === 0) {
                    expect(await btree.get(i)).to.be.undefined;
                }
                else {
                    expect(await btree.get(i)).to.equal(i);
                }
            }
        });
        it('should maintain correct count across splits and merges', async () => {
            for (let i = 0; i < 300; i++) {
                await btree.insert(i);
            }
            const countAll = await btree.getCount();
            expect(countAll).to.equal(300);
            // Delete half from the middle
            for (let i = 100; i < 200; i++) {
                const path = await btree.find(i);
                await btree.deleteAt(path);
            }
            expect(await btree.getCount()).to.equal(200);
        });
        it('should handle bulk upserts on large dataset', async () => {
            for (let i = 0; i < 200; i++) {
                await btree.insert(i);
            }
            // Upsert all existing and new values
            for (let i = 0; i < 400; i++) {
                await btree.upsert(i);
            }
            expect(await btree.getCount()).to.equal(400);
            for (let i = 0; i < 400; i++) {
                expect(await btree.get(i)).to.equal(i);
            }
        });
    });
    // TEST-3.1.2: Concurrent mutation tests (path invalidation)
    describe('path invalidation (TEST-3.1.2)', () => {
        it('should invalidate path after insert', async () => {
            await btree.insert(10);
            const path = await btree.find(10);
            expect(path.on).to.be.true;
            expect(btree.isValid(path)).to.be.true;
            await btree.insert(20);
            expect(btree.isValid(path)).to.be.false;
        });
        it('should invalidate path after deleteAt', async () => {
            await btree.insert(10);
            await btree.insert(20);
            const pathTo10 = await btree.find(10);
            expect(btree.isValid(pathTo10)).to.be.true;
            const pathTo20 = await btree.find(20);
            await btree.deleteAt(pathTo20);
            expect(btree.isValid(pathTo10)).to.be.false;
        });
        it('should invalidate path after updateAt', async () => {
            await btree.insert(10);
            await btree.insert(20);
            const pathTo10 = await btree.find(10);
            const pathTo20 = await btree.find(20);
            await btree.updateAt(pathTo20, 25);
            expect(btree.isValid(pathTo10)).to.be.false;
        });
        it('should invalidate path after upsert', async () => {
            await btree.insert(10);
            const path = await btree.find(10);
            await btree.upsert(30);
            expect(btree.isValid(path)).to.be.false;
        });
        it('should throw on stale path usage', async () => {
            await btree.insert(10);
            await btree.insert(20);
            const path = await btree.find(10);
            await btree.insert(30); // invalidate
            expect(() => btree.at(path)).to.throw('Path is invalid');
            await expect(btree.moveNext(path)).to.be.rejectedWith('Path is invalid');
            await expect(btree.movePrior(path)).to.be.rejectedWith('Path is invalid');
            await expect(btree.deleteAt(path)).to.be.rejectedWith('Path is invalid');
            await expect(btree.updateAt(path, 99)).to.be.rejectedWith('Path is invalid');
        });
        it('should return valid path from mutation operations', async () => {
            await btree.insert(10);
            const insertPath = await btree.insert(20);
            expect(btree.isValid(insertPath)).to.be.true;
            const [updatePath] = await btree.updateAt(insertPath, 25);
            expect(btree.isValid(updatePath)).to.be.true;
            const upsertPath = await btree.upsert(30);
            expect(btree.isValid(upsertPath)).to.be.true;
        });
    });
    describe('atomic rollback', () => {
        async function collectAll() {
            const values = [];
            const path = await btree.first();
            while (path.on) {
                values.push(btree.at(path));
                await btree.moveNext(path);
            }
            return values;
        }
        it('should preserve tree after failed insert', async () => {
            for (let i = 0; i < 100; i++) {
                await btree.insert(i);
            }
            const before = await collectAll();
            expect(before).to.have.length(100);
            // Sabotage reads - insert's find() will fail inside the atomic
            const realTryGet = store.tryGet.bind(store);
            store.tryGet = async () => { throw new Error('Store failure'); };
            await expect(btree.insert(100)).to.be.rejectedWith('Store failure');
            store.tryGet = realTryGet;
            // Tree should be unchanged and fully functional
            const after = await collectAll();
            expect(after).to.deep.equal(before);
            // Should still accept new inserts
            await btree.insert(100);
            expect(await btree.get(100)).to.equal(100);
        });
        it('should preserve tree after failed delete', async () => {
            for (let i = 0; i < 100; i++) {
                await btree.insert(i);
            }
            const before = await collectAll();
            // Get a valid path, then sabotage reads before deleteAt
            const path = await btree.find(50);
            expect(path.on).to.be.true;
            const realTryGet = store.tryGet.bind(store);
            store.tryGet = async () => { throw new Error('Store failure'); };
            // deleteAt applies the entry deletion to the Atomic, then tries to
            // rebalance (which reads siblings via tryGet) - may fail there.
            // If rebalance isn't needed, the delete succeeds through the Atomic.
            let failed = false;
            try {
                await btree.deleteAt(path);
            }
            catch {
                failed = true;
            }
            store.tryGet = realTryGet;
            if (failed) {
                // Atomic rolled back - all values preserved
                const after = await collectAll();
                expect(after).to.deep.equal(before);
            }
            else {
                // Delete committed - one fewer value
                expect(await btree.get(50)).to.be.undefined;
                expect(await btree.getCount()).to.equal(99);
            }
            // Tree is functional either way
            await btree.insert(200);
            expect(await btree.get(200)).to.equal(200);
        });
        it('should preserve tree after failed upsert', async () => {
            for (let i = 0; i < 50; i++) {
                await btree.insert(i);
            }
            const before = await collectAll();
            const realTryGet = store.tryGet.bind(store);
            store.tryGet = async () => { throw new Error('Store failure'); };
            await expect(btree.upsert(999)).to.be.rejectedWith('Store failure');
            store.tryGet = realTryGet;
            const after = await collectAll();
            expect(after).to.deep.equal(before);
        });
        it('should roll back partial delete when rebalance read fails', async () => {
            // Insert 65 values to force one split:
            //   leaf1: [0..31], leaf2: [32..64], root branch
            for (let i = 0; i < 65; i++) {
                await btree.insert(i);
            }
            // Delete 32 to bring leaf2 to exactly 32 entries [33..64]
            const path32 = await btree.find(32);
            await btree.deleteAt(path32);
            expect(await btree.getCount()).to.equal(64);
            // Now deleting 33 triggers rebalance (leaf2 drops to 31 < 32).
            // Rebalance tries to read sibling via tryGet, which we sabotage.
            const path33 = await btree.find(33);
            expect(path33.on).to.be.true;
            const realTryGet = store.tryGet.bind(store);
            store.tryGet = async () => { throw new Error('Rebalance failure'); };
            // The atomic wrapper: apply() deletes entry 33 (recorded in Atomic),
            // then rebalance reads sibling → tryGet fails → Atomic rolls back.
            await expect(btree.deleteAt(path33)).to.be.rejectedWith('Rebalance failure');
            store.tryGet = realTryGet;
            // Entry 33 should still exist (deletion was rolled back)
            expect(await btree.get(33)).to.equal(33);
            expect(await btree.getCount()).to.equal(64);
            // Tree should still be fully functional
            await btree.insert(100);
            expect(await btree.get(100)).to.equal(100);
        });
    });
});
//# sourceMappingURL=btree.spec.js.map