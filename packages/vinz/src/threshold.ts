import { ProjectivePoint as Point, utils, CURVE } from '@noble/secp256k1';
import { TextEncoder, TextDecoder } from 'util'; // Use standard En/Decoders
import { concat as uint8ArrayConcat } from 'uint8arrays/concat'; // For concatenating Uint8Arrays
import {
	bigintToBytes,
	hashBytes,
	ensureValidPrivateKey,
	lagrangeInterpolateAtZero
} from './helpers.js';
import type { DKGStateView } from './dkg-state.js';
import type { FinalShareData, RevealedShare } from './internal-types.js';

const G = Point.BASE;

// ----- GLOBAL DKG FUNCTIONS ----- //

/**
 * Calculates the final composite public key from the DKG state view.
 * Assumes sufficient commitments are present and valid.
 * @param stateView Read-only view of the current DKG state.
 * @returns The composite public key bytes, or null if calculation fails.
 */
export function calculateCompositePublicKey(stateView: Readonly<DKGStateView>): Uint8Array | null {
	let compositePubKeyPoint = Point.ZERO;

	if (Object.keys(stateView.participantContributions).length < stateView.deal.terms.participantIds.length) {
		return null;
	}

	for (const id of stateView.deal.terms.participantIds) {
		// Even if a participant failed later verification, their initial commitment (P_i(0))
		// contributes to the composite public key in Feldman VSS.
		const contribution = stateView.participantContributions[id];
		const commData = contribution?.commitments;

		if (!commData || !commData.commitments || commData.commitments.length === 0) {
			return null;
		}
		try {
			// G*P_i(0) is the first commitment
			const constantTermCommitmentPoint = Point.fromHex(commData.commitments[0]!);
			compositePubKeyPoint = compositePubKeyPoint.add(constantTermCommitmentPoint);
		} catch (e) {
			return null;
		}
	}
	return compositePubKeyPoint.toRawBytes(true);
}

// ----- POST-DKG CRYPTOGRAPHIC FUNCTIONS ----- //
// These functions operate *after* a successful DKG produced a compositePublicKey
// and keyholders have their final (private) shares.

/**
 * Encrypts data using the composite public key (ECIES-like).
 * @param message The message string.
 * @param compositePublicKey The public key from a completed DKG.
 * @returns Encrypted data (ephemeral pubkey || ciphertext).
 */
export async function encryptData(message: string, compositePublicKey: Uint8Array): Promise<Uint8Array> {
	const ephemeralPrivBytes = utils.randomPrivateKey();
	const ephemeralPrivScalar = utils.normPrivateKeyToScalar(ephemeralPrivBytes);
	const ephemeralPubPoint = G.multiply(ephemeralPrivScalar);
	const ephemeralPubKeyBytes = ephemeralPubPoint.toRawBytes(true);

	const sharedPoint = Point.fromHex(compositePublicKey).multiply(ephemeralPrivScalar);
	const sharedSecretBytes = sharedPoint.toRawBytes(true);
	const encryptionKey = await hashBytes(sharedSecretBytes);

	const messageBytes = new TextEncoder().encode(message);
	const ciphertext = new Uint8Array(messageBytes.length);
	for (let i = 0; i < messageBytes.length; i++) {
		ciphertext[i] = messageBytes[i]! ^ encryptionKey[i % encryptionKey.length]!;
	}
	return uint8ArrayConcat([ephemeralPubKeyBytes, ciphertext]);
}

/**
 * Prepares revealed shares into the format needed for reconstruction.
 * @param finalShareData Array of final share data from revealing participants.
 * @param revealingIds IDs of participants whose shares are included.
 * @param threshold The required threshold.
 * @returns Array of {idNum, share} objects for Lagrange interpolation.
 * @throws Error if fewer than `threshold` shares are provided.
 */
export function getSharesForReveal(
	finalShareData: FinalShareData[],
	revealingIds: string[], // Keep for validation, although data is already filtered
	threshold: number
): RevealedShare[] {
	const revealedSharesMap: Map<string, RevealedShare> = new Map();
	for (const holderShare of finalShareData) { // Iterate the provided shares
		if (revealingIds.includes(holderShare.id)) { // Double check ID is expected
			revealedSharesMap.set(holderShare.id, {
				idNum: holderShare.idNum,
				share: bigintToBytes(holderShare.finalShare)
			});
		}
	}
	if (revealedSharesMap.size < threshold) {
		throw new Error(`Insufficient valid keyholder shares provided for reveal (${revealedSharesMap.size} < ${threshold})`);
	}
	// Slice ensures we only use threshold shares even if more are provided
	return Array.from(revealedSharesMap.values()).slice(0, threshold);
}

/**
 * Reconstructs the composite private key from revealed shares using Lagrange interpolation.
 * @param revealedShares Array of prepared shares (output of getSharesForReveal).
 * @param threshold The required threshold.
 * @returns The reconstructed composite private key bytes.
 * @throws Error if interpolation fails or key is invalid.
 */
export function reconstructPrivateKey(
	revealedShares: RevealedShare[],
	threshold: number
): Uint8Array {
	if (revealedShares.length < threshold) {
		throw new Error(`Insufficient shares (${revealedShares.length}) to reconstruct key (threshold ${threshold}).`);
	}
	const points: { x: bigint; y: bigint }[] = revealedShares
		.slice(0, threshold) // Use exactly threshold shares
		.map(share => ({
			x: share.idNum,
			y: utils.normPrivateKeyToScalar(ensureValidPrivateKey(share.share))
		}));
	const reconstructedSecretBigInt = lagrangeInterpolateAtZero(points);
	const reconstructedSecretBytes = bigintToBytes(reconstructedSecretBigInt);
	return ensureValidPrivateKey(reconstructedSecretBytes);
}

/**
 * Decrypts data using a reconstructed threshold private key.
 * @param encryptedData The encrypted data (output of encryptData).
 * @param reconstructedPrivateKey The private key from reconstructPrivateKey.
 * @returns The original plaintext message.
 */
export async function decryptDataWithReconstructedKey(
	encryptedData: Uint8Array,
	reconstructedPrivateKey: Uint8Array
): Promise<string> {
	const validPrivKeyScalar = utils.normPrivateKeyToScalar(ensureValidPrivateKey(reconstructedPrivateKey));
	const ephemeralPubKeyBytes = encryptedData.slice(0, 33);
	const ciphertext = encryptedData.slice(33);

	const ephemeralPubPoint = Point.fromHex(ephemeralPubKeyBytes);
	const sharedPoint = ephemeralPubPoint.multiply(validPrivKeyScalar);
	const sharedSecretBytes = sharedPoint.toRawBytes(true);
	const decryptionKey = await hashBytes(sharedSecretBytes);

	const plainBytes = new Uint8Array(ciphertext.length);
	for (let i = 0; i < ciphertext.length; i++) {
		plainBytes[i] = ciphertext[i]! ^ decryptionKey[i % decryptionKey.length]!;
	}
	return new TextDecoder().decode(plainBytes);
}
