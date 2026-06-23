import { Chain } from "../index.js";
import type { IBlock, BlockId, ActionId, CollectionId, ChainPath, ActionRev, ActionContext, BlockStore } from "../index.js";
import type { ChainDataNode } from '../chain/chain-nodes.js';
import type { LogEntry } from "./index.js";
import type { GetFromResult } from './struct.js';
export type LogBlock<TAction> = ChainDataNode<LogEntry<TAction>> & {
    /** Base64url encoded Sha256 hash of the next block - present on every block except the head */
    priorHash?: string;
};
export declare const priorHash$: string;
export declare class Log<TAction> {
    private readonly chain;
    protected constructor(chain: Chain<LogEntry<TAction>>);
    get id(): string;
    /** Opens a presumably existing log. */
    static open<TAction>(store: BlockStore<IBlock>, id: BlockId): Promise<Log<TAction> | undefined>;
    /** Creates a new log. */
    static create<TAction>(store: BlockStore<IBlock>, options?: {
        newId?: BlockId;
        existingHeaderId?: BlockId;
    }): Promise<Log<TAction>>;
    /** Adds a new entry to the log. */
    addActions(actions: TAction[], actionId: ActionId, rev: number, getBlockIds: () => BlockId[], collectionIds?: CollectionId[], timestamp?: number): Promise<{
        entry: {
            action: {
                blockIds: string[];
                actionId: ActionId;
                actions: TAction[];
                collectionIds?: CollectionId[];
            };
            timestamp: number;
            rev: number;
            checkpoint?: import("./struct.js").CheckpointEntry;
        };
        tailPath: ChainPath<LogEntry<TAction>>;
    }>;
    /** Adds a checkpoint to the log. */
    addCheckpoint(pendings: ActionRev[], rev: number, timestamp?: number): Promise<{
        entry: {
            timestamp: number;
            rev: number;
            checkpoint: {
                pendings: ActionRev[];
            };
        };
        tailPath: ChainPath<LogEntry<TAction>>;
    }>;
    /** Gets the action context of the log. */
    getActionContext(): Promise<ActionContext | undefined>;
    /** Gets the actions from startRev (exclusive), to latest in the log. */
    getFrom(startRev: number | undefined): Promise<GetFromResult<TAction>>;
    /** Enumerates log entries from the given starting path or end if undefined, in forward (from tail to head) or reverse (from head to tail) order. */
    select(starting?: ChainPath<LogEntry<TAction>>, forward?: boolean): AsyncGenerator<LogEntry<TAction>, void, unknown>;
    /** Returns the set of pending transactions in the most recent checkpoint, at or preceding the given path. */
    private findCheckpoint;
    /** Returns the set of pending actions following, the given checkpoint path. */
    private pendingFrom;
    private static getChainOptions;
}
//# sourceMappingURL=log.d.ts.map