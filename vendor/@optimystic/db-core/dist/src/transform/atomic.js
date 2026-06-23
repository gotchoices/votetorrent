import { Tracker } from "./tracker.js";
import { applyTransformToStore } from "./helpers.js";
export class Atomic extends Tracker {
    store;
    constructor(store) {
        super(store);
        this.store = store;
    }
    commit() {
        const transform = this.reset();
        applyTransformToStore(transform, this.store);
    }
}
//# sourceMappingURL=atomic.js.map