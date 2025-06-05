/**
 * Converts an AsyncIterable into an array.
 * @param iterable The async iterable to convert.
 * @returns A promise that resolves with an array containing all items from the iterable.
 */
export async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterable) {
		console.log('item', item);
		result.push(item);
	}
	return result;
}
