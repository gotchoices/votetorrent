import { ProjectivePoint as Point, utils, CURVE } from '@noble/secp256k1';
import type { DKGDeal } from './dkg-terms.js';
import type { DKGStateView } from './dkg-state.js';
import type { KeyholderCommitments, EncryptedShare, FinalShareData } from './internal-types.js';
import { DKGActionType } from './dkg-actions.js';
import type { DeterminedAction, CommitmentsUpdate, SharesUpdate, VerificationUpdate, PostCommitmentsPayload, PostSharesPayload, VerifySharesPayload, RevealSharePayload, RevealShareUpdate } from './dkg-actions.js';
import { evaluatePolynomial } from './helpers.js';

const G = Point.BASE;

/** Represents the private state of a single keyholder participant. */
export interface KeyholderPrivateState {
	readonly id: string; // The user-provided arbitrary ID
	readonly idNum: bigint; // Derived 1-based index for polynomial evaluation
	readonly termsHash: string; // Store hash for consistency checks
	polynomial: bigint[] | null; // Secret polynomial coefficients
	verifiedReceivedShares: Map<string, bigint> | null; // sourceId -> shareValue
	computedFinalShare: FinalShareData | null;
	error: string | null; // Records any fatal error for this keyholder
}

/**
 * Initializes the private state for a keyholder.
 * @param keyholderId The participant's unique string ID.
 * @param deal The DKG identifier (terms and hash).
 * @returns Initialized private state.
 * @throws Error if keyholderId is not found in terms.
 */
export function initializeKeyholderPrivateState(keyholderId: string, deal: Readonly<DKGDeal>): KeyholderPrivateState {
	const index = deal.terms.participantIds.indexOf(keyholderId);
	if (index === -1) {
		throw new Error(`ID ${keyholderId} not found in DKG terms participant list.`);
	}
	const idNum = BigInt(index + 1); // 1-based index

	return {
		id: keyholderId,
		idNum: idNum,
		termsHash: deal.termsHash, // Store the hash from the identifier
		polynomial: null,
		verifiedReceivedShares: null,
		computedFinalShare: null,
		error: null,
	};
}

/**
 * Analyzes the public DKG state and determines the next required action for a specific keyholder.
 * This function is read-only regarding private state.
 * @param keyholderId The ID of the keyholder.
 * @param deal The DKG identifier (terms and hash).
 * @param stateView The current public view of the DKG state.
 * @returns The next action the keyholder should perform.
 */
export function determineKeyholderAction(
	keyholderId: string,
	deal: Readonly<DKGDeal>,
	stateView: DKGStateView
): DeterminedAction {
	// Basic checks
	if (stateView.deal.termsHash !== deal.termsHash) {
		return { type: DKGActionType.NoAction, reason: "Terms hash mismatch" };
	}
	if (!deal.terms.participantIds.includes(keyholderId)) {
		return { type: DKGActionType.NoAction, reason: `Keyholder ${keyholderId} not in terms` };
	}

	const myContribution = stateView.participantContributions[keyholderId];
	const myVerification = stateView.participantVerifications[keyholderId];
	const n = deal.terms.participantIds.length;

	// Phase 1: Commitments
	if (!myContribution?.commitments) {
		return { type: DKGActionType.PostCommitments };
	}

	// Phase 2: Share Distribution
	const allCommitmentsPosted = deal.terms.participantIds.every(id => !!stateView.participantContributions[id]?.commitments);
	if (!allCommitmentsPosted) {
		return { type: DKGActionType.NoAction, reason: "Waiting for all commitments" };
	}
	if (!myContribution?.distributedShares || myContribution.distributedShares.length < n) {
		return { type: DKGActionType.PostShares };
	}

	// Phase 3: Verification
	const allSharesPosted = deal.terms.participantIds.every(id =>
		(stateView.participantContributions[id]?.distributedShares?.length ?? 0) === n
	);
	if (!allSharesPosted) {
		return { type: DKGActionType.NoAction, reason: "Waiting for all shares" };
	}
	if (myVerification === undefined || myVerification.verified === undefined) {
		return { type: DKGActionType.VerifyShares };
	}

	// DKG Complete (from this keyholder's perspective for state progression)
	return { type: DKGActionType.NoAction, reason: "DKG protocol complete for this keyholder" };
}

