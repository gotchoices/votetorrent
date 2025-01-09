# BTree
BTree is a B+tree implementation based on Alivebase's BTree.

### Block types:

| BlockId | Type |
| TR | TreeRoot |
| TL | Leaf |
| TB | Branch |

### Overview

BTree is a B+tree partitioned set of unique keys (no values) with the following attributes:

* Data is represented as an entity, which is only a key on this base class, but can be sub-classed
* All data (entries) are stored at the leaves
* Branches are routing nodes which contain an ordered list of references to sub nodes (branches or leaves) and a list of partition keys
* No peer leaf references are stored

### Concepts

* **Trunk** - the block that holds the root reference
  * This is maintained through a different interface, so that the tree's root reference can be part of another data structure
  * **IndependentTrunk** - this manages stand-alone trees with a dedicated block holding the root reference

## BranchNode

Layout:
```
NodeIDs:                ID | ID | ID
                            ^    ^
                           /    /
Partitions (keys):         P    P
```

* Partition keys represent the lowest key of the lowest leaf node key represented by the "right" node

## Functional requirements

* Allow for key only or key in entry - already proven via Digitree
* Use storage system for retrieval/generation of nodes
  * Updates through block system operations
* Ability for tree header block to be nested inside another block

