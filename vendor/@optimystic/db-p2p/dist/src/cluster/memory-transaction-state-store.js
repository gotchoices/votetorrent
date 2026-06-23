/** In-memory ITransactionStateStore. Default when no persistent store is injected. */
export class MemoryTransactionStateStore {
    coordinatorStates = new Map();
    participantStates = new Map();
    executedMap = new Map();
    async saveCoordinatorState(messageHash, state) {
        this.coordinatorStates.set(messageHash, state);
    }
    async getCoordinatorState(messageHash) {
        return this.coordinatorStates.get(messageHash);
    }
    async deleteCoordinatorState(messageHash) {
        this.coordinatorStates.delete(messageHash);
    }
    async getAllCoordinatorStates() {
        return Array.from(this.coordinatorStates.values());
    }
    async saveParticipantState(messageHash, state) {
        this.participantStates.set(messageHash, state);
    }
    async getParticipantState(messageHash) {
        return this.participantStates.get(messageHash);
    }
    async deleteParticipantState(messageHash) {
        this.participantStates.delete(messageHash);
    }
    async getAllParticipantStates() {
        return Array.from(this.participantStates.values());
    }
    async markExecuted(messageHash, timestamp) {
        this.executedMap.set(messageHash, timestamp);
    }
    async wasExecuted(messageHash) {
        return this.executedMap.has(messageHash);
    }
    async pruneExecuted(olderThan) {
        for (const [hash, ts] of this.executedMap) {
            if (ts < olderThan) {
                this.executedMap.delete(hash);
            }
        }
    }
}
//# sourceMappingURL=memory-transaction-state-store.js.map