# Optimystic DB-P2P

A distributed peer-to-peer database system that provides concrete implementations of the Optimystic database abstractions using filesystem storage and libp2p networking. This package transforms the interfaces and abstractions from `@optimystic/db-core` into a fully operational distributed database system.

## Overview

The `@optimystic/db-core` package provides abstractions and interfaces for database operations—immutable blocks, versioned transactions, repository interfaces, and collection data structures. However, it doesn't provide concrete implementations for storage or distribution. `db-p2p` provides concrete implementations of the core abstractions using:

- **Filesystem storage** with serialization for persistent, versioned block storage
- **libp2p networking** for decentralized peer-to-peer communication
- **Distributed consensus** using 2-phase commit protocols for consistency
- **Fault-tolerant coordination** with automatic recovery and data restoration

The result is a fully operational distributed database system that implements the interfaces defined in the core abstractions to provide a complete distributed database system.

## Architecture Overview

The system provides three distinct communication interfaces, each serving different roles in the distributed architecture:

```mermaid
graph TD
    subgraph "External Client Process"
        A[Application Code]
        B[RepoClient]
        A --> B
    end
    
    subgraph "Coordinator Node Process<br/>(Orchestrates Transactions)"
        C[RepoService]
        D[CoordinatorRepo]
        E[ClusterClient]
        F[StorageRepo]
        subgraph "Local Storage"
            F1[BlockStorage]
            F2[FileRawStorage]
            F3[Local Filesystem]
        end
        C --> D
        D --> E
        D --> F
        F --> F1
        F1 --> F2
        F2 --> F3
    end
    
    subgraph "Cluster Peer 1 Process<br/>(Participates in Consensus)"
        G1[ClusterService]
        H1[ClusterMember]
        I1[StorageRepo]
        subgraph "Local Storage 1"
            I1A[BlockStorage]
            I1B[FileRawStorage]
            I1C[Local Filesystem]
        end
        G1 --> H1
        H1 --> I1
        I1 --> I1A
        I1A --> I1B
        I1B --> I1C
    end
    
    subgraph "Cluster Peer 2 Process<br/>(Participates in Consensus)"
        G2[ClusterService]
        H2[ClusterMember]
        I2[StorageRepo]
        subgraph "Local Storage 2"
            I2A[BlockStorage]
            I2B[FileRawStorage]
            I2C[Local Filesystem]
        end
        G2 --> H2
        H2 --> I2
        I2 --> I2A
        I2A --> I2B
        I2B --> I2C
    end
    
    subgraph "Cluster Peer N Process<br/>(Participates in Consensus)"
        G3[ClusterService]
        H3[ClusterMember]
        I3[StorageRepo]
        subgraph "Local Storage N"
            I3A[BlockStorage]
            I3B[FileRawStorage]
            I3C[Local Filesystem]
        end
        G3 --> H3
        H3 --> I3
        I3 --> I3A
        I3A --> I3B
        I3B --> I3C
    end
    
    %% Network communication
    B -.->|"/db-p2p/repo/1.0.0"| C
    E -.->|"/optimystic/&lt;network&gt;/cluster/1.0.0"| G1
    E -.->|"/optimystic/&lt;network&gt;/cluster/1.0.0"| G2
    E -.->|"/optimystic/&lt;network&gt;/cluster/1.0.0"| G3
```

### Repo Layer: External Client Interface

The repo layer provides the interface for external clients to communicate with the distributed database:

- **RepoClient**: Allows external clients to connect to any coordinator node
- **RepoService**: Handles incoming requests from external clients
- **CoordinatorRepo**: Orchestrates distributed transactions by coordinating with cluster peers
- **Network transparency**: Same `IRepo` interface whether local or distributed

### Cluster Layer: Peer-to-Peer Coordination Interface

The cluster layer provides the interface for coordinators to communicate with other peers in the cluster:

- **ClusterClient**: Allows coordinators to send consensus requests to cluster peers
- **ClusterService**: Handles incoming consensus requests from coordinators
- **ClusterMember**: Implements 2-phase commit protocol for distributed consensus
- **Byzantine fault tolerance**: Ensures consistency even with peer failures

