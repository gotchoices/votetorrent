// src/crypto/dkg.ts — dealerless DKG wrapper for keyholder key custody (D-13, D-16, D-17, D-14).
//
// ---------------------------------------------------------------------------
// Purpose and cited specifications
// ---------------------------------------------------------------------------
//
// This module is a thin, pure wrapper over noble `@noble/curves` secp256k1
// FROST (`abstract/frost.js`, re-exported as `secp256k1_FROST` from
// `secp256k1.js`). It implements:
//
//   - a Pedersen/Feldman-style Distributed Key Generation with NO trusted
//     dealer (D-16), built on noble's split-round `DKG.round1/round2/round3`
//     API (RFC 9591 leaves DKG itself out of scope — Appendix C only
//     specifies dealer/VSS key generation; the split-round shape here
//     mirrors the frost-rs interoperability API that noble's own test suite
//     targets);
//   - an R0 commit-reveal hash binding `electionId`/`revision`/`attempt`,
//     so a round-1 package cannot be replayed into a different attempt;
//   - per-recipient share ciphertexts (ECIES-style, SEC 1 §5.1 shape) with
//     HKDF-SHA256 (RFC 5869) key derivation and AES-256-GCM (NIST SP
//     800-38D) — not an HPKE ciphersuite, since RFC 9591 registers no
//     secp256k1 KEM for RFC 9180;
//   - complaint-evidence verification that returns an attributable verdict
//     wherever the protocol allows one (see "Security review" below for the
//     documented exception, residual A6);
//   - `validateSecret`-filtered, k-of-n reconstruction via `combineSecret`
//     with an `s*G == Y` assertion (D-17, D-14), honoring
//     `2 <= k <= n` everywhere a threshold enters (D-16).
//
// Bias discussion (residual A7, Gennaro-Jarecki-Krawczyk-Rabin, J.
// Cryptology 2007): Joint-Feldman DKG — which is what FROST's DKG is — does
// not by itself yield a uniform key against a rushing or aborting
// adversary. See "Security review (D-25)" below.
//
// ---------------------------------------------------------------------------
// Purity rules (D-25, three-runtime safety: Node / Hermes / browser)
// ---------------------------------------------------------------------------
//
// This module follows `src/bootstrap/sealed-payload.ts`'s purity discipline
// exactly:
//
//   - no `node:` import, no bare 'crypto' / 'fs' / 'path' / 'buffer' import,
//   - no reference to Node's byte-buffer type, no CommonJS dynamic require,
//   - no import of `../utils.js` (would drag the Quereus layer in),
//   - imports come ONLY from `@noble/curves/secp256k1.js`,
//     `@noble/curves/abstract/frost.js` (type-only), `@noble/hashes/sha2.js`,
//     `@noble/hashes/hkdf.js`, `@noble/hashes/utils.js`, `@noble/ciphers/aes.js`
//     and `@noble/ciphers/utils.js`.
//
// Randomness comes from noble's `randomBytes` / `secp256k1.utils.randomSecretKey`
// only, which read `crypto.getRandomValues` — present on Hermes via
// `react-native-get-random-values` (`polyfills.bootstrap.js:26-31`), and
// natively in Node and browsers. No exported function accepts a caller RNG
// or a caller-supplied polynomial secret: production randomness only.
//
// ---------------------------------------------------------------------------
// Consumer notes (copied here per the plan's <interfaces> section)
// ---------------------------------------------------------------------------
//
// - 62-17 stores the R1 package, the R0 commit hex, `EncryptedShare[]` and
//   `ComplaintEvidence` as signed row payloads. `serializeDkgSecret` output
//   is SECRET (polynomial coefficients) and goes only to `IKeyVault`.
// - 62-20 needs `groupCommitments`. Get them either from a stored
//   `ElectionKey`/R4 payload or by recomputing
//   `deriveGroupCommitments(qualifiedR1Packages)`. The recomputed value
//   must equal what round3 produced, and a test in `crypto-dkg.spec.ts`
//   proves this.
// - `dkgIdentifierForUser(userId)` makes released shares self-identifying,
//   and the identifier stays stable across attempts and qualified-set
//   changes.
// - This plan edits NO barrel (`src/index.ts`, `src/rn-entry.ts`,
//   `src/browser-entry.ts`, `src/crypto/index.ts`). Consumers import
//   `../crypto/dkg.js` directly.
// - Joint-key shapes match 62-04's block cipher: `DkgKeyMaterial.groupPublicKey`
//   is Y as 66-char lowercase hex (`encryptBlockContent`'s `jointPublicKey`),
//   and `ReconstructionResult.secretKey` is the 32-byte `Uint8Array`
//   `decryptBlockContent` takes. Both come straight from noble FROST output
//   (`commitments[0]` and `combineSecret`) — never re-encoded.
// - Known gate collision, flagged and not fixed here: 62-04's Task
//   acceptance greps `packages/vote-engine/src/crypto/*.ts` for
//   `secp256k1_FROST` expecting no match. This file legitimately uses it;
//   that gate is scoped to 62-04's own files and does not apply here.
//
// ---------------------------------------------------------------------------
// A deliberate departure from the Task 2 action text (recorded, not hidden)
// ---------------------------------------------------------------------------
//
// The plan's prose for `encryptShare` describes
// `salt = concatBytes(ephemeralPublicKey, recipientPublicKey)`. But
// `verifyComplaintEvidence`'s LOCKED signature
// (`ctx, threshold, participants, enc, dealerPkg, evidence`) carries no
// `recipientPublicKey` parameter, so a third party checking a complaint has
// no way to reconstruct a `recipientPublicKey`-dependent salt — which would
// make EVERY complaint verdict `unresolved`, including honest ones. That
// would contradict D-17 ("anyone... can reconstruct") and the behavior
// matrix's "honest dealer -> complainant-fault/share-valid" case. This is a
// Rule-1-class internal inconsistency in the action text versus the LOCKED
// `<interfaces>` block, which takes precedence. The fix applied here: the
// HKDF `salt` is `ephemeralPublicKey` alone. Because a fresh ephemeral key
// is drawn for every single `(dealer, recipient)` ciphertext, `ephemeralPublicKey`
// already uniquely binds the derivation to one encryption instance, so this
// preserves the intended domain separation without requiring a parameter
// the locked API does not carry.
//
// ---------------------------------------------------------------------------
// Security review (D-25) — dated 2026-10-01, 62-05 Task 3
// ---------------------------------------------------------------------------
//
// Adversarial review against a 14-item checklist, each with evidence (a test
// title that fails when the control is removed, or a grep/command output).
// ASVS L1: every HIGH finding is fixed before this section was written. None
// were found HIGH; see the findings table at the end.
//
//  1. No hand-rolled primitives.
//     `grep -vE '^\s*(//|\*|/\*)' dkg.ts | grep -cE "BigInt\(|Fn\.(mul|add|sub|inv|pow|div)\b"` -> 0.
//     `grep -vE '^\s*(//|\*|/\*)' dkg.ts | grep -c "\.add("` -> 1 (deriveGroupCommitments only).
//     All scalar/point algebra goes through `secp256k1_FROST` / `secp256k1.Point`.
//
//  2. Every dealer share is validated before use.
//     `dkgRound3` pre-checks every `received` entry with `verifyDealerShare`
//     against the matching `others` package BEFORE calling noble's `round3`.
//     Evidence: "crypto-dkg: round-3 blame attribution > one received share
//     altered gives invalid-share with dealer set to that dealer" (pinned by
//     negative control (g), which removes exactly this pre-check loop).
//
//  3. Released shares are filtered before `combineSecret`, and `s*G == Y` is
//     asserted after it.
//     Filter: "crypto-dkg: ... a bit-flipped P2 share fails
//     validateReleasedShare, and reconstructGroupSecret still recovers
//     group_secret_key over [P1, badP2, P3] with P2 rejected" and "3 valid
//     shares plus 1 bogus share reconstruct, with the bogus identifier
//     rejected" (pinned by negative control (a)).
//     Post-assertion: present in code (`derivedPublicKey` vs `groupPublicKey`
//     via `equalBytes`), REQUIRED by D-17's "the result is asserted s*G == Y
//     before it is returned". Negative control (b) finding: given control
//     (a)'s per-share Feldman check (RFC 9591 Appendix C.2 `vss_verify`) is
//     cryptographically BINDING on secp256k1 (cofactor 1, so every valid
//     curve point is in the prime-order subgroup; for a fixed commitment
//     vector and identifier there is EXACTLY ONE valid scalar, since
//     `s -> s*G` is injective on a prime-order group) and Lagrange
//     interpolation of `k` points consistent with one polynomial
//     deterministically recovers that exact polynomial's constant term,
//     NO adversarial `shares`/`groupCommitments`/`groupPublicKey` input can
//     make the post-assertion diverge from what the pre-filter already
//     proved, as long as control (a) stays active. Exhaustively checked:
//     length-mismatch padding (closed by `validateReleasedShare`'s own
//     `groupCommitments.length !== threshold` guard), share relabeling across
//     identifiers (closed by VSS uniqueness), over-counting beyond threshold
//     (over-determined-but-consistent systems still interpolate correctly).
//     Removing control (b) alone leaves the suite at 0 failing. This is
//     recorded as an INFO finding, not a vulnerability: the assertion is
//     correctness-required by D-17's own text and is retained as defense in
//     depth against a future regression in `validateReleasedShare` or an
//     accidental argument swap in a refactor — it is just not independently
//     triggerable by an external adversary today, which is a GOOD property of
//     a cryptographically sound VSS filter, not a gap.
//
//  4. Commit-reveal binds `electionId`/`revision`/`attempt`.
//     "crypto-dkg: commit-reveal (R0)" — 5 tests (commitment swap, attempt,
//     revision, electionId, PoK tamper). Pinned by negative control (f).
//
//  5. Share AAD binds `electionId`/`revision`/`attempt`/`dealer`/`recipient`.
//     "crypto-dkg-complaint: AAD binding" — 5 tests. Pinned by negative
//     control (d).
//
//  6. The key-commitment tag is compared in constant time with `equalBytes`.
//     `grep -c "equalBytes" dkg.ts` -> 5 (tag compares in `decryptShare` and
//     `verifyComplaintEvidence`, plus the group-key compare in
//     `reconstructGroupSecret`). Pinned by negative control (c).
//
//  7. The complaint verdict table is sound, and the A6 `unresolved` residual
//     is denial of service only.
//     "crypto-dkg-complaint: complaint verdicts" — 7 tests covering every
//     verdict/reason pair in the matrix, including the A6 case explicitly.
//     See residual A6 below.
//
//  8. `2 <= k <= n` holds everywhere a threshold enters.
//     "crypto-dkg: threshold bounds (D-16, 2 <= k <= n)" — 21 tests across
//     `assertDkgThreshold`, `dkgRound1` and `reconstructGroupSecret`. Pinned
//     by negative control (e).
//
//  9. No secret bytes appear in any error message.
//     "crypto-dkg-complaint: no secret leakage in DkgError messages".
//
// 10. Randomness comes from noble `randomBytes`/`randomSecretKey` only.
//     `grep -n "secret?:\|rng?:\|rng:" dkg.ts` -> no matches: no exported
//     function accepts a caller rng or a caller polynomial secret.
//
// 11. Zeroization is best-effort (`DKG.clean`), no erasure claim is made.
//     See the comment at the `DKG.clean` call site in `dkgRound3`.
//
// 12. `verifyRound1Package` relies on noble 2.2.0 internals (round2 not
//     re-running `validateSigners` against the real threshold), pinned by
//     the tampered-PoK blame test in "crypto-dkg: round-1 blame attribution".
//     MUST be re-verified on any `@noble/curves` bump (documented at the
//     function itself).
//
// 13. Hermes: the bigint math in `frost.js` and the multi-copy hazard are
//     guarded only in Node, via SC3/SC4 in `noble-dedupe-regression.spec.ts`.
//     The Hermes device KAT is PROOF DEBT, recorded here and tracked by
//     62-30 (D-23 style: code-complete, unverified on-device). Never claim
//     device proof for this module.
//
// 14. Bias residual A7 (Joint-Feldman DKG, Gennaro-Jarecki-Krawczyk-Rabin,
//     J. Cryptology 2007): FROST's DKG does not by itself yield a uniform
//     key against a rushing or aborting adversary. The R0 commit-reveal here
//     removes the RUSHING choice (a participant cannot choose its own R1
//     package after seeing others', because it already committed to a hash
//     of it), but a participant can still bias the group key by roughly one
//     bit per self-disqualifying abort-and-retry, bounded by 62-17's attempt
//     cap. GJKR's CT-RSA 2003 positive result (which removes even the abort
//     bias) applies to DL-reduction schemes like Schnorr signing, NOT to
//     ElGamal/ECIES-style encryption under the resulting public key Y — which
//     is exactly how this module's released shares and 62-04's block cipher
//     use Y. The residual is therefore documented as OPEN and surfaced to the
//     user/reviewer, never claimed safe. The named alternative, if this ever
//     needs closing, is full GJKR (Pedersen commitments plus a public
//     extraction/complaint phase) — not built here because it would be
//     additional hand-rolled protocol logic beyond what D-25 sanctions.
//
// Negative control results (temporarily mutate dkg.ts, run
// crypto-dkg.spec.ts + crypto-dkg-complaint.spec.ts, record the failing
// title(s), then `git checkout -- src/crypto/dkg.ts`):
//
//   (a) Skip the `validateReleasedShare` filter in `reconstructGroupSecret`.
//       RED: "a bit-flipped P2 share fails validateReleasedShare, and
//       reconstructGroupSecret still recovers group_secret_key over [P1,
//       badP2, P3] with P2 rejected"; "3 valid shares plus 1 bogus share
//       reconstruct, with the bogus identifier rejected". (2 failing)
//   (b) Remove the `s*G == Y` assertion.
//       GREEN (0 failing) — see item 3 above for the full algebraic proof of
//       why this is provably unreachable given (a), recorded as an INFO
//       finding rather than silently dropped.
//   (c) Skip the `keyCommitment` comparison in `decryptShare`.
//       RED: "decrypting with a different recipient private key throws
//       key-commitment-mismatch"; "a tampered keyCommitment throws
//       key-commitment-mismatch"; "a dealer-posted keyCommitment derived
//       from a different shared secret: ... (A6)". (3 failing)
//   (d) Drop `ctx.attempt` from the share AAD.
//       RED: "decrypting with ctx.attempt+1 throws share-decrypt-failed".
//       (1 failing)
//   (e) Relax `assertDkgThreshold` to `threshold >= 1`.
//       RED: "assertDkgThreshold(1, 3) throws threshold-out-of-range";
//       "dkgRound1 rejects threshold=1, participants=3"; "reconstructGroupSecret
//       rejects threshold=1, participants=3". (3 failing)
//   (f) Drop `ctx.attempt` from `commitRound1`.
//       RED: "verifyRound1Commit is false when ctx.attempt differs".
//       (1 failing)
//   (g) Skip the per-dealer pre-check in `dkgRound3`.
//       RED: "one received share altered gives invalid-share with dealer set
//       to that dealer" — fails because noble itself still throws, but an
//       UNATTRIBUTED `Error: invalid secret share`, not a `DkgError` with
//       `.dealer` set (exactly the predicted failure mode). (1 failing)
//
// Findings table (id, severity, status):
//
//   F-01 | INFO | accepted — control (b) is provably non-divergent given
//         control (a); the assertion stays as D-17-mandated defense in
//         depth. No fix needed; no HIGH/MEDIUM severity.
//
// No HIGH findings were raised by this review.
//
// Residuals (OPEN, not claimed safe):
//   A6 — complaint attribution without a DLEQ proof: a key-commitment tag
//        mismatch cannot distinguish a lying dealer from a lying complainant,
//        so the verdict is `unresolved`. Denial of service only (forces an
//        attempt restart), bounded by 62-17's attempt cap.
//   A7 — Joint-Feldman DKG bias under a rushing/aborting adversary (see
//        item 14 above). Roughly one bit of bias per self-disqualifying
//        abort-and-retry; bounded by 62-17's attempt cap; GJKR named as the
//        alternative if this needs closing later.
//
// Hermes device-KAT proof debt: this module's known-answer tests (RFC 9591
// E.5, frost-rs DKG vectors, SC3/SC4) run on Node only. No device KAT has
// been run on Hermes. Tracked for 62-30 in the D-23 "code-complete,
// unverified" style — never claim device proof from this review.

