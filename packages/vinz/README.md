# @votetorrent/vinz
> Vinz Clortho - The Keymaster. Threshold Cryptography for VoteTorrent

This package implements Distributed Key Generation (DKG) of threshold cryptography primitives based on Feldman's Verifiable Secret Sharing (VSS) scheme over the secp256k1 curve. It allows a group of participants to collaboratively generate a shared public key without any single participant knowing the corresponding private key. A threshold number of participants can later cooperate to reconstruct the private key or perform operations requiring it (like decryption).

This library uses stateless functions, requiring the caller to manage both the public shared state and the private state of each participant.

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