// --- Internal Helper: Verify a single received share ---
/**
 * Verifies a received share against the sender's commitments.
 * @param myIdNum The numeric ID (1-based index) of the recipient keyholder.
 * @param share The encrypted share received.
 * @param senderCommitments The commitments posted by the sender.
 * @returns A validation failure reason, or undefined if validation passes.
 */
function verifyReceivedShare(
	myIdNum: bigint,
	share: EncryptedShare,
	senderCommitments: KeyholderCommitments
): string | undefined {
	const t = senderCommitments.commitments.length; // Degree + 1 = Threshold
	const shareValue_sij = share.encryptedShare; // Assuming decryption happens elsewhere or is simulated

	try {
		const lhs = G.multiply(shareValue_sij);
		let rhs = Point.ZERO;
		let jPowerK = 1n; // j^k where j is myIdNum

		for (let k = 0; k < t; k++) {
			const commitment_Cik_bytes = senderCommitments.commitments[k];
			if (!commitment_Cik_bytes) {
				// This indicates malformed state, should ideally not happen if state validation is good
				return `Missing commitment data for k=${k}`; // Missing commitment data
			}

			let commitment_Cik_point: Point;
			try {
				commitment_Cik_point = Point.fromHex(commitment_Cik_bytes); // C_ik = G*a_ik
				// Basic validity check
				if (!commitment_Cik_point.x || !commitment_Cik_point.y || commitment_Cik_point.equals(Point.ZERO)) {
					throw new Error('Invalid point coordinates or zero point');
				}
				commitment_Cik_point.assertValidity(); // Throws if not on curve
			} catch (e) {
				// Invalid point data from sender
				return `Invalid commitment data for k=${k}: ${e}`;
			}

			const termPoint = commitment_Cik_point.multiply(jPowerK);
			rhs = rhs.add(termPoint);
			jPowerK = (jPowerK * myIdNum) % CURVE.n;
		}

		return lhs.equals(rhs) ? undefined : 'Share does not match commitment';

	} catch (error) {
		// Error during cryptographic operation usually means bad input
		return `Validation error: ${error}`;
	}
}


/** Return type for computeKeyholderUpdate */
export interface ComputationResult {
	/** The update to be applied to the public/shared DKG state, if any. */
	publicUpdate: CommitmentsUpdate | SharesUpdate | VerificationUpdate | null;
	/** The next private state for the keyholder. Null if a fatal error occurred. */
	nextPrivateState: KeyholderPrivateState | null;
	/** Optional reason, e.g., for verification failure */
	reason?: string;
}


/**
 * Performs the computation for the keyholder's next action based on the current state view.
 * Determines the action internally if not provided.
 * Returns the data needed to update the shared state and the keyholder's next private state.
 * This function is designed to be stateless regarding side effects.
 * @param currentPrivateState The keyholder's current private state.
 * @param deal The DKG identifier (terms and hash).
 * @param stateView The current public view of the DKG state.
 * @param action Optional: The predetermined action to compute. If not provided, it's determined internally.
 * @returns A ComputationResult containing the public update and the next private state.
 */
