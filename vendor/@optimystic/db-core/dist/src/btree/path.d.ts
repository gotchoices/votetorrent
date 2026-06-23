import type { BranchNode, LeafNode } from "./nodes.js";
export declare class PathBranch<TKey> {
    node: BranchNode<TKey>;
    index: number;
    constructor(node: BranchNode<TKey>, index: number);
    clone(): PathBranch<TKey>;
}
/** Represents a cursor in a BTree.  Invalid once mutation has occurred (unless it is the results of a mutation method).
 * Do not change the properties of this object directly.  Use the methods of the BTree class to manipulate it.
 * @member on - true if the cursor is on an entry, false if it is between entries.
 */
export declare class Path<TKey, TEntry> {
    branches: PathBranch<TKey>[];
    leafNode: LeafNode<TEntry>;
    leafIndex: number;
    on: boolean;
    version: number;
    constructor(branches: PathBranch<TKey>[], leafNode: LeafNode<TEntry>, leafIndex: number, on: boolean, version: number);
    isEqual(path: Path<TKey, TEntry>): boolean;
    clone(): Path<TKey, TEntry>;
}
//# sourceMappingURL=path.d.ts.map