import { Buffer } from 'buffer';
import {
    initParticipantContributionState, initParticipantVerificationState, initCommonDKGState,
    DKGActionType, createDKGTerms, calculateCompositePublicKey,
    encryptData, reconstructPrivateKey, decryptDataWithReconstructedKey,
    initializeKeyholderPrivateState,
    computeKeyholderUpdate,
    computeRevealShareUpdate
} from '../src/index.js';
import type {
    DKGTerms, DKGStateView, ParticipantContributionState, ParticipantVerificationState,
    CommonDKGState, CommitmentsUpdate, SharesUpdate, VerificationUpdate, RevealShareUpdate,
    KeyholderPrivateState,
    ComputationResult
} from '../src/index.js';
import { bigintToBytes } from '../src/helpers.js';

// --- Simulation State Management ---

// Represents the entire shared state persisted in the distributed store
interface SimulationDKGSharedState {
    termsHash: string;
    participantContributions: Record<string, ParticipantContributionState>;
    participantVerifications: Record<string, ParticipantVerificationState>;
    commonState: CommonDKGState;
}

// Creates a read-only view for the Keyholder logic
function createDKGStateView(terms: DKGTerms, sharedState: SimulationDKGSharedState, termsHash: string): DKGStateView {
    if (sharedState.termsHash !== termsHash) {
         throw new Error("Mismatched terms hash in shared state!");
    }
    // In a real system, ensure deep copies / immutability if needed
    return {
        terms: terms,
        termsHash: sharedState.termsHash,
        participantContributions: sharedState.participantContributions,
        participantVerifications: sharedState.participantVerifications,
        commonState: sharedState.commonState
    };
}

// Applies updates returned by computeKeyholderUpdate to the shared state
// Simulates a transactional update
function applyDKGUpdates(
    currentState: SimulationDKGSharedState,
    updates: (CommitmentsUpdate | SharesUpdate | VerificationUpdate | RevealShareUpdate | null)[]
): SimulationDKGSharedState {
    const nextState = {
         ...currentState,
        // Deep copy mutable parts
        participantContributions: { ...currentState.participantContributions },
        participantVerifications: { ...currentState.participantVerifications },
        commonState: {
             ...currentState.commonState,
             revealedSharesForDecryption: { ...currentState.commonState.revealedSharesForDecryption } // Copy reveal map
        }
    };

    for (const update of updates) {
        if (!update) continue;
         // Check terms hash consistency
        // if (update.termsHash !== nextState.termsHash) { ... }

         if (update.participantId && !nextState.participantContributions[update.participantId]) {
             // This might happen if a participant is instantly marked failed
             // console.warn(`State update for unknown or previously failed participant ${update.participantId}, ignoring.`);
             continue;
         }

        switch (update.type) {
            case DKGActionType.PostCommitments:
                 if (!nextState.participantContributions[update.participantId]) {
                    nextState.participantContributions[update.participantId] = initParticipantContributionState(nextState.termsHash, update.participantId);
                 }
                if (!nextState.participantContributions[update.participantId]!.commitments) {
                     nextState.participantContributions[update.participantId]!.commitments = update.payload.commitments;
                }
                break;
            case DKGActionType.PostShares:
                if (!nextState.participantContributions[update.participantId]) {
                    nextState.participantContributions[update.participantId] = initParticipantContributionState(nextState.termsHash, update.participantId);
                 }
                 if (!nextState.participantContributions[update.participantId]!.distributedShares) {
                    nextState.participantContributions[update.participantId]!.distributedShares = update.payload.shares;
                 }
                break;
            case DKGActionType.VerifyShares:
                 if (!nextState.participantVerifications[update.participantId]) {
                    nextState.participantVerifications[update.participantId] = initParticipantVerificationState(nextState.termsHash, update.participantId);
                 }
                 // Verification status is final once set
                 if (nextState.participantVerifications[update.participantId]!.verified === undefined) { // Check if undefined
                    nextState.participantVerifications[update.participantId]!.verified = update.payload.verified;
                    nextState.participantVerifications[update.participantId]!.reason = update.payload.reason;
                 }
                break;
            case DKGActionType.RevealShare:
                 const shareInfo = update.payload.finalShareData;
                 if (!nextState.commonState.revealedSharesForDecryption[update.participantId]) {
                      nextState.commonState.revealedSharesForDecryption[update.participantId] = {
                           idNum: shareInfo.idNum,
                           share: bigintToBytes(shareInfo.finalShare) // Convert to bytes for storage
                      };
                 }
                break;
        }
    }
    return nextState;
}

