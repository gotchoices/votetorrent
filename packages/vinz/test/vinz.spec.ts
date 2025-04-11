import { expect } from 'aegir/chai';
import { Buffer } from 'buffer';
import {
	initParticipantContributionState, initParticipantVerificationState, initCommonDKGState,
	DKGActionType, calculateCompositePublicKey, encryptData, reconstructPrivateKey, decryptDataWithReconstructedKey,
	initializeKeyholderPrivateState, computeKeyholderUpdate, computeRevealShareUpdate, genDKGTerms, createDKGTerms,
	determineKeyholderAction
} from '../src/index.js';
import type {
	DKGStateView, ParticipantContributionState, ParticipantVerificationState,
	CommonDKGState, CommitmentsUpdate, SharesUpdate, VerificationUpdate, RevealShareUpdate,
	KeyholderPrivateState, ComputationResult, DKGDeal,
	PostCommitmentsPayload, PostSharesPayload, VerifySharesPayload,
	EncryptedShare
} from '../src/index.js';
import { bigintToBytes, evaluatePolynomial, lagrangeInterpolateAtZero } from '../src/helpers.js';

// --- Test State Management Helpers (Adapted from Simulation) ---

interface TestDKGSharedState {
	termsHash: string;
	participantContributions: Record<string, ParticipantContributionState>;
	participantVerifications: Record<string, ParticipantVerificationState>;
	commonState: CommonDKGState;
}

function createEmptyDKGState(deal: Readonly<DKGDeal>): TestDKGSharedState {
	return {
		termsHash: deal.termsHash,
		participantContributions: Object.fromEntries(
			deal.terms.participantIds.map(id => [id, initParticipantContributionState(deal.termsHash, id)])
		),
		participantVerifications: Object.fromEntries(
			deal.terms.participantIds.map(id => [id, initParticipantVerificationState(deal.termsHash, id)])
		),
		commonState: initCommonDKGState(deal.termsHash)
	};
}

function createDKGStateView(deal: Readonly<DKGDeal>, sharedState: TestDKGSharedState): DKGStateView {
	if (sharedState.termsHash !== deal.termsHash) {
		throw new Error("Mismatched terms hash in shared state!");
	}
	return {
		deal,
		participantContributions: sharedState.participantContributions,
		participantVerifications: sharedState.participantVerifications,
		commonState: sharedState.commonState
	};
}

function applyDKGUpdates(
	currentState: TestDKGSharedState,
	updates: (CommitmentsUpdate | SharesUpdate | VerificationUpdate | RevealShareUpdate | null)[]
): TestDKGSharedState {
	const nextState = {
		...currentState,
		participantContributions: { ...currentState.participantContributions },
		participantVerifications: { ...currentState.participantVerifications },
		commonState: {
			...currentState.commonState,
			revealedSharesForDecryption: { ...currentState.commonState.revealedSharesForDecryption }
		}
	};

	for (const update of updates) {
		if (!update) continue;
		if (update.participantId && !nextState.participantContributions[update.participantId]) {
			continue;
		}

		switch (update.type) {
			case DKGActionType.PostCommitments:
				if (!nextState.participantContributions[update.participantId]!.commitments) {
					nextState.participantContributions[update.participantId]!.commitments = update.payload.commitments;
				}
				break;
			case DKGActionType.PostShares:
				if (!nextState.participantContributions[update.participantId]!.distributedShares) {
					nextState.participantContributions[update.participantId]!.distributedShares = update.payload.shares;
				}
				break;
			case DKGActionType.VerifyShares:
				if (nextState.participantVerifications[update.participantId]!.verified === undefined) {
					nextState.participantVerifications[update.participantId]!.verified = update.payload.verified;
					nextState.participantVerifications[update.participantId]!.reason = update.payload.reason;
				}
				break;
			case DKGActionType.RevealShare:
				const shareInfo = update.payload.finalShareData;
				if (!nextState.commonState.revealedSharesForDecryption[update.participantId]) {
					nextState.commonState.revealedSharesForDecryption[update.participantId] = {
						idNum: shareInfo.idNum,
						share: bigintToBytes(shareInfo.finalShare)
					};
				}
				break;
		}
	}
	return nextState;
}


// --- Unit Tests ---

