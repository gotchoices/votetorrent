import type { ClusterRecord } from "@optimystic/db-core";
/** Serializable coordinator transaction state (excludes timers, Pending wrapper) */
export interface PersistedCoordinatorState {
    messageHash: string;
    record: ClusterRecord;
    lastUpdate: number;
    /** Which phase was reached when last persisted */
    phase: 'promising' | 'committing' | 'broadcasting';
    /** Retry state for commit broadcast failures (excludes timer) */
    retryState?: {
        pendingPeers: string[];
        attempt: number;
        intervalMs: number;
    };
}
/** Serializable participant transaction state (excludes timers) */
export interface PersistedParticipantState {
    messageHash: string;
    record: ClusterRecord;
    lastUpdate: number;
}
/** Platform-agnostic store for persisting 2PC transaction state. */
export interface ITransactionStateStore {
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
//# sourceMappingURL=i-transaction-state-store.d.ts.map