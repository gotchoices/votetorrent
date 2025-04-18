/** Lightweight implementation of a mutex lock queue. */
export class Latches {
    // Stores the promise representing the completion of the last queued operation for a key.
    private static lockQueues = new Map<string, Promise<void>>();

    /**
     * Acquires a lock for the given key. Waits if another operation holds the lock.
     * Returns a release function that must be called to release the lock.
		 * WARNING: The key scope is global to the entire process, so follow the convention of using `ClassName.methodName:${id}` to avoid conflicts.
     */
    static async acquire(key: string): Promise<() => void> {
        // Get the promise the current operation needs to wait for (if any)
        const currentTail = this.lockQueues.get(key) ?? Promise.resolve();

        let resolveNewTail: () => void;
        // Create the promise that the *next* operation will wait for
        const newTail = new Promise<void>(resolve => {
            resolveNewTail = resolve;
        });

        // Immediately set the new promise as the tail for this key
        this.lockQueues.set(key, newTail);

        // Wait for the previous operation (if any) to complete
        await currentTail;

        // Lock acquired. Return the function to release *this* lock.
        const release = () => {
            // Signal that this operation is complete, allowing the next awaiter (if any)
            resolveNewTail();

            // Optimization: If this promise is still the current tail in the map,
            // it means no other operation queued up behind this one while it was running.
            // We can safely remove the entry from the map to prevent unbounded growth.
            if (this.lockQueues.get(key) === newTail) {
                this.lockQueues.delete(key);
            }
        };

        return release;
    }
}
