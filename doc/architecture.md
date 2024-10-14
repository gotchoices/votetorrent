# VoteTorrent Technical Architecture

## Matchmaking

VoteTorrent's peer-to-peer network employs a rendezvous-based matchmaking system to efficiently connect peers for various tasks, regardless of network size or task popularity. The core concept involves nodes meeting at localized rendezvous points, with rendezvous keys derived from a combination of local node address information and task-specific hashes. Peers can adjust the specificity of these keys based on their local Kademlia bucket distribution and network conditions, allowing for adaptive control over the search and matchmaking process.

The matchmaking process differs for active matchers and waiting workers. Active matchers generate rendezvous keys, publish their intent, search for matches, and adjust key specificity as needed to find suitable peers quickly. Workers, on the other hand, register their availability with longer Time-To-Live (TTL) values and wait for work assignments, adjusting their specificity to balance the load at rendezvous points. This flexible system can handle various scenarios, from sparse networks with few interested peers to dense networks with many participants, by dynamically adjusting the rendezvous key specificity to optimize peer discovery and work distribution.

For details, see [matchmaking](./doc/matchmaking.md).

## Storage

VoteTorrent uses **Arachnode**, a storage system that organizes storage nodes into concentric rings, with each ring representing progressively finer partitions of the keyspace. The outermost ring, called Ring Zulu, handles transactions and dynamic ranges based on an overlap factor rather than specific partition boundaries. Storage nodes in the innermost ring, Ring 0, store the entire keyspace, while nodes in outer rings manage smaller, more specific portions of the keyspace as they move outward. This design allows nodes to adjust their range responsibility based on storage capacity, dynamically shifting to more granular rings when needed.

Nodes in Arachnode maintain references to neighboring nodes within their ring and across adjacent inner and outer rings to facilitate data propagation and retrieval. As storage capacity reaches its limit, a node moves outward, adjusting its range and offloading excess data to nodes in the inner rings. This self-organizing system balances load across the rings, with global demand monitored through overlap factor sampling. This adaptive structure provides scalable, efficient storage management, with nodes dynamically adjusting their participation in rings to meet the system’s overall storage and processing needs.

For details, see [Arachnode](./doc/arachnode.md).

## Repository

Collectively the storage system acts as a **Block Repository** that manages versioned data blocks, enabling efficient access, conditional updates, and controlled deletion. The repository's primary goal is to maintain a historical record of changes, handle concurrent updates safely, and ensure data consistency. The Block Repository offers four core operations: 
- `getRevision()` to fetch the latest revision number, 
- `get()` to retrieve the latest or a specific version of a block, 
- `put()` to conditionally update a block based on its current version, and 
- `delete()` to mark blocks for eventual removal. 

Revisions facilitate optimistic concurrency control, preventing data loss during concurrent modifications, ensuring safe and reliable updates.

The repository also employs lifetime policies for efficient data management. Older versions of blocks are retained for a limited duration defined by a Time-To-Live (TTL), after which they may be garbage collected, while the latest version is always available. Revisions of deleted blocks are similarly managed, remaining available for a limited time before permanent removal. This approach allows for rollback and data recovery options while maintaining efficiency in storage management.

For details, see [repository](./doc/repository.md).

## Transactions

Repository actions are executed for the client using a distributed transaction processing scheme, where nodes interact to manage concurrent modifications to blocks in a decentralized manner. Each transaction involves a coordinating node, which is responsible for initially verifying the block's revision, then initiating a consensus process, and collecting peer signatures to reach an agreement. The consensus is achieved when a sufficient number of peers, determined by a threshold, sign off on the transaction, thereby ensuring that updates are propagated consistently across the network. Peer signatures are collected and validated to maintain the integrity and authenticity of updates, and nodes must cooperate to resolve in-doubt transactions in the event of timeouts or node failures.

Conflict and failure handling are integral to the robustness of this design. In case of conflicts, clients must retry operations after refreshing the latest state of the block, with nodes detecting conflicting modifications to ensure consistency. If a coordinating node fails during a transaction, the client can try again with a new coordinator to complete or roll back the transaction. To handle situations where nodes or clients do not receive transaction outcomes before a TTL expires, nodes will attempt cooperative communication to determine the result, while clients reconnect to the closest available node to query for the transaction status. This design emphasizes decentralized control, robustness to adversarial behavior, and mechanisms for retrying or coordinating failed transactions to ensure data integrity and consistency in the distributed network.

For details, see [transactions](./doc/transactions.md).

## Collections

For details, see [collections](./doc/collections.md).

## Block Negotiation

The apps should join the DHT networks in the background, and remain as an active node during the active election period.

