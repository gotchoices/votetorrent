/**
 * ITransactionStateStore backed by an IKVStore for cross-platform persistence.
 *
 * Key namespace:
 *   coordinator/{messageHash}  → JSON(PersistedCoordinatorState)
 *   participant/{messageHash}  → JSON(PersistedParticipantState)
 *   executed/{messageHash}     → JSON({ timestamp: number })
 */
export class PersistentTransactionStateStore {
    kv;
    constructor(kv) {
        this.kv = kv;
    }
    // --- Coordinator ---
    async saveCoordinatorState(messageHash, state) {
        await this.kv.set(`coordinator/${messageHash}`, JSON.stringify(state));
    }
    async getCoordinatorState(messageHash) {
        const raw = await this.kv.get(`coordinator/${messageHash}`);
        return raw ? JSON.parse(raw) : undefined;
    }
    async deleteCoordinatorState(messageHash) {
        await this.kv.delete(`coordinator/${messageHash}`);
    }
    async getAllCoordinatorStates() {
        const keys = await this.kv.list('coordinator/');
        const results = [];
        for (const key of keys) {
            const raw = await this.kv.get(key);
            if (raw) {
                results.push(JSON.parse(raw));
            }
        }
        return results;
    }
    // --- Participant ---
    async saveParticipantState(messageHash, state) {
        await this.kv.set(`participant/${messageHash}`, JSON.stringify(state));
    }
    async getParticipantState(messageHash) {
        const raw = await this.kv.get(`participant/${messageHash}`);
        return raw ? JSON.parse(raw) : undefined;
    }
    async deleteParticipantState(messageHash) {
        await this.kv.delete(`participant/${messageHash}`);
    }
    async getAllParticipantStates() {
        const keys = await this.kv.list('participant/');
        const results = [];
        for (const key of keys) {
            const raw = await this.kv.get(key);
            if (raw) {
                results.push(JSON.parse(raw));
            }
        }
        return results;
    }
    // --- Executed ---
    async markExecuted(messageHash, timestamp) {
        await this.kv.set(`executed/${messageHash}`, JSON.stringify({ timestamp }));
    }
    async wasExecuted(messageHash) {
        const raw = await this.kv.get(`executed/${messageHash}`);
        return raw !== undefined;
    }
    async pruneExecuted(olderThan) {
        const keys = await this.kv.list('executed/');
        for (const key of keys) {
            const raw = await this.kv.get(key);
            if (raw) {
                const { timestamp } = JSON.parse(raw);
                if (timestamp < olderThan) {
                    await this.kv.delete(key);
                }
            }
        }
    }
}
//# sourceMappingURL=persistent-transaction-state-store.js.map