import { gcm } from '@noble/ciphers/aes.js'
import { equalBytes } from '@noble/ciphers/utils.js'
import type { DKG_Round1, DKG_Round2, DKG_Secret, FrostSecret } from '@noble/curves/abstract/frost.js'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** Point byte length (33-byte compressed secp256k1). */
const POINT_BYTES = 33
/** Scalar byte length (32-byte secp256k1 field element). */
const SCALAR_BYTES = 32
/** AES-GCM nonce length for share ciphertexts. */
const DKG_SHARE_NONCE_BYTES = 12
/** HKDF output length for both the share key and the key-commitment tag. */
const DKG_HKDF_BYTES = 32

const DKG_SHARE_KEY_INFO = utf8ToBytes('vt-dkg-share-key-v1')
const DKG_SHARE_COMMIT_INFO = utf8ToBytes('vt-dkg-share-commit-v1')

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DkgErrorCode =
  | 'threshold-out-of-range' | 'malformed-input' | 'duplicate-identifier' | 'invalid-round1'
  | 'invalid-share' | 'key-commitment-mismatch' | 'share-decrypt-failed'
  | 'insufficient-shares' | 'group-key-mismatch'

/**
 * Carries the error `code`, and optionally the `dealer` identifier being
 * blamed. Messages carry codes, identifiers and counts ONLY — never a byte
 * of share, scalar, coefficient or shared-secret material (T-62-05-08).
 */
