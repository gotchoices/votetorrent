# Vote Privacy Implementation Plan

## Overview

This document outlines the comprehensive plan for implementing vote privacy in the VoteTorrent system using threshold encryption and mix-net protocols. This ensures that individual votes remain secret while maintaining verifiability and auditability.

## Background

From `doc/election.md`, the current design includes:
- **Keyholders**: Multiple parties who hold election-specific key pairs
- **Threshold Requirement**: A minimum number of keyholders must release their private keys to decrypt votes
- **Vote Blocks**: Groups of votes bundled together for privacy (prevents linking voter to specific vote)
- **Mix-Net Shuffling**: Blocks are shuffled to further anonymize the vote-to-voter relationship

## Goals

1. **Ballot Secrecy**: No party can decrypt individual votes before all required keyholders release their keys
2. **Verifiability**: Voters can verify their vote was included in the final tally
3. **Auditability**: Anyone can verify the election results after key release
4. **No Single Point of Failure**: Requires threshold of keyholders (not all) to decrypt
5. **Resistance to Coercion**: Even keyholders cannot decrypt until threshold is met

## Architecture Components

### 1. Threshold Encryption System

#### 1.1 Elliptic Curve Threshold Cryptography
We'll use **Shamir's Secret Sharing** combined with **ElGamal encryption** on secp256k1:

**Why this approach?**
- Compatible with existing secp256k1 infrastructure
- Proven secure threshold scheme
- Efficient implementation available
- No trusted dealer needed (using Distributed Key Generation)

**Key Generation Flow:**
```typescript
// Each keyholder generates a polynomial of degree (t-1)
// where t is the threshold
interface KeyholderPolynomial {
  coefficients: bigint[];  // [a0, a1, a2, ..., a(t-1)]
  degree: number;          // t - 1
}

// Each keyholder creates shares for all other keyholders
interface KeyShare {
  keyholderIndex: number;
  shareValue: bigint;      // P(i) where P is the polynomial
  commitment: string[];    // Pedersen commitments for verification
}

// The combined public key is derived without revealing individual secrets
interface ElectionPublicKey {
  publicKey: string;       // Hex-encoded secp256k1 public key
  keyholderCount: number;
  threshold: number;
  commitments: string[][];  // From all keyholders for verification
}
```

#### 1.2 Distributed Key Generation (DKG) Protocol

**Phase 1: Commitment**
```typescript
/**
 * Each keyholder i generates:
 * - Random polynomial P_i(x) = a_i0 + a_i1*x + ... + a_i(t-1)*x^(t-1)
 * - Secret share: s_i = a_i0 (the constant term)
 * - Commitments: C_ij = g^(a_ij) for j = 0...(t-1)
 */
async function generateKeyholderCommitment(
  keyholderIndex: number,
  threshold: number
): Promise<{
  polynomial: KeyholderPolynomial;
  commitments: string[];  // Pedersen commitments
  shares: Map<number, KeyShare>;  // Shares for other keyholders
}>;
```

**Phase 2: Share Distribution**
```typescript
/**
 * Each keyholder i sends P_i(j) to keyholder j
 * Recipients verify shares against commitments
 */
async function verifyReceivedShare(
  share: KeyShare,
  commitments: string[]
): Promise<boolean>;
```

**Phase 3: Public Key Derivation**
```typescript
/**
 * Combined public key Y = Π(C_i0) = g^(Σs_i)
 * Each keyholder can compute this independently
 */
async function deriveElectionPublicKey(
  allCommitments: string[][]
): Promise<ElectionPublicKey>;
```

### 2. Vote Encryption

#### 2.1 Vote Entry Encryption

