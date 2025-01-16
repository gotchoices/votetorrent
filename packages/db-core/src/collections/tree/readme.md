# Tree Collection

The Tree Collection combines the logical transaction logging of a collection, with a BTree data structure.

## CollectionTrunk

To avoid having both a collection header and a btree header, we enable the collection header to double as the btree header.  This is accomplished using the "...Trunk" abstraction provided by the BTree.  The trunk interface abstracts accessing or updating the root of the tree, from the btree proper.  For this implementation, we introduce a CollectionTrunk class that implements the trunk interface.  The CollectionTrunk reads the root id from the collection header, and updates the collection header with the new root id when the root changes.