export class DkgError extends Error {
  readonly code: DkgErrorCode
  readonly dealer?: string

  constructor (code: DkgErrorCode, message: string, dealer?: string) {
    super(message)
    this.name = 'DkgError'
    this.code = code
    if (dealer !== undefined) this.dealer = dealer
  }
}

// ---------------------------------------------------------------------------
// Public types (locked by <interfaces>)
// ---------------------------------------------------------------------------

export interface DkgContext { electionId: string, revision: number, attempt: number }
export interface DkgRound1Wire { identifier: string, commitment: string[], proofOfKnowledge: string }
export type DkgRound1Secret = DKG_Secret
export interface DkgReceivedShare { dealer: string, share: Uint8Array }
export interface DkgKeyMaterial {
  identifier: string
  signingShare: Uint8Array
  groupPublicKey: string
  groupCommitments: string[]
  verifyingShares: Record<string, string>
}
export interface EncryptedShare {
  v: 1
  dealer: string
  recipient: string
  ephemeralPublicKey: string
  nonce: string
  ciphertext: string
  keyCommitment: string
}
export interface ComplaintEvidence { dealer: string, recipient: string, sharedSecret: string }
export type ComplaintVerdict = 'dealer-fault' | 'complainant-fault' | 'unresolved'
export interface ComplaintResult {
  verdict: ComplaintVerdict
  reason: 'share-valid' | 'invalid-share' | 'undecryptable' | 'key-commitment-mismatch' | 'malformed-evidence'
}
export interface ReleasedShare { identifier: string, signingShare: string }
export interface ReconstructionResult { secretKey: Uint8Array, usedIdentifiers: string[], rejectedIdentifiers: string[] }