export function computeKeyholderUpdate(
	currentPrivateState: KeyholderPrivateState,
	deal: Readonly<DKGDeal>,
	stateView: DKGStateView,
	action?: DeterminedAction
): ComputationResult {

	let nextPrivateState = { ...currentPrivateState }; // Start with a copy

	// --- Pre-computation Checks --- Access terms via dkgId.terms
	if (nextPrivateState.error) {
		return { publicUpdate: null, nextPrivateState }; // Already in fatal error state
	}
	if (stateView.deal.termsHash !== nextPrivateState.termsHash || stateView.deal.termsHash !== deal.termsHash) {
		// Check against both private state and provided dkgId for consistency
		nextPrivateState.error = "Term hash mismatch";
		return { publicUpdate: null, nextPrivateState: null }; // Fatal error
	}
	if (!deal.terms.participantIds.includes(nextPrivateState.id)) {
		nextPrivateState.error = `Keyholder ${nextPrivateState.id} not found in terms`;
		return { publicUpdate: null, nextPrivateState: null }; // Fatal error
	}

	// Use dkgId for determining action
	const determinedAction = action ?? determineKeyholderAction(nextPrivateState.id, deal, stateView);

	if (determinedAction.type === DKGActionType.NoAction) {
		return { publicUpdate: null, nextPrivateState }; // No action needed or possible yet
	}

	// --- Perform Computation based on Action --- Access terms/threshold via dkgId.terms
	try {
		switch (determinedAction.type) {
			case DKGActionType.PostCommitments: {
				if (nextPrivateState.polynomial) {
					return { publicUpdate: null, nextPrivateState };
				}
				const poly = [];
				for (let k = 0; k < deal.terms.threshold; k++) { // Use dkgId.terms.threshold
					const coeffBytes = utils.randomPrivateKey();
					const coeff = utils.normPrivateKeyToScalar(coeffBytes);
					poly.push(coeff);
				}
				nextPrivateState.polynomial = poly;
				const commitmentsBytes = poly.map(coeff => G.multiply(coeff).toRawBytes(true));
				const payload: PostCommitmentsPayload = {
					commitments: {
						id: nextPrivateState.id,
						idNum: nextPrivateState.idNum,
						commitments: commitmentsBytes
					}
				};
				const publicUpdate: CommitmentsUpdate = { type: DKGActionType.PostCommitments, participantId: nextPrivateState.id, payload };
				return { publicUpdate, nextPrivateState };
			}

			case DKGActionType.PostShares: {
				if (!nextPrivateState.polynomial) {
					nextPrivateState.error = "Polynomial not available for share calculation";
					return { publicUpdate: null, nextPrivateState: null };
				}
				// Check if already computed/posted in stateView
				if (stateView.participantContributions[nextPrivateState.id]?.distributedShares?.length === deal.terms.participantIds.length) {
					return { publicUpdate: null, nextPrivateState };
				}
				const shares: EncryptedShare[] = [];
				for (let i = 0; i < deal.terms.participantIds.length; i++) { // Use dkgId.terms
					const targetId = deal.terms.participantIds[i]!;
					const targetIdNum = BigInt(i + 1);
					const shareValue = evaluatePolynomial(nextPrivateState.polynomial, targetIdNum);
					shares.push({
						sourceId: nextPrivateState.id,
						targetId: targetId,
						encryptedShare: shareValue
					});
				}
				// Optional: discard polynomial
				const payload: PostSharesPayload = { shares };
				const publicUpdate: SharesUpdate = { type: DKGActionType.PostShares, participantId: nextPrivateState.id, payload };
				return { publicUpdate, nextPrivateState };
			}

			case DKGActionType.VerifyShares: {
				if (nextPrivateState.verifiedReceivedShares) {
					return { publicUpdate: null, nextPrivateState };
				}
				const allCommitments = stateView.participantContributions;
				// Use dkgId.terms for participant list
				const allDistributedShares: EncryptedShare[] = deal.terms.participantIds.flatMap(pid =>
					stateView.participantContributions[pid]?.distributedShares ?? []
				);
				const sharesForMe = allDistributedShares.filter(s => s.targetId === nextPrivateState.id);

				if (sharesForMe.length !== deal.terms.participantIds.length) {
					return { publicUpdate: null, nextPrivateState, reason: "Waiting for all shares to arrive" };
				}
				let allValid = true;
				let failureReason: string | undefined = undefined;
				const verifiedMap = new Map<string, bigint>();
				for (const receivedShare of sharesForMe) {
					const senderCommitments = allCommitments[receivedShare.sourceId]?.commitments;
					if (!senderCommitments) {
						allValid = false;
						failureReason = `Missing commitments from sender ${receivedShare.sourceId}`;
						break;
					}
					const failure = verifyReceivedShare(nextPrivateState.idNum, receivedShare, senderCommitments);
					if (failure) {
						allValid = false;
						failureReason = `${failure} from sender ${receivedShare.sourceId}`;
						break;
					} else {
						verifiedMap.set(receivedShare.sourceId, receivedShare.encryptedShare);
					}
				}
				const payload: VerifySharesPayload = { verified: allValid, reason: failureReason };
				const publicUpdate: VerificationUpdate = { type: DKGActionType.VerifyShares, participantId: nextPrivateState.id, payload };
				if (allValid) {
					nextPrivateState.verifiedReceivedShares = verifiedMap;
					nextPrivateState.computedFinalShare = computeFinalShare(
						nextPrivateState.id,
						nextPrivateState.idNum,
						nextPrivateState.verifiedReceivedShares
					);
				} else {
					nextPrivateState.verifiedReceivedShares = null;
					nextPrivateState.computedFinalShare = null;
				}
				return { publicUpdate, nextPrivateState, reason: failureReason };
			}
		}
	} catch (error: any) {
		// Catch unexpected errors during computation
		// Use determinedAction.type if possible, otherwise a generic message
		const actionType = (determinedAction as any)?.type || 'unknown action';
		nextPrivateState.error = `Computation error during ${actionType}: ${error?.message ?? error}`;
		return { publicUpdate: null, nextPrivateState: null }; // Fatal error
	}

	// This part should be unreachable because all actions (including NoAction)
	// are handled above. If we reach here, it's an internal logic error.
	nextPrivateState.error = `Internal error: Reached end of computeKeyholderUpdate for action type ${(determinedAction as any)?.type}`;
	return { publicUpdate: null, nextPrivateState: null };
}


