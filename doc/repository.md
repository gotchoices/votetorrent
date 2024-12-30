# Block Repository

## Overview

This document outlines the design for a Block Repository that provides efficient access to versioned data. The system manages blocks of data with versioning capabilities, allowing users to retrieve blocks at specific versions, update blocks conditionally, and mark blocks for eventual deletion.

The system provides these core operations through the IBlockNetwork interface:
- `get(blockGets[])`: Fetch blocks by their IDs and versions or specific transactions
- `getStatus(trxRefs[])`: Get statuses of block transactions
- `pend(blockTrx)`: Post a transaction for a set of blocks
- `cancel(trxRef)`: Cancel a pending transaction
- `commit(tailId, trxRef)`: Commit a pending transaction

## Operations Description

### 1. `get(blockGets[])`

- **Purpose**: Fetch blocks by their IDs and versions or a specific transaction
- **Input**: Array of `BlockGet` objects containing:
  - `blockId` - A unique identifier for the block
  - `context` - Optional transaction context specifying either a revision or pending transaction
- **Output**: Array of `GetBlockResult` objects containing:
  - `block` - The block data
  - `state` - Current block state including latest revision or deletion status
- **Behavior**: 
  - If no context is provided, returns the latest version
  - If a revision is specified, returns the block at that revision
  - If a transaction ID is specified, returns the block with pending changes applied
  - Fails if requesting a deleted block with pending transaction

### 2. `pend(blockTrx)`

- **Purpose**: Post a transaction for a set of blocks
- **Input**: `PendRequest` containing:
  - `transform` - The changes to apply
  - `trxId` - Transaction identifier
  - `pending` - How to handle existing pending transactions
- **Output**: `PendResult` indicating success or failure with pending transaction information
- **Behavior**:
  - Creates metadata for new blocks if needed
  - Can fail if pending='fail' and other transactions are pending
  - Saves block-specific transforms for each affected block

### 3. `cancel(trxRef)`

- **Purpose**: Cancel a pending transaction
- **Input**: `TrxBlocks` containing block IDs and transaction ID
- **Behavior**: Removes the pending transaction from all specified blocks

### 4. `commit(tailId, trxRef)`

- **Purpose**: Commit a pending transaction
- **Input**:
  - `tailId` - Block ID
  - `trxRef` - Transaction reference
- **Output**: `CommitResult` indicating success or missing transactions needed
- **Behavior**:
  - Verifies expected revision matches current state
  - Updates block metadata and revision
  - Promotes pending transaction to committed state
  - Handles block deletion if specified in transform

## Block States and Versioning

Blocks maintain the following state information:
- Latest revision number
- Deletion status (if applicable)
- Pending transactions
- Materialized versions at specific revisions

The system uses a materialization strategy where:
- Blocks can be materialized at any revision by applying transforms sequentially
- Materialized versions are cached to improve performance
- Pending transactions can be applied on top of any materialized version

## Transaction Processing

Transactions go through the following lifecycle:
1. **Pending**: Posted via `pend()` but not yet committed
2. **Committed**: Applied to blocks and assigned a revision number
3. **Materialized**: Full block state computed and cached at specific revisions

The system supports:
- Optimistic concurrency through revision checking
- Transaction conflict detection
- Block restoration through callback mechanism
- Materialization caching for performance

## Block Lifecycle

1. **Creation**: Blocks are created through insert transforms
2. **Updates**: Applied through pending and committed transactions
3. **Deletion**: Marked via delete transform, maintaining revision history
4. **Restoration**: Possible through the restore callback mechanism

## Implementation Notes

The system is implemented with these key components:
- `StorageRepo`: Main implementation of the repository operations
- `IBlockStorage`: Interface for block storage operations
- `RestoreCallback`: Optional mechanism for block restoration

The storage layer maintains separate stores for:
- Block metadata
- Revisions
- Transactions (both pending and committed)
- Materialized block versions
