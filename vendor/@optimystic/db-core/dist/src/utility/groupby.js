// TODO: replace the usage of this with Object.groupBy in newer ES once more pervasive
/**
 * Groups an array of items by a key selector function.
 * @param array - The array of items to group.
 * @param keySelector - The function that selects the key for each item.
 * @returns An object where each key is a unique value from the key selector function, and each value is an array of items that have that key.
 */
export function groupBy(array, keySelector) {
    return array.reduce((acc, item) => {
        const key = keySelector(item);
        (acc[key] ??= []).push(item);
        return acc;
    }, {});
}
//# sourceMappingURL=groupby.js.map