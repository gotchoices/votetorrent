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

export async function asyncIteratorToArray<T>(iterator: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iterator) {
		result.push(item);
	}
	return result;
}

export function reduce<TP, TC>(iter: IterableIterator<TC>, each: (prior: TP, current: TC, index: number) => TP, start: TP) {
	let prior = start;
	let i = 0;
	for (let current of iter) {
		prior = each(prior, current, i);
		++i;
	}
	return prior;
}

