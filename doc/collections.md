# Distributed Collection Storage System


- **Collection Association**:
  - Each stored value is associated with a "collection" name.
  - A collection hash is derived from the collection name, serving as the key for the root of a collection tree.

- **Tree Structure**:
  - Trees are structured as either leaf or branch blocks:
    - **Leaf Blocks**: Contain keys associated with values.
    - **Branch Blocks**: Contain ranges of keys; form when leaf blocks become full and split.
  - Blocks are stored at key addresses formed by combining the Most Significant Bits (MSB) from specific key space with the Least Significant Bits (LSB) of the collection hash.
  - The root node always starts as a leaf block located at the full collection hash.

- **Hashing and Merkle Tree Mode**:
  - Collections can operate in "hashing" or "non-hashing" mode:
    - In **hashing mode**, leaves store hashes of content, while branches store hashes of sub-trees (creating a Merkle tree).

- **Transaction Updates**:
  - Transactions must update stored values and find the most specific block where the update applies, potentially propagating changes upward to the root.
  - **Coordination Challenges** (Q: Coordination mechanics?):
    - Updates may involve handing off from smaller-span transaction workers to workers assigned to specific tree blocks.
    - Maintaining consistency requires considering scenarios where a higher-level node has already been modified. It is worth exploring whether global consistency is essential or whether eventual consistency suffices for transaction accuracy.
