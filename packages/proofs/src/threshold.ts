import { ProjectivePoint as Point, utils, CURVE, getPublicKey } from '@noble/secp256k1';
import {
    bigintToBytes,
    hashBytes,
    ensureValidPrivateKey,
    evaluatePolynomial,
    lagrangeInterpolateAtZero
} from './helpers.js';

const G = Point.BASE;

// ----- DKG PHASES and STATE ----- //

export enum DKGPhase {
    Init = 0,                // Before anything starts
    Commitment = 1,          // Keyholders post commitments G*c_ik
    ShareDistribution = 2,   // Keyholders post encrypted shares P_i(j)
    VerificationAndFinalShare = 3, // Keyholders verify shares and compute/store final share S_j
    PublicKeyCalculation = 4, // Composite public key is calculated
    Complete = 5,            // DKG finished
    Failed = -1              // DKG encountered an unrecoverable error
}

/** Represents the publicly accessible shared state of the DKG process */
export interface DKGState {
    phase: DKGPhase;
    n: number;
    threshold: number;
    participantIds: string[]; // All expected participant IDs
    // Phase 1 Output: Commitments from each participant
    commitments: Record<string, KeyholderCommitments>; // keyholder.id -> commitments
    // Phase 2 Output: "Encrypted" shares targeting each participant
    // Stored flatly; recipients filter. In reality, encryption makes them target-specific.
    distributedShares: EncryptedShare[];
    // Phase 3 Output: Status indicating if a keyholder verified shares & computed their final share
    verificationStatus: Record<string, boolean>; // keyholder.id -> verified shares successfully?
    // Phase 4 Output: The final key
    compositePublicKey: Uint8Array | null;
    // Optional: Tracking failures
    failedParticipants?: Record<string, string>; // keyholder.id -> reason for failure
}

// ----- TYPES ----- //

/** Public commitments made by a keyholder in Phase 1 */
type KeyholderCommitments = {
    id: string;           // Participant ID (e.g., "keyholder-1")
    idNum: bigint;        // Participant number (e.g., 1n)
    commitments: Uint8Array[]; // [G*c0, G*c1, ..., G*ct-1]
};

/** Represents a share P_i(j) sent from keyholder i to keyholder j in Phase 2 */
// In practice, this would be encrypted for the recipient j
type EncryptedShare = {
    sourceId: string;
    targetId: string;
    encryptedShare: bigint; // Simulate encryption by just storing the raw value P_i(j)
};

/** Represents the final computed share S_j held by keyholder j after Phase 3 */
// This should ideally be kept private by the keyholder or encrypted if stored publicly
export type FinalShareData = {
    id: string;
    idNum: bigint;
    finalShare: bigint; // S_j = sum_i(P_i(j))
};

/** Represents a revealed share ready for reconstruction */
type RevealedShare = {
    idNum: bigint;
    share: Uint8Array; // The raw bytes of the finalShare
};


// ----- KEYHOLDER CLASS ----- //

/** Represents the private state and actions of a single keyholder participant */
export class Keyholder {
    readonly id: string;
    readonly idNum: bigint;
    readonly n: number;
    readonly threshold: number;

    // Private state - handle securely in production!
    private polynomial: bigint[] | null = null;
    private receivedValidShares: Map<string, bigint> = new Map(); // sourceId -> shareValue
    private hasComputedFinalShare: boolean = false;
    private finalShareValue: bigint | null = null; // S_j

    // Optional callbacks
    onCommitmentPosted?: () => void;
    onSharesPosted?: () => void;
    onVerificationComplete?: (success: boolean) => void;
    onFinalShareComputed?: () => void;

    constructor(idNum: number, n: number, threshold: number) {
        if (idNum <= 0 || idNum > n) throw new Error("Keyholder ID number invalid.");
        if (threshold <= 0 || threshold > n) throw new Error("Invalid threshold.");
        this.idNum = BigInt(idNum);
        this.id = `keyholder-${this.idNum}`;
        this.n = n;
        this.threshold = threshold;
    }

