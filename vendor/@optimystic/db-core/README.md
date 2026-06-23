# Optimystic DB Core

A distributed database system designed for peer-to-peer networks, providing ACID transactions across content-addressed storage with strong consistency guarantees and conflict resolution.

## Overview

Optimystic DB Core solves the fundamental challenge of maintaining **atomic transactions across content-addressed distributed storage**. Unlike traditional databases where related data resides on a single server, Optimystic distributes blocks across multiple independent peers.

### The Challenge

In distributed content-addressed systems:
- **Logically related blocks** are scattered across different network peers
- **Atomic transactions** must coordinate across multiple independent clusters
- **Consensus ordering** must be established without centralized coordination
- **Network failures** can occur independently at any peer or cluster
- **Conflict resolution** must handle concurrent modifications gracefully

### The Solution

Optimystic provides a **layered architecture** that maintains ACID properties while achieving horizontal scalability and fault tolerance:

1. **Randomly distributed block storage** with immutable, versioned units
2. **Block-based data structures** (B-trees, chains) built on block primitives
3. **Transaction logging** with integrity guarantees and checkpointing
4. **Collection abstractions** that combine data structures with distributed transactions
5. **Distributed coordination** through log-first transaction ordering
6. **Peer-to-peer networking** with cluster-aware consensus and failure recovery

A key innovation of this system is that the transaction payload is transmitted prior to the commital, as part of the "pend" phase.  This minimizes the overhead of commitment since the propagation and validation of the transaction are complete prior to commit.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Collections Layer                        │
│  High-level abstractions: Tree, Diary, Custom Collections  │
│  • Action-based mutations with conflict resolution         │
│  • Local snapshots with explicit synchronization           │
│  • Integration with specialized data structures             │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│                 Transaction Layer                           │
│        Logs (transaction ordering) + Transactors           │
│  • Log-first transaction ordering across collections       │
│  • Distributed consensus with conflict detection           │
│  • Missing/pending transaction resolution                  │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│              Data Structures Layer                          │
│            Chains (ordered) + BTrees (indexed)             │
│  • Chains: stacks, queues, logs with linked blocks         │
│  • BTrees: sorted access with range queries                │
│  • Both built on immutable block operations                │
└─────────────────┬───────────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────────┐
│                   Block Layer                               │
│           Immutable, versioned storage units               │
│  • Content-addressed with base32 IDs                       │
│  • Atomic operations with transform tracking               │
│  • Network-ready serialization and distribution            │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### [Blocks](docs/blocks.md) - Foundation Storage Units

Immutable, versioned data storage units that form the foundation of the system:

- **Content-addressed**: Uniquely identified by base32-encoded block IDs
- **Atomic operations**: Precise modifications through block operations
- **Transform tracking**: Collect changes without immediate application
- **Network-ready**: Designed for distributed storage and retrieval

```typescript
// Basic block with header
type IBlock = {
  header: {
    id: BlockId;
    type: BlockType;
    collectionId: BlockId;
  }
}

// Atomic operations on block properties
apply(store, block, ['items', 0, 1, ['newValue']]);
```

### [Chains](docs/chains.md) - Ordered Data Structures

Linked block primitives that can function as stacks, queues, or logs:

- **Flexible access patterns**: LIFO (stack), FIFO (queue), or sequential (log)
- **Efficient traversal**: Forward and backward iteration with precise navigation
- **Block efficiency**: 32 entries per block optimized for network transfer
- **Distributed ready**: Lazy loading and efficient network operations

```typescript
// Stack operations (LIFO)
await chain.add('item1', 'item2');
const items = await chain.pop(1); // ['item2']

// Queue operations (FIFO)  
await chain.add('first', 'second');
const items = await chain.dequeue(1); // ['first']
```

### [BTrees](docs/btree.md) - Indexed Data Structures

B+tree implementation providing efficient sorted access to data:

- **Sorted access**: Keys maintained in order for efficient range queries
- **Path-based navigation**: Cursor-like traversal through the tree
- **Automatic rebalancing**: Splits, merges, and borrowing maintain optimal structure
- **Type-safe**: Generic implementation supporting custom key/entry types

```typescript
// Range queries with efficient iteration
const range = new KeyRange(startKey, endKey, true);
for await (const path of tree.range(range)) {
  const entry = tree.at(path);
  console.log(entry);
}
```

### [Logs](docs/logs.md) - Transaction Logging

Transaction logging built on chains with integrity guarantees:

- **SHA256 integrity**: Block hashing ensures tamper detection
- **Action tracking**: Transaction IDs, revision numbers, affected blocks
- **Checkpoint management**: Efficient transaction state queries
- **Multi-collection coordination**: Cross-collection transaction support

```typescript
// Record transaction with affected blocks
await log.addActions(
  [action1, action2],
  transactionId,
  revisionNumber,
  () => affectedBlockIds,
  involvedCollectionIds
);
```

### [Collections](docs/collections.md) - High-Level Abstractions

Logical groupings that combine data structures with distributed transactions:

- **Local snapshots**: Immediate local changes with explicit synchronization
- **Action abstraction**: Replay actions from local, remote, or conflict resolution
- **Conflict resolution**: Customizable strategies for concurrent modifications
- **Data structure integration**: Tree collections (indexed), Diary collections (append-only)

