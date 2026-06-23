import { expect } from 'chai';
import { CacheSource } from '../src/transform/cache-source.js';
function makeBlock(id, data = 'test', items = []) {
    return {
        header: { id: id, type: 'test', collectionId: 'col' },
        data,
        items,
    };
}
function makeSource(blocks) {
    return {
        tryGet: async (id) => {
            const block = blocks.get(id);
            return block ? structuredClone(block) : undefined;
        },
        generateId: () => 'gen-id',
        createBlockHeader: (type) => ({ id: 'gen-id', type, collectionId: 'col' }),
    };
}
describe('CacheSource', () => {
    let blocks;
    let source;
    let cache;
    beforeEach(() => {
        blocks = new Map([
            ['a', makeBlock('a', 'alpha', ['x', 'y'])],
            ['b', makeBlock('b', 'beta')],
        ]);
        source = makeSource(blocks);
        cache = new CacheSource(source);
    });
    describe('tryGet', () => {
        it('should return block from source on cache miss', async () => {
            const result = await cache.tryGet('a');
            expect(result).to.not.be.undefined;
            expect(result.data).to.equal('alpha');
            expect(result.items).to.deep.equal(['x', 'y']);
        });
        it('should return cached block on subsequent calls', async () => {
            await cache.tryGet('a');
            // Mutate the source to prove cache is used
            blocks.set('a', makeBlock('a', 'changed'));
            const result = await cache.tryGet('a');
            expect(result.data).to.equal('alpha');
        });
        it('should return undefined for absent blocks', async () => {
            const result = await cache.tryGet('missing');
            expect(result).to.be.undefined;
        });
        it('should not cache absent blocks', async () => {
            await cache.tryGet('missing');
            // Add the block to source
            blocks.set('missing', makeBlock('missing', 'now-here'));
            const result = await cache.tryGet('missing');
            expect(result.data).to.equal('now-here');
        });
        it('should return a clone — mutating result does not affect cache', async () => {
            const first = await cache.tryGet('a');
            first.data = 'mutated';
            first.items.push('z');
            const second = await cache.tryGet('a');
            expect(second.data).to.equal('alpha');
            expect(second.items).to.deep.equal(['x', 'y']);
        });
    });
    describe('clear', () => {
        it('should clear specific blocks', async () => {
            await cache.tryGet('a');
            await cache.tryGet('b');
            cache.clear(['a']);
            // Mutate source to detect refetch
            blocks.set('a', makeBlock('a', 'refetched'));
            const a = await cache.tryGet('a');
            const b = await cache.tryGet('b');
            expect(a.data).to.equal('refetched');
            expect(b.data).to.equal('beta');
        });
        it('should clear all blocks when called without arguments', async () => {
            await cache.tryGet('a');
            await cache.tryGet('b');
            cache.clear();
            blocks.set('a', makeBlock('a', 'new-a'));
            blocks.set('b', makeBlock('b', 'new-b'));
            const a = await cache.tryGet('a');
            const b = await cache.tryGet('b');
            expect(a.data).to.equal('new-a');
            expect(b.data).to.equal('new-b');
        });
    });
    describe('transformCache', () => {
        it('should apply deletes to cached blocks', async () => {
            await cache.tryGet('a');
            const transform = { deletes: ['a'] };
            cache.transformCache(transform);
            // Block is removed from cache — refetch from source
            blocks.set('a', makeBlock('a', 'refetched'));
            const result = await cache.tryGet('a');
            expect(result.data).to.equal('refetched');
        });
        it('should apply inserts to cache', async () => {
            const newBlock = makeBlock('c', 'gamma');
            const transform = { inserts: { c: newBlock } };
            cache.transformCache(transform);
            const result = await cache.tryGet('c');
            expect(result.data).to.equal('gamma');
        });
        it('should clone inserted blocks', async () => {
            const newBlock = makeBlock('c', 'gamma');
            const transform = { inserts: { c: newBlock } };
            cache.transformCache(transform);
            // Mutate original
            newBlock.data = 'mutated';
            const result = await cache.tryGet('c');
            expect(result.data).to.equal('gamma');
        });
        it('should apply updates to cached blocks', async () => {
            await cache.tryGet('a');
            const op = ['data', 0, 0, 'updated'];
            const transform = { updates: { a: [op] } };
            cache.transformCache(transform);
            const result = await cache.tryGet('a');
            expect(result.data).to.equal('updated');
        });
        it('should apply array updates to cached blocks', async () => {
            await cache.tryGet('a');
            const op = ['items', 1, 1, ['z']];
            const transform = { updates: { a: [op] } };
            cache.transformCache(transform);
            const result = await cache.tryGet('a');
            expect(result.items).to.deep.equal(['x', 'z']);
        });
        it('should no-op for updates on uncached blocks', async () => {
            const op = ['data', 0, 0, 'updated'];
            const transform = { updates: { a: [op] } };
            cache.transformCache(transform);
            // Block was not in cache, so update is a no-op — source data is unchanged
            const result = await cache.tryGet('a');
            expect(result.data).to.equal('alpha');
        });
    });
    describe('LRU eviction', () => {
        it('should evict oldest entry when maxSize exceeded', async () => {
            const smallCache = new CacheSource(source, 2);
            await smallCache.tryGet('a');
            await smallCache.tryGet('b');
            // Add a third block — should evict 'a' (oldest)
            blocks.set('c', makeBlock('c', 'gamma'));
            await smallCache.tryGet('c');
            // 'b' is still cached (verify before refetching 'a', which would evict 'b')
            blocks.set('b', makeBlock('b', 'should-not-see'));
            const b = await smallCache.tryGet('b');
            expect(b.data).to.equal('beta');
            // 'a' was evicted — refetch from source
            blocks.set('a', makeBlock('a', 'refetched'));
            const a = await smallCache.tryGet('a');
            expect(a.data).to.equal('refetched');
        });
        it('should refresh entry on access', async () => {
            const smallCache = new CacheSource(source, 2);
            await smallCache.tryGet('a');
            await smallCache.tryGet('b');
            // Access 'a' again to refresh it
            await smallCache.tryGet('a');
            // Add 'c' — should evict 'b' (oldest), not 'a' (refreshed)
            blocks.set('c', makeBlock('c', 'gamma'));
            await smallCache.tryGet('c');
            // 'a' is still cached
            blocks.set('a', makeBlock('a', 'should-not-see'));
            const a = await smallCache.tryGet('a');
            expect(a.data).to.equal('alpha');
            // 'b' was evicted
            blocks.set('b', makeBlock('b', 'refetched'));
            const b = await smallCache.tryGet('b');
            expect(b.data).to.equal('refetched');
        });
        it('should work with maxSize of 1', async () => {
            const tinyCache = new CacheSource(source, 1);
            await tinyCache.tryGet('a');
            await tinyCache.tryGet('b');
            // 'a' was evicted
            blocks.set('a', makeBlock('a', 'refetched'));
            const a = await tinyCache.tryGet('a');
            expect(a.data).to.equal('refetched');
        });
    });
    describe('delegation', () => {
        it('should delegate generateId to source', () => {
            expect(cache.generateId()).to.equal('gen-id');
        });
        it('should delegate createBlockHeader to source', () => {
            const header = cache.createBlockHeader('test');
            expect(header.type).to.equal('test');
        });
    });
});
//# sourceMappingURL=cache-source.spec.js.map