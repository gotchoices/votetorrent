import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from "./i-transaction-state-store.js";
/** In-memory ITransactionStateStore. Default when no persistent store is injected. */
export declare class MemoryTransactionStateStore implements ITransactionStateStore {
    private readonly coordinatorStates;
    private readonly participantStates;
    private readonly executedMap;
    saveCoordinatorState(messageHash: string, state: PersistedCoordinatorState): Promise<void>;
    getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined>;
    deleteCoordinatorState(messageHash: string): Promise<void>;
    getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]>;
    saveParticipantState(messageHash: string, state: PersistedParticipantState): Promise<void>;
    getParticipantState(messageHash: string): Promise<PersistedParticipantState | undefined>;
    deleteParticipantState(messageHash: string): Promise<void>;
    getAllParticipantStates(): Promise<PersistedParticipantState[]>;
    markExecuted(messageHash: string, timestamp: number): Promise<void>;
    wasExecuted(messageHash: string): Promise<boolean>;
    pruneExecuted(olderThan: number): Promise<void>;
}
//# sourceMappingURL=memory-transaction-state-store.d.ts.map