// ---------------------------------------------------------------------------
// Module-private decode/validate helpers (fail-closed, structural only)
// ---------------------------------------------------------------------------

function isHexOfByteLength (value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, 'i').test(value)
}

function isHex (value: unknown): value is string {
  return typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]*$/i.test(value)
}

function decodeHexFixed (value: unknown, byteLength: number, where: string): Uint8Array {
  if (!isHexOfByteLength(value, byteLength)) {
    throw new DkgError('malformed-input', `${where}: expected ${byteLength * 2}-char lowercase hex`)
  }
  return hexToBytes(value)
}

function decodeHex (value: unknown, where: string): Uint8Array {
  if (!isHex(value)) {
    throw new DkgError('malformed-input', `${where}: expected lowercase hex`)
  }
  return hexToBytes(value)
}

function decodeHexPoint (value: unknown, where: string): Uint8Array {
  return decodeHexFixed(value, POINT_BYTES, where)
}

function assertValidContext (ctx: DkgContext): void {
  if (
    ctx === null || typeof ctx !== 'object' ||
    typeof ctx.electionId !== 'string' || ctx.electionId.length === 0 ||
    !Number.isSafeInteger(ctx.revision) ||
    !Number.isSafeInteger(ctx.attempt)
  ) {
    throw new DkgError('malformed-input', 'DkgContext: electionId must be a non-empty string, revision and attempt must be safe integers')
  }
}

/** Decode a wire `DkgRound1Wire` into noble's raw `DKG_Round1` shape. Structural validation only. */
function decodeRound1Wire (pkg: DkgRound1Wire): DKG_Round1 {
  if (pkg === null || typeof pkg !== 'object') {
    throw new DkgError('malformed-input', 'DkgRound1Wire: must be an object')
  }
  if (!isHexOfByteLength(pkg.identifier, SCALAR_BYTES)) {
    throw new DkgError('malformed-input', 'DkgRound1Wire: identifier must be 64-char lowercase hex')
  }
  if (!Array.isArray(pkg.commitment) || pkg.commitment.length === 0) {
    throw new DkgError('malformed-input', 'DkgRound1Wire: commitment must be a non-empty array')
  }
  const commitment: Uint8Array[] = []
  for (const c of pkg.commitment) {
    if (!isHexOfByteLength(c, POINT_BYTES)) {
      throw new DkgError('malformed-input', 'DkgRound1Wire: each commitment element must be 66-char lowercase hex')
    }
    commitment.push(hexToBytes(c))
  }
  if (!isHexOfByteLength(pkg.proofOfKnowledge, POINT_BYTES + SCALAR_BYTES)) {
    throw new DkgError('malformed-input', 'DkgRound1Wire: proofOfKnowledge must be 130-char lowercase hex')
  }
  return {
    identifier: pkg.identifier,
    commitment,
    proofOfKnowledge: hexToBytes(pkg.proofOfKnowledge)
  } as DKG_Round1
}

function identifierToHex (identifier: bigint): string {
  return bytesToHex(secp256k1_FROST.utils.Fn.toBytes(identifier))
}

function shareAad (ctx: DkgContext, dealer: string, recipient: string): Uint8Array {
  return utf8ToBytes(JSON.stringify(['vt-dkg-share-v1', ctx.electionId, ctx.revision, ctx.attempt, dealer, recipient]))
}

// ---------------------------------------------------------------------------
// Threshold enforcement (D-16): a threshold of 1 lets any single keyholder
// decrypt alone, which contradicts the "no device ever holds the full key
// before release" requirement. The engine rule from the outline's
// discretion choices lives here. The `ElectionRevision.KeyholderThreshold`
// CHECK is deliberately NOT tightened by this plan.
// ---------------------------------------------------------------------------

export function assertDkgThreshold (threshold: number, participants: number): void {
  if (
    !Number.isSafeInteger(threshold) ||
    !Number.isSafeInteger(participants) ||
    threshold < 2 ||
    threshold > participants
  ) {
    throw new DkgError(
      'threshold-out-of-range',
      `assertDkgThreshold: requires a safe integer threshold with 2 <= threshold <= participants (got threshold=${String(threshold)}, participants=${String(participants)})`
    )
  }
}

// ---------------------------------------------------------------------------
// Identifiers and receiving keys
// ---------------------------------------------------------------------------

export function dkgIdentifierForUser (userId: string): string {
  return secp256k1_FROST.Identifier.derive(`vt-dkg-v1:${userId}`)
}

export function generateDkgReceivingKey (): { privateKey: Uint8Array, publicKey: string } {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
  return { privateKey, publicKey }
}

// ---------------------------------------------------------------------------
// Round 1 and commit-reveal (R0)
// ---------------------------------------------------------------------------

export function dkgRound1 (identifier: string, threshold: number, participants: number): { public: DkgRound1Wire, secret: DkgRound1Secret } {
  assertDkgThreshold(threshold, participants)
  if (!isHexOfByteLength(identifier, SCALAR_BYTES)) {
    throw new DkgError('malformed-input', 'dkgRound1: identifier must be 64-char lowercase hex')
  }
  const { public: pub, secret } = secp256k1_FROST.DKG.round1(identifier, { min: threshold, max: participants })
  return {
    public: {
      identifier: pub.identifier,
      commitment: pub.commitment.map((c) => bytesToHex(c)),
      proofOfKnowledge: bytesToHex(pub.proofOfKnowledge)
    },
    secret
  }
}

function round1CommitPreimage (ctx: DkgContext, pkg: DkgRound1Wire): Uint8Array {
  return utf8ToBytes(JSON.stringify([
    'vt-dkg-commit-v1', ctx.electionId, ctx.revision, ctx.attempt,
    pkg.identifier, pkg.commitment, pkg.proofOfKnowledge
  ]))
}

export function commitRound1 (ctx: DkgContext, pkg: DkgRound1Wire): string {
  assertValidContext(ctx)
  return bytesToHex(sha256(round1CommitPreimage(ctx, pkg)))
}

