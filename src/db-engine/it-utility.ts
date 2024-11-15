export async function first<T>(
	createIterable: (signal: AbortSignal) => AsyncIterable<T>,
	onEmpty: () => T = () => { throw new Error('No items found') }
): Promise<T> {
	const controller = new AbortController();
	try {
		for await (const item of createIterable(controller.signal)) {
			return item;
		}
		return onEmpty();
	} finally {
		controller.abort();
	}
}
