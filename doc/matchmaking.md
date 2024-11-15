# Matchmaking Subsystem
Rendezvous-based matchmaking in Kademlia DHT Networks

## Introduction

In VoteTorrent's peer-to-peer (P2P) networks, efficient matchmaking between peers is crucial, especially when dealing with dynamic and varying network sizes. VoteTorrent's rendezvous-based matchmaking design ensures that peers can find each other efficiently, whether the network has millions of nodes or just a few, and whether the subset of nodes interested in a particular task is large or sparse.  Broadly, matchmaking is used for:
* Finding peers with which to form blocks together
* Asking peers to do work, such as transacting changes to shared records

## Overview of the Design

The core idea is to have nodes "meet" at as local as possible rendezvous points.  **rendezvous keys** are derived from a combination of **local node address information** and **task-specific hashes**. Peers adjust the specificity of these keys based on the distribution of their local Kademlia buckets and the network conditions. By doing so, peers can effectively control the granularity of their search and matchmaking process.

- **Most General Rendezvous Key**: A key that points to a single location in the DHT, the place of maximal likelihood to find other interested peers.
- **Most Specific Rendezvous Keys**: Keys that are more widely distributed across the DHT, representing less likely places to find other interested peers.
- **Adaptive Specificity**: Peers adjust the specificity of their rendezvous keys based on the number of matches found, scaling naturally with the network size and density of interested peers.

## Generating Rendezvous Keys

### Steps to Generate an initial Rendezvous Key

1. **Estimate Local Common Significant Bits**:
   - Analyze the **n-nearest peer addresses** in the Kademlia routing table.
   - Determine the number of **common significant bits** among these addresses.
   - This common prefix represents the shared address space in the local network neighborhood.

2. **Create the Rendezvous Key**:
   - **Most Significant Bits (MSBs)**: Use the common significant bits from the local address estimation.
   - **Least Significant Bits (LSBs)**: Use bits from the **hashed topic identifier** (e.g., `SHA-256` hash of the task type).
   - **Combined Key**: Concatenate the MSBs and LSBs to form the initial rendezvous key.

### Adjusting the Rendezvous Key Specificity

- **Insufficient Matches**:
  - If no or too few peers are found at the current rendezvous point:
    - **Decrease** the number of local common bits used (making the key less specific to the local address space).
    - **Increase** the number of topic hash bits used.
- **Too Many Matches**:
  - If too many peers are found (overcrowding the rendezvous point):
    - **Increase** the number of local common bits used (making the key more specific to the local address space).
    - **Decrease** the number of topic hash bits used.

- **Extreme Cases**:
  - **Very Sparse Networks**: Use the entire topic hash, resulting in a single rendezvous point.
  - **Very Dense Networks**: Use more local common bits to narrow down the rendezvous point.

## Matchmaking Process

### Steps for Active Matchers

1. **Generate Initial Rendezvous Key**:
   - Follow the steps in **Generating Rendezvous Keys**.

2. **Publish Matchmaking Intent**:
   - Use a `provide` operation to store your availability or matchmaking intent at the rendezvous key in the DHT.

3. **Search for Matches**:
   - Perform a `findProviders` operation at the rendezvous key to retrieve other peers' matchmaking intents.

4. **Evaluate Matches**:
   - If sufficient matches are found, proceed to establish connections.
   - If not, adjust the rendezvous key specificity and repeat the process.

5. **Adjust Specificity as Needed**:
   - Use the methods described in **Adjusting the Rendezvous Key Specificity**.

### Steps for Waiting Workers

1. **Generate Rendezvous Key**:
   - Similar to active matchers, but may start with less specificity to join a broader pool.

2. **Register Availability**:
   - Store your availability at the rendezvous key with a Time-To-Live (TTL) value.
   - **Renew TTL** periodically to maintain presence.

3. **Wait for Work**:
   - Monitor for incoming requests or work assignments from peers.

4. **Adjust Specificity if Overcrowded**:
   - When renewing, if the rendezvous point becomes too crowded, increase specificity to balance the load.

## Worker Nodes vs. Active Matchers

### Worker Nodes Waiting for Work

- **Objective**: Remain available for work assignments without immediate matchmaking.
- **Approach**:
  - **Longer TTLs**: Register at rendezvous points with longer TTLs, periodically renewing to stay available.
  - **Load Management**: Adjust rendezvous key specificity to balance the number of workers at each point.
  - **Wait State**: Remain at the rendezvous point until work is assigned, rather than actively searching for matches.

### Active Matchers Seeking Immediate Matches

- **Objective**: Quickly find peers to collaborate on tasks.
- **Approach**:
  - **Short TTLs**: Use shorter TTLs since the intent is to find matches quickly and then leave.
  - **Aggressive Specificity Adjustment**: Rapidly adjust rendezvous key specificity if matches are not found.
  - **Direct Connection**: Upon finding matches, establish direct peer-to-peer connections and proceed with the task.

## Example Scenarios

### Scenario 1: Sparse Network Matchmaking

- **Network Size**: 1,000,000 peers
- **Interested Peers**: 10 peers

#### Steps:

1. **Estimate Local Common Bits**:
   - Assume the local common prefix is 10 bits.

2. **Generate Rendezvous Key**:
   - **MSBs**: 10 local common bits.
   - **LSBs**: Remaining bits from the topic hash (e.g., 150 bits for a 160-bit keyspace).

3. **Publish and Search**:
   - Peers store their intent at the rendezvous key and attempt to retrieve others' intents.

4. **Insufficient Matches Found**:
   - Peers find no matches due to sparsity.

5. **Adjust Specificity**:
   - **Decrease** local common bits to 9.
   - **Increase** topic hash bits by 1.

6. **Repeat Steps**:
   - Continue adjusting until matches are found, potentially ending up using the entire topic hash.

### Scenario 2: Dense Network Matchmaking

- **Network Size**: 1,000,000 peers
- **Interested Peers**: 500,000 peers

#### Steps:

1. **Estimate Local Common Bits**:
   - Assume the local common prefix is 10 bits.

2. **Generate Rendezvous Key**:
   - Start with the initial rendezvous key as above.

3. **Publish and Search**:
   - Peers store their intent and retrieve others'.

4. **Too Many Matches Found**:
   - Peers encounter overcrowding at the rendezvous point.

5. **Adjust Specificity**:
   - **Increase** local common bits to 11.
   - **Decrease** topic hash bits by 1.

6. **Repeat Steps**:
   - Continue adjusting until a manageable number of matches are found.

### Scenario 3: Worker Nodes Waiting for Work

- **Network Size**: 1,000,000 workers
- **Work Availability**: Limited tasks at any given time

#### Steps:

1. **Generate Rendezvous Key**:
   - Workers estimate local common bits and generate the key accordingly.

2. **Register Availability with Longer TTLs**:
   - Workers store their availability at the rendezvous point, renewing TTLs to stay registered.

3. **Load Balancing**:
   - Workers adjust specificity to ensure that rendezvous points are not overcrowded.

4. **Task Assignment**:
   - Peers with work to assign search the rendezvous points to find available workers.

5. **Waiting State**:
   - Workers remain at the rendezvous point until selected for work.
