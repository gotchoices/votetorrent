export declare class KeyBound<TKey> {
    key: TKey;
    inclusive: boolean;
    constructor(key: TKey, inclusive?: boolean);
}
/** Used for range scans.  Omitting first or last implies the end of the tree. */
export declare class KeyRange<TKey> {
    first?: KeyBound<TKey> | undefined;
    last?: KeyBound<TKey> | undefined;
    isAscending: boolean;
    constructor(first?: KeyBound<TKey> | undefined, last?: KeyBound<TKey> | undefined, isAscending?: boolean);
}
//# sourceMappingURL=key-range.d.ts.map