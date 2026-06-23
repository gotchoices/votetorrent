import { expect } from 'chai';
import { LruMap } from '../src/utility/lru-map.js';
describe('LruMap', () => {
    it('should store and retrieve values', () => {
        const map = new LruMap(10);
        map.set('a', 1);
        map.set('b', 2);
        expect(map.get('a')).to.equal(1);
        expect(map.get('b')).to.equal(2);
    });
    it('should return undefined for missing keys', () => {
        const map = new LruMap(10);
        expect(map.get('missing')).to.be.undefined;
    });
    it('should report size correctly', () => {
        const map = new LruMap(10);
        expect(map.size).to.equal(0);
        map.set('a', 1);
        expect(map.size).to.equal(1);
        map.set('b', 2);
        expect(map.size).to.equal(2);
    });
    it('should evict oldest entry when full', () => {
        const map = new LruMap(2);
        map.set('a', 1);
        map.set('b', 2);
        map.set('c', 3);
        expect(map.has('a')).to.be.false;
        expect(map.get('b')).to.equal(2);
        expect(map.get('c')).to.equal(3);
        expect(map.size).to.equal(2);
    });
    it('should refresh entry on get', () => {
        const map = new LruMap(2);
        map.set('a', 1);
        map.set('b', 2);
        // Access 'a' to refresh it
        map.get('a');
        // Add 'c' — should evict 'b' (oldest), not 'a'
        map.set('c', 3);
        expect(map.has('a')).to.be.true;
        expect(map.has('b')).to.be.false;
        expect(map.has('c')).to.be.true;
    });
    it('should refresh entry on set (update)', () => {
        const map = new LruMap(2);
        map.set('a', 1);
        map.set('b', 2);
        // Update 'a' to refresh it
        map.set('a', 10);
        // Add 'c' — should evict 'b', not 'a'
        map.set('c', 3);
        expect(map.get('a')).to.equal(10);
        expect(map.has('b')).to.be.false;
    });
    it('should delete entries', () => {
        const map = new LruMap(10);
        map.set('a', 1);
        expect(map.delete('a')).to.be.true;
        expect(map.has('a')).to.be.false;
        expect(map.size).to.equal(0);
    });
    it('should return false for deleting missing key', () => {
        const map = new LruMap(10);
        expect(map.delete('missing')).to.be.false;
    });
    it('should clear all entries', () => {
        const map = new LruMap(10);
        map.set('a', 1);
        map.set('b', 2);
        map.clear();
        expect(map.size).to.equal(0);
        expect(map.has('a')).to.be.false;
    });
    it('should work with maxSize of 1', () => {
        const map = new LruMap(1);
        map.set('a', 1);
        expect(map.get('a')).to.equal(1);
        map.set('b', 2);
        expect(map.has('a')).to.be.false;
        expect(map.get('b')).to.equal(2);
        expect(map.size).to.equal(1);
    });
    it('should throw for maxSize < 1', () => {
        expect(() => new LruMap(0)).to.throw('maxSize must be >= 1');
        expect(() => new LruMap(-1)).to.throw('maxSize must be >= 1');
    });
    it('should be iterable', () => {
        const map = new LruMap(10);
        map.set('a', 1);
        map.set('b', 2);
        const entries = [...map];
        expect(entries).to.deep.equal([['a', 1], ['b', 2]]);
    });
    it('should not evict when setting existing key at capacity', () => {
        const map = new LruMap(2);
        map.set('a', 1);
        map.set('b', 2);
        // Update 'a' — should NOT evict anything
        map.set('a', 10);
        expect(map.size).to.equal(2);
        expect(map.get('a')).to.equal(10);
        expect(map.get('b')).to.equal(2);
    });
});
//# sourceMappingURL=lru-map.spec.js.map