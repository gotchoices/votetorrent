**Transaction Processing Scheme Design**

**Overview**

This design outlines a transaction processing scheme using libp2p, built around the [Repository](repository.md) primitives. The transaction API used by clients interacts with a distributed set of nodes, leveraging Kademlia for efficient peer discovery and consensus-based updates. The main focus is on enabling concurrent access to distributed blocks while ensuring consistency, with nodes coordinating through a consensus mechanism.

**Node Coordination and Consensus Requirements**

The Repository primitives are client-facing and abstract away the complexities involved in maintaining consistency across multiple nodes. Behind the scenes, nodes must coordinate with each other to ensure that any modifications follow a consensus-based approach, preventing conflicting updates and maintaining data integrity. Each node is part of a Kademlia-based distributed hash table (DHT) network, allowing efficient lookup and communication.

For nodes to accept a modification (`put` or `delete`), two main conditions must be met:

1. **Revision Match**: The proposed modification must include the current revision number of the block, ensuring that it matches the latest version that the node knows. If the revision does not match, the modification will be rejected, indicating that the block has been modified by another client.  It is up to the client to retry with the updated revision.

2. **Consensus from Peers**: To proceed with an update, the node must obtain agreement from a sufficient number of peers within the Kademlia key range covering the block ID. This consensus ensures that:
   - The update is propagated reliably to the relevant nodes.
   - Conflicts are resolved in a decentralized manner, avoiding the need for a central authority.
  
3. **Block Validity**: The block must be valid according to the higher-level semantics of specific block types. This includes ensuring hashes and signatures for things like registration blocks or voter blocks.

**Consensus Flow**

1. **Initiate Update**: When a client calls `put(blockId, revision, block)`, the node responsible for that block (referred to as the *coordinating node*) will first verify if the revision matches its stored revision. It is important to note that there is no central node responsible for any block. Instead, responsibility is distributed across multiple nodes in the Kademlia DHT, with the node closest to the block ID acting as the coordinator for that specific request.

2. **Request Peer Signatures**: If the revision matches, and the block is valid according to the coordinator, it will initiate a request to other nodes in the key range to obtain signatures for the modification. These nodes verify the block and check if they agree with the proposed update.

3. **Amassing Peer Signatures**: The coordinating node must gather signatures from a sufficient number of peers to reach consensus. The process works as follows:
   - The coordinating node uses the Kademlia lookup process, or it's cached view of the network, to find the nodes closest to the key. During this process, the node will naturally discover multiple neighboring nodes that overlap the key range.
   - The coordinating node sends a request to all nodes within the relevant Kademlia key range that were identified during the lookup.
   - Each peer independently verifies the proposed modification by checking its own stored data and validating the update request.
   - If the peer agrees with the modification, it signs the request and returns its signature to the coordinating node.
   - The coordinating node must collect enough signatures to meet the consensus threshold. This threshold is based on a configurable majority.
   - Once the required number of signatures is obtained, the coordinating node commits the update and broadcasts the updated state to all relevant nodes.

4. **Reach Consensus**: If a sufficient number of peers (depending on the consensus protocol—e.g., a majority or quorum) provide their signatures, the coordinating node commits the update, broadcasts the updated state to all relevant nodes, and returns success to the client.

5. **Handle Conflicts**: If the revision does not match or consensus is not reached, the update fails, and the client must retry, typically after fetching the latest revision number using `getRevision(blockId)`.

**Handling Peer Signatures**

Handling peer signatures is critical for maintaining the integrity of the distributed transaction process. The following specifics outline how peer signatures are handled:

1. **Signature Structure**:
   - Each peer's signature digest includes the following components:
     - **Peer ID**: The unique identifier of the peer signing the request.
     - **Block ID**: The identifier of the block being updated.
     - **Revision Number**: The revision number of the block at the time of signature.
     - **Hash of Proposed Update**: A cryptographic hash of the proposed update to ensure that peers are signing off on a specific, unaltered version of the block.

