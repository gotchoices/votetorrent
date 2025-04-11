import { Buffer } from 'buffer';
import {
	initParticipantContributionState, initParticipantVerificationState, initCommonDKGState,
	DKGActionType, calculateCompositePublicKey, encryptData, reconstructPrivateKey, decryptDataWithReconstructedKey,
	initializeKeyholderPrivateState, computeKeyholderUpdate, computeRevealShareUpdate, genDKGTerms
} from '../src/index.js';
import type {
	DKGStateView, ParticipantContributionState, ParticipantVerificationState,
	CommonDKGState, CommitmentsUpdate, SharesUpdate, VerificationUpdate, RevealShareUpdate,
	KeyholderPrivateState, ComputationResult, DKGDeal
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
function createDKGStateView(deal: Readonly<DKGDeal>, sharedState: SimulationDKGSharedState): DKGStateView {
	if (sharedState.termsHash !== deal.termsHash) {
		// Keep critical error throws for simulation setup issues
		throw new Error("Mismatched terms hash in shared state!");
	}
	// Ensure consistency between sharedState hash and dkgId hash
	if (sharedState.termsHash !== deal.termsHash) {
		throw new Error("Internal Inconsistency: Shared state termsHash does not match DKGIdentifier termsHash.")
	}
	return {
		deal, // Pass the identifier
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
	// Access terms via stateView.deal.terms
	const n = stateView.deal.terms.participantIds.length;
	const threshold = stateView.deal.terms.threshold;

	// Phase 1 Done?
	const allCommitmentsPosted = stateView.deal.terms.participantIds.every(id =>
		!!stateView.participantContributions[id]?.commitments
	);
	if (!allCommitmentsPosted) return false;

	// Phase 2 Done?
	const allSharesPosted = stateView.deal.terms.participantIds.every(id =>
		(stateView.participantContributions[id]?.distributedShares?.length ?? 0) === n
	);
	if (!allSharesPosted) return false;

	// Phase 3 Done?
	const allVerificationDone = stateView.deal.terms.participantIds.every(id =>
		stateView.participantVerifications[id]?.verified !== undefined
	);
	if (!allVerificationDone) return false;

	// Enough participants succeeded verification?
	const successfulCount = stateView.deal.terms.participantIds.filter(id =>
		stateView.participantVerifications[id]?.verified === true
	).length;

	// If all verifications are done, but not enough succeeded, the DKG has failed.
	if (allVerificationDone && successfulCount < threshold) return true;

	// Phase 4 Done? Public key calculated
	if (!stateView.commonState.compositePublicKey) return false;

	return true;
}

// Return type reflects stateless change
async function runDKGSimulation(n: number, threshold: number): Promise<{
	deal: DKGDeal, // Return the identifier
	finalState: SimulationDKGSharedState,
	finalPrivateStates: Record<string, KeyholderPrivateState>
} | null> {

	// createDKGTerms now returns DKGIdentifier
	const deal = await genDKGTerms(n, threshold);

	// Initialize private states for each participant
	let keyholderPrivateStates: Record<string, KeyholderPrivateState> = {};
	for (const id of deal.terms.participantIds) {
		try {
			// Pass dkgId to initializeKeyholderPrivateState
			keyholderPrivateStates[id] = initializeKeyholderPrivateState(id, deal);
		} catch (error: any) {
			console.error(`Failed to initialize private state for ${id}: ${error.message}`);
			return null; // Cannot proceed if initialization fails
		}
	}

	// Initialize shared state using termsHash from dkgId
	let sharedState: SimulationDKGSharedState = {
		termsHash: deal.termsHash,
		participantContributions: Object.fromEntries(
			deal.terms.participantIds.map(id => [id, initParticipantContributionState(deal.termsHash, id)])
		),
		participantVerifications: Object.fromEntries(
			deal.terms.participantIds.map(id => [id, initParticipantVerificationState(deal.termsHash, id)])
		),
		commonState: initCommonDKGState(deal.termsHash)
	};

	let loopCount = 0;
	const maxLoops = n * 6; // Safety break

	console.log(`--- Starting DKG Simulation (Terms Hash: ${deal.termsHash.substring(0, 8)}...) ---`);

	while (loopCount < maxLoops) {
		loopCount++;
		// Pass dkgId to createDKGStateView
		const currentStateView = createDKGStateView(deal, sharedState);

		// Check for completion *before* processing actions in this loop
		const successfulCountPreLoop = deal.terms.participantIds.filter(id => currentStateView.participantVerifications[id]?.verified === true).length;
		const allVerificationDonePreLoop = deal.terms.participantIds.every(id => currentStateView.participantVerifications[id]?.verified !== undefined);
		if (isDKGComplete(currentStateView)) {
			if (allVerificationDonePreLoop && successfulCountPreLoop < threshold) {
				console.error(`--- DKG Simulation Failed (Completed in ${loopCount - 1} loops - Insufficient successful participants: ${successfulCountPreLoop}/${threshold}) ---`);
				return null;
			}
			if (currentStateView.commonState.compositePublicKey) {
				console.log(`--- DKG Simulation Successful (Completed in ${loopCount - 1} loops) ---`);
				// Return dkgId
				return { deal: deal, finalState: sharedState, finalPrivateStates: keyholderPrivateStates };
			}
			console.error(`--- DKG Simulation Error (Completed state reached without public key, ${successfulCountPreLoop}/${threshold} success) ---`);
			return null;
		}

		const updatesToApply: (CommitmentsUpdate | SharesUpdate | VerificationUpdate | null)[] = [];
		let activityInLoop = false;
		// Use participantIds from dkgId
		const participantOrder = [...deal.terms.participantIds].sort(() => Math.random() - 0.5);

		const nextKeyholderPrivateStates = { ...keyholderPrivateStates };

		for (const participantId of participantOrder) {
			const currentPrivateState = nextKeyholderPrivateStates[participantId];
			if (!currentPrivateState || currentPrivateState.error) continue;
			if (sharedState.participantVerifications[participantId]?.verified === false) continue;

			// Pass dkgId to computeKeyholderUpdate
			const computationResult: ComputationResult = computeKeyholderUpdate(
				currentPrivateState,
				deal,
				currentStateView
			);

			if (computationResult.publicUpdate) {
				updatesToApply.push(computationResult.publicUpdate);
				activityInLoop = true;
			}

			// Update private state
			if (computationResult.nextPrivateState) {
				nextKeyholderPrivateStates[participantId] = computationResult.nextPrivateState;
				if (computationResult.nextPrivateState.error) {
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
				if (sharedState.participantVerifications[participantId]?.verified === undefined) {
					updatesToApply.push({
						type: DKGActionType.VerifyShares,
						participantId: participantId,
						payload: { verified: false, reason: `Fatal internal compute error` }
					});
				}
				console.error(`Loop ${loopCount}: Participant ${participantId} encountered fatal error during computation.`);
				const errorState = { ...currentPrivateState, error: currentPrivateState.error || "Fatal compute error" };
				nextKeyholderPrivateStates[participantId] = errorState;
			}
		} // End participant loop

		keyholderPrivateStates = nextKeyholderPrivateStates;

		if (updatesToApply.length > 0) {
			sharedState = applyDKGUpdates(sharedState, updatesToApply);
		}

		// Pass dkgId to createDKGStateView
		const updatedStateView = createDKGStateView(deal, sharedState);

		// Global state checks
		if (!updatedStateView.commonState.compositePublicKey) {
			// Use participantIds from dkgId
			const allVerificationDone = deal.terms.participantIds.every(id =>
				updatedStateView.participantVerifications[id]?.verified !== undefined
			);
			const successfulCount = deal.terms.participantIds.filter(id =>
				updatedStateView.participantVerifications[id]?.verified === true
			).length;

			if (allVerificationDone) {
				if (successfulCount >= threshold) {
					// Pass updatedStateView which contains dkgId
					const pubKey = calculateCompositePublicKey(updatedStateView);
					if (pubKey) {
						sharedState = {
							...sharedState,
							commonState: { ...sharedState.commonState, compositePublicKey: pubKey }
						};
						activityInLoop = true;
					} else {
						console.error("Public key calculation failed despite sufficient successful participants! DKG Process Failed.");
						return null;
					}
				} // else: Failed threshold handled by isDKGComplete
			}
		}

		// Stall check
		if (!activityInLoop && loopCount > 1) {
			// Pass updatedStateView
			const isCompleteAfterCheck = isDKGComplete(updatedStateView);
			if (!isCompleteAfterCheck) {
				console.error(`--- DKG Simulation Failed (Stalled at loop ${loopCount}) ---`);
				return null;
			}
		}

	} // End while loop

	if (loopCount >= maxLoops) {
		console.error("--- DKG Simulation Failed: Reached max loop count ---");
		return null;
	}

	// Safeguard check
	const finalViewCheck = createDKGStateView(deal, sharedState);
	if (isDKGComplete(finalViewCheck)) {
		// Use participantIds from dkgId
		const finalSuccessCount = deal.terms.participantIds.filter(id => finalViewCheck.participantVerifications[id]?.verified === true).length;
		if (finalSuccessCount >= threshold && finalViewCheck.commonState.compositePublicKey) {
			console.log(`--- DKG Simulation Successful (Completed by loop exit safeguard) ---`);
			// Return dkgId
			return { deal: deal, finalState: sharedState, finalPrivateStates: keyholderPrivateStates };
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

	// Use dkgId from result
	const { deal: dkgId, finalState, finalPrivateStates } = dkgResult;
	// Pass dkgId to createDKGStateView
	const finalStateView = createDKGStateView(dkgId, finalState);

	// Check success using dkgId
	const successfulIds = dkgId.terms.participantIds.filter(id => finalStateView.participantVerifications[id]?.verified === true);
	if (successfulIds.length < threshold || !finalStateView.commonState.compositePublicKey) {
		console.error(`Test Error: DKG simulation returned success, but final state is invalid (Success: ${successfulIds.length}/${threshold}, PK Calculated: ${!!finalStateView.commonState.compositePublicKey}).`);
		process.exitCode = 1;
		return;
	}

	const compositePublicKey = finalStateView.commonState.compositePublicKey;
	console.log('\nComposite Public Key:', Buffer.from(compositePublicKey).toString('base64url'));
	console.log(`Final successful participants (${successfulIds.length}):`, successfulIds.join(', '));
	console.log('\nOriginal message:', message);

	try {
		// --- Encryption Phase ---
		console.log('Encrypting data...');
		const encrypted = await encryptData(message, compositePublicKey);
		console.log('Encrypted:', Buffer.from(encrypted).toString('base64url'));

		// --- Decryption Phase ---
		console.log('\nSimulating share reveal and decryption...');
		const revealingIds = successfulIds.slice(0, threshold);
		console.log('Revealing shares from:', revealingIds.join(', '));

		// Reveal shares
		const revealUpdates: RevealShareUpdate[] = [];
		let revealError = false;
		for (const id of revealingIds) {
			const privateState = finalPrivateStates[id];
			if (!privateState || privateState.error) {
				console.error(`Cannot reveal share for ${id}: Participant is in error state or missing.`);
				revealError = true;
				break;
			}
			const result = computeRevealShareUpdate(privateState);
			if (result.publicUpdate) {
				revealUpdates.push(result.publicUpdate);
			} else {
				console.error(`Keyholder ${id} could not compute reveal update: ${result.error}`);
				revealError = true;
				break;
			}
		}
		if (revealError) {
			console.error("Decryption cannot proceed due to reveal error.");
			process.exitCode = 1;
			return;
		}

		// Apply updates
		let stateAfterReveal = applyDKGUpdates(finalState, revealUpdates);
		// Pass dkgId to create view
		let viewAfterReveal = createDKGStateView(dkgId, stateAfterReveal);

		// Get revealed shares from updated view
		const revealedSharesBytes: { idNum: bigint, share: Uint8Array }[] = [];
		for (const id of revealingIds) {
			const revealedData = viewAfterReveal.commonState.revealedSharesForDecryption[id];
			if (!revealedData) {
				throw new Error(`Critical Error: Share for ${id} not found in common state after reveal update.`);
			}
			revealedSharesBytes.push({ idNum: revealedData.idNum, share: revealedData.share });
		}

		// Reconstruct key
		// Pass threshold from dkgId
		const reconstructedPrivKey = reconstructPrivateKey(revealedSharesBytes, dkgId.terms.threshold);

		// Decrypt
		const decrypted = await decryptDataWithReconstructedKey(encrypted, reconstructedPrivKey);
		console.log('Decrypted:', decrypted);

		if (decrypted !== message) {
			console.error('DECRYPTION FAILED! Result does not match original message.');
			process.exitCode = 1;
		} else {
			console.log('\nDecryption successful!');
		}

	} catch (error: any) {
		console.error('\nError during crypto process:', error?.message ?? error);
		process.exitCode = 1;
	}
}

main().catch(err => {
	console.error("Unhandled error in main:", err);
	process.exitCode = 1;
});
