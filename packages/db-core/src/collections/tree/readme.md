# Tree Collection

The Tree Collection combines the logical transaction logging of a collection, with a BTree data structure.

## CollectionTrunk

To avoid having both a collection header and a btree header, we enable the collection header to double as the btree header.  This is accomplished using the "...Trunk" abstraction provided by the BTree.  The trunk interface abstracts accessing or updating the root of the tree, from the btree proper.  For this implementation, we introduce a CollectionTrunk class that implements the trunk interface.  The CollectionTrunk reads the root id from the collection header, and updates the collection header with the new root id when the root changes.

## Replace Action

The replace action is a unit of change to the tree collection.  It is a list of key-value pairs, where the key is the key to replace, and the value is the new value to replace the old value with.  If the value is not provided, the key is deleted.

```ts
tree.replace([
	{ key: 5, value: { a: 1, b: 'Value' } },
	{ key: 10 },
]);
```
Replaces the value at key 5 with { a: 1, b: 'Value' }, and deletes the value at key 10.
