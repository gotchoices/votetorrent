import { applyOperation } from "../transform/helpers.js";
export async function get(store, id) {
    const block = await store.tryGet(id);
    if (!block)
        throw Error(`Missing block (${id})`);
    return block;
}
export function apply(store, block, op) {
    applyOperation(block, op);
    store.update(block.header.id, op);
}
//# sourceMappingURL=helpers.js.map