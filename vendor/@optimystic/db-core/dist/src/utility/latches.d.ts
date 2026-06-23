/** Lightweight implementation of a mutex lock queue. */
export declare class Latches {
    private static lockQueues;
    /**
     * Acquires a lock for the given key. Waits if another operation holds the lock.
     * Returns a release function that must be called to release the lock.
         * WARNING: The key scope is global to the entire process, so follow the convention of using `ClassName.methodName:${id}` to avoid conflicts.
     */
    static acquire(key: string): Promise<() => void>;
}
//# sourceMappingURL=latches.d.ts.map