export function verifyRound1Commit (ctx: DkgContext, pkg: DkgRound1Wire, commitHex: string): boolean {
  try {
    assertValidContext(ctx)
    const expected = sha256(round1CommitPreimage(ctx, pkg))
    const actual = decodeHexFixed(commitHex, expected.length, 'verifyRound1Commit: commitHex')
    return equalBytes(expected, actual)
  } catch {
    return false
  }
}

/**
 * Checks ONE round-1 package's internal self-consistency: its Feldman
 * commitment plus its Schnorr proof of knowledge. Implemented by cloning the
 * caller's own round-1 `secret` with `signers.max` forced to 2 and running
 * noble's OWN `DKG.round2` against a single-element `others` array — this
 * reuses noble's Schnorr-PoK and point-decoding checks verbatim rather than
 * reimplementing them (D-25: no hand-rolled primitives).
 *
 * This relies on noble 2.2.0's `round2` internals: it validates each
 * `others` package's PoK and commitment shape but does NOT re-run
 * `validateSigners` against the caller's own real threshold, so a `max: 2`
 * clone is accepted. Pinned by the tampered-PoK blame test in
 * `crypto-dkg.spec.ts`. MUST be re-verified on any `@noble/curves` bump.
 */
export function verifyRound1Package (secret: DkgRound1Secret, pkg: DkgRound1Wire): boolean {
  try {
    const decoded = decodeRound1Wire(pkg)
    if (secret.coefficients === undefined) return false
    const clone: DKG_Secret = {
      identifier: secret.identifier,
      coefficients: [...secret.coefficients],
      commitment: [...secret.commitment],
      signers: { min: secret.signers.min, max: 2 },
      step: 1
    }
    secp256k1_FROST.DKG.round2(clone, [decoded])
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Round 2
// ---------------------------------------------------------------------------

export function dkgRound2 (secret: DkgRound1Secret, others: DkgRound1Wire[]): Record<string, Uint8Array> {
  const expectedCount = secret.signers.max - 1
  if (!Array.isArray(others) || others.length !== expectedCount) {
    throw new DkgError(
      'malformed-input',
      `dkgRound2: expected ${expectedCount} round1 packages, got ${Array.isArray(others) ? others.length : typeof others}`
    )
  }
  const seenIdentifiers: Record<string, true> = {}
  for (const pkg of others) {
    if (typeof pkg?.identifier !== 'string') {
      throw new DkgError('malformed-input', 'dkgRound2: each package needs a string identifier')
    }
    if (seenIdentifiers[pkg.identifier] === true) {
      throw new DkgError('duplicate-identifier', `dkgRound2: duplicate identifier among round1 packages`, pkg.identifier)
    }
    seenIdentifiers[pkg.identifier] = true
  }
  for (const pkg of others) {
    if (!verifyRound1Package(secret, pkg)) {
      throw new DkgError('invalid-round1', 'dkgRound2: a round1 package failed self-verification', pkg.identifier)
    }
  }
  const decodedOthers = others.map((pkg) => decodeRound1Wire(pkg))
  const result = secp256k1_FROST.DKG.round2(secret, decodedOthers)
  const shares: Record<string, Uint8Array> = {}
  for (const recipientId of Object.keys(result)) {
    const entry = result[recipientId]
    if (entry !== undefined) shares[recipientId] = entry.signingShare
  }
  return shares
}

// ---------------------------------------------------------------------------
// Round 3 and per-dealer share verification
// ---------------------------------------------------------------------------

export function verifyDealerShare (threshold: number, participants: number, dealerPkg: DkgRound1Wire, recipient: string, share: Uint8Array): boolean {
  try {
    assertDkgThreshold(threshold, participants)
    if (!isHexOfByteLength(recipient, SCALAR_BYTES)) return false
    if (!(share instanceof Uint8Array) || share.length !== SCALAR_BYTES) return false
    const decoded = decodeRound1Wire(dealerPkg)
    const secretShare = { identifier: recipient, signingShare: share } as FrostSecret
    secp256k1_FROST.validateSecret(secretShare, {
      signers: { min: threshold, max: participants },
      commitments: decoded.commitment,
      verifyingShares: {}
    })
    return true
  } catch {
    return false
  }
}

export function dkgRound3 (secret: DkgRound1Secret, others: DkgRound1Wire[], received: DkgReceivedShare[]): DkgKeyMaterial {
  const threshold = secret.signers.min
  const participants = secret.signers.max
  if (!Array.isArray(received) || received.length !== others.length) {
    throw new DkgError(
      'malformed-input',
      `dkgRound3: expected ${others.length} received shares, got ${Array.isArray(received) ? received.length : typeof received}`
    )
  }
  const byDealer: Record<string, DkgRound1Wire> = {}
  for (const pkg of others) byDealer[pkg.identifier] = pkg
  const selfIdentifier = identifierToHex(secret.identifier)
  for (const r of received) {
    const dealerPkg = byDealer[r.dealer]
    if (dealerPkg === undefined) {
      throw new DkgError('invalid-share', 'dkgRound3: no round1 package for this dealer', r.dealer)
    }
    if (!verifyDealerShare(threshold, participants, dealerPkg, selfIdentifier, r.share)) {
      throw new DkgError('invalid-share', 'dkgRound3: share failed verification against the dealer\'s own commitment', r.dealer)
    }
  }
  const decodedOthers = others.map((pkg) => decodeRound1Wire(pkg))
  const decodedReceived = received.map((r) => ({ identifier: r.dealer, signingShare: r.share })) as DKG_Round2[]
  const key = secp256k1_FROST.DKG.round3(secret, decodedOthers, decodedReceived)
  // Best-effort erasure only — bigint/JIT copies may survive on the heap.
  // No erasure claim is made (T-62-05-10).
  secp256k1_FROST.DKG.clean(secret)
  const groupCommitments = key.public.commitments.map((c) => bytesToHex(c))
  const verifyingShares: Record<string, string> = {}
  for (const id of Object.keys(key.public.verifyingShares)) {
    const bytes = key.public.verifyingShares[id]
    if (bytes !== undefined) verifyingShares[id] = bytesToHex(bytes)
  }
  const firstCommitment = groupCommitments[0]
  if (firstCommitment === undefined) {
    throw new DkgError('malformed-input', 'dkgRound3: noble returned no group commitments')
  }
  return {
    identifier: key.secret.identifier,
    signingShare: key.secret.signingShare,
    groupPublicKey: firstCommitment,
    groupCommitments,
    verifyingShares
  }
}

// ---------------------------------------------------------------------------
// Group commitments (recomputation path for 62-20)
// ---------------------------------------------------------------------------

/**
 * Sums each qualified participant's round-1 commitment vector
 * component-wise — this is the module's ONLY point arithmetic, and it is
 * exactly the same operation noble's own `round3` performs internally to
 * build `public.commitments` (see `frost.ts` round3: `mergedCommitment[i] =
 * mergedCommitment[i].add(parsePoint(v[i]))`). Recomputing it here lets
 * 62-20 verify `groupCommitments` without re-running the whole DKG.
 */
export function deriveGroupCommitments (packages: DkgRound1Wire[]): string[] {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new DkgError('malformed-input', 'deriveGroupCommitments: packages must be a non-empty array')
  }
  const first = packages[0]
  if (first === undefined || !Array.isArray(first.commitment) || first.commitment.length === 0) {
    throw new DkgError('malformed-input', 'deriveGroupCommitments: first package has no commitment')
  }
  const width = first.commitment.length
  const sums: string[] = []
  for (let i = 0; i < width; i++) {
    const firstHex = first.commitment[i]
    if (!isHexOfByteLength(firstHex, POINT_BYTES)) {
      throw new DkgError('malformed-input', 'deriveGroupCommitments: malformed commitment element')
    }
    let point = secp256k1.Point.fromHex(firstHex)
    for (let j = 1; j < packages.length; j++) {
      const pkg = packages[j]
      if (pkg === undefined || !Array.isArray(pkg.commitment) || pkg.commitment.length !== width) {
        throw new DkgError('malformed-input', 'deriveGroupCommitments: inconsistent commitment length across packages')
      }
      const elementHex = pkg.commitment[i]
      if (!isHexOfByteLength(elementHex, POINT_BYTES)) {
        throw new DkgError('malformed-input', 'deriveGroupCommitments: malformed commitment element')
      }
      point = point.add(secp256k1.Point.fromHex(elementHex))
    }
    sums.push(bytesToHex(point.toBytes(true)))
  }
  return sums
}

// ---------------------------------------------------------------------------
// Secret serialization (vault custody — 62-17 wraps bytes via utf8ToBytes)
// ---------------------------------------------------------------------------

interface SerializedDkgSecretV1 {
  v: 1
  identifier: string
  coefficients: string[]
  commitment: string[]
  signers: { min: number, max: number }
  step: 1 | 2
}

export function serializeDkgSecret (secret: DkgRound1Secret): string {
  if (secret.coefficients === undefined) {
    throw new DkgError('malformed-input', 'serializeDkgSecret: secret has no coefficients (already consumed by round3)')
  }
  if (secret.step !== 1 && secret.step !== 2) {
    throw new DkgError('malformed-input', `serializeDkgSecret: step must be 1 or 2 (got ${String(secret.step)})`)
  }
  const payload: SerializedDkgSecretV1 = {
    v: 1,
    identifier: identifierToHex(secret.identifier),
    coefficients: secret.coefficients.map((c) => bytesToHex(secp256k1_FROST.utils.Fn.toBytes(c))),
    commitment: secret.commitment.map((c) => bytesToHex(c)),
    signers: { min: secret.signers.min, max: secret.signers.max },
    step: secret.step
  }
  return JSON.stringify(payload)
}

export function parseDkgSecret (serialized: string): DkgRound1Secret {
  if (typeof serialized !== 'string') {
    throw new DkgError('malformed-input', 'parseDkgSecret: input must be a string')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new DkgError('malformed-input', 'parseDkgSecret: input is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new DkgError('malformed-input', 'parseDkgSecret: input must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 1) {
    throw new DkgError('malformed-input', `parseDkgSecret: unsupported version ${String(obj.v)}`)
  }
  if (obj.step !== 1 && obj.step !== 2) {
    throw new DkgError('malformed-input', 'parseDkgSecret: step must be 1 or 2')
  }
  if (!isHexOfByteLength(obj.identifier, SCALAR_BYTES)) {
    throw new DkgError('malformed-input', 'parseDkgSecret: identifier must be 64-char lowercase hex')
  }
  const signersObj = obj.signers as { min?: unknown, max?: unknown } | undefined
  if (signersObj === undefined || typeof signersObj.min !== 'number' || typeof signersObj.max !== 'number') {
    throw new DkgError('malformed-input', 'parseDkgSecret: signers must have numeric min/max')
  }
  assertDkgThreshold(signersObj.min, signersObj.max)
  if (!Array.isArray(obj.coefficients) || obj.coefficients.length !== signersObj.min) {
    throw new DkgError('malformed-input', 'parseDkgSecret: wrong coefficient count for the declared threshold')
  }
  for (const c of obj.coefficients) {
    if (!isHexOfByteLength(c, SCALAR_BYTES)) {
      throw new DkgError('malformed-input', 'parseDkgSecret: each coefficient must be 64-char lowercase hex')
    }
  }
  if (!Array.isArray(obj.commitment) || obj.commitment.length !== signersObj.min) {
    throw new DkgError('malformed-input', 'parseDkgSecret: wrong commitment count for the declared threshold')
  }
  for (const c of obj.commitment) {
    if (!isHexOfByteLength(c, POINT_BYTES)) {
      throw new DkgError('malformed-input', 'parseDkgSecret: each commitment element must be 66-char lowercase hex')
    }
  }
  return {
    identifier: secp256k1_FROST.utils.Fn.fromBytes(hexToBytes(obj.identifier as string)),
    coefficients: (obj.coefficients as string[]).map((c) => secp256k1_FROST.utils.Fn.fromBytes(hexToBytes(c))),
    commitment: (obj.commitment as string[]).map((c) => hexToBytes(c)),
    signers: { min: signersObj.min, max: signersObj.max },
    step: obj.step as 1 | 2
  }
}

// ---------------------------------------------------------------------------
// Released-share validation and k-of-n reconstruction (D-17, D-14)
// ---------------------------------------------------------------------------

export function validateReleasedShare (threshold: number, participants: number, groupCommitments: string[], share: ReleasedShare): boolean {
  try {
    assertDkgThreshold(threshold, participants)
    if (share === null || typeof share !== 'object') return false
    if (!isHexOfByteLength(share.identifier, SCALAR_BYTES)) return false
    if (!isHexOfByteLength(share.signingShare, SCALAR_BYTES)) return false
    if (!Array.isArray(groupCommitments) || groupCommitments.length !== threshold) return false
    const commitments: Uint8Array[] = []
    for (const c of groupCommitments) {
      if (!isHexOfByteLength(c, POINT_BYTES)) return false
      commitments.push(hexToBytes(c))
    }
    const secretShare: FrostSecret = { identifier: share.identifier, signingShare: hexToBytes(share.signingShare) }
    secp256k1_FROST.validateSecret(secretShare, {
      signers: { min: threshold, max: participants },
      commitments,
      verifyingShares: {}
    })
    return true
  } catch {
    return false
  }
}

export function reconstructGroupSecret (input: {
  threshold: number
  participants: number
  groupPublicKey: string
  groupCommitments: string[]
  shares: ReleasedShare[]
}): ReconstructionResult {
  const { threshold, participants, groupPublicKey, groupCommitments, shares } = input
  assertDkgThreshold(threshold, participants)
  if (!isHexOfByteLength(groupPublicKey, POINT_BYTES)) {
    throw new DkgError('group-key-mismatch', 'reconstructGroupSecret: groupPublicKey must be 66-char lowercase hex')
  }
  if (!Array.isArray(groupCommitments) || groupCommitments[0] !== groupPublicKey) {
    throw new DkgError('group-key-mismatch', 'reconstructGroupSecret: groupCommitments[0] must equal groupPublicKey')
  }

  const rejectedIdentifiers: string[] = []
  const validById: Record<string, ReleasedShare> = {}
  for (const share of Array.isArray(shares) ? shares : []) {
    const ok = validateReleasedShare(threshold, participants, groupCommitments, share)
    if (!ok) {
      if (share !== null && typeof share === 'object' && typeof share.identifier === 'string') {
        rejectedIdentifiers.push(share.identifier)
      }
      continue
    }
    if (validById[share.identifier] === undefined) {
      validById[share.identifier] = share
    }
  }

  const validShares = Object.values(validById)
  if (validShares.length < threshold) {
    throw new DkgError(
      'insufficient-shares',
      `reconstructGroupSecret: ${validShares.length} valid share(s), need ${threshold}`
    )
  }
  validShares.sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0))
  const used = validShares.slice(0, threshold)

  const secretKey = secp256k1_FROST.combineSecret(
    used.map((s): FrostSecret => ({ identifier: s.identifier, signingShare: hexToBytes(s.signingShare) })),
    { min: threshold, max: participants }
  )
  const derivedPublicKey = secp256k1.getPublicKey(secretKey, true)
  if (!equalBytes(derivedPublicKey, hexToBytes(groupPublicKey))) {
    throw new DkgError('group-key-mismatch', 'reconstructGroupSecret: reconstructed secret does not match groupPublicKey')
  }

  return {
    secretKey,
    usedIdentifiers: used.map((s) => s.identifier),
    rejectedIdentifiers
  }
}