### Storage Layer: Persistent Data Implementation

The storage layer provides concrete implementations of the core database abstractions:

- **StorageRepo**: Implements `IRepo` interface with filesystem-based persistence
- **BlockStorage**: Provides versioned block storage with conflict resolution
- **FileRawStorage**: JSON-based file storage with atomic operations
- **Data restoration**: Pluggable restoration for missing data from network peers

## Detailed Component Architecture

### Repo Layer Components

#### `RepoClient`
Allows external clients to connect to coordinator nodes:

```typescript
class RepoClient extends ProtocolClient implements IRepo {
  static create(peerId: PeerId, peerNetwork: IPeerNetwork): RepoClient
  // Implements same IRepo interface as local storage
}
```

**Key Features:**
- Network-transparent database operations for external clients
- Automatic protocol handling and message serialization
- Error handling for network failures and timeouts
- Connection pooling and optimization

#### `RepoService`
Handles incoming repository protocol messages from external clients:

```typescript
class RepoService implements Startable {
  // Protocol: /db-p2p/repo/1.0.0
  // Transport: Length-prefixed JSON over libp2p streams
  async start(): Promise<void>
  async stop(): Promise<void>
}
```

**Key Features:**
- Registers and handles the repository protocol
- Routes operations from external clients to coordinator implementation
- Manages concurrent connections and stream processing
- Provides comprehensive error handling and logging

#### `CoordinatorRepo`
Orchestrates distributed transactions by coordinating with cluster peers:

```typescript
class CoordinatorRepo implements IRepo {
  constructor(
    keyNetwork: IKeyNetwork,
    createClusterClient: (peerId: PeerId) => ClusterClient,
    storageRepo: IRepo
  )
}
```

**Key Features:**
- Manages distributed transactions using cluster consensus
- Integrates with key network for peer discovery
- Uses cluster layer to coordinate with other peers
- Maintains local storage directly while coordinating remote operations

### Cluster Layer Components

#### `ClusterClient`
Allows coordinators to send consensus requests to cluster peers:

```typescript
class ClusterClient extends ProtocolClient implements ICluster {
  async update(record: ClusterRecord): Promise<ClusterRecord>
}
```

**Key Features:**
- Network communication for consensus operations
- Handles cluster record updates and responses
- Manages timeouts and retries for consensus requests

#### `ClusterService`
Handles incoming consensus requests from coordinators:

```typescript
class ClusterService implements Startable {
  // Protocol: /optimystic/<network>/cluster/1.0.0 (built from protocolPrefix)
  // Handles ClusterRecord updates for consensus
}
```

**Key Features:**
- Registers and handles the cluster consensus protocol
- Routes consensus requests to local cluster member
- Manages concurrent consensus operations

#### `ClusterMember`
Implements 2-phase commit protocol for distributed consensus:

```typescript
class ClusterMember implements ICluster {
  async update(record: ClusterRecord): Promise<ClusterRecord>
  // Handles: Promise collection → Majority consensus → Commit execution
}
```

**Key Features:**
- Complete 2-phase commit protocol implementation
- Conflict detection and resolution
- Cryptographic signature verification
- Automatic timeout and cleanup management
- Uses storage layer to execute operations when consensus is reached

### Storage Layer Components

#### `StorageRepo`
Implements `IRepo` interface with filesystem-based persistence:

```typescript
class StorageRepo implements IRepo {
  async get(blockGets: BlockGets): Promise<GetBlockResults>
  async pend(request: PendRequest): Promise<PendResult>  
  async commit(request: CommitRequest): Promise<CommitResult>
  async cancel(trxRef: TrxBlocks): Promise<void>
}
```

**Key Features:**
- Concrete implementation of core database abstractions
- Orchestrates transactions across multiple blocks
- Handles revision conflicts and missing transaction detection
- Provides atomic commit operations with proper locking

#### `BlockStorage`
Provides versioned block storage with conflict resolution:

```typescript
class BlockStorage implements IBlockStorage {
  async getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev }>
  async savePendingAction(actionId: ActionId, transform: Transform): Promise<void>
  async promotePendingAction(actionId: ActionId): Promise<void>
  async ensureRevision(rev: number): Promise<void>
}
```

**Key Features:**
- Maintains complete revision history for each block
- Reconstructs blocks by applying transforms to base versions
- Integrates with restoration callbacks for missing data
- Uses latches for thread-safe concurrent access

#### `FileRawStorage`
JSON-based file storage with atomic operations:

```typescript
// File system organization
{basePath}/
├── {blockId}/
│   ├── meta.json             # Block metadata and revision ranges
│   ├── revs/{rev}.json       # Revision → ActionId mappings
│   ├── pend/{actionId}.json  # Pending actions
│   ├── trx/{actionId}.json   # Committed actions
│   └── blocks/{actionId}.json # Materialized blocks
```

**Key Features:**
- Concrete filesystem implementation of storage interfaces
- JSON serialization for cross-platform compatibility
- Atomic file operations for consistency
- Organized directory structure for efficient access

## Integration Patterns

### Relationship to `@optimystic/db-core`

The `db-p2p` package provides concrete implementations of the core database abstractions:

```typescript
// Core provides interfaces and abstractions
import { IRepo, IBlock, Transform, IBlockStorage } from '@optimystic/db-core';

// P2P provides concrete implementations
class StorageRepo implements IRepo { /* filesystem-based repo */ }
class BlockStorage implements IBlockStorage { /* versioned block storage */ }
class RepoClient implements IRepo { /* network-transparent repo */ }
class CoordinatorRepo implements IRepo { /* distributed consensus repo */ }
```

**Implementation Points:**
- **Storage Layer**: Provides concrete filesystem-based implementations of core interfaces
- **Network Layer**: Implements peer-to-peer communication using libp2p
- **Consensus Layer**: Adds distributed consensus while maintaining core interfaces
- **API Compatibility**: Same interfaces as core abstractions for seamless integration

### Libp2p Integration

The package integrates deeply with libp2p for networking:

```typescript
// Node creation with integrated services
const node = await createLibp2pNode({
  services: {
    repo: repoService({ protocolPrefix: '/optimystic/<network>' }),
    cluster: clusterService({ protocolPrefix: '/optimystic/<network>' })
  }
});

// Key network integration
const keyNetwork = new Libp2pKeyPeerNetwork(node);
```

**Integration Features:**
- **Protocol Management**: Registers custom protocols for repo and cluster operations
- **Stream Handling**: Uses libp2p streams for reliable message transport
- **Peer Discovery**: Integrates with libp2p DHT for peer discovery
- **Security**: Leverages libp2p's cryptographic peer identity

## Usage Examples

### Setting Up a Coordinator Node

```typescript
import { createLibp2pNode } from '@optimystic/db-p2p';
import { repoService, clusterService, StorageRepo, CoordinatorRepo } from '@optimystic/db-p2p';

// Create a libp2p node with database services
const node = await createLibp2pNode({
  services: {
    repo: repoService(),     // Handles external client requests
    cluster: clusterService() // Handles peer coordination requests
  }
});

// Set up storage layer with filesystem persistence
const storageRepo = new StorageRepo(/* filesystem config */);

// Set up coordinator that uses cluster layer for consensus
const coordinatorRepo = new CoordinatorRepo(
  keyNetwork,           // For peer discovery
  createClusterClient,  // For communicating with cluster peers
  storageRepo          // For local storage operations
);

// Start the node
await node.start();
```

### External Client Operations

```typescript
// External clients connect to coordinator nodes
const client = RepoClient.create(coordinatorPeerId, peerNetwork);

// Operations work the same as core database interfaces
const blocks = await client.get({
  blockIds: ['block1', 'block2'],
  context: { rev: 10 }
});

// But automatically coordinate across the cluster
const pendResult = await client.pend({
  actionId: 'tx1',
  transforms: { block1: [/* operations */] },
  rev: 11
});

const commitResult = await client.commit({
  actionId: 'tx1',
  blockIds: ['block1'],
  rev: 11
});
```

### How Coordination Works