```typescript
/**
 * Vote entry structure (encrypted)
 */
interface EncryptedVoteEntry {
  // Encrypted ballot answers
  ciphertext: {
    c1: string;  // g^r (ephemeral public key)
    c2: string;  // M * Y^r (encrypted message)
  };

  // Vote nonce (public, for voter verification)
  nonce: string;

  // Zero-knowledge proof that encryption is valid
  proof: EncryptionProof;
}

/**
 * Voter entry structure (links to registration)
 */
interface VoterEntry {
  // Public registrant key
  registrantKey: string;

  // Registration CIDs
  publicCID: string;
  privateCID?: string;

  // Optional metadata
  metadata?: {
    location?: string;
    deviceId?: string;
    deviceAttestation?: string;
  };

  // Signature of vote entry CID + ballot CID
  signature: Signature;
}

/**
 * Vote block structure
 */
interface VoteBlock {
  blockId: string;
  electionSid: SID;
  ballotSid: SID;

  // Encrypted votes and voter entries (same count)
  votes: EncryptedVoteEntry[];
  voters: VoterEntry[];

  // Block metadata
  timestamp: Timestamp;
  poolCoordinator: string;  // Multiaddress
}
```

#### 2.2 Encryption Implementation

```typescript
/**
 * Encrypt a vote using ElGamal encryption
 *
 * @param voteData - Serialized vote answers
 * @param electionPublicKey - Combined public key from all keyholders
 * @param nonce - Random vote nonce for verification
 * @returns Encrypted vote entry with proof
 */
async function encryptVote(
  voteData: VoteAnswers,
  electionPublicKey: ElectionPublicKey,
  nonce: string
): Promise<EncryptedVoteEntry> {
  // 1. Serialize vote data
  const message = serializeVoteData(voteData);

  // 2. Generate random ephemeral key r
  const r = generateRandomScalar();

  // 3. Compute ElGamal ciphertext
  // c1 = g^r
  const c1 = scalarMult(GENERATOR, r);

  // c2 = M * Y^r (where Y is the election public key)
  const Yr = scalarMult(electionPublicKey.publicKey, r);
  const c2 = pointAdd(message, Yr);

  // 4. Generate zero-knowledge proof
  const proof = generateEncryptionProof(message, r, electionPublicKey);

  return {
    ciphertext: { c1: pointToHex(c1), c2: pointToHex(c2) },
    nonce,
    proof
  };
}

/**
 * Vote answer serialization
 */
interface VoteAnswers {
  ballotSid: SID;
  answers: Record<string, VoteAnswer>;  // questionCode -> answer
}

type VoteAnswer =
  | { type: 'select'; values: string[] }
  | { type: 'rank'; ranking: string[] }
  | { type: 'score'; scores: Record<string, number> }
  | { type: 'text'; text: string };

function serializeVoteData(vote: VoteAnswers): Buffer {
  // Deterministic serialization for encryption
  return Buffer.from(JSON.stringify(vote, Object.keys(vote).sort()));
}
```

### 3. Mix-Net Implementation

#### 3.1 Verifiable Shuffle Protocol

We'll use a **re-encryption mix-net** where each mix node:
1. Re-encrypts all vote blocks with fresh randomness
2. Shuffles the re-encrypted blocks
3. Provides zero-knowledge proof of correct shuffle

**Mix Node Operations:**
```typescript
/**
 * Mix node configuration
 */
interface MixNode {
  nodeId: string;
  publicKey: string;
  multiaddress: string;
}

/**
 * Re-encrypt and shuffle vote blocks
 *
 * Uses Wikström's proof of shuffle
 */
async function mixVoteBlocks(
  blocks: VoteBlock[],
  electionPublicKey: ElectionPublicKey,
  mixNodePrivateKey: string
): Promise<{
  shuffled: VoteBlock[];
  proof: ShuffleProof;
}> {
  // 1. Re-encrypt each vote in each block
  const reencrypted = await Promise.all(
    blocks.map(block => reencryptBlock(block, electionPublicKey))
  );

  // 2. Shuffle blocks and votes within blocks
  const shuffled = shuffleBlocks(reencrypted);

  // 3. Generate proof of correct shuffle
  const proof = await generateShuffleProof(
    blocks,
    shuffled,
    electionPublicKey,
    mixNodePrivateKey
  );

  return { shuffled, proof };
}

/**
 * Re-encrypt a vote block with fresh randomness
 */
async function reencryptBlock(
  block: VoteBlock,
  electionPublicKey: ElectionPublicKey
): Promise<VoteBlock> {
  const reencryptedVotes = await Promise.all(
    block.votes.map(vote => reencryptVote(vote, electionPublicKey))
  );

  return {
    ...block,
    votes: reencryptedVotes
  };
}

/**
 * Re-encrypt a single vote with fresh randomness
 *
 * ElGamal re-encryption: (c1, c2) -> (c1 * g^r', c2 * Y^r')
 */
async function reencryptVote(
  vote: EncryptedVoteEntry,
  electionPublicKey: ElectionPublicKey
): Promise<EncryptedVoteEntry> {
  // Generate fresh randomness
  const r_prime = generateRandomScalar();

  // Re-encrypt
  const c1 = pointFromHex(vote.ciphertext.c1);
  const c2 = pointFromHex(vote.ciphertext.c2);

  const c1_new = pointAdd(c1, scalarMult(GENERATOR, r_prime));
  const c2_new = pointAdd(c2, scalarMult(electionPublicKey.publicKey, r_prime));

  // Generate new proof
  const proof = generateReencryptionProof(vote, r_prime, electionPublicKey);

  return {
    ciphertext: {
      c1: pointToHex(c1_new),
      c2: pointToHex(c2_new)
    },
    nonce: vote.nonce,  // Nonce stays the same
    proof
  };
}
```