// ---------------------------------------------------------------------------
// Share ciphertexts (ECIES-style: HKDF-SHA256 + AES-256-GCM)
// ---------------------------------------------------------------------------

export function encryptShare (ctx: DkgContext, dealer: string, recipient: string, recipientPublicKey: string, share: Uint8Array): EncryptedShare {
  assertValidContext(ctx)
  if (typeof dealer !== 'string' || dealer.length === 0 || typeof recipient !== 'string' || recipient.length === 0) {
    throw new DkgError('malformed-input', 'encryptShare: dealer and recipient must be non-empty strings')
  }
  if (!(share instanceof Uint8Array) || share.length !== SCALAR_BYTES) {
    throw new DkgError('malformed-input', `encryptShare: share must be a ${SCALAR_BYTES}-byte Uint8Array`)
  }
  const recipientPub = decodeHexPoint(recipientPublicKey, 'encryptShare: recipientPublicKey')

  // A FRESH ephemeral key for every (dealer, recipient) ciphertext, so
  // revealing one shared secret exposes exactly one share.
  const ephemeralSecret = secp256k1.utils.randomSecretKey()
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralSecret, true)
  const sharedSecret = secp256k1.getSharedSecret(ephemeralSecret, recipientPub, true)

  // salt = ephemeralPublicKey alone — see the header note on the deliberate
  // departure from the action text's recipientPublicKey-inclusive salt.
  const salt = ephemeralPublicKey
  const kek = hkdf(sha256, sharedSecret, salt, DKG_SHARE_KEY_INFO, DKG_HKDF_BYTES)
  const keyCommitment = hkdf(sha256, sharedSecret, salt, DKG_SHARE_COMMIT_INFO, DKG_HKDF_BYTES)
  const nonce = randomBytes(DKG_SHARE_NONCE_BYTES)
  const aad = shareAad(ctx, dealer, recipient)
  const ciphertext = gcm(kek, nonce, aad).encrypt(share)

  return {
    v: 1,
    dealer,
    recipient,
    ephemeralPublicKey: bytesToHex(ephemeralPublicKey),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
    keyCommitment: bytesToHex(keyCommitment)
  }
}