```mermaid
sequenceDiagram
    participant Client as External Client
    participant RC as RepoClient
    participant CR as CoordinatorRepo
    participant CC as ClusterClient
    participant CS as ClusterService
    participant CM as ClusterMember
    participant SR as StorageRepo
    
    Client->>RC: pend(transaction)
    RC->>CR: pend(transaction)
    CR->>CC: consensus request
    CC->>CS: cluster protocol
    CS->>CM: update(ClusterRecord)
    CM->>CM: 2-phase commit
    CM->>SR: execute operation
    SR-->>CM: result
    CM-->>CS: consensus result
    CS-->>CC: response
    CC-->>CR: consensus complete
    CR-->>RC: transaction result
    RC-->>Client: pend result
```

## Documentation

For detailed information about specific components:

- **[Storage System](./docs/storage.md)**: Versioned block storage and persistence
- **[Repo Interface](./docs/repo.md)**: Distributed database operations
- **[Cluster Consensus](./docs/cluster.md)**: 2-phase commit and distributed consensus

## Block Restoration & Arachnode Integration

The db-p2p package includes **dynamic Arachnode ring discovery** for automatic block restoration across storage tiers.

### How Block Restoration Works

When a node is missing a block or revision, the restoration system:

1. **Determines storage rings** - Nodes self-select ring depth based on capacity
2. **Discovers peers via FRET** - Ring membership propagates via existing neighbor exchange
3. **Queries rings intelligently** - Tries transaction ring first, then inner storage rings
4. **Filters by partition** - Only queries peers responsible for the block's keyspace

### Ring Selection

Nodes calculate their appropriate ring depth using:

```
ringDepth = ceil(-log2(available_capacity / estimated_demand))
```

**Examples:**
- 100% coverage → Ring 0 (full keyspace)
- 50% coverage → Ring 1 (2 partitions)  
- 1% coverage → Ring 7 (128 partitions)

### Architecture

```
FRET (Pure DHT)
  - Generic metadata transport
  - Peer discovery & routing
  
ArachnodeFretAdapter (Plugin Layer)
  - Arachnode-specific semantics
  - Ring discovery methods
  
Restoration Components
  - RingSelector: Capacity-based ring selection
  - RestorationCoordinator: Multi-ring queries
  - StorageMonitor: Capacity tracking
  - SyncService/Client: Block request protocol
```

### Configuration

```typescript
const node = await createLibp2pNode({
    port: 9000,
    networkName: 'mynet',
    bootstrapNodes: ['...'],
    clusterSize: 10,  // Cluster size for peer discovery
    arachnode: {
        enableRingZulu: true  // Default: enabled
    }
});
```

#### Solo / bootstrap / mobile nodes (no remote peers)

A node can operate fully on its own — no bootstrap peers, no listen addresses, no
connectivity to other peers. This is the common shape for a mobile app on first
launch or for a local-only sanity test.

```typescript
const soloNode = await createLibp2pNode({
    networkName: 'mynet',
    bootstrapNodes: [],           // no bootstrap
    listenAddrs: [],              // no incoming connections
    transports: [webSockets()],   // transports still required
    clusterSize: 1,
});
```

In solo mode:

- The node is its own coordinator. `CoordinatorRepo` short-circuits to local
  storage when the cluster size is ≤ 1, so `pend`/`commit` do not require
  cluster consensus and do not attempt to dial self.
- Block restoration is skipped when the only discovered peer is self.
  `RestorationCoordinator` will return `undefined` immediately rather than
  attempt to dial self (which would hang on a node with no listen addrs).
- If an operation fails for some other reason, `findCoordinator` surfaces a
  distinguishable `FindCoordinatorError` with `code ===
  FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED` rather than the
  generic "all candidates excluded". The aggregate error thrown by
  `NetworkTransactor` preserves the ORIGINAL first-attempt cause so callers can
  diagnose the real problem.

Once remote peers become reachable, the node transitions out of solo mode
automatically as FRET discovers them. Persisted network state (HWM, FRET
table) carries across restarts when an `options.persistence` is supplied.

#### Custom transports (including React Native)

