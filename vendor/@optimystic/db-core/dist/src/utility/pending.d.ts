export declare class Pending<T> {
    promise: Promise<T>;
    response?: T;
    error?: unknown;
    t1: number;
    duration?: number;
    get isResponse(): boolean;
    get isError(): boolean;
    get isComplete(): boolean;
    result(): Promise<T>;
    constructor(promise: Promise<T>);
}
//# sourceMappingURL=pending.d.ts.map