export function decryptShare (ctx: DkgContext, enc: EncryptedShare, recipientPrivateKey: Uint8Array): Uint8Array {
  assertValidContext(ctx)
  // --- 1. structural -------------------------------------------------------
  if (enc === null || typeof enc !== 'object' || enc.v !== 1) {
    throw new DkgError('malformed-input', 'decryptShare: enc.v must be 1')
  }
  if (typeof enc.dealer !== 'string' || typeof enc.recipient !== 'string') {
    throw new DkgError('malformed-input', 'decryptShare: enc.dealer and enc.recipient must be strings')
  }
  const ephemeralPublicKey = decodeHexPoint(enc.ephemeralPublicKey, 'decryptShare: ephemeralPublicKey')
  const nonce = decodeHexFixed(enc.nonce, DKG_SHARE_NONCE_BYTES, 'decryptShare: nonce')
  const keyCommitment = decodeHexFixed(enc.keyCommitment, DKG_HKDF_BYTES, 'decryptShare: keyCommitment')
  const ciphertext = decodeHex(enc.ciphertext, 'decryptShare: ciphertext')
  if (!(recipientPrivateKey instanceof Uint8Array) || recipientPrivateKey.length !== SCALAR_BYTES) {
    throw new DkgError('malformed-input', `decryptShare: recipientPrivateKey must be a ${SCALAR_BYTES}-byte Uint8Array`)
  }

  // --- 2. recompute Z -------------------------------------------------------
  const sharedSecret = secp256k1.getSharedSecret(recipientPrivateKey, ephemeralPublicKey, true)
  const salt = ephemeralPublicKey

  // --- 3. key-commitment tag, constant-time compare -------------------------
  const expectedTag = hkdf(sha256, sharedSecret, salt, DKG_SHARE_COMMIT_INFO, DKG_HKDF_BYTES)
  if (!equalBytes(expectedTag, keyCommitment)) {
    throw new DkgError('key-commitment-mismatch', 'decryptShare: key-commitment tag mismatch')
  }

  // --- 4. authenticated decryption ------------------------------------------
  const kek = hkdf(sha256, sharedSecret, salt, DKG_SHARE_KEY_INFO, DKG_HKDF_BYTES)
  const aad = shareAad(ctx, enc.dealer, enc.recipient)
  let plaintext: Uint8Array
  try {
    plaintext = gcm(kek, nonce, aad).decrypt(ciphertext)
  } catch {
    throw new DkgError('share-decrypt-failed', 'decryptShare: authenticated decryption failed')
  }

  // --- 5. plaintext shape -----------------------------------------------------
  if (plaintext.length !== SCALAR_BYTES) {
    throw new DkgError('share-decrypt-failed', `decryptShare: decrypted plaintext is ${plaintext.length} bytes, expected ${SCALAR_BYTES}`)
  }
  return plaintext
}

