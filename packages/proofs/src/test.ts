import {
    DKGPhase,
    Keyholder,
    calculateCompositePublicKey, // Use the global calculation function
    encryptData,
    getSharesForReveal,
    reconstructPrivateKey,
    decryptDataWithReconstructedKey,
} from './threshold.js';
import type {
    DKGState,
    FinalShareData
} from './threshold.js'; // Use type imports

// Helper function to initialize DKG state
function initializeDKG(n: number, threshold: number): DKGState {
    const participantIdNums = Array.from({ length: n }, (_, i) => BigInt(i + 1));
    const participantIds = participantIdNums.map(num => `keyholder-${num}`);
    return {
        phase: DKGPhase.Init,
        n,
        threshold,
        participantIds,
        commitments: {},
        distributedShares: [],
        verificationStatus: {},
        compositePublicKey: null,
        failedParticipants: {},
    };
}

// Helper to check if all participants (not failed) have completed an action for a phase
function haveAllCompleted(state: DKGState, check: (id: string) => boolean): boolean {
    return state.participantIds
        .filter(id => !state.failedParticipants?.[id]) // Ignore failed participants
        .every(check);
}

// Simulation Runner
async function runDKGSimulation(n: number, threshold: number): Promise<{ finalState: DKGState, keyholders: Keyholder[] } | null> {
    const keyholders = Array.from({ length: n }, (_, i) => new Keyholder(i + 1, n, threshold));
    let state = initializeDKG(n, threshold);

    let activeKeyholders = [...keyholders];
    let actionsTakenInLoop = 0;
    const maxLoops = n * 5; // Safety break for infinite loops
    let loopCount = 0;

    console.log("--- Starting DKG Simulation ---");

    while (state.phase !== DKGPhase.Complete && state.phase !== DKGPhase.Failed && loopCount < maxLoops) {
        actionsTakenInLoop = 0;
        loopCount++;
        // console.log(`\nLoop ${loopCount}: Current Phase: ${DKGPhase[state.phase]}`);

        // Simulate shuffling order of keyholders acting
        activeKeyholders.sort(() => Math.random() - 0.5);

        let nextState = {
            ...state,
            // Deep copy objects/arrays that will be mutated in the loop
            commitments: { ...state.commitments },
            distributedShares: [...state.distributedShares],
            verificationStatus: { ...state.verificationStatus },
            failedParticipants: { ...state.failedParticipants },
        };

        for (const holder of activeKeyholders) {
            if (state.failedParticipants?.[holder.id]) continue; // Skip failed holders

            const requiredActionPhase = holder.getNextAction(state);

            if (requiredActionPhase === null) continue; // Holder doesn't need to act now

            // Check if the holder's required action matches the *expected* next step for the current global phase
            let expectedActionPhase: DKGPhase | null = null;
            switch(state.phase) {
                case DKGPhase.Init: expectedActionPhase = DKGPhase.Commitment; break;
                case DKGPhase.Commitment: expectedActionPhase = DKGPhase.Commitment; break; // Still posting commitments
                case DKGPhase.ShareDistribution: expectedActionPhase = DKGPhase.ShareDistribution; break; // Still posting shares
                case DKGPhase.VerificationAndFinalShare: expectedActionPhase = DKGPhase.VerificationAndFinalShare; break; // Still verifying
            }

            if (requiredActionPhase !== expectedActionPhase) {
                 // Holder wants to do something not matching current global phase focus
                 // console.log(`${holder.id} wants ${DKGPhase[requiredActionPhase]}, phase is ${DKGPhase[state.phase]}`);
                 continue;
            }

             // console.log(`${holder.id} taking action for phase ${DKGPhase[requiredActionPhase]}...`);
             actionsTakenInLoop++;

            try {
                switch (requiredActionPhase) {
                    case DKGPhase.Commitment:
                        const commitment = holder.performCommitmentPhase();
                        nextState.commitments[holder.id] = commitment;
                        break;

                    case DKGPhase.ShareDistribution:
                        const shares = holder.performShareDistributionPhase(state); // Pass immutable state
                        // Update state atomically (simulated) - append new shares
                        // Avoid duplicates if action is somehow run twice by mistake
                        const existingShareIds = new Set(nextState.distributedShares.map(s => `${s.sourceId}->${s.targetId}`));
                        const newShares = shares.filter(s => !existingShareIds.has(`${s.sourceId}->${s.targetId}`));
                        if (newShares.length > 0) {
                             nextState.distributedShares.push(...newShares);
                        }
                        break;

                    case DKGPhase.VerificationAndFinalShare:
                        const verificationResult = holder.performVerificationAndFinalSharePhase(state); // Pass immutable state
                        // Only record status if not already present
                        if (nextState.verificationStatus[holder.id] === undefined) {
                             nextState.verificationStatus[holder.id] = verificationResult.status;
                             if (!verificationResult.status) {
                                 console.warn(`${holder.id} failed verification. Reason: ${verificationResult.failureReason}`);
                                 nextState.failedParticipants[holder.id] = verificationResult.failureReason ?? "Verification failed";
                             }
                        }
                        break;
                     default:
                         console.warn(`${holder.id} requested unhandled action ${DKGPhase[requiredActionPhase]}`);

                }
            } catch (error: any) {
                console.error(`Error during action for ${holder.id} in phase ${DKGPhase[requiredActionPhase]}:`, error);
                 nextState.failedParticipants[holder.id] = error.message ?? "Runtime error";
                 // Ensure verification status reflects failure if error occurred during verification phase
                 if (requiredActionPhase === DKGPhase.VerificationAndFinalShare) {
                    nextState.verificationStatus[holder.id] = false;
                 }
            }
        } // End keyholder loop

        // --- State Transition Logic ---
        let advancedPhase = false;
        const currentPhase = state.phase; // Base decision on state *before* loop actions
        const potentialNextState = nextState; // Use the state potentially modified by loop actions

        if (currentPhase === DKGPhase.Init && Object.keys(potentialNextState.commitments).length > 0) {
             potentialNextState.phase = DKGPhase.Commitment;
             advancedPhase = true;
             console.log(`Advancing to Phase: ${DKGPhase[potentialNextState.phase]}`);
        }
        else if (currentPhase === DKGPhase.Commitment) {
            if (haveAllCompleted(potentialNextState, id => !!potentialNextState.commitments[id])) {
                potentialNextState.phase = DKGPhase.ShareDistribution;
                advancedPhase = true;
                 console.log(`Advancing to Phase: ${DKGPhase[potentialNextState.phase]}`);
            }
        }
        else if (currentPhase === DKGPhase.ShareDistribution) {
             const expectedShares = potentialNextState.participantIds.filter(id => !potentialNextState.failedParticipants?.[id]).length * n;
             const uniqueShares = new Set(potentialNextState.distributedShares.map(s => `${s.sourceId}`)).size * n; // Count shares per source
             if (potentialNextState.distributedShares.length >= expectedShares) {
                 console.log(`Advancing to Phase: ${DKGPhase[DKGPhase.VerificationAndFinalShare]}`);
                 potentialNextState.phase = DKGPhase.VerificationAndFinalShare;
                 advancedPhase = true;
             }
        }
        else if (currentPhase === DKGPhase.VerificationAndFinalShare) {
             if (haveAllCompleted(potentialNextState, id => potentialNextState.verificationStatus[id] !== undefined)) {
                 const successfulCount = Object.keys(potentialNextState.verificationStatus).filter(id => potentialNextState.verificationStatus[id] === true).length;

                 if (successfulCount < threshold) {
                     console.error(`DKG Failed: Only ${successfulCount} participants succeeded verification (threshold ${threshold}).`);
                     potentialNextState.phase = DKGPhase.Failed;
                 } else {
                     console.log(`Verification complete (${successfulCount} successful). Advancing to Public Key Calculation.`);
                     potentialNextState.phase = DKGPhase.PublicKeyCalculation;
                 }
                  advancedPhase = true;
             }
        }
        else if (currentPhase === DKGPhase.PublicKeyCalculation) {
             const pubKey = calculateCompositePublicKey(potentialNextState); // Pass immutable state
             if (pubKey) {
                 potentialNextState.compositePublicKey = pubKey;
                 potentialNextState.phase = DKGPhase.Complete;
                 console.log("DKG Complete. Composite Public Key available.");
             } else {
                 console.error("DKG Failed: Could not calculate composite public key.");
                 potentialNextState.phase = DKGPhase.Failed;
                 potentialNextState.failedParticipants = {...potentialNextState.failedParticipants, system: "PubKey Calc Failed" };
             }
             advancedPhase = true;
        }

        // Update the main state for the next loop
        state = potentialNextState;

        if (state.phase === DKGPhase.Failed) {
            console.error("--- DKG Simulation Failed --- Rerun with logs for details --- ");
            // console.error("Failure Reasons:", state.failedParticipants);
            return null;
        }
         if (state.phase === DKGPhase.Complete) {
            console.log("--- DKG Simulation Successful ---");
            return { finalState: state, keyholders };
        }

        if (!advancedPhase && actionsTakenInLoop === 0 && loopCount > 1) {
             console.warn("Simulation stalled. No actions taken and phase did not advance.");
             state.phase = DKGPhase.Failed;
             state.failedParticipants = { ...state.failedParticipants, system: "Stalled" };
             return null;
        }

    } // End while loop

     if (loopCount >= maxLoops) {
         console.error("--- DKG Simulation Failed: Reached max loop count --- Rerun with logs for details ---");
         state.phase = DKGPhase.Failed;
         state.failedParticipants = { ...state.failedParticipants, system: "Max loops reached" };
         return null;
     }

    // Should not be reached
    return null;
}