// --- Simulation Runner ---

// Determine if the DKG process is complete based on state view
function isDKGComplete(stateView: DKGStateView): boolean {
    const n = stateView.terms.n;
    const threshold = stateView.terms.threshold;

    // Phase 1 Done? All contributions exist and have commitments
    const allCommitmentsPosted = stateView.terms.participantIds.every(id =>
        !!stateView.participantContributions[id]?.commitments
    );
    if (!allCommitmentsPosted) return false;

    // Phase 2 Done? All contributions exist and have shares
    const allSharesPosted = stateView.terms.participantIds.every(id =>
         (stateView.participantContributions[id]?.distributedShares?.length ?? 0) === n
    );
    if (!allSharesPosted) return false;

    // Phase 3 Done? All verifications exist and have a status
    const allVerificationDone = stateView.terms.participantIds.every(id =>
        stateView.participantVerifications[id]?.verified !== undefined
    );
    if (!allVerificationDone) return false;

    // Enough participants succeeded verification?
    const successfulCount = stateView.terms.participantIds.filter(id =>
        stateView.participantVerifications[id]?.verified === true
    ).length;
    if (successfulCount < threshold) return false; // Failed threshold check

    // Phase 4 Done? Public key calculated
    if (!stateView.commonState.compositePublicKey) return false;

    return true; // All checks passed
}

