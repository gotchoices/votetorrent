export class PathBranch {
    node;
    index;
    constructor(node, index) {
        this.node = node;
        this.index = index;
    }
    clone() {
        return new PathBranch(this.node, this.index);
    }
}
/** Represents a cursor in a BTree.  Invalid once mutation has occurred (unless it is the results of a mutation method).
 * Do not change the properties of this object directly.  Use the methods of the BTree class to manipulate it.
 * @member on - true if the cursor is on an entry, false if it is between entries.
 */
export class Path {
    branches;
    leafNode;
    leafIndex;
    on;
    version;
    constructor(branches, leafNode, leafIndex, on, version) {
        this.branches = branches;
        this.leafNode = leafNode;
        this.leafIndex = leafIndex;
        this.on = on;
        this.version = version;
    }
    isEqual(path) {
        return this.leafNode === path.leafNode
            && this.leafIndex === path.leafIndex
            && this.on === path.on
            && this.version === path.version;
    }
    clone() {
        return new Path(this.branches.map(b => b.clone()), this.leafNode, this.leafIndex, this.on, this.version);
    }
}
//# sourceMappingURL=path.js.map