```typescript
// Local changes applied immediately to snapshot
await collection.act(action1, action2, action3);

// Explicit synchronization with distributed state
await collection.updateAndSync();
```

### [Transactors](docs/transactor.md) - Distributed Coordination

Abstract coordination layer managing distributed transactions:

- **Log-first ordering**: Transaction order established by log tail commits
- **Two-phase coordination**: Pend → commit pattern for atomic operations
- **Conflict detection**: Missing vs pending transaction differentiation
- **Network abstraction**: Clean interface hiding consensus complexity

```typescript
// Two-phase distributed transaction
const pendResult = await transactor.pend(request);
if (pendResult.success) {
  const commitResult = await transactor.commit(request);
}
```

### [Network Layer](docs/network.md) - Peer-to-Peer Implementation

Concrete implementation for peer-to-peer networks:

- **Content-to-cluster mapping**: Deterministic routing via consistent hashing
- **Parallel cluster coordination**: Execute operations across multiple clusters
- **Failure-aware retry**: Handle peer failures and network partitions
- **Cluster-aware batching**: Group operations by responsible peers

## Key Features

### Distributed ACID Transactions

- **Atomicity**: All changes in a transaction succeed or fail together
- **Consistency**: Strong consistency across distributed participants
- **Isolation**: Conflict detection and resolution for concurrent operations
- **Durability**: Committed transactions survive network partitions

### Content-Addressed Storage

- **Deterministic distribution**: Blocks distributed based on content hash
- **Location independence**: Access blocks without knowing physical location
- **Efficient routing**: Consistent hashing maps blocks to responsible peers
- **Fault tolerance**: Multiple peers can coordinate same keyspace regions

### Conflict Resolution

- **Action filtering**: Customizable strategies for resolving conflicts
- **State replay**: Re-apply local actions on updated remote state
- **Missing transactions**: Automatic rebasing on newer committed changes
- **Pending awareness**: Handle concurrent modifications gracefully

### Horizontal Scalability

- **Peer-to-peer architecture**: No single points of failure
- **Parallel execution**: Operations on different blocks execute concurrently
- **Load distribution**: Coordination responsibility spread across network
- **Dynamic membership**: Peers can join and leave without disruption

## Usage Patterns

### Simple Append-Only Storage

```typescript
// Create diary for event logging
const eventLog = await Diary.create<Event>(transactor, 'events');

// Add events
await eventLog.append({ type: 'user_login', userId: '123' });
await eventLog.append({ type: 'user_logout', userId: '123' });

// Read events in order
for await (const event of eventLog.select()) {
  processEvent(event);
}
```

### Indexed Data with Range Queries

```typescript
// Create tree collection for user data
const userTree = await Tree.createOrOpen<string, User>(
  transactor, 
  'users',
  user => user.id,  // Key extractor
  (a, b) => a.localeCompare(b)  // Comparator
);

// Batch updates
await userTree.replace([
  ['user1', { id: 'user1', name: 'Alice' }],
  ['user2', { id: 'user2', name: 'Bob' }]
]);

// Range queries
for await (const path of userTree.range({ from: 'user1', to: 'user9' })) {
  console.log(userTree.at(path));
}
```

### Custom Collections with Conflict Resolution

```typescript
class CounterCollection {
  static async create(transactor: ITransactor, id: CollectionId) {
    const init: CollectionInitOptions<IncrementAction> = {
      modules: {
        "increment": async (action, store) => {
          // Custom increment logic
        }
      },
      filterConflict: (local, remote) => {
        // Merge conflicting increments
        const remoteSum = remote.reduce((sum, r) => sum + r.data.value, 0);
        return { ...local, data: { ...local.data, value: local.data.value + remoteSum }};
      }
    };
    
    return await Collection.createOrOpen(transactor, id, init);
  }
}
```

## Getting Started

### Installation

```bash
npm install @optimystic/db-core
```

### Basic Setup

```typescript
import { 
  NetworkTransactor, 
  Tree, 
  Diary,
  Collection 
} from '@optimystic/db-core';

// Set up distributed transactor
const transactor = new NetworkTransactor({
  keyNetwork,    // Peer discovery implementation
  peerNetwork,   // Communication layer
  getRepo        // Repository factory
});

// Create collections
const userTree = await Tree.createOrOpen(transactor, 'users', /* ... */);
const eventLog = await Diary.create(transactor, 'events');

// Use collections
await userTree.replace([['user1', userData]]);
await eventLog.append(eventData);
```

## Documentation

- **[Blocks](docs/blocks.md)** - Immutable storage units and operations
- **[BTrees](docs/btree.md)** - Sorted data access and range queries  
- **[Chains](docs/chains.md)** - Ordered data structures (stacks, queues, logs)
- **[Logs](docs/logs.md)** - Transaction logging with integrity guarantees
- **[Collections](docs/collections.md)** - High-level abstractions with conflict resolution
- **[Transactors](docs/transactor.md)** - Distributed transaction coordination
- **[Network](docs/network.md)** - Peer-to-peer implementation architecture

### Internal Architecture

For developers and AI agents working on internals, see [Internals Guide](../../docs/internals.md) for:
- Data flow diagrams (read/write/commit paths)
- Mutation contracts (which functions mutate vs clone)
- Key invariants and common pitfalls
- Type glossary and debugging tips
