import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, BlockStore } from "../index.js";
import { Tracker, CacheSource, TransactorSource } from "../index.js";
import type { CollectionId, ICollection } from "./index.js";
import type { ReadDependency } from "../transaction/transaction.js";
export type CollectionInitOptions<TAction> = {
    modules: Record<ActionType, ActionHandler<TAction>>;
    createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
    /** Called for each local action that is potentially in conflict with a remote action.
     * @param action - The local action to check
     * @param potential - The remote action that is potentially in conflict
     * @returns The original action, a replacement action (return a new instance; will be
     * 	applied through act()), or undefined to discard this action
     */
    filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined;
};
export declare class Collection<TAction> implements ICollection<TAction> {
    readonly id: CollectionId;
    readonly transactor: ITransactor;
    private readonly handlers;
    private readonly source;
    /** Cache of unmodified blocks from the source */
    private readonly sourceCache;
    /** Tracked Changes */
    readonly tracker: Tracker<IBlock>;
    private readonly filterConflict?;
    private pending;
    private readonly latchId;
    protected constructor(id: CollectionId, transactor: ITransactor, handlers: Record<ActionType, ActionHandler<TAction>>, source: TransactorSource<IBlock>, 
    /** Cache of unmodified blocks from the source */
    sourceCache: CacheSource<IBlock>, 
    /** Tracked Changes */
    tracker: Tracker<IBlock>, filterConflict?: ((action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined) | undefined);
    static createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>): Promise<Collection<TAction>>;
    act(...actions: Action<TAction>[]): Promise<void>;
    private actInternal;
    private internalTransact;
    /** Load external changes and update our context to the latest log revision - resolve any conflicts with our pending actions. */
    update(): Promise<void>;
    private updateInternal;
    /** Push our pending actions to the transactor */
    sync(): Promise<void>;
    private syncInternal;
    updateAndSync(): Promise<void>;
    selectLog(forward?: boolean): AsyncIterableIterator<Action<TAction>>;
    private replayActions;
    getReadDependencies(): ReadDependency[];
    clearReadDependencies(): void;
    /** Called for each local action that may be in conflict with a remote action (always called under latch).
     * @param action - The local action to check
     * @param potential - The remote action that is potentially in conflict
     * @returns true if the action should be kept, false to discard it
     */
    protected doFilterConflict(action: Action<TAction>, potential: Action<TAction>[]): boolean;
    /** Bootstrap ActionContext from the committed tail block's state.
     * The tail is always committed first (commit protocol guarantee), so it's readable
     * with context=undefined. Its state.latest contains the ActionRev of the most recent
     * committed action — exactly the proof needed for the transactor to serve pending
     * non-tail blocks during chain walks.
     */
    private static bootstrapContext;
}
//# sourceMappingURL=collection.d.ts.map