// Return type reflects stateless change
async function runDKGSimulation(n: number, threshold: number): Promise<{
    terms: DKGTerms,
    termsHash: string,
    finalState: SimulationDKGSharedState,
    finalPrivateStates: Record<string, KeyholderPrivateState>
} | null> {

    const { terms, termsHash } = await createDKGTerms(n, threshold);

    // Initialize private states for each participant
    let keyholderPrivateStates: Record<string, KeyholderPrivateState> = {};
    for (const id of terms.participantIds) {
        try {
            keyholderPrivateStates[id] = initializeKeyholderPrivateState(id, terms, termsHash);
        } catch (error: any) {
            console.error(`Failed to initialize private state for ${id}: ${error.message}`);
            return null; // Cannot proceed if initialization fails
        }
    }

    // Initialize shared state
    let sharedState: SimulationDKGSharedState = {
        termsHash,
        participantContributions: Object.fromEntries(
            terms.participantIds.map(id => [id, initParticipantContributionState(termsHash, id)])
        ),
        participantVerifications: Object.fromEntries(
            terms.participantIds.map(id => [id, initParticipantVerificationState(termsHash, id)])
        ),
        commonState: initCommonDKGState(termsHash)
    };

    let loopCount = 0;
    const maxLoops = n * 6; // Safety break

    console.log(`--- Starting DKG Simulation (Terms Hash: ${termsHash.substring(0, 8)}...) ---`);

    while (loopCount < maxLoops) {
        loopCount++;
        const currentStateView = createDKGStateView(terms, sharedState, termsHash);

        // Check for completion *before* processing actions in this loop
        const successfulCountPreLoop = terms.participantIds.filter(id => currentStateView.participantVerifications[id]?.verified === true).length;
        const allVerificationDonePreLoop = terms.participantIds.every(id => currentStateView.participantVerifications[id]?.verified !== undefined);
        if (isDKGComplete(currentStateView)) {
             if (allVerificationDonePreLoop && successfulCountPreLoop < threshold) {
                 console.error(`--- DKG Simulation Failed (Completed in ${loopCount - 1} loops - Insufficient successful participants: ${successfulCountPreLoop}/${threshold}) ---`);
                 return null;
             }
             if (currentStateView.commonState.compositePublicKey) {
                 console.log(`--- DKG Simulation Successful (Completed in ${loopCount - 1} loops) ---`);
                 return { terms, termsHash, finalState: sharedState, finalPrivateStates: keyholderPrivateStates };
             }
             // If somehow complete but no public key and threshold met, it implies a logic error somewhere
             console.error(`--- DKG Simulation Error (Completed state reached without public key, ${successfulCountPreLoop}/${threshold} success) ---`);
             return null;
        }

        const updatesToApply: (CommitmentsUpdate | SharesUpdate | VerificationUpdate | null)[] = [];
        let activityInLoop = false;
        const participantOrder = [...terms.participantIds].sort(() => Math.random() - 0.5); // Shuffle

        const nextKeyholderPrivateStates = { ...keyholderPrivateStates }; // Copy state for updates within the loop

        for (const participantId of participantOrder) {
            const currentPrivateState = nextKeyholderPrivateStates[participantId];
            if (!currentPrivateState || currentPrivateState.error) continue; // Skip participants in error state

            // Check if holder already definitively failed based on public verification state
            if (sharedState.participantVerifications[participantId]?.verified === false) continue;

            // computeKeyholderUpdate determines the action internally
            const computationResult: ComputationResult = computeKeyholderUpdate(
                currentPrivateState,
                terms,
                currentStateView
            );

            if (computationResult.publicUpdate) {
                 updatesToApply.push(computationResult.publicUpdate);
                 activityInLoop = true;
                 // console.log(`Loop ${loopCount}: ${participantId} produced update: ${computationResult.publicUpdate.type}`);
            }

            // Update private state for the next loop iteration
            if (computationResult.nextPrivateState) {
                nextKeyholderPrivateStates[participantId] = computationResult.nextPrivateState;
                if (computationResult.nextPrivateState.error) {
                     // If computeUpdate resulted in a fatal private error, ensure public state reflects failure if possible
                     // We can signal a verification failure if verification hasn't been posted yet
                     if (sharedState.participantVerifications[participantId]?.verified === undefined) {
                         updatesToApply.push({
                             type: DKGActionType.VerifyShares,
                             participantId: participantId,
                             payload: { verified: false, reason: `Internal compute error: ${computationResult.nextPrivateState.error}` }
                         });
                     }
                     console.warn(`Loop ${loopCount}: Participant ${participantId} entered error state: ${computationResult.nextPrivateState.error}`);
                }
            } else {
                 // Fatal error occurred, nextPrivateState is null.
                 // The private state map retains the *last valid* state before the error.
                 // Mark as failed publicly if possible.
                 if (sharedState.participantVerifications[participantId]?.verified === undefined) {
                     updatesToApply.push({
                         type: DKGActionType.VerifyShares,
                         participantId: participantId,
                         payload: { verified: false, reason: `Fatal internal compute error` }
                     });
                 }
                 console.error(`Loop ${loopCount}: Participant ${participantId} encountered fatal error during computation.`);
                 // Remove from future processing? For simulation, just let loop continue but state is marked error.
                 // If using the entry from keyholderPrivateStates, we need to update it to reflect the error.
                 // Let's keep the last valid state but mark error for check at top of loop.
                 const errorState = { ...currentPrivateState, error: currentPrivateState.error || "Fatal compute error" };
                 nextKeyholderPrivateStates[participantId] = errorState;
            }
        } // End participant loop

        // Update the main private state map after processing all participants in the loop
        keyholderPrivateStates = nextKeyholderPrivateStates;

        // Apply computed public updates to shared state
        if (updatesToApply.length > 0) {
             sharedState = applyDKGUpdates(sharedState, updatesToApply);
             // Activity already marked true if updates were generated
        }

        // --- Global State Checks and Updates --- (after applying updates)
        const updatedStateView = createDKGStateView(terms, sharedState, termsHash);

        // Check if public key can be calculated (only if not already calculated)
        if (!updatedStateView.commonState.compositePublicKey) {
            const allVerificationDone = updatedStateView.terms.participantIds.every(id =>
                updatedStateView.participantVerifications[id]?.verified !== undefined
            );
            const successfulCount = updatedStateView.terms.participantIds.filter(id =>
                updatedStateView.participantVerifications[id]?.verified === true
            ).length;

            if (allVerificationDone) { // Only calculate after all have reported verification
                 if (successfulCount >= threshold) {
                    // console.log(`All participants verified (${successfulCount} successful). Calculating public key...`);
                    const pubKey = calculateCompositePublicKey(updatedStateView);
                    if (pubKey) {
                        // Simulate update to common state
                        sharedState = {
                            ...sharedState,
                            commonState: { ...sharedState.commonState, compositePublicKey: pubKey }
                        };
                        // console.log("Public key calculated and stored.");
                        activityInLoop = true; // Calculating key counts as activity
                    } else {
                        // This indicates an issue with calculateCompositePublicKey or the input state
                        console.error("Public key calculation failed despite sufficient successful participants! DKG Process Failed.");
                        return null;
                    }
                } else {
                     // DKG has definitively failed if all reported and not enough succeeded
                     // isDKGComplete check at loop start handles this now.
                     // console.error(`DKG Failed: Only ${successfulCount} participants succeeded verification (threshold ${threshold}). All participants have reported.`);
                     // return null; // Let loop complete and check at start
                 }
            }
        }

        // Check for stall condition (no state changes occurred in this loop)
        if (!activityInLoop && loopCount > 1) {
             // Re-check completeness after potential key calculation
             const isCompleteAfterCheck = isDKGComplete(updatedStateView);
             if (!isCompleteAfterCheck) {
                  // If not complete and no activity, it's stalled
                  console.error(`--- DKG Simulation Failed (Stalled at loop ${loopCount}) ---`);
                  // console.error("Final State:", sharedState); // Optional debug log
                  return null;
             }
             // If it IS complete, the loop will terminate naturally on the next iteration's check.
        }

    } // End while loop

    // If loop finishes due to maxLoops
    if (loopCount >= maxLoops) {
        console.error("--- DKG Simulation Failed: Reached max loop count ---");
        // console.error("Final State:", sharedState); // Optional debug log
        return null;
    }

     // Should be unreachable if completion logic is correct, but as a safeguard:
     const finalViewCheck = createDKGStateView(terms, sharedState, termsHash);
     if (isDKGComplete(finalViewCheck)) {
         const finalSuccessCount = terms.participantIds.filter(id => finalViewCheck.participantVerifications[id]?.verified === true).length;
         if (finalSuccessCount >= threshold && finalViewCheck.commonState.compositePublicKey) {
            console.log(`--- DKG Simulation Successful (Completed by loop exit safeguard) ---`);
            return { terms, termsHash, finalState: sharedState, finalPrivateStates: keyholderPrivateStates };
         } else {
             console.error(`--- DKG Simulation Failed (Loop exited, complete but failed threshold check: ${finalSuccessCount}/${threshold}) ---`);
             return null;
         }
     } else {
        console.error("--- DKG Simulation Failed (Unknown reason after loop) ---");
        return null;
     }
}