describe('Vinz DKG', () => {
	describe('DKG Terms', () => {
		it('should create valid DKG terms and deal', async () => {
			const threshold = 3;
			const participantIds = ['a', 'b', 'c', 'd'];
			const deal = await createDKGTerms(threshold, participantIds);

			expect(deal).to.exist;
			expect(deal.terms.threshold).to.equal(threshold);
			expect(deal.terms.participantIds).to.deep.equal(participantIds.sort()); // Should be sorted
			expect(deal.termsHash).to.be.a('string').with.length.greaterThan(10);
		});

		it('should generate terms with genDKGTerms', async () => {
			const n = 5;
			const threshold = 3;
			const deal = await genDKGTerms(n, threshold);

			expect(deal.terms.participantIds).to.have.lengthOf(n);
			expect(deal.terms.threshold).to.equal(threshold);
			expect(deal.terms.participantIds[0]).to.equal('0');
			expect(deal.terms.participantIds[n - 1]).to.equal(String(n - 1));
			expect(deal.termsHash).to.be.a('string');
		});

		it('should throw error for invalid threshold (t > n)', async () => {
			await expect(createDKGTerms(5, ['a', 'b', 'c'])).to.be.rejectedWith('Invalid threshold');
		});

		it('should throw error for invalid threshold (t < 1)', async () => {
			await expect(createDKGTerms(0, ['a', 'b', 'c'])).to.be.rejectedWith('Invalid threshold');
		});

		it('should throw error for no participants', async () => {
			await expect(createDKGTerms(1, [])).to.be.rejectedWith('Must be at least one participant');
		});
	});

	describe('Keyholder Initialization', () => {
		let deal: DKGDeal;

		before(async () => {
			deal = await genDKGTerms(3, 2);
		});

		it('should initialize keyholder private state correctly', () => {
			const participantId = deal.terms.participantIds[1]!; // '1'
			const state = initializeKeyholderPrivateState(participantId, deal);

			expect(state.id).to.equal(participantId);
			expect(state.idNum).to.equal(2n); // 1-based index
			expect(state.termsHash).to.equal(deal.termsHash);
			expect(state.polynomial).to.be.null;
			expect(state.verifiedReceivedShares).to.be.null;
			expect(state.computedFinalShare).to.be.null;
			expect(state.error).to.be.null;
		});

		it('should throw error if keyholder ID not in terms', () => {
			expect(() => initializeKeyholderPrivateState('nonexistent', deal)).to.throw('not found in DKG terms');
		});
	});

	describe('Helper Functions', () => {
		it('should evaluate polynomial correctly', () => {
			// P(x) = 3 + 2x + 1x^2 mod 101
			const coeffs = [3n, 2n, 1n];
			const n = 101n;
			expect(evaluatePolynomial(coeffs, 0n, n)).to.equal(3n); // P(0)
			expect(evaluatePolynomial(coeffs, 1n, n)).to.equal(6n); // P(1) = 3 + 2 + 1 = 6
			expect(evaluatePolynomial(coeffs, 2n, n)).to.equal(11n); // P(2) = 3 + 2*2 + 1*4 = 3 + 4 + 4 = 11
			expect(evaluatePolynomial(coeffs, 10n, n)).to.equal(22n);
		});

		it('should perform Lagrange interpolation at zero correctly', () => {
			// P(x) = 5 + 2x (mod 101) -> P(0)=5
			// P(1) = 7, P(2) = 9, P(3) = 11
			const n = 101n;
			const points2 = [{ x: 1n, y: 7n }, { x: 2n, y: 9n }]; // t=2
			const points3 = [{ x: 1n, y: 7n }, { x: 2n, y: 9n }, { x: 3n, y: 11n }]; // t=3

			expect(lagrangeInterpolateAtZero(points2, n)).to.equal(5n);
			expect(lagrangeInterpolateAtZero(points3, n)).to.equal(5n);
		});

		it('should throw if Lagrange interpolation has x=0', () => {
			const points = [{ x: 1n, y: 7n }, { x: 0n, y: 9n }];
			expect(() => lagrangeInterpolateAtZero(points, 101n)).to.throw('non-zero x coordinates');
		});
	});

	describe('Keyholder Actions & Computations', () => {
		let deal_3_2: DKGDeal;
		let deal_5_3: DKGDeal;
		let p0_state: KeyholderPrivateState, p1_state: KeyholderPrivateState, p2_state: KeyholderPrivateState;
		let sharedState: TestDKGSharedState;
		let initialStateView: DKGStateView;

		beforeEach(async () => {
			deal_3_2 = await genDKGTerms(3, 2); // n=3, t=2
			deal_5_3 = await genDKGTerms(5, 3); // n=5, t=3

			// Setup for deal_3_2
			p0_state = initializeKeyholderPrivateState(deal_3_2.terms.participantIds[0]!, deal_3_2);
			p1_state = initializeKeyholderPrivateState(deal_3_2.terms.participantIds[1]!, deal_3_2);
			p2_state = initializeKeyholderPrivateState(deal_3_2.terms.participantIds[2]!, deal_3_2);
			sharedState = createEmptyDKGState(deal_3_2);
			initialStateView = createDKGStateView(deal_3_2, sharedState);
		});

		it('should determine PostCommitments action initially', () => {
			const action = determineKeyholderAction(p0_state.id, deal_3_2, initialStateView);
			expect(action.type).to.equal(DKGActionType.PostCommitments);
		});

		it('should compute PostCommitments update', () => {
			const result = computeKeyholderUpdate(p0_state, deal_3_2, initialStateView);

			expect(result.publicUpdate).to.exist;
			expect(result.publicUpdate?.type).to.equal(DKGActionType.PostCommitments);
			expect(result.publicUpdate?.participantId).to.equal(p0_state.id);
			const payload = result.publicUpdate?.payload as PostCommitmentsPayload;
			expect(payload?.commitments.id).to.equal(p0_state.id);
			expect(payload?.commitments.idNum).to.equal(p0_state.idNum);
			expect(payload?.commitments.commitments).to.be.an('array').with.lengthOf(deal_3_2.terms.threshold); // t=2
			payload?.commitments.commitments.forEach((c: Uint8Array) => expect(c).to.be.instanceOf(Uint8Array).with.lengthOf(33)); // Compressed points

			expect(result.nextPrivateState).to.exist;
			expect(result.nextPrivateState?.polynomial).to.be.an('array').with.lengthOf(deal_3_2.terms.threshold);
			result.nextPrivateState?.polynomial?.forEach(c => expect(c).to.be.a('bigint'));
			expect(result.nextPrivateState?.error).to.be.null;
		});

		it('should determine NoAction if waiting for commitments', () => {
			// p0 posts commitments
			const res0 = computeKeyholderUpdate(p0_state, deal_3_2, initialStateView);
			sharedState = applyDKGUpdates(sharedState, [res0.publicUpdate]);
			p0_state = res0.nextPrivateState!;
			const stateView1 = createDKGStateView(deal_3_2, sharedState);

			// p1 hasn't posted yet
			const action1 = determineKeyholderAction(p1_state.id, deal_3_2, stateView1);
			expect(action1.type).to.equal(DKGActionType.PostCommitments);

			// p0 has posted, should wait
			const action0 = determineKeyholderAction(p0_state.id, deal_3_2, stateView1);
			expect(action0.type).to.equal(DKGActionType.NoAction);
			// Only check reason if type is NoAction
			if (action0.type === DKGActionType.NoAction) {
				expect(action0.reason).to.contain('Waiting for all commitments');
			}
		});

		it('should determine PostShares after all commitments are posted', () => {
			// All participants post commitments
			const updates: CommitmentsUpdate[] = [];
			let states = [p0_state, p1_state, p2_state];
			states.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, initialStateView);
				expect(res.publicUpdate?.type).to.equal(DKGActionType.PostCommitments);
				updates.push(res.publicUpdate! as CommitmentsUpdate);
				states[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewCommitmentsDone = createDKGStateView(deal_3_2, sharedState);

			// Now p0 should be ready to post shares
			const action = determineKeyholderAction(states[0]!.id, deal_3_2, stateViewCommitmentsDone);
			expect(action.type).to.equal(DKGActionType.PostShares);
		});

		it('should compute PostShares update', () => {
			// Get p0 state after it computed commitments
			const resCommit = computeKeyholderUpdate(p0_state, deal_3_2, initialStateView);
			p0_state = resCommit.nextPrivateState!;
			// Assume all commitments are in stateView for action determination (not strictly needed for computation itself)
			const result = computeKeyholderUpdate(p0_state, deal_3_2, initialStateView, { type: DKGActionType.PostShares });

			expect(result.publicUpdate).to.exist;
			expect(result.publicUpdate?.type).to.equal(DKGActionType.PostShares);
			expect(result.publicUpdate?.participantId).to.equal(p0_state.id);
			const payload = result.publicUpdate?.payload as PostSharesPayload;
			expect(payload?.shares).to.be.an('array').with.lengthOf(deal_3_2.terms.participantIds.length); // n=3
			payload?.shares.forEach((share, i) => {
				expect(share.sourceId).to.equal(p0_state.id);
				expect(share.targetId).to.equal(deal_3_2.terms.participantIds[i]);
				expect(share.encryptedShare).to.be.a('bigint');
				// Verify the share value against the polynomial
				const expectedShare = evaluatePolynomial(p0_state.polynomial!, BigInt(i + 1));
				expect(share.encryptedShare).to.equal(expectedShare);
			});

			expect(result.nextPrivateState).to.exist; // State can optionally discard polynomial here, we don't check that
			expect(result.nextPrivateState?.error).to.be.null;
		});

		it('should determine VerifyShares after all shares are posted', () => {
			// Run full commitment and share posting phases
			let currentStates = [p0_state, p1_state, p2_state];
			let updates: any[] = [];
			// Commitments
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, initialStateView);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewCommitments = createDKGStateView(deal_3_2, sharedState);
			updates = [];
			// Shares
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, stateViewCommitments);
				expect(res.publicUpdate?.type).to.equal(DKGActionType.PostShares);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewSharesDone = createDKGStateView(deal_3_2, sharedState);

			// Now p0 should be ready to verify shares
			const action = determineKeyholderAction(currentStates[0]!.id, deal_3_2, stateViewSharesDone);
			expect(action.type).to.equal(DKGActionType.VerifyShares);
		});

		it('should compute VerifyShares update (successful verification)', () => {
			// Run full commitment and share posting phases correctly
			let currentStates = [p0_state, p1_state, p2_state];
			let updates: any[] = [];
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, initialStateView);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewCommitments = createDKGStateView(deal_3_2, sharedState);
			updates = [];
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, stateViewCommitments);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewSharesDone = createDKGStateView(deal_3_2, sharedState);

			// Compute verification for p0
			const result = computeKeyholderUpdate(currentStates[0]!, deal_3_2, stateViewSharesDone);

			expect(result.publicUpdate).to.exist;
			expect(result.publicUpdate?.type).to.equal(DKGActionType.VerifyShares);
			expect(result.publicUpdate?.participantId).to.equal(currentStates[0]!.id);
			// Cast payload to the expected type for this test
			const payload = result.publicUpdate?.payload as VerifySharesPayload;
			expect(payload?.verified).to.be.true;
			expect(payload?.reason).to.be.undefined;

			expect(result.nextPrivateState).to.exist;
			expect(result.nextPrivateState?.verifiedReceivedShares).to.be.instanceOf(Map).with.keys(deal_3_2.terms.participantIds);
			expect(result.nextPrivateState?.computedFinalShare).to.exist;
			const finalShare = result.nextPrivateState?.computedFinalShare!;
			expect(finalShare.id).to.equal(currentStates[0]!.id);
			expect(finalShare.idNum).to.equal(currentStates[0]!.idNum);
			expect(finalShare.finalShare).to.be.a('bigint');
			expect(result.nextPrivateState?.error).to.be.null;
		});

		it('should compute VerifyShares update (failed verification)', () => {
			// Run commitment phase
			let currentStates = [p0_state, p1_state, p2_state];
			let updates: any[] = [];
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, initialStateView);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewCommitments = createDKGStateView(deal_3_2, sharedState);
			updates = [];
			// Post shares, but p1 posts a bad share to p0
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, stateViewCommitments);
				if (i === 1) { // p1 is sending
					// Cast payload before accessing shares
					const currentPayload = res.publicUpdate!.payload as PostSharesPayload;
					const badShares = currentPayload.shares.map((s: EncryptedShare, j: number) => {
						if (j === 0) return { ...s, encryptedShare: s.encryptedShare + 1n }; // Corrupt share for p0
						return s;
					});
					updates.push({ ...res.publicUpdate!, payload: { shares: badShares } });
				} else {
					updates.push(res.publicUpdate);
				}
				// Ensure nextPrivateState is assigned even if publicUpdate is null (though unlikely here)
				if (res.nextPrivateState) {
					currentStates[i] = res.nextPrivateState;
				} else if (!currentStates[i]!.error) {
					// If computation failed without error, mark private state (should not happen ideally)
					currentStates[i]!.error = "Computation failed unexpectedly";
				}
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewBadShares = createDKGStateView(deal_3_2, sharedState);

			// Compute verification for p0
			const result = computeKeyholderUpdate(currentStates[0]!, deal_3_2, stateViewBadShares);

			expect(result.publicUpdate).to.exist;
			expect(result.publicUpdate?.type).to.equal(DKGActionType.VerifyShares);
			// Cast payload to the expected type for this test
			const payload = result.publicUpdate?.payload as VerifySharesPayload;
			expect(payload?.verified).to.be.false;
			expect(payload?.reason).to.contain('does not match commitment').and.contain(currentStates[1]!.id);

			expect(result.nextPrivateState).to.exist;
			expect(result.nextPrivateState?.verifiedReceivedShares).to.be.null;
			expect(result.nextPrivateState?.computedFinalShare).to.be.null;
			expect(result.nextPrivateState?.error).to.be.null; // Verification failure is not a keyholder error state
		});

		it('should determine NoAction after successful verification', () => {
			// Run full DKG successfully through verification for p0
			let currentStates = [p0_state, p1_state, p2_state];
			let updates: any[] = [];
			// Commitments
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, initialStateView);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewCommitments = createDKGStateView(deal_3_2, sharedState);
			updates = [];
			// Shares
			currentStates.forEach((state, i) => {
				const res = computeKeyholderUpdate(state, deal_3_2, stateViewCommitments);
				updates.push(res.publicUpdate);
				currentStates[i] = res.nextPrivateState!;
			});
			sharedState = applyDKGUpdates(sharedState, updates);
			const stateViewSharesDone = createDKGStateView(deal_3_2, sharedState);
			updates = [];
			// Verification (only p0 computes and updates state)
			const resVerify = computeKeyholderUpdate(currentStates[0]!, deal_3_2, stateViewSharesDone);
			// Check type before accessing payload properties
			expect(resVerify.publicUpdate?.type).to.equal(DKGActionType.VerifyShares);
			if (resVerify.publicUpdate?.type === DKGActionType.VerifyShares) {
				expect((resVerify.publicUpdate.payload as VerifySharesPayload).verified).to.be.true;
			}
			sharedState = applyDKGUpdates(sharedState, [resVerify.publicUpdate]);
			currentStates[0] = resVerify.nextPrivateState!;
			const stateViewP0Verified = createDKGStateView(deal_3_2, sharedState);

			// p0 should now have no action
			const action = determineKeyholderAction(currentStates[0]!.id, deal_3_2, stateViewP0Verified);
			expect(action.type).to.equal(DKGActionType.NoAction);
			// Only check reason if type is NoAction
			if (action.type === DKGActionType.NoAction) {
				expect(action.reason).to.contain('DKG protocol complete');
			}
		});

		it('should compute RevealShare update', () => {
			// Assume p0 completed DKG and has computedFinalShare
			p0_state.computedFinalShare = {
				id: p0_state.id,
				idNum: p0_state.idNum,
				finalShare: 12345n
			};

			const result = computeRevealShareUpdate(p0_state);
			expect(result.error).to.be.undefined;
			expect(result.publicUpdate).to.exist;
			expect(result.publicUpdate?.type).to.equal(DKGActionType.RevealShare);
			expect(result.publicUpdate?.participantId).to.equal(p0_state.id);
			expect(result.publicUpdate?.payload.finalShareData).to.deep.equal(p0_state.computedFinalShare);
		});

		it('should fail RevealShare if final share not computed', () => {
			p0_state.computedFinalShare = null; // Ensure it's null
			const result = computeRevealShareUpdate(p0_state);
			expect(result.publicUpdate).to.be.null;
			expect(result.error).to.contain('Final share not computed');
		});
	});

	describe('End-to-End DKG and Crypto Flow', () => {
		it('should complete DKG, encrypt, and decrypt successfully (3/5)', async () => {
			const n = 5;
			const threshold = 3;
			const message = 'Test message for Vinz!';

			// --- DKG Phase ---
			const deal = await genDKGTerms(n, threshold);
			let privateStates: Record<string, KeyholderPrivateState> = {};
			deal.terms.participantIds.forEach(id => {
				privateStates[id] = initializeKeyholderPrivateState(id, deal);
			});
			let sharedState = createEmptyDKGState(deal);
			let updates: any[] = [];

			// Commitments
			for (const id of deal.terms.participantIds) {
				const stateView = createDKGStateView(deal, sharedState);
				const res = computeKeyholderUpdate(privateStates[id]!, deal, stateView);
				expect(res.publicUpdate?.type).to.equal(DKGActionType.PostCommitments);
				updates.push(res.publicUpdate);
				privateStates[id] = res.nextPrivateState!;
			}
			sharedState = applyDKGUpdates(sharedState, updates);
			updates = [];

			// Shares
			for (const id of deal.terms.participantIds) {
				const stateView = createDKGStateView(deal, sharedState);
				const res = computeKeyholderUpdate(privateStates[id]!, deal, stateView);
				expect(res.publicUpdate?.type).to.equal(DKGActionType.PostShares);
				updates.push(res.publicUpdate);
				privateStates[id] = res.nextPrivateState!;
			}
			sharedState = applyDKGUpdates(sharedState, updates);
			updates = [];

			// Verification
			const successfulIds: string[] = [];
			for (const id of deal.terms.participantIds) {
				const stateView = createDKGStateView(deal, sharedState);
				const res = computeKeyholderUpdate(privateStates[id]!, deal, stateView);
				expect(res.publicUpdate?.type).to.equal(DKGActionType.VerifyShares);
				updates.push(res.publicUpdate);
				// Check type before accessing verified
				if (res.publicUpdate?.type === DKGActionType.VerifyShares && (res.publicUpdate.payload as VerifySharesPayload).verified) {
					successfulIds.push(id);
				}
				privateStates[id] = res.nextPrivateState!;
			}
			sharedState = applyDKGUpdates(sharedState, updates);
			expect(successfulIds.length).to.be.at.least(threshold);

			// Public Key Calculation
			const finalStateView = createDKGStateView(deal, sharedState);
			const compositePublicKey = calculateCompositePublicKey(finalStateView);
			expect(compositePublicKey).to.be.instanceOf(Uint8Array).with.lengthOf(33);
			sharedState.commonState.compositePublicKey = compositePublicKey; // Manually add for state consistency

			// --- Crypto Phase ---
			const encrypted = await encryptData(message, compositePublicKey!);
			expect(encrypted).to.be.instanceOf(Uint8Array);
			expect(encrypted.length).to.be.greaterThan(message.length);

			// Reveal Shares
			const revealUpdates: RevealShareUpdate[] = [];
			const revealingIds = successfulIds.slice(0, threshold);
			for (const id of revealingIds) {
				const state = privateStates[id]!;
				expect(state.computedFinalShare).to.exist;
				const res = computeRevealShareUpdate(state);
				expect(res.error).to.be.undefined;
				revealUpdates.push(res.publicUpdate!);
			}
			sharedState = applyDKGUpdates(sharedState, revealUpdates);
			const stateViewAfterReveal = createDKGStateView(deal, sharedState);

			// Get Shares for Reconstruction
			const revealedSharesBytes: { idNum: bigint, share: Uint8Array }[] = [];
			for (const id of revealingIds) {
				const revealedData = stateViewAfterReveal.commonState.revealedSharesForDecryption[id];
				expect(revealedData).to.exist;
				revealedSharesBytes.push({ idNum: revealedData!.idNum, share: revealedData!.share });
			}
			expect(revealedSharesBytes).to.have.lengthOf(threshold);

			// Reconstruct & Decrypt
			const reconstructedPrivKey = reconstructPrivateKey(revealedSharesBytes, deal.terms.threshold);
			expect(reconstructedPrivKey).to.be.instanceOf(Uint8Array).with.lengthOf(32);

			const decrypted = await decryptDataWithReconstructedKey(encrypted, reconstructedPrivKey);
			expect(decrypted).to.equal(message);
		});
	});
});