2. **Signature Collection by Coordinating Node**:
   - The coordinating node collects the signatures and verifies their validity by:
     - **Signature Authenticity**: Checking the digital signature using the public keys of the signing peers.
     - **Threshold Check**: Ensuring that the number of collected signatures meets the predefined consensus threshold (e.g., a particular majority of the involved peers).
   - If the signatures are valid and the consensus threshold is met, the coordinating node proceeds with committing the update.

3. **Transaction Record Propagation**:
   - Once consensus is reached, the coordinating node includes all collected signatures in a transaction record, which is then broadcast to all relevant nodes. This ensures that:
     - **Auditability**: All nodes have a record of the signatures involved in approving the update, allowing them to verify that proper consensus was achieved.
     - **Conflict Prevention**: Nodes receiving the transaction record can use the signatures to confirm that the committed state is valid and was agreed upon by the required number of peers.

4. **Handling Signature Failures**:
   - If a peer rejects the transaction (e.g., due to a revision mismatch or integrity failure), the coordinating node logs the rejection in the transaction record which is eventually propagated back to the participants.  If enough participants reject the transaction, it will be rolled back and the client notified.
   - **Timeout Management**: If a peer does not respond within the transaction's timeout period, the coordinating node assumes that node will reject the transaction, and either reject or proceed to commit the transaction as a whole.

5. **Consensus Failure**:
   - In the event that consensus could not be reached, and the client retries with updated data, the coordinating node must re-initiate the signature process.
   - Nodes that had previously signed must verify the new revision and hash before re-signing. This ensures that they are aware of the updated context and do not inadvertently approve conflicting modifications.

6. **In-doubt Transactions**:
   - In the event that a node is not informed of the outcome of a transaction, ether at the timeout period for that transaction, or upon receiving a subsequent transaction, it should connect with other peer nodes and attempt to resolve the transaction.  The prior transaction's outcome must be resolved before signing off on subsequent transactions.

**Conflict Resolution and Failure Handling**

In distributed systems, conflicts and node failures are common scenarios that need careful handling to ensure consistency. Below are the strategies for dealing with conflicts and dropped coordinators:

1. **Conflict Resolution**:
   - **Retry Mechanism**: If a conflict occurs (e.g., due to a revision mismatch), the client should retry the operation after obtaining the latest revision using `getRevision(blockId)`. This ensures that the client has the most recent state before attempting a new update.
   - **Conflict Detection**: Nodes should detect conflicting modifications by comparing the incoming update's revision number with the current state. If the revision does not match, the update is rejected, and the client is informed to retry.
   - **Backoff Strategy**: Clients may implement an exponential backoff strategy when retrying updates to avoid overwhelming the network with repeated attempts, especially during high contention periods.

3. **Failure Handling and Fault Tolerance**:
   - **Persisted State Storage**: Each node should maintain a stored copy of its current state and pending transactions to handle sudden failures. This ensures that nodes can recover quickly without losing transaction information.
   - **Node Recovery**: When a failed node recovers, it must synchronize with the network to obtain the latest committed state for the blocks it is responsible for. This may involve fetching transaction records from neighboring nodes to ensure it is consistent with the network.
   - **Peer Communication at TTL Expiry**: If the TTL (time-to-live) is reached and non-coordinator nodes have not heard whether consensus was achieved, they should reach out to each other to try and ascertain the transaction result. This cooperative communication can help determine whether the transaction was completed or if it should be rolled back.
   - **Client Recovery at TTL Expiry**: If the client has not heard back by the TTL and the prior coordinator can no longer be reached, the client should re-establish a connection to the closest node (as determined by a new Kademlia lookup) and retry the transaction or read the status of the transaction.

**Challenges and Considerations**

- **Adversarial Coordinators**: There is a risk that a node closest to a key value may be adversarial, potentially preventing valid transactions from succeeding.  To mitigate this, if a client believes that a valid block has been rejected, it can utilize any key overlapping node to coordinate the transaction.
- **Adversarial Transactors**: If a node participating in a transaction explicitly rejects a block that a majority of nodes agree is valid, this information is noted by peers and with sufficient such events, may lead to the node being excluded from future transactions.
- **TTL Expiry Handling**: Nodes and clients must be able to handle cases where the TTL expires without receiving confirmation, by cooperating to determine transaction outcomes or reconnecting to the network for updated information.