/**
 * Computes the final share S_j = sum_i(P_i(j)) using verified shares.
 * @param keyholderId The participant's unique string ID.
 * @param idNum The participant's numeric ID (1-based index).
 * @param verifiedShares Map of verified shares received by this participant.
 * @returns The computed final share data, or null if input is invalid.
 */
function computeFinalShare(
	keyholderId: string,
	idNum: bigint,
	verifiedShares: Map<string, bigint> | null
): FinalShareData | null {
	if (!verifiedShares || verifiedShares.size === 0) {
		// Cannot compute if shares aren't verified or map is empty
		return null;
	}

	const finalShareValue = Array.from(verifiedShares.values())
		.reduce((sum, verifiedShare) => (sum + verifiedShare) % CURVE.n, 0n);

	return {
		id: keyholderId,
		idNum: idNum,
		finalShare: finalShareValue
	};
}

/** Return type for computeRevealShareUpdate */
export interface RevealComputationResult {
	/** The update to be applied to the public/shared DKG state, if any. */
	publicUpdate: RevealShareUpdate | null;
	/** Optional error message if reveal computation failed. */
	error?: string;
}

/**
 * Computes the update payload for revealing this keyholder's final share for decryption.
* This is triggered externally, not via determineKeyholderAction.
* @param currentPrivateState The keyholder's current private state.
* @returns A RevealComputationResult containing the public update or an error.
*/
export function computeRevealShareUpdate(
	currentPrivateState: KeyholderPrivateState
): RevealComputationResult {
	if (currentPrivateState.error) {
		return { publicUpdate: null, error: `Cannot reveal share due to prior error: ${currentPrivateState.error}` };
	}
	if (!currentPrivateState.computedFinalShare) {
		// This might happen if verification failed or wasn't completed successfully.
		return { publicUpdate: null, error: "Final share not computed or available" };
	}
	if (currentPrivateState.computedFinalShare.id !== currentPrivateState.id || currentPrivateState.computedFinalShare.idNum !== currentPrivateState.idNum) {
		// Sanity check
		return { publicUpdate: null, error: "Internal state inconsistency: final share ID mismatch" };
	}

	const payload: RevealSharePayload = {
		finalShareData: currentPrivateState.computedFinalShare
	};
	const publicUpdate: RevealShareUpdate = { type: DKGActionType.RevealShare, participantId: currentPrivateState.id, payload };

	return { publicUpdate, error: undefined };
}

/**
 * Retrieves the final computed share data from the private state, if available.
 * @param privateState The keyholder's private state.
 * @returns The final share data or null.
 */
export function getFinalShareData(privateState: KeyholderPrivateState): FinalShareData | null {
	// Expose the computed share if available and no error occurred preventing its computation
	if (privateState.error) return null;
	return privateState.computedFinalShare;
}