// Main test execution
async function main() {
    const message = 'Hello, secure threshold world!';
    const n = 5;
    const threshold = 3;

    console.log(`Running DKG Simulation: n=${n}, threshold=${threshold}`);
    const dkgResult = await runDKGSimulation(n, threshold);

    if (!dkgResult) {
        console.log("\nDKG Process failed. Exiting test.");
        return;
    }

    const { finalState, keyholders } = dkgResult;

    if (!finalState.compositePublicKey) {
        console.error("Test Error: DKG reported complete but no public key found.");
        return;
    }

    console.log('\nComposite Public Key:', Buffer.from(finalState.compositePublicKey).toString('hex'));
    const successfulIds = keyholders
                                .filter(h => finalState.verificationStatus[h.id] === true)
                                .map(h => h.id);
    console.log(`Final successful participants (${successfulIds.length}):`, successfulIds.join(', '));

    console.log('\nOriginal message:', message);

    try {
        // --- Encryption Phase ---
        console.log('Encrypting data...');
        const encrypted = await encryptData(message, finalState.compositePublicKey);
        console.log('Encrypted:', Buffer.from(encrypted).toString('hex'));

        // --- Decryption Phase ---
        console.log('\nSimulating share reveal and decryption...');

        // Select a subset of *successful* keyholders to reveal shares
        if (successfulIds.length < threshold) {
             console.error(`Cannot proceed to decryption: Not enough successful participants (${successfulIds.length} < ${threshold})`);
             return;
        }

        // Choose a subset of the successful ones
        const revealingIds = successfulIds.slice(0, threshold);
        console.log('Revealing shares from:', revealingIds.join(', '));

        // 1. Get the final share data from the chosen keyholders
        const finalShareDataForReveal: FinalShareData[] = [];
        for(const id of revealingIds) {
            const holder = keyholders.find(h => h.id === id);
            const shareData = holder?.getFinalShareData(); // Retrieve final share
            if (shareData) {
                finalShareDataForReveal.push(shareData);
            } else {
                 // This should only happen if a keyholder failed verification but was somehow included
                 console.error(`Could not retrieve final share data for successful participant ${id}`);
                 return;
            }
        }

        // 2. Prepare shares in the format needed for reconstruction
        const sharesToReveal = getSharesForReveal(finalShareDataForReveal, revealingIds, threshold);

        // 3. Reconstruct the private key
        const reconstructedPrivKey = reconstructPrivateKey(sharesToReveal, threshold);
        console.log('Reconstructed Private Key:', Buffer.from(reconstructedPrivKey).toString('hex'));

        // 4. Decrypt the data
        const decrypted = await decryptDataWithReconstructedKey(encrypted, reconstructedPrivKey);
        console.log('Decrypted:', decrypted);

        if (decrypted !== message) {
            console.error('DECRYPTION FAILED! Result does not match original message.');
        } else {
            console.log('\nDecryption successful!');
        }

    } catch (error) {
        console.error('\nError during crypto process:', error);
    }
}

main().catch(console.error);