#### 3.2 Shuffle Proof (Wikström)

```typescript
/**
 * Zero-knowledge proof that shuffle was performed correctly
 *
 * Based on Wikström's "A Commitment-Consistent Proof of a Shuffle"
 */
interface ShuffleProof {
  // Commitment to permutation
  commitments: string[];

  // Challenge from Fiat-Shamir heuristic
  challenge: string;

  // Response values
  responses: string[];

  // Auxiliary proof data
  auxiliary: {
    permutationCommitment: string;
    reencryptionRandomness: string[];
  };
}

async function generateShuffleProof(
  inputBlocks: VoteBlock[],
  outputBlocks: VoteBlock[],
  electionPublicKey: ElectionPublicKey,
  mixNodePrivateKey: string
): Promise<ShuffleProof> {
  // Implementation of Wikström proof
  // (Detailed implementation would go here)

  // This proves:
  // 1. Output is a permutation of input
  // 2. Each output is a valid re-encryption of some input
  // 3. No votes were added, removed, or modified

  throw new Error('Not yet implemented');
}

async function verifyShuffleProof(
  inputBlocks: VoteBlock[],
  outputBlocks: VoteBlock[],
  proof: ShuffleProof,
  electionPublicKey: ElectionPublicKey
): Promise<boolean> {
  // Verify the zero-knowledge proof
  throw new Error('Not yet implemented');
}
```

### 4. Threshold Decryption

#### 4.1 Partial Decryption by Keyholders

```typescript
/**
 * Keyholder's partial decryption of a vote
 */
interface PartialDecryption {
  keyholderIndex: number;
  decryptionShare: string;  // c1^(secret_share_i)
  proof: DecryptionProof;   // Proof of correct decryption
}

/**
 * Each keyholder computes their decryption share
 */
async function computePartialDecryption(
  encryptedVote: EncryptedVoteEntry,
  keyholderSecretShare: bigint,
  keyholderIndex: number
): Promise<PartialDecryption> {
  const c1 = pointFromHex(encryptedVote.ciphertext.c1);

  // Compute c1^(secret_share_i)
  const share = scalarMult(c1, keyholderSecretShare);

  // Generate proof of correct decryption
  const proof = generateDecryptionProof(
    c1,
    share,
    keyholderSecretShare,
    keyholderIndex
  );

  return {
    keyholderIndex,
    decryptionShare: pointToHex(share),
    proof
  };
}
```

#### 4.2 Vote Reconstruction

