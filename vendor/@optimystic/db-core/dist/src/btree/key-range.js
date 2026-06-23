export class KeyBound {
    key;
    inclusive;
    constructor(key, inclusive = true) {
        this.key = key;
        this.inclusive = inclusive;
    }
}
/** Used for range scans.  Omitting first or last implies the end of the tree. */
export class KeyRange {
    first;
    last;
    isAscending;
    constructor(first, last, isAscending = true) {
        this.first = first;
        this.last = last;
        this.isAscending = isAscending;
    }
}
//# sourceMappingURL=key-range.js.map