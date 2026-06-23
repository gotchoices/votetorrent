import { Path, PathBranch } from "./index.js";
import { apply, get } from "../blocks/index.js";
import { TreeLeafBlockType, TreeBranchBlockType, entries$, nodes$, partitions$ } from "./nodes.js";
import { AtomicProxy } from "../transform/atomic-proxy.js";
export const NodeCapacity = 64;
/**
 * Represents a lightweight B+(ish)Tree (data at leaves, but no linked list of leaves).
 * Allows for efficient storage and retrieval of data in a sorted manner.
 * @template TEntry The type of entries stored in the B-tree.
 * @template TKey The type of keys used for indexing the entries.  This might be an element of TEntry, or TEntry itself.
 */
export class BTree {
    store;
    trunk;
    keyFromEntry;
    compare;
    _version = 0; // only for path invalidation
    _proxy;
    /**
     * @param [compare=(a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0] a comparison function for keys.  The default uses < and > operators.
     * @param [keyFromEntry=(entry: TEntry) => entry as unknown as TKey] a function to extract the key from an entry.  The default assumes the key is the entry itself.
     */
    constructor(store, trunk, keyFromEntry = (entry) => entry, compare = (a, b) => a < b ? -1 : a > b ? 1 : 0) {
        this.store = store;
        this.trunk = trunk;
        this.keyFromEntry = keyFromEntry;
        this.compare = compare;
    }
    atomic(fn) {
        return this._proxy ? this._proxy.atomic(fn) : fn();
    }
    static createRoot(store) {
        return newLeafNode(store, []);
    }
    static create(store, createTrunk, keyFromEntry = (entry) => entry, compare = (a, b) => a < b ? -1 : a > b ? 1 : 0, newId) {
        const proxy = new AtomicProxy(store);
        const root = BTree.createRoot(proxy);
        proxy.insert(root);
        const trunk = createTrunk(proxy, root.header.id, newId);
        const tree = new BTree(proxy, trunk, keyFromEntry, compare);
        tree._proxy = proxy;
        return tree;
    }
    /** @returns a path to the first entry (on = false if no entries) */
    async first() {
        return await this.getFirst(await this.trunk.get());
    }
    /** @returns a path to the last entry (on = false if no entries) */
    async last() {
        return await this.getLast(await this.trunk.get());
    }
    /** Attempts to find the given key
     * @returns Path to the key or the "crack" before it.  If `on` is true on the resulting path, the key was found.
     * 	If `on` is false, next() and prior() can attempt to move to the nearest match. */
    async find(key) {
        return await this.getPath(await this.trunk.get(), key);
    }
    /** Retrieves the entry for the given key.
     * Use find instead for a path to the key, the nearest match, or as a basis for navigation.
     * @returns the entry for the given key if found; undefined otherwise. */
    async get(key) {
        return this.at(await this.find(key));
    }
    /** @returns the entry for the given path if on an entry; undefined otherwise. */
    at(path) {
        this.validatePath(path);
        return path.on ? this.getEntry(path) : undefined;
    }
    /** Iterates based on the given range
     * WARNING: mutation during iteration will result in an exception
    */
    async *range(range) {
        const startPath = range.first
            ? await this.findFirst(range)
            : (range.isAscending ? await this.first() : await this.last());
        const endPath = range.last
            ? await this.findLast(range)
            : (range.isAscending ? await this.last() : await this.first());
        // If the tree is empty or endPath is not on an entry, return early
        if (!endPath.on) {
            return;
        }
        const endKey = this.keyFromPath(endPath);
        const iterable = range.isAscending
            ? this.internalAscending(startPath)
            : this.internalDescending(startPath);
        const iter = iterable[Symbol.asyncIterator]();
        const ascendingFactor = range.isAscending ? 1 : -1;
        for await (let path of iter) {
            if (!path.on || this.compare(this.keyFromPath(path), endKey) * ascendingFactor > 0) {
                break;
            }
            yield path;
        }
    }
    /** @returns true if the given path remains valid; false if the tree has been mutated, invalidating the path. */
    isValid(path) {
        return path.version === this._version;
    }
    /**
     * Adds a value to the tree.  Be sure to check the result, as the tree does not allow duplicate keys.
     * Added entries are frozen to ensure immutability
     * @returns path to the new (on = true) or conflicting (on = false) row. */
    async insert(entry) {
        return this.atomic(async () => {
            Object.freeze(entry); // Ensure immutability
            const path = await this.internalInsert(entry);
            if (path.on) {
                path.version = ++this._version;
            }
            return path;
        });
    }
    /** Updates the entry at the given path to the given value.  Deletes and inserts if the key changes.
     * @returns path to resulting entry and whether it was an update (as opposed to an insert).
     * 	* on = true if update/insert succeeded.
     * 		* wasUpdate = true if updated; false if inserted.
     * 		* Returned path is on entry
     * 	* on = false if update/insert failed.
     * 		* wasUpdate = true, given path is not on an entry
     * 		* else newEntry's new key already present; returned path is "near" existing entry */
    async updateAt(path, newEntry) {
        return this.atomic(async () => {
            this.validatePath(path);
            if (path.on) {
                Object.freeze(newEntry);
            }
            const result = await this.internalUpdate(path, newEntry);
            if (result[0].on) {
                result[0].version = ++this._version;
            }
            return result;
        });
    }
    /** Inserts the entry if it doesn't exist, or updates it if it does.
     * The entry is frozen to ensure immutability.
     * @returns path to the new entry.  on = true if existing; on = false if new. */
    async upsert(entry) {
        return this.atomic(async () => {
            const path = await this.find(this.keyFromEntry(entry));
            Object.freeze(entry);
            if (path.on) {
                this.updateEntry(path, entry);
            }
            else {
                await this.internalInsertAt(path, entry);
            }
            path.version = ++this._version;
            return path;
        });
    }
    /** Inserts or updates depending on the existence of the given key, using callbacks to generate the new value.
     * @param newEntry the new entry to insert if the key doesn't exist.
     * @param getUpdated a callback to generate an updated entry if the key does exist.  WARNING: mutation in this callback will cause merge to error.
     * @returns path to new entry and whether an update or insert attempted.
     * If getUpdated callback returns a row that is already present, the resulting path will not be on. */
    async merge(newEntry, getUpdated) {
        return this.atomic(async () => {
            const newKey = await this.keyFromEntry(newEntry);
            const path = await this.find(newKey);
            if (path.on) {
                const result = await this.updateAt(path, getUpdated(this.getEntry(path))); // Don't use internalUpdate - need to freeze and check for mutation
                // Note: updateAt already increments version, so don't double-increment here
                return result;
            }
            else {
                await this.internalInsertAt(path, Object.freeze(newEntry));
                path.on = true;
                path.version = ++this._version;
                return [path, false];
            }
        });
    }
    /** Deletes the entry at the given path.
     * The on property of the path will be cleared.
     * @returns true if the delete succeeded (the key was found); false otherwise.
    */
    async deleteAt(path) {
        return this.atomic(async () => {
            this.validatePath(path);
            const result = await this.internalDelete(path);
            if (result) {
                ++this._version;
            }
            return result;
        });
    }
    async drop() {
        return this.atomic(async () => {
            const root = await this.trunk.get();
            for await (const id of this.nodeIds(root)) {
                this.store.delete(id);
            }
        });
    }
    /** Iterates forward starting from the path location (inclusive) to the end.
     * WARNING: mutation during iteration will result in an exception.
    */
    ascending(path) {
        this.validatePath(path);
        return this.internalAscending(path.clone());
    }
    /** Iterates backward starting from the path location (inclusive) to the end.
     * WARNING: mutation during iteration will result in an exception
    */
    descending(path) {
        this.validatePath(path);
        return this.internalDescending(path.clone());
    }
    /** Computed (not stored) count.  Computes the sum using leaf-node lengths.  O(n/af) where af is average fill.
     * @param from if provided, the count will start from the given path (inclusive).  If ascending is false,
     * 	the count will start from the end of the tree.  Ascending is true by default.
     */
    async getCount(from) {
        let result = 0;
        const path = from ? from.path.clone() : await this.first();
        if (from?.ascending ?? true) {
            while (path.on) {
                result += path.leafNode.entries.length - path.leafIndex;
                path.leafIndex = path.leafNode.entries.length - 1;
                await this.internalNext(path);
            }
        }
        else {
            while (path.on) {
                result += path.leafIndex + 1;
                path.leafIndex = 0;
                await this.internalPrior(path);
            }
        }
        return result;
    }
    /** @returns a path one step forward.  on will be true if the path hasn't hit the end. */
    async next(path) {
        const newPath = path.clone();
        await this.moveNext(newPath);
        return newPath;
    }
    /** Attempts to advance the given path one step forward. (mutates the path) */
    async moveNext(path) {
        this.validatePath(path);
        await this.internalNext(path);
    }
    /** @returns a path one step backward.  on will be true if the path hasn't hit the end. */
    async prior(path) {
        const newPath = path.clone();
        this.movePrior(newPath);
        return newPath;
    }
    /** Attempts to advance the given path one step backwards. (mutates the path) */
    async movePrior(path) {
        this.validatePath(path);
        await this.internalPrior(path);
    }
    /** @remarks Assumes the path is "on" */
    keyFromPath(path) {
        return this.keyFromEntry(path.leafNode.entries[path.leafIndex]);
    }
    async *internalAscending(path) {
        this.validatePath(path);
        while (path.on) {
            yield path;
            await this.moveNext(path); // Not internal - re-check after yield
        }
    }
    async *internalDescending(path) {
        this.validatePath(path);
        while (path.on) {
            yield path;
            await this.movePrior(path); // Not internal - re-check after yield
        }
    }
    async findFirst(range) {
        const startPath = await this.find(range.first.key);
        if (!startPath.on || (range.first && !range.first.inclusive)) {
            if (range.isAscending) {
                await this.internalNext(startPath);
            }
            else {
                await this.internalPrior(startPath);
            }
        }
        return startPath;
    }
    async findLast(range) {
        const endPath = await this.find(range.last.key);
        if (!endPath.on || (range.last && !range.last.inclusive)) {
            if (range.isAscending) {
                await this.internalPrior(endPath);
            }
            else {
                await this.internalNext(endPath);
            }
        }
        return endPath;
    }
    async getPath(node, key) {
        if (node.header.type === TreeLeafBlockType) {
            const leaf = node;
            const [on, index] = this.indexOfEntry(leaf.entries, key);
            return new Path([], leaf, index, on, this._version);
        }
        else {
            const branch = node;
            const index = this.indexOfKey(branch.partitions, key);
            const path = await this.getPath(await get(this.store, branch.nodes[index]), key);
            path.branches.unshift(new PathBranch(branch, index));
            return path;
        }
    }
    indexOfEntry(entries, key) {
        let lo = 0;
        let hi = entries.length - 1;
        let split = 0;
        let result = -1;
        while (lo <= hi) {
            split = (lo + hi) >>> 1;
            result = this.compare(key, this.keyFromEntry(entries[split]));
            if (result === 0)
                return [true, split];
            else if (result < 0)
                hi = split - 1;
            else
                lo = split + 1;
        }
        return [false, lo];
    }
    indexOfKey(keys, key) {
        let lo = 0;
        let hi = keys.length - 1;
        let split = 0;
        let result = -1;
        while (lo <= hi) {
            split = (lo + hi) >>> 1;
            result = this.compare(key, keys[split]);
            if (result === 0)
                return split + 1; // +1 because taking right partition
            else if (result < 0)
                hi = split - 1;
            else
                lo = split + 1;
        }
        return lo;
    }
    async internalNext(path) {
        if (!path.on) { // Attempt to move off of crack
            path.on = path.branches.every(branch => branch.index >= 0 && branch.index < branch.node.nodes.length)
                && path.leafIndex >= 0 && path.leafIndex < path.leafNode.entries.length;
            if (path.on) {
                return;
            }
        }
        else if (path.leafIndex >= path.leafNode.entries.length - 1) {
            let popCount = 0;
            let found = false;
            const last = path.branches.length - 1;
            while (popCount <= last && !found) {
                const branch = path.branches[last - popCount];
                if (branch.index === branch.node.partitions.length) // last node in branch
                    ++popCount;
                else
                    found = true;
            }
            if (!found) {
                path.leafIndex = path.leafNode.entries.length; // after last row = end crack
                path.on = false;
            }
            else {
                path.branches.splice(-popCount, popCount);
                const branch = path.branches.at(-1);
                ++branch.index;
                this.moveToFirst(await get(this.store, branch.node.nodes[branch.index]), path);
            }
        }
        else {
            ++path.leafIndex;
            path.on = true;
        }
    }
    async internalPrior(path) {
        this.validatePath(path);
        if (path.leafIndex <= 0) {
            let popCount = 0;
            let opening = false;
            const last = path.branches.length - 1;
            while (popCount <= last && !opening) {
                const branch = path.branches[last - popCount];
                if (branch.index === 0) // first node in branch
                    ++popCount;
                else
                    opening = true;
            }
            if (!opening) {
                path.leafIndex = 0;
                path.on = false;
            }
            else {
                path.branches.splice(-popCount, popCount);
                const branch = path.branches.at(-1);
                --branch.index;
                await this.moveToLast(await get(this.store, branch.node.nodes[branch.index]), path);
            }
        }
        else {
            --path.leafIndex;
            path.on = true;
        }
    }
    async internalUpdate(path, newEntry) {
        if (path.on) {
            const oldKey = this.keyFromPath(path);
            const newKey = this.keyFromEntry(newEntry);
            if (this.compare(oldKey, newKey) !== 0) { // if key changed, delete and re-insert
                let newPath = await this.internalInsert(newEntry);
                if (newPath.on) { // insert succeeded
                    this.internalDelete(await this.find(oldKey)); // Re-find - the prior insert invalidated the path
                    newPath = await this.find(newKey); // Re-find- delete invalidated path
                }
                return [newPath, false];
            }
            else {
                this.updateEntry(path, newEntry);
            }
        }
        return [path, true];
    }
    async internalDelete(path) {
        if (path.on) {
            apply(this.store, path.leafNode, [entries$, path.leafIndex, 1, []]);
            if (path.branches.length > 0) { // Only worry about underflows, balancing, etc. if not root
                if (path.leafIndex === 0 && path.leafNode.entries.length > 0) { // If we deleted index 0 and leaf is not empty, update branches with new key
                    const pathBranch = path.branches.at(-1);
                    this.updatePartition(pathBranch.index, path, path.branches.length - 1, this.keyFromPath(path));
                }
                const newRoot = await this.rebalanceLeaf(path, path.branches.length);
                if (newRoot) {
                    await this.trunk.set(newRoot);
                }
            }
            path.on = false;
            return true;
        }
        else {
            return false;
        }
    }
    async internalInsert(entry) {
        const path = await this.find(this.keyFromEntry(entry));
        if (path.on) {
            path.on = false;
            return path;
        }
        await this.internalInsertAt(path, entry);
        path.on = true;
        return path;
    }
    async internalInsertAt(path, entry) {
        let split = this.leafInsert(path, entry);
        let branchIndex = path.branches.length - 1;
        while (split && branchIndex >= 0) {
            split = await this.branchInsert(path, branchIndex, split);
            --branchIndex;
        }
        if (split) {
            const newBranch = newBranchNode(this.store, [split.key], [await this.trunk.getId(), split.right.header.id]);
            await this.store.insert(newBranch);
            await this.trunk.set(newBranch);
            path.branches.unshift(new PathBranch(newBranch, split.indexDelta));
        }
    }
    /** Starting from the given node, recursively working down to the leaf, build onto the path based on the beginning-most entry. */
    async moveToFirst(node, path) {
        if (node.header.type === TreeLeafBlockType) {
            const leaf = node;
            path.leafNode = leaf;
            path.leafIndex = 0;
            path.on = leaf.entries.length > 0;
        }
        else {
            path.branches.push(new PathBranch(node, 0));
            await this.moveToFirst(await get(this.store, node.nodes[0]), path);
        }
    }
    /** Starting from the given node, recursively working down to the leaf, build onto the path based on the end-most entry. */
    async moveToLast(node, path) {
        if (node.header.type === TreeLeafBlockType) {
            const leaf = node;
            const count = leaf.entries.length;
            path.leafNode = leaf;
            path.on = count > 0;
            path.leafIndex = count > 0 ? count - 1 : 0;
        }
        else {
            const branch = node;
            const pathBranch = new PathBranch(branch, branch.partitions.length);
            path.branches.push(pathBranch);
            await this.moveToLast(await get(this.store, branch.nodes[pathBranch.index]), path);
        }
    }
    /** Construct a path based on the first-most edge of the given. */
    async getFirst(node) {
        if (node.header.type === TreeLeafBlockType) {
            const leaf = node;
            return new Path([], leaf, 0, leaf.entries.length > 0, this._version);
        }
        else {
            const branch = node;
            const path = await this.getFirst(await get(this.store, branch.nodes[0]));
            path.branches.unshift(new PathBranch(branch, 0));
            return path;
        }
    }
    /** Construct a path based on the last-most edge of the given node */
    async getLast(node) {
        if (node.header.type === TreeLeafBlockType) {
            const leaf = node;
            const count = leaf.entries.length;
            return new Path([], leaf, count > 0 ? count - 1 : 0, count > 0, this._version);
        }
        else {
            const branch = node;
            const index = branch.nodes.length - 1;
            const path = await this.getLast(await get(this.store, branch.nodes[index]));
            path.branches.unshift(new PathBranch(branch, index));
            return path;
        }
    }
    leafInsert(path, entry) {
        const { leafNode: leaf, leafIndex: index } = path;
        if (leaf.entries.length < NodeCapacity) { // No split needed
            apply(this.store, leaf, [entries$, index, 0, [entry]]);
            return undefined;
        }
        // Full. Split needed
        const midIndex = (leaf.entries.length + 1) >>> 1;
        const newEntries = leaf.entries.slice(midIndex);
        // New node
        if (index >= midIndex) { // Put the new entry directly rather than log an insert
            newEntries.splice(index - midIndex, 0, entry);
        }
        const newLeaf = newLeafNode(this.store, newEntries);
        this.store.insert(newLeaf);
        // Delete entries from old node
        apply(this.store, leaf, [entries$, midIndex, leaf.entries.length - midIndex, []]);
        if (index < midIndex) { // Insert new entry into old node
            apply(this.store, leaf, [entries$, index, 0, [entry]]);
        }
        else {
            path.leafNode = newLeaf;
            path.leafIndex -= midIndex;
        }
        return new Split(this.keyFromEntry(newEntries[0]), newLeaf, index < midIndex ? 0 : 1);
    }
    async branchInsert(path, branchIndex, split) {
        const pathBranch = path.branches[branchIndex];
        const { index: splitIndex, node } = pathBranch;
        pathBranch.index += split.indexDelta;
        if (node.nodes.length < NodeCapacity) { // no split needed
            apply(this.store, node, [partitions$, splitIndex, 0, [split.key]]);
            apply(this.store, node, [nodes$, splitIndex + 1, 0, [split.right.header.id]]);
            return undefined;
        }
        // Full. Split needed
        const midIndex = (node.nodes.length + 1) >>> 1;
        const newPartitions = node.partitions.slice(midIndex);
        const newNodes = node.nodes.slice(midIndex);
        const delta = pathBranch.index < midIndex ? 0 : 1;
        // New node
        if (delta) { // If split is on new, add it before the split to avoid logging an insert
            pathBranch.index -= midIndex;
            newPartitions.splice(pathBranch.index, 0, split.key);
            newNodes.splice(pathBranch.index + 1, 0, split.right.header.id);
        }
        const newBranch = newBranchNode(this.store, newPartitions, newNodes);
        // Delete partitions and nodes
        const newPartition = node.partitions[midIndex - 1];
        apply(this.store, node, [partitions$, midIndex - 1, newPartitions.length + 1, []]);
        apply(this.store, node, [nodes$, midIndex, newNodes.length, []]);
        if (pathBranch.index < midIndex) { // Insert into old node
            apply(this.store, node, [partitions$, splitIndex, 0, [split.key]]);
            apply(this.store, node, [nodes$, splitIndex + 1, 0, [split.right.header.id]]);
        }
        return new Split(newPartition, newBranch, delta);
    }
    async rebalanceLeaf(path, depth) {
        if (depth === 0 || path.leafNode.entries.length >= (NodeCapacity >>> 1)) {
            return undefined;
        }
        const leaf = path.leafNode;
        const parent = path.branches.at(depth - 1);
        const pIndex = parent.index;
        const pNode = parent.node;
        const rightSibId = pNode.nodes[pIndex + 1];
        const rightSib = rightSibId ? (await get(this.store, rightSibId)) : undefined;
        if (rightSib && rightSib.entries.length > (NodeCapacity >>> 1)) { // Attempt to borrow from right sibling
            const entry = rightSib.entries[0];
            apply(this.store, rightSib, [entries$, 0, 1, []]);
            apply(this.store, leaf, [entries$, leaf.entries.length, 0, [entry]]);
            this.updatePartition(pIndex + 1, path, depth - 1, this.keyFromEntry(entry));
            return undefined;
        }
        const leftSibId = pNode.nodes[pIndex - 1];
        const leftSib = leftSibId ? (await get(this.store, leftSibId)) : undefined;
        if (leftSib && leftSib.entries.length > (NodeCapacity >>> 1)) { // Attempt to borrow from left sibling
            const entry = leftSib.entries[leftSib.entries.length - 1];
            apply(this.store, leftSib, [entries$, leftSib.entries.length - 1, 1, []]);
            apply(this.store, leaf, [entries$, 0, 0, [entry]]);
            this.updatePartition(pIndex, path, depth - 1, this.keyFromEntry(entry));
            path.leafIndex += 1;
            return undefined;
        }
        if (rightSib && rightSib.entries.length + leaf.entries.length <= NodeCapacity) { // Attempt to merge right sibling into leaf (right sib deleted)
            apply(this.store, leaf, [entries$, leaf.entries.length, 0, rightSib.entries]);
            this.deletePartition(pNode, pIndex);
            if (pIndex === 0) { // 0th node of parent, update parent key
                this.updatePartition(pIndex, path, depth - 1, this.keyFromEntry(leaf.entries[0]));
            }
            this.store.delete(rightSib.header.id);
            return await this.rebalanceBranch(path, depth - 1);
        }
        if (leftSib && leftSib.entries.length + leaf.entries.length <= NodeCapacity) { // Attempt to merge into left sibling (leaf deleted)
            path.leafNode = leftSib;
            path.leafIndex += leftSib.entries.length;
            apply(this.store, leftSib, [entries$, leftSib.entries.length, 0, leaf.entries]);
            this.deletePartition(pNode, pIndex - 1);
            this.store.delete(leaf.header.id);
            return await this.rebalanceBranch(path, depth - 1);
        }
    }
    async rebalanceBranch(path, depth) {
        const pathBranch = path.branches[depth];
        const branch = pathBranch.node;
        if (depth === 0 && branch.partitions.length === 0) { // last node... collapse child into root
            return path.branches[depth + 1]?.node ?? path.leafNode;
        }
        if (depth === 0 || (branch.nodes.length >= NodeCapacity >>> 1)) {
            return undefined;
        }
        const parent = path.branches.at(depth - 1);
        const pIndex = parent.index;
        const pNode = parent.node;
        const rightSibId = pNode.nodes[pIndex + 1];
        const rightSib = rightSibId ? (await get(this.store, rightSibId)) : undefined;
        if (rightSib && rightSib.nodes.length > (NodeCapacity >>> 1)) { // Attempt to borrow from right sibling
            const node = rightSib.nodes[0];
            const rightKey = rightSib.partitions[0];
            this.insertPartition(branch, branch.partitions.length, pNode.partitions[pIndex], node);
            this.deletePartition(rightSib, 0, 0);
            this.updatePartition(pIndex + 1, path, depth - 1, rightKey);
            return undefined;
        }
        const leftSibId = pNode.nodes[pIndex - 1];
        const leftSib = leftSibId ? (await get(this.store, leftSibId)) : undefined;
        if (leftSib && leftSib.nodes.length > (NodeCapacity >>> 1)) { // Attempt to borrow from left sibling
            const node = leftSib.nodes[leftSib.nodes.length - 1];
            const pKey = leftSib.partitions[leftSib.partitions.length - 1];
            this.insertPartition(branch, 0, pNode.partitions[pIndex - 1], node, 0);
            this.deletePartition(leftSib, leftSib.partitions.length - 1);
            pathBranch.index += 1;
            this.updatePartition(pIndex, path, depth - 1, pKey);
            return undefined;
        }
        if (rightSib && rightSib.nodes.length + branch.nodes.length <= NodeCapacity) { // Attempt to merge right sibling into self
            const pKey = pNode.partitions[pIndex];
            this.deletePartition(pNode, pIndex);
            apply(this.store, branch, [partitions$, branch.partitions.length, 0, [pKey]]);
            apply(this.store, branch, [partitions$, branch.partitions.length, 0, rightSib.partitions]);
            apply(this.store, branch, [nodes$, branch.nodes.length, 0, rightSib.nodes]);
            if (pIndex === 0 && pNode.partitions.length > 0) { // if parent is left edge, new right sibling is now the first partition
                this.updatePartition(pIndex, path, depth - 1, pNode.partitions[0]);
            }
            this.store.delete(rightSib.header.id);
            return this.rebalanceBranch(path, depth - 1);
        }
        if (leftSib && leftSib.nodes.length + branch.nodes.length <= NodeCapacity) { // Attempt to merge self into left sibling
            const pKey = pNode.partitions[pIndex - 1];
            this.deletePartition(pNode, pIndex - 1);
            apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, [pKey]]);
            apply(this.store, leftSib, [partitions$, leftSib.partitions.length, 0, branch.partitions]);
            apply(this.store, leftSib, [nodes$, leftSib.nodes.length, 0, branch.nodes]);
            pathBranch.node = leftSib;
            pathBranch.index += leftSib.nodes.length;
            this.store.delete(branch.header.id);
            return this.rebalanceBranch(path, depth - 1);
        }
    }
    updatePartition(nodeIndex, path, depth, newKey) {
        const pathBranch = path.branches[depth];
        if (nodeIndex > 0) { // Only affects this branch; just update the partition key
            apply(this.store, pathBranch.node, [partitions$, nodeIndex - 1, 1, [newKey]]);
        }
        else if (depth !== 0) {
            this.updatePartition(path.branches[depth - 1].index, path, depth - 1, newKey);
        }
    }
    insertPartition(branch, index, key, node, nodeOffset = 1) {
        apply(this.store, branch, [partitions$, index, 0, [key]]);
        apply(this.store, branch, [nodes$, index + nodeOffset, 0, [node]]);
    }
    deletePartition(branch, index, nodeOffset = 1) {
        apply(this.store, branch, [partitions$, index, 1, []]);
        apply(this.store, branch, [nodes$, index + nodeOffset, 1, []]);
    }
    validatePath(path) {
        if (!this.isValid(path)) {
            throw new Error("Path is invalid due to mutation of the tree");
        }
    }
    /** Iterates every node ID below and including the given node. */
    async *nodeIds(node) {
        // TODO: This would be much more efficient if we avoided iterating into leaf nodes
        if (node.header.type === TreeBranchBlockType) {
            const subNodes = await Promise.all(node.nodes.map(id => get(this.store, id)));
            for (let subNode of subNodes) {
                yield* this.nodeIds(subNode);
            }
        }
        yield node.header.id;
    }
    getEntry(path) {
        return path.leafNode.entries[path.leafIndex];
    }
    updateEntry(path, entry) {
        apply(this.store, path.leafNode, [entries$, path.leafIndex, 1, [entry]]);
    }
}
class Split {
    key;
    right;
    indexDelta;
    constructor(key, right, indexDelta) {
        this.key = key;
        this.right = right;
        this.indexDelta = indexDelta;
    }
}
function newLeafNode(store, entries) {
    const header = store.createBlockHeader(TreeLeafBlockType);
    return { header, entries };
}
function newBranchNode(store, partitions, nodes) {
    const header = store.createBlockHeader(TreeBranchBlockType);
    return { header, partitions, nodes };
}
//# sourceMappingURL=btree.js.map