export function buildComplaintEvidence (enc: EncryptedShare, recipientPrivateKey: Uint8Array): ComplaintEvidence {
  if (enc === null || typeof enc !== 'object' || typeof enc.dealer !== 'string' || typeof enc.recipient !== 'string') {
    throw new DkgError('malformed-input', 'buildComplaintEvidence: enc must carry dealer and recipient strings')
  }
  if (!(recipientPrivateKey instanceof Uint8Array) || recipientPrivateKey.length !== SCALAR_BYTES) {
    throw new DkgError('malformed-input', `buildComplaintEvidence: recipientPrivateKey must be a ${SCALAR_BYTES}-byte Uint8Array`)
  }
  const ephemeralPublicKey = decodeHexPoint(enc.ephemeralPublicKey, 'buildComplaintEvidence: ephemeralPublicKey')
  const sharedSecret = secp256k1.getSharedSecret(recipientPrivateKey, ephemeralPublicKey, true)
  return { dealer: enc.dealer, recipient: enc.recipient, sharedSecret: bytesToHex(sharedSecret) }
}

/**
 * Makes the per-ciphertext verdict publicly checkable by anyone who holds
 * `enc`, the dealer's round-1 package and the complainant's claimed
 * `evidence` — no private key is required by the verifier.
 *
 * Without a DLEQ proof binding `evidence.sharedSecret` to the complainant's
 * own public key, step 2 below cannot distinguish "the dealer posted a bad
 * tag" from "the complainant lied about Z": both look identical, a tag
 * mismatch. The outcome is `unresolved`, which only forces the DKG attempt
 * to restart — bounded by 62-17's attempt cap — and is documented as
 * residual A6 (denial of service only; building a DLEQ proof here would be
 * a hand-rolled primitive, which D-25 disfavors).
 *
 * ANY complaint aborts the current attempt, because noble's split-round DKG
 * needs the full participant set to complete round3. The verdict only
 * decides who is excluded from the NEXT attempt; revealing `Z` for an
 * aborted attempt leaks nothing that survives it.
 */
export function verifyComplaintEvidence (
  ctx: DkgContext,
  threshold: number,
  participants: number,
  enc: EncryptedShare,
  dealerPkg: DkgRound1Wire,
  evidence: ComplaintEvidence
): ComplaintResult {
  // --- 1. structural sanity of the evidence itself --------------------------
  if (
    evidence === null || typeof evidence !== 'object' ||
    evidence.dealer !== enc.dealer || evidence.recipient !== enc.recipient ||
    evidence.dealer !== dealerPkg.identifier
  ) {
    return { verdict: 'complainant-fault', reason: 'malformed-evidence' }
  }
  let sharedSecret: Uint8Array
  try {
    sharedSecret = decodeHexFixed(evidence.sharedSecret, POINT_BYTES, 'verifyComplaintEvidence: sharedSecret')
    secp256k1.Point.fromBytes(sharedSecret) // must decode to a valid curve point
  } catch {
    return { verdict: 'complainant-fault', reason: 'malformed-evidence' }
  }

  let ephemeralPublicKey: Uint8Array
  let keyCommitment: Uint8Array
  let nonce: Uint8Array
  let ciphertext: Uint8Array
  try {
    assertValidContext(ctx)
    ephemeralPublicKey = decodeHexPoint(enc.ephemeralPublicKey, 'verifyComplaintEvidence: ephemeralPublicKey')
    keyCommitment = decodeHexFixed(enc.keyCommitment, DKG_HKDF_BYTES, 'verifyComplaintEvidence: keyCommitment')
    nonce = decodeHexFixed(enc.nonce, DKG_SHARE_NONCE_BYTES, 'verifyComplaintEvidence: nonce')
    ciphertext = decodeHex(enc.ciphertext, 'verifyComplaintEvidence: ciphertext')
  } catch {
    return { verdict: 'complainant-fault', reason: 'malformed-evidence' }
  }

  // --- 2. key-commitment tag: unresolved, not attributed (residual A6) ------
  const salt = ephemeralPublicKey
  const expectedTag = hkdf(sha256, sharedSecret, salt, DKG_SHARE_COMMIT_INFO, DKG_HKDF_BYTES)
  if (!equalBytes(expectedTag, keyCommitment)) {
    return { verdict: 'unresolved', reason: 'key-commitment-mismatch' }
  }

  // --- 3. decrypt under the now-authenticated key ----------------------------
  const kek = hkdf(sha256, sharedSecret, salt, DKG_SHARE_KEY_INFO, DKG_HKDF_BYTES)
  const aad = shareAad(ctx, enc.dealer, enc.recipient)
  let plaintext: Uint8Array
  try {
    plaintext = gcm(kek, nonce, aad).decrypt(ciphertext)
  } catch {
    return { verdict: 'dealer-fault', reason: 'undecryptable' }
  }
  if (plaintext.length !== SCALAR_BYTES) {
    return { verdict: 'dealer-fault', reason: 'undecryptable' }
  }

  // --- 4. check the decrypted share against the dealer's own commitment -----
  if (!verifyDealerShare(threshold, participants, dealerPkg, enc.recipient, plaintext)) {
    return { verdict: 'dealer-fault', reason: 'invalid-share' }
  }

  // --- 5. share checks out: the complainant's complaint was unfounded -------
  return { verdict: 'complainant-fault', reason: 'share-valid' }
}