// --- Main test execution ---
async function main() {
    const message = 'Hello, functional threshold world!';
    const n = 5;
    const threshold = 3;

    console.log(`\nRunning DKG Simulation: n=${n}, threshold=${threshold}`);
    const dkgResult = await runDKGSimulation(n, threshold);

    if (!dkgResult) {
        console.log("\nDKG Process failed. Exiting test.");
        process.exitCode = 1; // Indicate failure
        return;
    }

    // Use results returned from the simulation
    const { terms, termsHash, finalState, finalPrivateStates } = dkgResult;
    const finalStateView = createDKGStateView(terms, finalState, termsHash);

    // Check if DKG actually succeeded based on final state
    const successfulIds = terms.participantIds.filter(id => finalStateView.participantVerifications[id]?.verified === true);
    if (successfulIds.length < threshold || !finalStateView.commonState.compositePublicKey) {
        console.error(`Test Error: DKG simulation returned success, but final state is invalid (Success: ${successfulIds.length}/${threshold}, PK Calculated: ${!!finalStateView.commonState.compositePublicKey}).`);
         process.exitCode = 1; // Indicate failure
        return;
    }

    const compositePublicKey = finalStateView.commonState.compositePublicKey;
    console.log('\nComposite Public Key:', Buffer.from(compositePublicKey).toString('hex'));
    console.log(`Final successful participants (${successfulIds.length}):`, successfulIds.join(', '));
    console.log('\nOriginal message:', message);

    try {
        // --- Encryption Phase ---
        console.log('Encrypting data...');
        const encrypted = await encryptData(message, compositePublicKey);
        console.log('Encrypted:', Buffer.from(encrypted).toString('hex'));

        // --- Decryption Phase ---
        console.log('\nSimulating share reveal and decryption...');

        // Choose a subset of the successful ones for decryption
        const revealingIds = successfulIds.slice(0, threshold);
        console.log('Revealing shares from:', revealingIds.join(', '));

        // 1. Trigger reveal action using stateless function
         const revealUpdates: RevealShareUpdate[] = [];
         let revealError = false;
         for (const id of revealingIds) {
             const privateState = finalPrivateStates[id];
             if (!privateState || privateState.error) {
                 console.error(`Cannot reveal share for ${id}: Participant is in error state or missing.`);
                 revealError = true;
                 break; // Cannot proceed
             }
             const result = computeRevealShareUpdate(privateState);
             if (result.publicUpdate) {
                 revealUpdates.push(result.publicUpdate);
             } else {
                 console.error(`Keyholder ${id} could not compute reveal update: ${result.error}`);
                 revealError = true;
                 break; // Cannot proceed if a required share cannot be revealed
             }
         }

         if (revealError) {
             console.error("Decryption cannot proceed due to reveal error.");
              process.exitCode = 1; // Indicate failure
             return;
         }

        // 2. Apply reveal updates to the shared state (specifically commonState)
        let stateAfterReveal = applyDKGUpdates(finalState, revealUpdates);
        let viewAfterReveal = createDKGStateView(terms, stateAfterReveal, termsHash);

        // 3. Get the final share data (as bytes) from the common state's reveal map
        const revealedSharesBytes: { idNum: bigint, share: Uint8Array }[] = [];
        for (const id of revealingIds) {
            const revealedData = viewAfterReveal.commonState.revealedSharesForDecryption[id];
            if (!revealedData) {
                // This should not happen if revealUpdates were processed correctly
                throw new Error(`Critical Error: Share for ${id} not found in common state after reveal update.`);
            }
            revealedSharesBytes.push({ idNum: revealedData.idNum, share: revealedData.share });
        }

        // 4. Reconstruct the private key
        const reconstructedPrivKey = reconstructPrivateKey(revealedSharesBytes, threshold);
        // console.log('Reconstructed Private Key:', Buffer.from(reconstructedPrivKey).toString('hex')); // Optional debug log

        // 5. Decrypt the data
        const decrypted = await decryptDataWithReconstructedKey(encrypted, reconstructedPrivKey);
        console.log('Decrypted:', decrypted);

        if (decrypted !== message) {
            console.error('DECRYPTION FAILED! Result does not match original message.');
             process.exitCode = 1; // Indicate failure
        } else {
            console.log('\nDecryption successful!');
        }

    } catch (error: any) {
        console.error('\nError during crypto process:', error?.message ?? error);
         process.exitCode = 1; // Indicate failure
    }
}

main().catch(err => {
     console.error("Unhandled error in main:", err);
     process.exitCode = 1; // Indicate failure
});
