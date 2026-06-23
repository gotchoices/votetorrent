/**
 * Groups an array of items by a key selector function.
 * @param array - The array of items to group.
 * @param keySelector - The function that selects the key for each item.
 * @returns An object where each key is a unique value from the key selector function, and each value is an array of items that have that key.
 */
export declare function groupBy<T, K extends string | number | symbol>(array: T[], keySelector: (item: T) => K): Record<K, T[]>;
//# sourceMappingURL=groupby.d.ts.map