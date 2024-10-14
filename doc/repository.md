# Block Repository

## Overview

This document outlines the design for a Block Repository that provides efficient access to versioned data. The system manages blocks of data with versioning capabilities, allowing users to retrieve the latest or specific versions of a block, update a block conditionally based on its current version, and mark blocks for eventual deletion. The primary use cases for this system include maintaining a historical record of changes, handling concurrent updates, and ensuring consistency of stored blocks.

This is the API used within Arachnode for versioned block storage.

The system provides four core primitives:
- `getRevision(blockId)`: Fetch the latest revision number of the given block.
- `get(blockId, revision)`: Fetch the block with the latest revision that is at most the given revision.
- `put(blockId, revision, block)`: Update the given block conditionally based on its current revision.
- `delete(blockId)`: Mark the block for eventual deletion.

## Primitives Description

### 1. `getRevision(blockId)`

- **Purpose**: Retrieve the latest revision number, and block hash of the block associated with the provided blockId.
- **Input**: `blockId` - A unique identifier for the block.
- **Output**: The latest revision number, and block hash of the block.

### 2. `get(blockId, revision)`

- **Purpose**: Fetch the block with the latest revision that is equal to or less than the provided revision number. The revision can be set to infinity to fetch the latest version.
- **Input**:
  - `blockId` - A unique identifier for the block.
  - `revision` - The maximum revision number that can be returned.
- **Output**: The block data, including hash, and the revision number.
- **Behavior**: If the `revision` provided is greater than the latest revision of the block, the latest available block is returned. If no block exists for the given blockId, an error or null response is returned.
- **Note**: Older versions of blocks are subject to lifetime policies and may become unavailable after a defined Time-To-Live (TTL). The latest version should always be available unless the block was deleted and the revision expired..

### 3. `put(blockId, revision, block)`

- **Purpose**: Attempt to update a block conditionally based on its current revision number.
- **Input**:
  - `blockId` - A unique identifier for the block.
  - `revision` - Must either a) match the current latest revision, or b) match the prior revision if the block's hash is correct.
  - `block` - The new data to store.
- **Output**: If successful, returns confirmation of the update including the new revision number. If the update fails (i.e., the current revision number does not match the provided revision, or the block's hash does not match the expected hash), it returns the latest block and its revision number.
- **Behavior**: The update is only applied if the provided `revision` matches the current latest revision and all validations succeed. This ensures that updates are not overwritten in the presence of concurrent modifications, providing optimistic concurrency control.  The prior revision is allowed in order to attempt retries for in-doubt transactions.

### 4. `delete(blockId, revision)`

- **Purpose**: Mark a block for eventual deletion.
- **Input**:
  - `blockId` - A unique identifier for the block.
  - `revision` - Must either a) match the current latest revision, or b) match the prior revision if the block was already deleted.
- **Output**: Confirmation that the block has been marked for deletion.
- **Behavior**: The block is marked for deletion, and it's revision is incremented, but the block is not immediately removed. The system may eventually perform garbage collection to permanently delete the block once all revisions are expired. Revisions of deleted blocks remain available, subject to the same lifetime collection policies as non-latest versions, ensuring that both deleted and older versions of blocks can be retained for a limited time before removal.  The prior revision is allowed in order to attempt retries for in-doubt transactions.

## Concurrency and Consistency

## Lifetime Management

The Block Repository uses lifetime policies to manage the retention of older versions of blocks. These policies ensure that:

- **Older Versions**: Older versions of blocks are retained for a limited duration, defined by a Time-To-Live (TTL) parameter. Once the TTL expires, these versions may be subject to garbage collection and could become unavailable.
- **Latest Version**: The latest version of a block is always retained and remains accessible to clients.
- **Deleted Blocks**: Revisions of deleted blocks remain available for a period governed by the same TTL policies applied to non-latest versions, allowing for rollback or data recovery before permanent removal.

The garbage collection process ensures that blocks marked for deletion or expired versions are eventually purged, maintaining the efficiency and performance of the storage system.

The system uses optimistic concurrency control to handle concurrent modifications to blocks. The `put` operation requires the caller to provide the expected current revision of the block, ensuring that updates are only applied if no other updates have occurred in the meantime. If the revision does not match, the operation fails, and the client is informed of the latest revision and block content. This approach prevents data loss due to race conditions and provides a clear mechanism for clients to resolve conflicts.

## Deletion Policy

Blocks are marked for eventual deletion through the `delete(blockId)` primitive. The actual removal of the block is handled by a background garbage collection process, ensuring that deleted data can still be accessed for a short period if necessary. This policy supports:
- **Eventual Consistency**: Data marked for deletion remains available for a limited time, allowing the system to propagate the deletion mark across all replicas.
- **Recovery**: In the case that a `put` operation is made to a deleted block, the block is effectively restored, since the latest revision is active.

## Example Workflow

1. **Initial Storage**: A client adds a block with blockId `A` using `put(A, 0, blockData)`.
2. **Fetching the Latest Version**: Another client calls `getRevision(A)` and receives revision `1`.
3. **Conditional Update**: The first client attempts to update the block by calling `put(A, 1, updatedBlockData)`. If the revision matches, the update succeeds.
4. **Conflict Handling**: If a second client has concurrently updated the block, the first client's `put` call will fail, and they will receive the latest block and revision to reconcile changes.
5. **Mark for Deletion**: Once no longer needed, a client calls `delete(A)` to mark the block for removal. The system eventually removes the block through a background process.
