# @votetorrent/vinz
> Vinz Clortho - The Keymaster. Threshold Cryptography for VoteTorrent

This package implements Distributed Key Generation (DKG) of threshold cryptography primitives based on Feldman's Verifiable Secret Sharing (VSS) scheme over the secp256k1 curve. It allows a group of participants to collaboratively generate a shared public key without any single participant knowing the corresponding private key. A threshold number of participants can later cooperate to reconstruct the private key or perform operations requiring it (like decryption).

This library uses stateless functions, requiring the caller to manage both the public shared state and the private state of each participant.

## Cryptography Choice and Future Considerations

**Goal:** The primary goal of Vinz is to enable threshold cryptography, specifically generating a shared public key whose corresponding private key is never held by a single entity but can be reconstructed or used collaboratively by a threshold number of participants.

**Current Implementation: Feldman VSS over secp256k1**

This library currently uses Feldman's Verifiable Secret Sharing (VSS) scheme operating over the secp256k1 elliptic curve group.

**Why Feldman VSS?**

*   **Verifiability:** It allows participants to verify the consistency of shares they receive during the DKG process. This is crucial to prevent malicious participants from disrupting the key generation.
*   **Composite Public Key Generation:** The VSS scheme naturally produces a composite public key corresponding to the shared secret. This is essential for Vote Torrent's use case, where votes will be secured using the composite public key.
*   **Maturity:** Feldman VSS combined with elliptic curves is a well-understood and relatively mature technique in threshold cryptography.

**Post-Quantum Considerations:**

We have explored the feasibility of using post-quantum (PQ) cryptography to make the system secure against potential future quantum computers.

*   **Shamir's Secret Sharing (SSS):** While the core math of SSS (polynomial interpolation) is post-quantum secure, basic SSS lacks the verifiability needed for a robust DKG. Adapting Vinz to basic SSS would remove protection against malicious actors, eliminate the composite public key, and require a centralized key distributor.
*   **Lattice-Based Schemes (e.g., CRYSTALS-Kyber):** These are leading PQ candidates but rely on different mathematical foundations (Learning With Errors). They do not directly support the homomorphic properties used by Feldman VSS for verification and public key generation. Achieving threshold cryptography with these schemes typically requires more complex protocols (like specialized PQ-VSS or Multi-Party Computation) which are not yet widely available as simple, integrated libraries.

**Conclusion:** Given the requirements for verifiability and composite public key generation, and the current landscape of readily available cryptographic libraries, Feldman VSS over secp256k1 provides the best balance of security (against classical computers), functionality, and implementation maturity for Vinz's goals at this time. We will continue to monitor the development of practical and standardized post-quantum threshold schemes for future integration.

**Conceptual Overview of Feldman VSS in Vinz:**

Imagine we need `t` out of `n` participants to reconstruct a secret.

1.  **Polynomials:** Each participant `i` secretly chooses a random polynomial \( P_i(x) \) of degree \( t-1 \). Their contribution to the final secret key is \( a_{i,0} = P_i(0) \).
2.  **Commitments:** Participant `i` computes public "commitments" to their polynomial's coefficients \( a_{i,k} \). Using the elliptic curve generator point \( G \), they calculate \( C_{i,k} = G \cdot a_{i,k} \) for each coefficient \( k \). These commitments \( C_{i,0}, C_{i,1}, ..., C_{i,t-1} \) are published. Note that \( C_{i,0} \) is the public key corresponding to participant `i`'s secret share \( a_{i,0} \).
3.  **Shares:** Participant `i` calculates a secret share for every participant `j` by evaluating their polynomial: \( s_{ij} = P_i(j) \). This share \( s_{ij} \) is sent securely to participant `j`.
4.  **Verification:** Participant `j` receives the share \( s_{ij} \) from participant `i`. To verify it, `j` checks if the share matches the public commitments broadcast by `i`. They compute \( G \cdot s_{ij} \) and compare it to \( \sum_{k=0}^{t-1} C_{i,k} \cdot j^k \). Because elliptic curve math allows \( G \cdot (\sum a_{i,k} j^k) = \sum (G \cdot a_{i,k}) \cdot j^k = \sum C_{i,k} \cdot j^k \), this equation holds *if and only if* \( s_{ij} = P_i(j) \). This step prevents participant `i` from sending inconsistent shares.
5.  **Final Secret Share:** After verifying shares from all other participants, participant `j` combines them to get their final secret share \( S_j = \sum_i s_{ij} \). This \( S_j \) represents the evaluation of the overall combined polynomial \( P(x) = \sum_i P_i(x) \) at point `j`.
6.  **Composite Public Key:** The final shared public key is the sum of the commitments to the constant terms of everyone's polynomials: \( PK = \sum_i C_{i,0} = \sum_i (G \cdot a_{i,0}) = G \cdot (\sum_i a_{i,0}) = G \cdot P(0) \).
7.  **Reconstruction:** Later, if `t` participants reveal their final shares \( S_j \), the original secret \( P(0) \) (the private key corresponding to \( PK \)) can be reconstructed using Lagrange interpolation on the points \( (j, S_j) \).