By default, `createLibp2pNode()` uses TCP + circuit-relay transport.

To use non-default transports, pass `transports` (and typically `listenAddrs`):

```typescript
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNode } from '@optimystic/db-p2p';

const node = await createLibp2pNode({
    networkName: 'mynet',
    bootstrapNodes: ['/dns4/relay.example.com/tcp/443/wss/p2p/12D3...'],
    transports: [webSockets(), circuitRelayTransport()],
    listenAddrs: [],  // client-only; no incoming connections
});
```

#### React Native

For React Native, import from `@optimystic/db-p2p/rn` instead of the root entrypoint.
The `/rn` entrypoint does **not** import `@libp2p/tcp`, so Metro/Hermes won't try to
bundle Node-only native modules. It requires `options.transports` explicitly:

```typescript
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';

const node = await createLibp2pNode({
    networkName: 'mynet',
    bootstrapNodes: ['/dns4/relay.example.com/tcp/443/wss/p2p/12D3...'],
    transports: [webSockets(), circuitRelayTransport()],
});
```

RN environments (Hermes) need polyfills for globals that libp2p and its
dependencies expect. Install these early (e.g. in your app's entry file
before any other imports).

**Global polyfills** (patch `globalThis` before any library code):

| API | Required by | Notes |
|-----|-------------|-------|
| `crypto.getRandomValues()` | @noble/hashes, @libp2p/crypto | RN 0.76+ New Architecture provides natively; fallback via e.g. `react-native-get-random-values` |
| `crypto.subtle.digest()` | multiformats/hashes/sha2-browser | Async SHA-256/SHA-512 — implement via @noble/hashes |
| `structuredClone()` | @optimystic/db-core | JSON round-trip is sufficient |
| `Promise.withResolvers()` | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue | ES2024 — simple shim |
| `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/circuit-relay-v2, it-pushable | DOM spec addition — simple shim |
| Timer `.ref()` / `.unref()` | @optimystic/db-p2p, undici | Wrap Hermes numeric timer IDs in objects with no-op `.ref()`/`.unref()` methods; patch `clearTimeout`/`clearInterval` to unwrap |
| `Event`, `CustomEvent`, `EventTarget` | libp2p, @libp2p/interface | Custom shim or npm `event-target-polyfill` |
| `Intl.PluralRules` | moat-maker | English-only ordinal/cardinal shim is sufficient |

**Node.js built-in module shims** (via Metro `extraNodeModules` or bundler aliases):

| Module | Required by | Recommended shim |
|--------|-------------|------------------|
| `os` / `node:os` | @libp2p/utils | Custom shim: `networkInterfaces()` → `{}`, `platform()` → `Platform.OS` |
| `crypto` / `node:crypto` | multiformats/hashes/sha2 | Custom shim: `createHash()` via @noble/hashes |
| `stream` / `node:stream` | libp2p | `readable-stream` (npm) |
| `buffer` / `node:buffer` | libp2p, multiformats | `buffer` (npm) |

**Built-in (no polyfill needed):**
- `TextEncoder` — built-in to Hermes
- `TextDecoder` — built-in to Expo SDK 52+ (UTF-8 only)
- `BigInt` — built-in to Hermes since RN 0.70

See the [Sereus reference-app-rn](https://github.com/gotchoices/sereus/tree/master/packages/reference-app-rn/polyfills) for working polyfill implementations.

### Ring Transitions

Nodes automatically transition between rings based on capacity thresholds:
- **Move OUT** (to more granular ring) when > 85% capacity used
- **Move IN** (to broader ring) when < 40% capacity used

## Related Packages

- **[@optimystic/db-core](../db-core)**: Core database interfaces and local operations
- **[@optimystic/db-quereus](../db-quereus)**: Query engine and data access patterns
- **[p2p-fret](../fret)**: DHT implementation for peer discovery

### Internal Architecture

For developers and AI agents working on internals, see [Internals Guide](../../docs/internals.md) for:
- Data flow diagrams (read/write/commit paths)
- Mutation contracts (which functions mutate vs clone)
- Key invariants and common pitfalls
- Type glossary and debugging tips
