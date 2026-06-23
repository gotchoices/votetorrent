type AsyncMethodKeys<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];
type Actor<T> = {
    [K in AsyncMethodKeys<T>]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
} & {
    [K in Exclude<keyof T, AsyncMethodKeys<T>>]: T[K];
};
export declare function createActor<T extends object>(target: T): Actor<T>;
export {};
//# sourceMappingURL=actor.d.ts.map