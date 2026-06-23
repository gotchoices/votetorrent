import { Tracker } from "./tracker.js";
import type { IBlock, BlockStore } from "../index.js";
export declare class Atomic<TBlock extends IBlock> extends Tracker<TBlock> {
    readonly store: BlockStore<TBlock>;
    constructor(store: BlockStore<TBlock>);
    commit(): void;
}
//# sourceMappingURL=atomic.d.ts.map