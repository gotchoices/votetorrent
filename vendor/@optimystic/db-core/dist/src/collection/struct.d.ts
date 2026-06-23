import type { IBlock, BlockId, Action } from "../index.js";
import type { IChainHeader } from "../chain/chain-nodes.js";
export type CollectionId = BlockId;
export type CollectionHeaderBlock = IBlock & Partial<IChainHeader>;
export interface ICollection<TAction> {
    readonly id: CollectionId;
    act(...actions: Action<TAction>[]): Promise<void>;
    update(): Promise<void>;
    sync(): Promise<void>;
    updateAndSync(): Promise<void>;
    selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
}
export type CreateCollectionAction = Action<void> & {
    type: "create";
};
//# sourceMappingURL=struct.d.ts.map