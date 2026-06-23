import { expect } from 'chai';
import { Tracker } from '../src/transform/tracker.js';
import { applyOperation, withOperation, blockIdsForTransforms, emptyTransforms, mergeTransforms, concatTransforms, transformForBlockId, applyTransformToStore, concatTransform, copyTransforms } from '../src/index.js';
import { apply } from '../src/blocks/index.js';
import { TestBlockStore } from './test-block-store.js';
describe('Transform functionality', () => {
    let mockSource;
    let testBlock;
    beforeEach(() => {
        mockSource = {
            tryGet: async (_id) => testBlock,
            generateId: () => 'test-id',
            createBlockHeader: (type) => ({ id: 'test-id', type })
        };
        testBlock = {
            header: {
                id: 'test-id',
                type: 'test'
            },
            data: 'initial',
            items: ['item1', 'item2']
        };
    });
    describe('Tracker', () => {
        it('should track inserts correctly', async () => {
            const tracker = new Tracker(mockSource);
            const newBlock = { ...testBlock, header: { ...testBlock.header, id: 'new-id' } };
            tracker.insert(newBlock);
            expect(tracker.transforms.inserts['new-id']).to.deep.equal(newBlock);
            expect(tracker.transforms.deletes?.includes('new-id') ?? false).to.be.false;
        });
        it('should track updates correctly', async () => {
            const tracker = new Tracker(mockSource);
            const operation = ['data', 0, 0, 'updated'];
            tracker.update('test-id', operation);
            expect(tracker.transforms.updates['test-id']).to.deep.equal([operation]);
        });
        it('should track deletes correctly', async () => {
            const tracker = new Tracker(mockSource);
            tracker.delete('test-id');
            expect(tracker.transforms.deletes.includes('test-id')).to.be.true;
            expect(tracker.transforms.inserts?.['test-id']).to.be.undefined;
            expect(tracker.transforms.updates?.['test-id']).to.be.undefined;
        });
        it('should reset transform correctly', async () => {
            const tracker = new Tracker(mockSource);
            tracker.insert(testBlock);
            const oldTransforms = tracker.reset();
            expect(oldTransforms.inserts['test-id']).to.deep.equal(testBlock);
            expect(tracker.transforms).to.deep.equal(emptyTransforms());
        });
        it('should not corrupt deletes array when inserting block not in deletes', async () => {
            const tracker = new Tracker(mockSource);
            // Pre-populate deletes with some entries
            tracker.delete('existing-delete-1');
            tracker.delete('existing-delete-2');
            expect(tracker.transforms.deletes).to.have.lengthOf(2);
            // Insert a new block that was never deleted
            const newBlock = { ...testBlock, header: { ...testBlock.header, id: 'new-id' } };
            tracker.insert(newBlock);
            // Deletes array should remain unchanged (no corruption from splice(-1, 1))
            expect(tracker.transforms.deletes).to.have.lengthOf(2);
            expect(tracker.transforms.deletes).to.include('existing-delete-1');
            expect(tracker.transforms.deletes).to.include('existing-delete-2');
        });
        it('should remove block from deletes when re-inserting previously deleted block', async () => {
            const tracker = new Tracker(mockSource);
            const blockId = 'reinserted-block';
            const block = { ...testBlock, header: { ...testBlock.header, id: blockId } };
            // Delete the block first
            tracker.delete(blockId);
            expect(tracker.transforms.deletes).to.include(blockId);
            // Re-insert the block
            tracker.insert(block);
            expect(tracker.transforms.deletes).to.not.include(blockId);
            expect(tracker.transforms.inserts[blockId]).to.deep.equal(block);
        });
    });
    describe('Transform Helpers', () => {
        it('should apply attribute operations correctly', () => {
            const block = { ...testBlock };
            const operation = ['data', 0, 0, 'updated'];
            applyOperation(block, operation);
            expect(block.data).to.equal('updated');
        });
        it('should apply array operations correctly', () => {
            const block = { ...testBlock };
            const operation = ['items', 0, 1, ['updated']];
            applyOperation(block, operation);
            expect(block.items).to.deep.equal(['updated', 'item2']);
        });
        it('should create new block with operation applied', () => {
            const operation = ['data', 0, 0, 'updated'];
            const newBlock = withOperation(testBlock, operation);
            expect(newBlock.data).to.equal('updated');
            expect(testBlock.data).to.equal('initial'); // Original unchanged
        });
        it('should get block ids for transform', () => {
            const transform = {
                inserts: { 'id1': testBlock },
                updates: { 'id2': [] },
                deletes: ['id3']
            };
            const ids = blockIdsForTransforms(transform);
            expect(ids).to.have.members(['id1', 'id2', 'id3']);
        });
        it('should merge transforms correctly', () => {
            const transform1 = {
                inserts: { 'id1': testBlock },
                updates: {},
                deletes: []
            };
            const transform2 = {
                inserts: { 'id2': testBlock },
                updates: {},
                deletes: ['id3']
            };
            const merged = mergeTransforms(transform1, transform2);
            expect(merged.inserts).to.have.keys(['id1', 'id2']);
            expect(merged.deletes.includes('id3')).to.be.true;
        });
        it('should concatenate multiple transforms', () => {
            const transforms = [
                {
                    inserts: { 'id1': testBlock },
                    updates: {},
                    deletes: []
                },
                {
                    inserts: { 'id2': testBlock },
                    updates: {},
                    deletes: ['id3']
                }
            ];
            const concatenated = concatTransforms(...transforms);
            expect(concatenated.inserts).to.have.keys(['id1', 'id2']);
            expect(concatenated.deletes.includes('id3')).to.be.true;
        });
        it('should create transform for specific block id', () => {
            const transform = {
                inserts: { 'id1': testBlock, 'id2': testBlock },
                updates: { 'id1': [], 'id3': [] },
                deletes: ['id1', 'id4']
            };
            const blockTransform = transformForBlockId(transform, 'id1');
            expect(blockTransform.insert).to.exist;
            expect(blockTransform.insert).to.deep.equal(testBlock);
            expect(blockTransform.updates).to.exist;
            expect(blockTransform.delete).to.be.true;
        });
    });
    describe('Block ID Collision and Overlap Tests (TEST-1.1.1)', () => {
        const sharedId = 'shared-block';
        it('should silently drop updates from first transform when mergeTransforms has overlapping block IDs (BUG: data loss)', () => {
            const op1 = ['data', 0, 0, 'from-a'];
            const op2 = ['items', 0, 1, ['replaced']];
            const op3 = ['data', 0, 0, 'from-b'];
            const a = { inserts: {}, updates: { [sharedId]: [op1, op2] }, deletes: [] };
            const b = { inserts: {}, updates: { [sharedId]: [op3] }, deletes: [] };
            const merged = mergeTransforms(a, b);
            // BUG: a's two operations are silently dropped - only b's single operation survives
            expect(merged.updates[sharedId]).to.deep.equal([op3]);
            expect(merged.updates[sharedId]).to.not.deep.equal([op1, op2, op3]);
        });
        it('should silently drop insert from first transform when mergeTransforms has overlapping block IDs (BUG: data loss)', () => {
            const blockA = { header: { id: sharedId, type: 'test', collectionId: 'c' }, data: 'version-a', items: [] };
            const blockB = { header: { id: sharedId, type: 'test', collectionId: 'c' }, data: 'version-b', items: [] };
            const a = { inserts: { [sharedId]: blockA }, updates: {}, deletes: [] };
            const b = { inserts: { [sharedId]: blockB }, updates: {}, deletes: [] };
            const merged = mergeTransforms(a, b);
            // BUG: a's insert is silently overwritten by b's insert
            expect(merged.inserts[sharedId].data).to.equal('version-b');
        });
        it('should accumulate duplicate block IDs in deletes array from mergeTransforms', () => {
            const a = { inserts: {}, updates: {}, deletes: [sharedId] };
            const b = { inserts: {}, updates: {}, deletes: [sharedId] };
            const merged = mergeTransforms(a, b);
            // Deletes array has the same ID twice - not deduplicated
            expect(merged.deletes.filter(id => id === sharedId)).to.have.lengthOf(2);
        });
        it('should ignore Tracker insert when source already has block with same ID (BUG: silent shadow)', async () => {
            const sourceBlock = {
                header: { id: sharedId, type: 'test', collectionId: 'c' },
                data: 'from-source', items: ['original']
            };
            const insertedBlock = {
                header: { id: sharedId, type: 'test', collectionId: 'c' },
                data: 'from-insert', items: ['replaced']
            };
            const source = {
                tryGet: async (id) => id === sharedId ? structuredClone(sourceBlock) : undefined,
                generateId: () => 'gen',
                createBlockHeader: (type) => ({ id: 'gen', type, collectionId: 'c' })
            };
            const tracker = new Tracker(source);
            tracker.insert(insertedBlock);
            // The insert IS stored in transforms
            expect(tracker.transforms.inserts[sharedId]).to.exist;
            // BUG: tryGet returns the SOURCE block, not the inserted block
            const result = await tracker.tryGet(sharedId);
            expect(result.data).to.equal('from-source');
            expect(result.data).to.not.equal('from-insert');
        });
        it('should leave block in deletes after double-delete then re-insert (BUG: phantom delete)', async () => {
            const source = {
                tryGet: async () => undefined,
                generateId: () => 'gen',
                createBlockHeader: (type) => ({ id: 'gen', type, collectionId: 'c' })
            };
            const tracker = new Tracker(source);
            // Delete the same block twice
            tracker.delete(sharedId);
            tracker.delete(sharedId);
            expect(tracker.transforms.deletes.filter(id => id === sharedId)).to.have.lengthOf(2);
            // Re-insert - only removes one occurrence from deletes
            const block = {
                header: { id: sharedId, type: 'test', collectionId: 'c' },
                data: 'reinserted', items: []
            };
            tracker.insert(block);
            // BUG: One delete remains even though we re-inserted
            expect(tracker.transforms.deletes.filter(id => id === sharedId)).to.have.lengthOf(1);
            expect(tracker.transforms.inserts[sharedId]).to.exist;
            // Block is both in inserts AND deletes - contradictory state
            const hasInsert = Object.hasOwn(tracker.transforms.inserts, sharedId);
            const hasDelete = tracker.transforms.deletes.includes(sharedId);
            expect(hasInsert && hasDelete).to.be.true;
        });
        it('should silently overwrite existing block when applyTransformToStore inserts duplicate ID', async () => {
            const store = new TestBlockStore();
            const header = store.createBlockHeader('TL', sharedId);
            // Insert original block
            const original = { header, entries: ['original'] };
            store.insert(original);
            const before = await store.tryGet(sharedId);
            expect(before.entries).to.deep.equal(['original']);
            // Apply transform that inserts a block with the same ID
            const duplicate = { header, entries: ['overwritten'] };
            const transform = { inserts: { [sharedId]: duplicate }, updates: {}, deletes: [] };
            applyTransformToStore(transform, store);
            // BUG: Original is silently overwritten with no warning
            const after = await store.tryGet(sharedId);
            expect(after.entries).to.deep.equal(['overwritten']);
        });
        it('apply-over-insert survives copyTransforms (regression for fresh-collection chain.add)', async () => {
            // Models Collection.syncInternal: header block is inserted into the tracker, then
            // Chain.open applies headId/tailId to it via `apply()`. copyTransforms is called
            // to snapshot for the transact step, and a new Tracker opens another Log over the
            // snapshot. The snapshot must surface a header with headId/tailId — otherwise
            // Chain.open won't find the tail and chain.add throws "non-existent chain".
            const source = {
                tryGet: async () => undefined,
                generateId: () => 'gen',
                createBlockHeader: (type, newId) => ({ id: (newId ?? 'gen'), type, collectionId: 'c' })
            };
            const tracker = new Tracker(source);
            const headerId = 'hdr';
            const headerBlock = { header: { id: headerId, type: 'H', collectionId: 'c' }, rootId: 'root' };
            tracker.insert(headerBlock);
            // Chain.open's apply() pattern: two attribute ops on the already-inserted block
            apply(tracker, headerBlock, ['headId', 0, 0, 'tail-1']);
            apply(tracker, headerBlock, ['tailId', 0, 0, 'tail-1']);
            // Second inserted block (the tail)
            const tailBlock = { header: { id: 'tail-1', type: 'D', collectionId: 'c' }, entries: [], priorId: undefined, nextId: undefined };
            tracker.insert(tailBlock);
            // Take a snapshot copy, mirroring Collection.syncInternal
            const snapshot = copyTransforms(tracker.transforms);
            const snapshotTracker = new Tracker(source, snapshot);
            const hdr = await snapshotTracker.tryGet(headerId);
            expect(hdr).to.exist;
            expect(hdr.rootId).to.equal('root');
            expect(hdr.headId).to.equal('tail-1');
            expect(hdr.tailId).to.equal('tail-1');
            const tail = await snapshotTracker.tryGet('tail-1');
            expect(tail).to.exist;
            expect(tail.entries).to.deep.equal([]);
            // Both blocks should appear in transformedBlockIds. Since the two apply() calls
            // went into the inserted header in-place, there should be no updates[headerId].
            const ids = snapshotTracker.transformedBlockIds();
            expect(ids).to.have.members([headerId, 'tail-1']);
            expect(snapshot.updates?.[headerId]).to.be.undefined;
        });
        it('copyTransforms isolates inserted block objects from snapshot mutations', () => {
            const blockId = 'iso-block';
            const original = {
                inserts: { [blockId]: { header: { id: blockId, type: 'test', collectionId: 'c' }, data: 'orig', items: ['a'] } },
                updates: {},
                deletes: []
            };
            const snapshot = copyTransforms(original);
            // Object identity must change — otherwise mutations leak through the shared reference.
            expect(snapshot.inserts[blockId]).to.not.equal(original.inserts[blockId]);
            // A Tracker built over the snapshot mutates inserts in place via applyOperation.
            // That mutation must not be visible in the original transform.
            const source = {
                tryGet: async () => undefined,
                generateId: () => 'gen',
                createBlockHeader: (type) => ({ id: 'gen', type, collectionId: 'c' })
            };
            const snapshotTracker = new Tracker(source, snapshot);
            snapshotTracker.update(blockId, ['data', 0, 0, 'mutated']);
            expect(snapshot.inserts[blockId].data).to.equal('mutated');
            expect(original.inserts[blockId].data).to.equal('orig');
        });
        it('should silently drop operations when concatTransform overlaps existing updates (BUG: data loss)', () => {
            const existingOps = [['data', 0, 0, 'first'], ['items', 0, 0, ['a']]];
            const base = { inserts: {}, updates: { [sharedId]: existingOps }, deletes: [] };
            const newOps = [['data', 0, 0, 'second']];
            const result = concatTransform(base, sharedId, { updates: newOps });
            // BUG: base's operations for sharedId are silently overwritten
            expect(result.updates[sharedId]).to.deep.equal(newOps);
            expect(result.updates[sharedId]).to.not.include(existingOps[0]);
            expect(result.updates[sharedId]).to.not.include(existingOps[1]);
        });
    });
});
//# sourceMappingURL=transform.spec.js.map