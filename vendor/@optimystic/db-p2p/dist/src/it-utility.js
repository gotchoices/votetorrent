export async function first(createIterable, onEmpty = () => { throw new Error('No items found'); }, timeoutMs) {
    const controller = new AbortController();
    const timer = typeof timeoutMs === 'number' ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
        for await (const item of createIterable(controller.signal)) {
            return item;
        }
        return onEmpty();
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        controller.abort();
    }
}
export async function asyncIteratorToArray(iterator) {
    const result = [];
    for await (const item of iterator) {
        result.push(item);
    }
    return result;
}
export function reduce(iter, each, start) {
    let prior = start;
    let i = 0;
    for (let current of iter) {
        prior = each(prior, current, i);
        ++i;
    }
    return prior;
}
//# sourceMappingURL=it-utility.js.map