This process ensures that no single participant knows the final private key \( P(0) \), but a threshold `t` can collaboratively reconstruct it or use their shares \( S_j \) to perform cryptographic operations.

## Installation

This package is part of the VoteTorrent monorepo. Install dependencies from the root of the repository:

```sh
npm install
# or
yarn install
```

## Usage

The process involves several phases managed by an external coordinator or state machine that collects and distributes updates.

**1. Initialization:**

*   Define the DKG parameters (total participants `n`, threshold `t`).
*   Generate the `DKGIdentifier` (which contains the `DKGTerms` and `termsHash`) using `createDKGTerms(n, t)`.
*   Each participant initializes their private state using `initializeKeyholderPrivateState(myId, dkgIdentifier)`.
*   Initialize the shared public state (contributions, verifications, common state) using helpers like `initParticipantContributionState`, `initParticipantVerificationState`, `initCommonDKGState` (passing the `termsHash` from the `dkgIdentifier`).

**2. State Progression (Loop):**

Participants interact with a shared state view (`DKGStateView`). In each round, a participant:

*   (Optional) Calls `determineKeyholderAction(myId, dkgIdentifier, stateView)` to see what action is needed.
*   Calls `computeKeyholderUpdate(currentPrivateState, dkgIdentifier, stateView)` to perform the necessary computation for the next step.
    *   This returns a `ComputationResult` containing:
        *   `publicUpdate`: Data to be broadcast and applied to the shared state.
        *   `nextPrivateState`: The updated private state for the participant.
        *   `reason`: Optional explanation.
*   The caller applies the `publicUpdate` to the shared state view.
*   The caller stores the `nextPrivateState` for the participant.

**Phases managed by `computeKeyholderUpdate`:**

*   **PostCommitments:** Generates a secret polynomial and public commitments (`G*coeff`).
*   **PostShares:** Calculates encrypted shares `P_i(j)` for each participant `j`. (Note: Current implementation simulates encryption).
*   **VerifyShares:** Verifies received shares against sender commitments using the VSS equation. If successful, computes the final private share `S_j = sum(P_i(j))`.

**3. Public Key Calculation:**

*   Once enough participants (`>= t`) have successfully completed verification, anyone can calculate the composite public key using `calculateCompositePublicKey(stateView)`. The `stateView` includes the necessary `DKGIdentifier`.

**4. Threshold Decryption (Example Usage):**

*   **Encryption:** Data can be encrypted using the `compositePublicKey` via `encryptData(message, compositePublicKey)`.
*   **Share Reveal:** When decryption is needed, at least `t` *successful* participants must reveal their final shares.
    *   Each revealing participant calls `computeRevealShareUpdate(currentPrivateState)`.
    *   This returns a `RevealComputationResult` with a `publicUpdate` containing their `FinalShareData`.
    *   These reveal updates are applied to the `commonState.revealedSharesForDecryption` in the shared state.
*   **Reconstruction:** Collect revealed shares. Reconstruct the private key using `reconstructPrivateKey(revealedShares, dkgIdentifier.terms.threshold)`.
*   **Decryption:** Decrypt the data using `decryptDataWithReconstructedKey(encryptedData, reconstructedPrivateKey)`.

## Key Functions

*   `createDKGTerms`: Setup DKG parameters and return `DKGIdentifier`.
*   `initializeKeyholderPrivateState`: Create initial private state.
*   `determineKeyholderAction`: Check the next required action.
*   `computeKeyholderUpdate`: Perform the core DKG computation step.
*   `calculateCompositePublicKey`: Compute the shared public key.
*   `computeRevealShareUpdate`: Prepare a participant's final share for revealing.
*   `encryptData`: Encrypt using the composite public key.
*   `reconstructPrivateKey`: Rebuild the private key from revealed shares.
*   `decryptDataWithReconstructedKey`: Decrypt using the reconstructed private key.

## Key Types

*   `DKGIdentifier`: Contains `terms` and `termsHash`.
*   `DKGTerms`: Defines `n`, `threshold`, `participantIds`.
*   `DKGStateView`: Read-only view of the full public state, includes `DKGIdentifier`.
*   `KeyholderPrivateState`: Private state managed by the caller for each participant.
*   `ComputationResult`: Return type for `computeKeyholderUpdate`.
*   `RevealComputationResult`: Return type for `computeRevealShareUpdate`.

## Error Handling

Functions generally return specific result objects (e.g., `ComputationResult`, `RevealComputationResult`) which include potential error information or indicate failure by returning `null` for `nextPrivateState` or `publicUpdate`. Participants entering an error state will have the `error` field set in their `KeyholderPrivateState`.