    /** Determines the next action needed based on public state */
    getNextAction(state: DKGState): DKGPhase | null {
        if (state.phase === DKGPhase.Failed) return null;
        if (state.failedParticipants?.[this.id]) return null; // This participant failed

        switch (state.phase) {
            case DKGPhase.Init:
                return DKGPhase.Commitment; // Needs to post commitments
            case DKGPhase.Commitment:
                // If my commitment isn't posted, I need to post it.
                if (!state.commitments[this.id]) {
                    return DKGPhase.Commitment;
                }
                // If all commitments are posted, next phase is ShareDistribution
                // This check should ideally be done by the state transition logic, not the keyholder
                // if (Object.keys(state.commitments).length === this.n) { ... }
                return null; // Waiting for others or already done Phase 1
            case DKGPhase.ShareDistribution:
                 // If my shares aren't fully posted, I need to post them.
                 const myPostedShares = state.distributedShares.filter(s => s.sourceId === this.id);
                 if (myPostedShares.length < this.n) {
                     return DKGPhase.ShareDistribution;
                 }
                 // Check for next phase should be done by state transition logic
                 // if (state.distributedShares.length === this.n * this.n) { ... }
                 return null; // Waiting for others or already done Phase 2
            case DKGPhase.VerificationAndFinalShare:
                 // If I haven't verified yet, I need to do it.
                 if (state.verificationStatus[this.id] === undefined) {
                     return DKGPhase.VerificationAndFinalShare;
                 }
                 // Check for next phase should be done by state transition logic
                 // if (successfulVerifiers.length === expectedVerifiers.length) { ... }
                 return null; // Waiting for others or already done Phase 3
             case DKGPhase.PublicKeyCalculation:
             case DKGPhase.Complete:
                 return null; // Nothing further for individual keyholder
            default:
                return null;
        }
    }

    /** Action for Phase 1: Generate polynomial and return commitments */
    performCommitmentPhase(): KeyholderCommitments {
        if (this.polynomial) throw new Error(`${this.id}: Polynomial already generated.`);

        console.log(`${this.id}: Generating polynomial and commitments...`);
        this.polynomial = [];
        for (let k = 0; k < this.threshold; k++) {
            this.polynomial.push(utils.normPrivateKeyToScalar(utils.randomPrivateKey()));
        }
        const commitments = this.polynomial.map(coeff => G.multiply(coeff).toRawBytes(true));

        this.onCommitmentPosted?.();
        return { id: this.id, idNum: this.idNum, commitments };
    }

    /** Action for Phase 2: Calculate and return shares for all participants */
    performShareDistributionPhase(state: DKGState): EncryptedShare[] {
        if (!this.polynomial) {
            // Attempt to regenerate if lost? Or fail? For simulation, fail.
            throw new Error(`${this.id}: Polynomial not available for share distribution.`);
        }
        // Check if already posted
        const myPostedShares = state.distributedShares.filter(s => s.sourceId === this.id);
        if (myPostedShares.length === this.n) {
             // console.log(`${this.id}: Shares already posted.`);
             return []; // Already done
        }

        console.log(`${this.id}: Calculating shares for all participants...`);
        const participantIdNums = state.participantIds.map(id => BigInt(id.split('-')[1]!));
        const shares: EncryptedShare[] = [];

        for (const targetIdNum of participantIdNums) {
            const targetId = `keyholder-${targetIdNum}`;
            const shareValue = evaluatePolynomial(this.polynomial, targetIdNum);
            shares.push({
                sourceId: this.id,
                targetId: targetId,
                encryptedShare: shareValue // Simulate encryption
            });
        }
        // **Crucial Security Step:** In production, *securely erase* the polynomial now
        // this.polynomial = null;

        this.onSharesPosted?.();
        return shares;
    }

