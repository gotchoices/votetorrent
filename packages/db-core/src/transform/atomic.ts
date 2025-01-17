import { Tracker } from "./tracker.js";
import type { IBlock, BlockStore } from "../index.js";
import { applyTransformToStore } from "./helpers.js";

export class Atomic<TBlock extends IBlock> extends Tracker<TBlock> {
	constructor(public readonly store: BlockStore<TBlock>) {
		super(store);
	}

	commit() {
		const transform = this.reset();
		applyTransformToStore(transform, this.store);
	}

	// rollback = reset
}