```typescript
/**
 * Combine partial decryptions to recover plaintext vote
 *
 * Uses Lagrange interpolation
 */
async function reconstructVote(
  encryptedVote: EncryptedVoteEntry,
  partialDecryptions: PartialDecryption[],
  threshold: number
): Promise<VoteAnswers> {
  // Verify we have enough shares
  if (partialDecryptions.length < threshold) {
    throw new Error(`Need ${threshold} shares, got ${partialDecryptions.length}`);
  }

  // Verify all proofs
  for (const pd of partialDecryptions) {
    const valid = await verifyDecryptionProof(
      encryptedVote,
      pd,
      threshold
    );
    if (!valid) {
      throw new Error(`Invalid proof from keyholder ${pd.keyholderIndex}`);
    }
  }

  // Compute Lagrange coefficients
  const indices = partialDecryptions.map(pd => pd.keyholderIndex);
  const lagrange = computeLagrangeCoefficients(indices, threshold);

  // Combine shares: Π(share_i^λ_i) where λ_i is Lagrange coefficient
  let combined = IDENTITY_POINT;
  for (let i = 0; i < partialDecryptions.length; i++) {
    const share = pointFromHex(partialDecryptions[i].decryptionShare);
    const weighted = scalarMult(share, lagrange[i]);
    combined = pointAdd(combined, weighted);
  }

  // Decrypt: M = c2 / (c1^secret) = c2 / combined
  const c2 = pointFromHex(encryptedVote.ciphertext.c2);
  const message = pointSubtract(c2, combined);

  // Deserialize vote data
  const voteData = deserializeVoteData(pointToBuffer(message));

  return voteData;
}

/**
 * Lagrange interpolation coefficients
 */
function computeLagrangeCoefficients(
  indices: number[],
  threshold: number
): bigint[] {
  const coefficients: bigint[] = [];

  for (let i = 0; i < indices.length; i++) {
    let numerator = BigInt(1);
    let denominator = BigInt(1);

    for (let j = 0; j < indices.length; j++) {
      if (i !== j) {
        numerator *= BigInt(indices[j]);
        denominator *= BigInt(indices[j] - indices[i]);
      }
    }

    // Compute modular inverse
    const coefficient = modInverse(numerator * denominator, CURVE_ORDER);
    coefficients.push(coefficient);
  }

  return coefficients;
}
```

### 5. Zero-Knowledge Proofs

#### 5.1 Encryption Correctness Proof

```typescript
/**
 * Proof that encrypted vote contains valid ballot answers
 *
 * Without revealing the actual vote
 */
interface EncryptionProof {
  // Proof type identifier
  type: 'encryption_validity';

  // Schnorr-like proof components
  commitment: string;
  challenge: string;
  response: string;
}

async function generateEncryptionProof(
  message: Buffer,
  randomness: bigint,
  electionPublicKey: ElectionPublicKey
): Promise<EncryptionProof> {
  // Generate Schnorr proof that ciphertext is well-formed
  // Proves knowledge of (message, randomness) such that:
  // c1 = g^r and c2 = M * Y^r

  throw new Error('Not yet implemented');
}
```

#### 5.2 Decryption Correctness Proof

```typescript
/**
 * Proof that partial decryption was computed correctly
 */
interface DecryptionProof {
  type: 'decryption_validity';
  commitment: string;
  challenge: string;
  response: string;
}

async function generateDecryptionProof(
  c1: Point,
  decryptionShare: Point,
  secretShare: bigint,
  keyholderIndex: number
): Promise<DecryptionProof> {
  // Prove: decryptionShare = c1^(secretShare)
  // Without revealing secretShare

  throw new Error('Not yet implemented');
}
```

## Implementation Phases

### Phase 1: Research & Design (2-3 weeks)
- [ ] **Study threshold cryptography libraries**
  - Evaluate existing TypeScript/JavaScript implementations
  - Consider: `@noble/curves` extensions, `tss-lib`, custom implementation
- [ ] **Study mix-net implementations**
  - Research verifiable shuffle algorithms (Wikström, Neff, Groth)
  - Evaluate proof systems (Bulletproofs, SNARKs, Sigma protocols)
- [ ] **Design keyholder DKG protocol**
  - Define message format for key generation rounds
  - Design pub-sub topics for coordination
  - Plan for Byzantine fault tolerance
- [ ] **Design vote block encryption format**
  - Define ciphertext structure
  - Plan for metadata (nonce, proofs, timestamps)