    /** Action for Phase 3: Verify received shares and compute final share */
    performVerificationAndFinalSharePhase(state: DKGState): { status: boolean; failureReason?: string } {
         if (state.verificationStatus[this.id] !== undefined) {
            // console.log(`${this.id}: Verification status already recorded.`);
            return { status: state.verificationStatus[this.id]! }; // Already done
         }

        console.log(`${this.id}: Verifying received shares...`);
        this.receivedValidShares.clear();

        const sharesForMe = state.distributedShares.filter(s => s.targetId === this.id);
        // Check if *all* expected shares are present before verifying
        if (sharesForMe.length !== this.n) {
            // Cannot complete verification yet, waiting for shares
            // console.log(`${this.id}: Waiting for shares. Expected ${this.n}, got ${sharesForMe.length}.`);
            return { status: false, failureReason: `Waiting for shares (got ${sharesForMe.length}/${this.n})` };
        }

        let allSharesValid = true;
        let failReason = "";
        for (const receivedShare of sharesForMe) {
            const senderCommitments = state.commitments[receivedShare.sourceId];
            if (!senderCommitments) {
                failReason = `Missing commitments from sender ${receivedShare.sourceId}`;
                allSharesValid = false;
                break;
            }
            const isValid = this.verifyReceivedShareInternal(receivedShare, senderCommitments);
            if (!isValid) {
                failReason = `Invalid share from sender ${receivedShare.sourceId}`;
                allSharesValid = false;
                break;
            } else {
                 this.receivedValidShares.set(receivedShare.sourceId, receivedShare.encryptedShare);
            }
        }

        this.onVerificationComplete?.(allSharesValid);

        if (!allSharesValid) {
            console.warn(`${this.id}: Failed verification phase. Reason: ${failReason}`);
            // Keyholder reports failure
            return { status: false, failureReason: failReason };
        }

        // Compute and store final share if verification passed
        console.log(`${this.id}: All shares verified. Computing final share.`);
        this.finalShareValue = Array.from(this.receivedValidShares.values())
                                  .reduce((sum, verifiedShare) => (sum + verifiedShare) % CURVE.n, 0n);
        this.hasComputedFinalShare = true;
        this.onFinalShareComputed?.();

        // Keyholder reports success
        return { status: true };
    }

    /** Internal logic for verifying a single share (extracted) */
    private verifyReceivedShareInternal(share: EncryptedShare, senderCommitments: KeyholderCommitments): boolean {
         const t = senderCommitments.commitments.length;
         const shareValue_sij = share.encryptedShare;
         const targetIdNum_j = this.idNum;

         const lhs = G.multiply(shareValue_sij);
         let rhs = Point.ZERO;
         let jPowerK = 1n;

         for (let k = 0; k < t; k++) {
             const commitment_Cik_bytes = senderCommitments.commitments[k];
             if (!commitment_Cik_bytes) return false;
             const commitment_Cik_point = Point.fromHex(commitment_Cik_bytes);
             rhs = rhs.add(commitment_Cik_point.multiply(jPowerK));
             jPowerK = (jPowerK * targetIdNum_j) % CURVE.n;
         }
         return lhs.equals(rhs);
    }

     /** Retrieve the computed final share data (only if computed successfully) */
    getFinalShareData(): FinalShareData | null {
        if (!this.hasComputedFinalShare || this.finalShareValue === null) {
            // Return null instead of throwing, allows checking if ready
             return null;
        }
        return { id: this.id, idNum: this.idNum, finalShare: this.finalShareValue };
    }
}

// ----- Global Calculation Functions ----- //

