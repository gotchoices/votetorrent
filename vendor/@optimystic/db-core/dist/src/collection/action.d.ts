import type { BlockStore } from "../index.js";
import type { IBlock } from "../index.js";
import type { TransactionRef } from "../transaction/index.js";
export type ActionId = string;
export type ActionType = string;
export type Action<T> = {
    type: ActionType;
    data: T;
    /** Optional reference to the transaction this action came from */
    transaction?: TransactionRef;
};
export type ActionHandler<T, TResult = void> = (action: Action<T>, store: BlockStore<IBlock>) => Promise<TResult>;
export type ActionRev = {
    actionId: ActionId;
    rev: number;
};
/** Situational awareness of the action state */
export type ActionContext = {
    /** Actions that may not have been checkpointed */
    committed: ActionRev[];
    /** The latest known revision number */
    rev: number;
    /** Optional uncommitted pending action ID */
    actionId?: ActionId;
};
//# sourceMappingURL=action.d.ts.map