- [ ] **Design mix-net coordination**
  - Select mix nodes (deterministic? volunteer-based? authority-run?)
  - Define shuffle ordering and synchronization
- [ ] **Security analysis**
  - Threat model review
  - Attack vector analysis
  - Coercion resistance evaluation

### Phase 2: Core Cryptography (3-4 weeks)
- [ ] **Implement threshold key generation**
  - DKG protocol implementation
  - Pedersen commitments
  - Share distribution and verification
- [ ] **Implement ElGamal encryption**
  - Vote encryption functions
  - Serialization/deserialization
  - Error handling
- [ ] **Implement threshold decryption**
  - Partial decryption computation
  - Lagrange interpolation
  - Vote reconstruction
- [ ] **Implement zero-knowledge proofs**
  - Encryption validity proofs
  - Decryption validity proofs
  - Proof verification
- [ ] **Testing**
  - Unit tests for all cryptographic operations
  - Test vectors from academic papers
  - Property-based testing (QuickCheck-style)

### Phase 3: Mix-Net Implementation (2-3 weeks)
- [ ] **Implement re-encryption**
  - Fresh randomness generation
  - Re-encryption of vote blocks
- [ ] **Implement shuffle**
  - Permutation generation
  - Block and vote shuffling
- [ ] **Implement shuffle proof**
  - Wikström proof generation
  - Proof verification
  - Optimization for large vote sets
- [ ] **Mix-net coordination protocol**
  - Mix node selection
  - Sequential mixing
  - Proof chain validation
- [ ] **Testing**
  - Shuffle correctness tests
  - Proof soundness tests
  - Performance benchmarks

### Phase 4: Integration (2-3 weeks)
- [ ] **Vote encryption integration**
  - Update `VoteEngine` to encrypt votes
  - Update vote block negotiation
  - Update IPFS publishing
- [ ] **Keyholder workflow**
  - Key generation UI in Authority App
  - Key storage (encrypted with biometric key)
  - Key release workflow
- [ ] **Tallying integration**
  - Collect partial decryptions from keyholders
  - Reconstruct votes
  - Update tally computation
- [ ] **Verification integration**
  - Verify vote encryption proofs
  - Verify shuffle proofs
  - Verify decryption proofs
- [ ] **Database schema updates**
  - Store encrypted votes
  - Store keyholder information
  - Store proofs
- [ ] **Testing**
  - Integration tests
  - End-to-end election simulation
  - Multi-device testing

### Phase 5: Performance & Optimization (1-2 weeks)
- [ ] **Batch operations**
  - Batch encryption/decryption
  - Parallel proof generation
- [ ] **Proof optimization**
  - Aggregate proofs where possible
  - Optimize proof verification
- [ ] **Caching strategy**
  - Cache verified proofs
  - Cache intermediate computations
- [ ] **Benchmarking**
  - Measure encryption/decryption performance
  - Measure proof generation/verification
  - Identify bottlenecks

### Phase 6: Security Audit & Documentation (2 weeks)
- [ ] **Internal security review**
  - Code review with security focus
  - Penetration testing
  - Coercion resistance analysis
- [ ] **External audit (recommended)**
  - Professional cryptography audit
  - Formal verification (if possible)
- [ ] **Documentation**
  - API documentation
  - Protocol specification
  - Security assumptions
  - Threat model
  - User guides (keyholder workflow)

## Technical Dependencies

### Libraries to Evaluate

1. **@noble/curves** (Already in use)
   - Excellent foundation for elliptic curve operations
   - May need extension for threshold operations

2. **tss-lib** or **@safeheron/crypto-bls-wasm**
   - Mature threshold signature schemes
   - May need adaptation for threshold encryption

3. **Custom Implementation**
   - Full control over implementation
   - Can optimize for React Native
   - More audit burden

### New Dependencies

```json
{
  "dependencies": {
    "@noble/curves": "^1.6.0",  // Already present
    "@noble/hashes": "^1.5.0",  // Already present

    // Potential additions:
    "@tss-lib/threshold": "^1.0.0",  // If using existing library
    "bigint-mod-arith": "^3.3.0",    // Modular arithmetic helpers
    "sparse-array": "^1.3.2"          // For efficient Lagrange interpolation
  }
}
```

