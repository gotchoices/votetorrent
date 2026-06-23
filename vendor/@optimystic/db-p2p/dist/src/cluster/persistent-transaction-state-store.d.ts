import type { IKVStore } from "../storage/i-kv-store.js";
import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from "./i-transaction-state-store.js";
/**
 * ITransactionStateStore backed by an IKVStore for cross-platform persistence.
 *
 * Key namespace:
 *   coordinator/{messageHash}  → JSON(PersistedCoordinatorState)
 *   participant/{messageHash}  → JSON(PersistedParticipantState)
 *   executed/{messageHash}     → JSON({ timestamp: number })
 */
export declare class PersistentTransactionStateStore implements ITransactionStateStore {
    private readonly kv;
    constructor(kv: IKVStore);
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
//# sourceMappingURL=persistent-transaction-state-store.d.ts.map