Blocks are negotiated as follows, from the perspective of a given node:

### Pair finding
* A pairing public/private key pair is generated, with the private key kept accessible (not locked in hardware vault)
* A clock delta is established relative to an NTP server - this allows us to estimate latency from peers in one hop
* Subscribe to an Election Network pub-sub topic based on the template CID, and a 'seeding' token.
  * Initially the pairing token is based on several of the most significant digits of a hash of the registrantKey (Q: good to have this content based, but not sure if we can do that quite yet) 
* Upon joining the topic, send an `present` message to the topic, with our Peer ID, adjusted time, and multiaddress
* Wait for at least an accumulation time (if accumulation count messages arrive), and at most a timeout period, for topic messages from other peers
* For each `present` message received from the pubsub, send a `greet` message, directly to the least n latent peers, with our Peer ID, time, multiaddress, and pairing public key
* If we receive a `greet` message: 
  * If its apparent latency is less than any of the peers we have encountered, respond with a `pair` message containing:
    * Our voter and vote records completely encrypted using the combined public key of both nodes
    * The pairing public key
  * Otherwise respond with a `reject` message
* If our outgoing `greet` message(s) timeout or are rejected, go to the next n latent peers and repeat
* If we receive a `pair` message, we should check that it's round-trip latency reasonably matches the estimated one hop latency, if so, and we have accepted no other pairings, the pairing is complete and we proceed to the next step, otherwise we respond with a `reject` message
* Keep track of rejected peers, and if we get to a latency that would make the rejected peer the least latent, attempt a `greet` again
* If we encounter no other peers after the maximum timeout period, continue "listening" on this topic, but subscribe to the next most general topic pairing token, announce our presence, and repeat
  * A `greet` message from a more specific topic node should supersede a lower response time (up to some limit) 
* If we get to the root token (empty), and the voting period is elapsing, we must form a unitary block and submit it

### Seeding
At the end of pair finding, one node should have the encrypted vote and voter records from the other node, as well as the pairing public key of the other node.  We'll call this node the pair coordinator.

* The coordinator will completely encrypt its own voter and vote records and form a "seed", with the combined voter and vote records in scrambled order relative to each other.  Note that the vote and voter records contain a visible nonce and registrantKey and an encrypted content portion, so this encryption hides those visible values.
* In a manner similar to pair finding, the coordinator attempts to find either a 3rd peer or another coordinator node to form a "pool".
  * The `present` and `greet` messages are sent as above
  * Rather than sending a `pair` message, however, a `pool` message is sent containing the seed, the coordinator's private key, and the non-coordinator's public key and multiaddress
  * If we, as a node, receive a `pool` message, we should:
    * Send a `confirm` message to the non-coordinator peer indicated in the message, containing the non-coordinator's public key
    * Wait for a `received` message from the non-coordinator peer containing the non-coordinator's private key
    * Decrypt the seed using the non-coordinator and coordinator's combined private keys
    * Combine the voter and vote records from the seed with our own voter and vote records, scrambling the order of each list independently, forming a pool
    * We become the pool coordinator, and we inform all contributing peers that they are in the pool
    * If we don't receive an `ack` message from one or more peers within a timeout period, we revert to our previous state and `inform` all contributing peers that we did

### Pool Merging
* As pool coordinator, we subscribe to an election network pub-sub topic based on the template CID, a 'pooling' token, and the hash of the pool
* Similar to pairing, we start with a more specific token of the pool hash and move to a more general one, announce our presence, and try to find other pool coordinators
* `present` messages in this topic include the current pool size, and the pool coordinator's multiaddress
* `greet` messages include reciprocal size information, followed by a `merge` message
* At completion of each merge, all contributing peers are `inform`ed of the new pool size and the pool coordinator's multiaddress
  * Any nodes not acknowledging cause the merge to be reverted, with follow up `inform` messages going to all members - including information about which peer(s) did not acknowledge
  * Q: Perhaps nodes should track pool and seed revisions, and potentially drop repeat offenders.  Should this also be whispered?  Announced via pubsub?
* If pool size reaches a capacity margin, or the period is ending, the pool coordinator sends a `form` message to all contributors to announce block formation
  * This message includes a CID, representing the hash of the records portion of the block
  * All peers should check that:
    * The CID is correct
    * The records include their unaltered vote and voter records
    * There are an equal number of voter and vote records
    * Q: Should peers check for voter uniqueness, or should this be left solely to transaction validation when incorporating blocks

## Block transaction
Blocks are transacted into the Election Network when all registrant records have been updated to point to the block's CID, and all transaction voters have signed their commitment.
