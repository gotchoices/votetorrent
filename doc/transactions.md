# Optimystic - Transaction Processing Scheme

## Overview

The transaction system described here uses a logical transaction log combined with block-based storage.  This scheme can be used as a stand-alone logging system, or can be coupled with a tree or other data structure.  This design is based on the transaction system of [AliveBase](https://github.com/Digithought).

This scheme employs a logical transaction log combined with block-based storage, supporting both single-collection and cross-collection transactions. The system utilizes a multi-phase process for propagating updates, committing transactions, and checkpointing affected blocks, ensuring consistency across distributed collections while allowing for concurrent operations through conditional commits.

While the system may experience transient hotspots at the log tail block and potential cascading failures in upstream transactions, it offers a lockless design that enables transactions to proceed with conditions, providing both flexibility and efficiency. The scheme also incorporates robust failure handling mechanisms, validation processes based on atomic writes and peer communication, and optimizations such as an optional sync phase and efficient tracking of unknown block transactions.

### Summary

#### Single collection transactions:
* Each collection maintains log of logical transactions, each with:
  * sequence (LSN), random ID, block IDs, logical changes
* Logical log stored physically in linked list queue of blocks
* Collection header block references head and tail block IDs
* Blocks (including log blocks) versioned by the associated collection's LSN - can read from previous version up to history TTL
* Phase 1 - Propagate: `pending update`s are posted to all affected blocks (w/ TTLs) - these don't update the revision
* Phase 2 - Commit: Transaction is appended to tail, obtaining a new LSN
* Phase 3 - Checkpoint: All affected blocks' LSNs are updated - checkpoint LSN in tail block updated when complete
* Before reading from collection, obtain LSN, as well as the transaction IDs between checkpoint (exclusive) and LSN (inclusive) from tail block
* Explicitly mention uncheckpointed transaction IDs (in order) when reading from blocks - ensures read includes uncheckpointed transactions, and checkpoints them

#### Cross-collection transactions:
* Logical transaction shares common transaction ID with same transaction in other collections
* Phase 1 - Propagate: `pending update`s are posted, but across all affected collections
* Phase 2 - Commit: Conditional transaction appended to tail
* Phase 3 - Checkpoint: All affected blocks' LSNs are updated - checkpoint LSN in tail block updated when complete - transaction no longer conditional
* Between Commit and Checkpoint:
  * other transactions posting against old LSN will reject as usual, with already committed - need to resync
  * other transactions posting against new LSN are allowed, but become conditional - they inherit the conditions of the prior transaction

## Transactions

### Client

#### Block mirroring
* The client should read and maintain a synchronized copy of all participant blocks from the repository
* The first read for any collection should be from the header block, which points to the tail of the logical log, which should be the second read
* With the LSN and the uncheckpointed transaction IDs in hand, the client can read any other blocks that may be part of the collection
* All changes to blocks should be tracked locally along with the logical log entries
* Modifications to blocks should be made into copies, maintaining the original versions
  
#### Synchronization

##### When to sync
* If much time has passed since the blocks were read, the client should sync before posting pending updates
* Syncing will also be necessary if the transaction is rejected due to stale data

##### How to sync
* To sync, the client will:
  * Load new logical log entries from the tail block
  * Starting from unmodified cached blocks, play the read logical log entries, capturing physical changes in "unchanged" blocks
  * Note any conflicts from the loaded logical log entries, from our list - affect our list if necessary
  * Play our logical log entries, capturing physical changes as changed blocks and transforms

### Log

The transaction log is a linked list of blocks, each containing a set of logical log entries.  The collection header block points to the tail block, and each block points to the prior block in the chain.

![Collection Log](figures/collection-log.png)

### Structure

#### Transaction Submission
- **Transaction ID**: A unique random identifier for the transaction - used to correlate actions across collections and blocks, and to recognize reposts
- **Collections**: List of:
  - **Collection ID**: The ID of the collection
  - **Tail Block ID**: The ID of the tail block for the collection
  - [**New Tail**]: only present if the tail block was full
    - **Block ID**: The ID of the new tail block for the collection
    - **Header ID**: The ID of the updated header block for the collection
  - **Transform**: The set of physical mutations to the blocks in this collection - tail block transform includes the logical changes
- **Timestamp**: The time when the transaction was submitted - based on the client's clock - will be validated for reasonableness - will be made >= prior transaction's timestamp
- **Signatures**: Cryptographic signatures from participating nodes to ensure the integrity and authenticity of the transaction.

#### Transaction Log Entry

### Interface

- `Pend(transaction, failIfPending: boolean): success<pending: (collectionId, transactionId)[]> | failure<missing: (collectionId, transactionId)[]>` - posts a pending transaction for the block
  - Ensures that all blocks have the transaction payload
  - If the transaction targets the correct version, the call succeeds, unless failIfPending and there are any pending transactions - the caller may choose to wait for pending transactions to clear rather than risk racing with them
  - If the transaction targets an older version of any block, the call fails, and the caller must resync using the missing transactions
  
- `Cancel(id): void` - cancels a pending transaction
  - If the given transaction ID is pending on any block, it is canceled

- `Commit(id): conditions | failure<missing: blockTransaction[]>`
  - If the transaction references the current version, the pending transaction is conditionally committed
    - The returned conditions are those uncommitted inherited from prior transaction(s) 
      - If any such conditional transactions are aborted, this transaction will implicitly be aborted
    - If the transaction mentions other collections, those are assumed conditions - returned conditions only list inherited conditions
    - This call will complete once the commit to the tail block is complete 
      - Other blocks are allowed to commit in parallel, so read's must provide the transaction ID to ensure they see the commit
      - If the tail block is full, multiple block will be involved: new tail and collection header - the commit won't complete until all of these blocks are updated in that order
  - If posting from an old version, unknown logical transactions are returned in the failure - must resync

- `Checkpoint(id): void` - checkpoints a committed transaction
  - Updates the checkpoint LSN in the tail block
  - Removes conditions from the transaction

## Blocks

### Structures

#### Log Block:
- [**Previous Block ID**]: The ID of the prior block in the chain
- **Starting Log Sequence Number**: A monotonically increasing number for log entries - the LSN of the first committed entry in the block.
- **Entries**: list of:
  - **Transaction ID**: The ID of the transaction
  - **Operations**: A set of logical operations

#### Block Repository:
- **Pending**: list of:
  - **Transaction ID**: Used to identify the transaction while pending
  - **Transform**: The set of physical mutations to this block
  - **Expiration**: A time after which the transaction becomes in-doubt; this block should proactively determine resolution at this point
- **Revisions**: list of:
  - **LSN**: The LSN of this version
  - **Transform**: The set of physical mutations represented by this revision
  - [**Block**]: Materialized block for this revision - always present for current version
  - [**Expiration**]: The time after which this revision is eligible for garbage collection - never present for current version
  - **Conditions**: list of zero or more:
    - **Block ID**: Other block on which this revision is conditional
    - [**Signature**]: The signature of the other block - presence indicates that this revision is checkpointed
- **Aborted Revisions**: list of revisions that have been aborted

- **Commits**: corresponds to committed entries -list of:
  - **Conditional Collection IDs**: RemainingIDs of collections that are conditionally depended on

#### Block Transaction:
- **Block ID**: The ID of the block
- **Transaction ID**: The ID of the transaction - shared across blocks and collections
- **Transform**: The set of physical mutations to the block
- **Expiration**: A time after which the transaction becomes in-doubt; any involved node should proactively determine resolution at this point

#### Block Repository Interface



#### Block Network Interface

- `Pend(blockTransaction, failIfPending: boolean): success<pending: blockTransaction[]> | failure<missing: blockTransaction[]>` - posts a pending transaction for the block
  - Does not update the version of the block, but the transaction is available for explicit reading, and for committing
  - If the transaction targets the correct version, the call succeeds, unless failIfPending and there are any pending transactions - the caller may choose to wait for pending transactions to clear rather than risk racing with them
  - If the transaction targets an older version, the call fails, and the caller must resync using the missing transactions
  
- `Cancel(id): void` - cancels a pending transaction
  - If the given transaction ID is pending, it is canceled

- `Commit(id): conditions | failure<missing: blockTransaction[]>`
  - If the transaction references the current version, the pending transaction is conditionally committed
    - The returned conditions are those uncommitted inherited from older transaction(s) - if any of those are aborted, this transaction will implicitly be aborted
    - If the transaction mentions other collections, those are assumed conditions - returned conditions only list inherited conditions
  - If posting from an old version, unknown transactions are returned in the failure - must resync

- `Abort(id): void` - aborts a conditional committed transaction
  - Aborts the conditional transaction on all blocks



#### Block
- Block header
- Block body

#### Transform
- Set of block inserts, updates, and deletes

#### Overall Transaction
-Set of block transforms

The logical structure of a transaction can be represented as follows:

## Failure handling

#### Failure to propagate
#### Failure to commit
#### Failure to prepare
#### Failure to checkpoint
#### Effect on successive transactions

## Validation
* Block level validation is based on the distributed storage system; this system assumes a block repository with atomic writes as long as posting from most recent version
* General pattern is that all transaction phases are dictated by TTLs; if the coordinator/client fails to notify any party by the TTL, the party is to reach out to peers to resolve
* Each phase requires all parties to acknowledge before moving on
* TODO: distributed, signature based validation of log tail writes, and general block writes

## Optimizations
* Optional Phase 0 - Sync: Read latest LSN and integrate before wasting time posting pending updates
* Optimization - when posting pending updates, note any unknown block transactions - sync needed

