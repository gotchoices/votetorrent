export declare function first<T>(createIterable: (signal: AbortSignal) => AsyncIterable<T>, onEmpty?: () => T, timeoutMs?: number): Promise<T>;
export declare function asyncIteratorToArray<T>(iterator: AsyncIterable<T>): Promise<T[]>;
export declare function reduce<TP, TC>(iter: IterableIterator<TC>, each: (prior: TP, current: TC, index: number) => TP, start: TP): TP;
//# sourceMappingURL=it-utility.d.ts.map