## Database Schema Extensions

### New Tables

```sql
-- Keyholder records
CREATE TABLE Keyholder (
  ElectionSid SID NOT NULL,
  KeyholderIndex INTEGER NOT NULL,
  UserSid SID NOT NULL,
  PublicKey TEXT NOT NULL,
  Commitments TEXT NOT NULL,  -- JSON array of Pedersen commitments
  AcceptedAt TIMESTAMP NOT NULL,

  PRIMARY KEY (ElectionSid, KeyholderIndex),
  FOREIGN KEY (ElectionSid) REFERENCES Election(Sid),
  FOREIGN KEY (UserSid) REFERENCES User(Sid)
);

-- Election public key
CREATE TABLE ElectionKey (
  ElectionSid SID PRIMARY KEY,
  PublicKey TEXT NOT NULL,
  Threshold INTEGER NOT NULL,
  KeyholderCount INTEGER NOT NULL,
  AllCommitments TEXT NOT NULL,  -- JSON array of all commitments

  FOREIGN KEY (ElectionSid) REFERENCES Election(Sid)
);

-- Keyholder partial decryptions
CREATE TABLE PartialDecryption (
  ElectionSid SID NOT NULL,
  VoteBlockId TEXT NOT NULL,
  VoteIndex INTEGER NOT NULL,
  KeyholderIndex INTEGER NOT NULL,
  DecryptionShare TEXT NOT NULL,
  Proof TEXT NOT NULL,  -- JSON DecryptionProof
  ReleasedAt TIMESTAMP NOT NULL,

  PRIMARY KEY (ElectionSid, VoteBlockId, VoteIndex, KeyholderIndex),
  FOREIGN KEY (ElectionSid) REFERENCES Election(Sid)
);

-- Mix-net shuffle records
CREATE TABLE Shuffle (
  ElectionSid SID NOT NULL,
  MixRound INTEGER NOT NULL,
  MixNodeId TEXT NOT NULL,
  InputBlocks TEXT NOT NULL,   -- JSON array of block IDs
  OutputBlocks TEXT NOT NULL,  -- JSON array of shuffled block IDs
  Proof TEXT NOT NULL,         -- JSON ShuffleProof
  Timestamp TIMESTAMP NOT NULL,

  PRIMARY KEY (ElectionSid, MixRound),
  FOREIGN KEY (ElectionSid) REFERENCES Election(Sid)
);
```

### Updated Tables

```sql
-- Add encryption fields to existing VoteBlock structure
ALTER TABLE VoteBlock ADD COLUMN Encrypted BOOLEAN DEFAULT 1;
ALTER TABLE VoteBlock ADD COLUMN EncryptionProof TEXT;  -- JSON proof

-- Vote entries now store encrypted data
ALTER TABLE VoteEntry ADD COLUMN Ciphertext TEXT NOT NULL;  -- JSON {c1, c2}
ALTER TABLE VoteEntry ADD COLUMN EncryptionProof TEXT NOT NULL;  -- JSON proof
```

## Security Considerations

### Threat Model

1. **Malicious Keyholders**
   - Cannot decrypt alone (need threshold)
   - Partial decryptions are verifiable
   - Mitigation: Require t-of-n threshold with n >> t

2. **Malicious Mix Nodes**
   - Cannot modify votes (re-encryption is verifiable)
   - Cannot link votes to voters (if enough honest mix nodes)
   - Mitigation: Multiple mix rounds, diverse mix node operators

3. **Network Adversaries**
   - Cannot decrypt votes (properly encrypted)
   - Cannot link votes to voters (mix-net)
   - Mitigation: Use authenticated channels for DKG

4. **Coercion Attacks**
   - Voter cannot prove how they voted (receipt-freeness challenging)
   - Note: Full receipt-freeness may require additional protocols
   - Mitigation: Document limitations, consider future enhancements

5. **Keyholder Collusion**
   - If >= threshold keyholders collude, can decrypt early
   - Mitigation: Geographic/organizational diversity, reputation systems

### Assumptions