/** Phase 4: Calculate the final composite public key from commitments */
export function calculateCompositePublicKey(state: Readonly<DKGState>): Uint8Array | null {
    // Phase check should be done by the state transition logic before calling this
    console.log("Calculating composite public key...");
    let compositePubKeyPoint = Point.ZERO;
    for (const id of state.participantIds) {
        // If a participant failed verification, should we exclude their commitment?
        // For Feldman VSS, the public key relies on P_i(0) which is derived from the commitment C_i0.
        // Even if a participant sends bad shares later, their initial commitment contributes.
        // However, if they posted invalid *commitments* initially (e.g., not points on curve),
        // the DKG should have failed earlier.
        const commData = state.commitments[id];
         if (!commData || !commData.commitments || commData.commitments.length === 0) {
             console.error(`Cannot calculate public key: Commitments missing for ${id}. DKG failed.`);
             return null;
        }
        try {
            const constantTermCommitmentPoint = Point.fromHex(commData.commitments[0]!);
            compositePubKeyPoint = compositePubKeyPoint.add(constantTermCommitmentPoint);
        } catch (e) {
             console.error(`Cannot calculate public key: Invalid commitment point for ${id}. DKG failed.`, e);
             return null;
        }
    }
    console.log("Composite public key calculated.");
    return compositePubKeyPoint.toRawBytes(true);
}

// ----- Functions dependent on DKG results ----- //

// encryptData: Takes compositePublicKey
export async function encryptData(message: string, compositePublicKey: Uint8Array): Promise<Uint8Array> {
    const ephemeralPrivBytes = utils.randomPrivateKey();
    const ephemeralPrivScalar = utils.normPrivateKeyToScalar(ephemeralPrivBytes);
    const ephemeralPubPoint = G.multiply(ephemeralPrivScalar);
    const ephemeralPubKeyBytes = ephemeralPubPoint.toRawBytes(true);

    const sharedPoint = Point.fromHex(compositePublicKey).multiply(ephemeralPrivScalar);
    const sharedSecretBytes = sharedPoint.toRawBytes(true);
    const encryptionKey = await hashBytes(sharedSecretBytes);

    const messageBuffer = Buffer.from(message, 'utf8');
    const ciphertext = Buffer.alloc(messageBuffer.length);
    for (let i = 0; i < messageBuffer.length; i++) {
        ciphertext[i] = messageBuffer[i]! ^ encryptionKey[i % encryptionKey.length]!;
    }
    return Buffer.concat([ephemeralPubKeyBytes, ciphertext]);
}

// getSharesForReveal: Takes FinalShareData[] retrieved from successful keyholders
export function getSharesForReveal(
    finalShareData: FinalShareData[],
    revealingIds: string[],
    threshold: number
): RevealedShare[] {
    const revealedSharesMap: Map<string, RevealedShare> = new Map();
    for (const id of revealingIds) {
        const holderShare = finalShareData.find(s => s.id === id);
        if (holderShare) {
            revealedSharesMap.set(id, {
                idNum: holderShare.idNum,
                share: bigintToBytes(holderShare.finalShare)
            });
        }
    }
    if (revealedSharesMap.size < threshold) {
        throw new Error(`Insufficient valid keyholder IDs provided for reveal (${revealedSharesMap.size} < ${threshold})`);
    }
    return Array.from(revealedSharesMap.values()).slice(0, threshold);
}

// reconstructPrivateKey: Takes RevealedShare[]
export function reconstructPrivateKey(
    revealedShares: RevealedShare[],
    threshold: number
): Uint8Array {
    if (revealedShares.length < threshold) {
        throw new Error(`Insufficient shares (${revealedShares.length}) to reconstruct key (threshold ${threshold}).`);
    }
    const points: { x: bigint; y: bigint }[] = revealedShares
        .slice(0, threshold)
        .map(share => ({
            x: share.idNum,
            y: utils.normPrivateKeyToScalar(ensureValidPrivateKey(share.share))
        }));
    const reconstructedSecretBigInt = lagrangeInterpolateAtZero(points);
    const reconstructedSecretBytes = bigintToBytes(reconstructedSecretBigInt);
    return ensureValidPrivateKey(reconstructedSecretBytes);
}

// decryptDataWithReconstructedKey: Takes reconstructed private key
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
    const plain = Buffer.alloc(ciphertext.length);
    for (let i = 0; i < ciphertext.length; i++) {
        plain[i] = ciphertext[i]! ^ decryptionKey[i % decryptionKey.length]!;
    }
    return plain.toString('utf8');
}
