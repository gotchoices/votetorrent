import { expect } from 'chai';
import { mergeRanges } from '../src/storage/helpers.js';
describe('mergeRanges', () => {
    it('returns empty array for empty input', () => {
        expect(mergeRanges([])).to.deep.equal([]);
    });
    it('returns single range unchanged', () => {
        expect(mergeRanges([[0, 10]])).to.deep.equal([[0, 10]]);
    });
    it('returns open-ended single range unchanged', () => {
        expect(mergeRanges([[5]])).to.deep.equal([[5]]);
    });
    it('merges adjacent ranges', () => {
        const result = mergeRanges([[0, 5], [5, 10]]);
        expect(result).to.deep.equal([[0, 10]]);
    });
    it('merges overlapping ranges', () => {
        const result = mergeRanges([[0, 7], [5, 10]]);
        expect(result).to.deep.equal([[0, 10]]);
    });
    it('keeps non-overlapping ranges separate', () => {
        const result = mergeRanges([[0, 5], [10, 15]]);
        expect(result).to.deep.equal([[0, 5], [10, 15]]);
    });
    it('handles unsorted input', () => {
        const result = mergeRanges([[10, 15], [0, 5], [5, 10]]);
        expect(result).to.deep.equal([[0, 15]]);
    });
    it('open-ended range consumes all following ranges', () => {
        // [3] is open-ended starting at 3, merges with [0, 5] to become [0, undefined]
        // which then consumes [10, 20]
        const result = mergeRanges([[0, 5], [3], [10, 20]]);
        // After sorting: [[0, 5], [3, undefined], [10, 20]]
        // [3, undefined] starts at 3 <= 5, so [0, 5] becomes [0, undefined]
        // [10, 20] is skipped because last is open-ended
        expect(result).to.deep.equal([[0, undefined]]);
    });
    it('extends closed range to open when merging with open-ended', () => {
        // [5] is [5, undefined], merges with [0, 10] because 5 <= 10
        const result = mergeRanges([[0, 10], [5]]);
        expect(result).to.deep.equal([[0, undefined]]);
    });
    it('handles multiple disjoint ranges correctly', () => {
        const result = mergeRanges([[0, 3], [5, 8], [10, 13], [15, 18]]);
        expect(result).to.deep.equal([[0, 3], [5, 8], [10, 13], [15, 18]]);
    });
    it('handles complex merge scenario', () => {
        // Ranges: [0-5], [4-8], [10-12], [11-15], [20-∞]
        const result = mergeRanges([[0, 5], [4, 8], [10, 12], [11, 15], [20]]);
        expect(result).to.deep.equal([[0, 8], [10, 15], [20]]);
    });
    it('handles touching but not overlapping ranges (exclusive end)', () => {
        // [0, 5) and [5, 10) should merge because 5 <= 5
        const result = mergeRanges([[0, 5], [5, 10]]);
        expect(result).to.deep.equal([[0, 10]]);
    });
    it('handles gap of 1 between ranges', () => {
        // [0, 5) and [6, 10) have gap at position 5
        const result = mergeRanges([[0, 5], [6, 10]]);
        expect(result).to.deep.equal([[0, 5], [6, 10]]);
    });
    it('handles identical ranges', () => {
        const result = mergeRanges([[5, 10], [5, 10], [5, 10]]);
        expect(result).to.deep.equal([[5, 10]]);
    });
    it('handles contained ranges', () => {
        // [0, 20) contains [5, 10)
        const result = mergeRanges([[0, 20], [5, 10]]);
        expect(result).to.deep.equal([[0, 20]]);
    });
    it('extends to larger end value when merging', () => {
        const result = mergeRanges([[0, 5], [3, 15]]);
        expect(result).to.deep.equal([[0, 15]]);
    });
});
//# sourceMappingURL=helpers.spec.js.map