1. **Honest Majority**: Assume < t keyholders are malicious
2. **Secure Channels**: DKG requires authenticated communication
3. **Tamper-Resistant Storage**: Keyholder devices secure key shares
4. **Timing Assumptions**: Threshold release happens after voting closes

## Testing Strategy

### Unit Tests
- [ ] Threshold key generation
- [ ] Vote encryption/decryption
- [ ] Zero-knowledge proof generation/verification
- [ ] Lagrange interpolation
- [ ] Mix-net shuffle and re-encryption

### Integration Tests
- [ ] Full DKG protocol across multiple keyholders
- [ ] Vote encryption → shuffle → decryption pipeline
- [ ] Keyholder key release coordination
- [ ] Tallying with threshold decryption

### Security Tests
- [ ] Test with malicious keyholders (< threshold)
- [ ] Test with invalid proofs (should be rejected)
- [ ] Test with insufficient keyholder shares
- [ ] Timing attack resistance

### Performance Tests
- [ ] Encryption performance (target: < 100ms per vote)
- [ ] Decryption performance (target: < 500ms per vote)
- [ ] Shuffle performance (target: handle 10,000 votes)
- [ ] Proof verification performance

## Success Criteria

1. **Functional Requirements**
   - ✅ Votes encrypted with threshold public key
   - ✅ Decryption requires t-of-n keyholders
   - ✅ Mix-net successfully anonymizes votes
   - ✅ All proofs verify correctly
   - ✅ Voters can verify their vote was counted

2. **Security Requirements**
   - ✅ No single keyholder can decrypt
   - ✅ Mix-net prevents vote-to-voter linking
   - ✅ Invalid proofs are rejected
   - ✅ Coercion resistance documented

3. **Performance Requirements**
   - ✅ Vote encryption < 100ms
   - ✅ Vote decryption < 500ms
   - ✅ Handles elections with 10,000+ votes
   - ✅ Mobile device friendly (no excessive battery/CPU)

4. **Usability Requirements**
   - ✅ Keyholder workflow is clear and documented
   - ✅ Error messages are actionable
   - ✅ Verification process is user-friendly

## Estimated Timeline

- **Total Duration**: 12-17 weeks (3-4 months)
- **Team Size**: 1-2 developers with cryptography experience
- **Critical Path**: Phase 2 (Core Cryptography) → Phase 3 (Mix-Net) → Phase 4 (Integration)

## Open Questions

1. **Mix Node Selection**: How are mix nodes chosen? Authority-run? Volunteer-based? Random selection from network?

2. **Receipt-Freeness**: Do we need full receipt-freeness (preventing vote selling)? This may require additional protocols like Benaloh challenges.

3. **Key Recovery**: What happens if a keyholder loses their device? Should we have backup key recovery mechanisms?

4. **Verifiability vs Privacy**: How do we balance individual verifiability with ballot secrecy? Consider universal vs individual verifiability trade-offs.

5. **Scalability**: For very large elections (millions of votes), do we need hierarchical mixing or batch proofs?

6. **Mobile Constraints**: Can we perform DKG on mobile devices efficiently? May need dedicated keyholder devices.

## References

### Academic Papers
- Shamir, A. (1979). "How to Share a Secret"
- Pedersen, T. P. (1991). "A Threshold Cryptosystem without a Trusted Party"
- Wikström, D. (2009). "A Commitment-Consistent Proof of a Shuffle"
- Groth, J. (2010). "A Verifiable Secret Shuffle of Homomorphic Encryptions"

### Implementation References
- @noble/curves: https://github.com/paulmillr/noble-curves
- tss-lib: https://github.com/binance-chain/tss-lib
- Helios Voting: https://vote.heliosvoting.org/

### Standards
- NIST SP 800-57: Key Management
- ISO/IEC 9796-3: Digital signatures with message recovery

## Conclusion

Implementing vote privacy is a substantial undertaking requiring:
- Deep cryptographic expertise
- Careful protocol design
- Extensive testing and validation
- Potential external security audit

However, it is essential for a production-ready voting system to ensure ballot secrecy while maintaining verifiability. This plan provides a roadmap for achieving these goals in a systematic, secure manner.
