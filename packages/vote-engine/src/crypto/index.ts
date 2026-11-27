// src/crypto/index.ts — named-export barrel for the crypto module (D-03,
// D-04, D-13, D-18, D-25).
//
// Named exports only — NEVER `export *` — so a careless future addition to
// envelope.ts, block-cipher.ts or vault.ts cannot silently widen this
// barrel the way a wildcard would.
//
// Three things are deliberately absent from this barrel:
//
//   - the deterministic entry points that accept caller-supplied
//     randomness, the in-memory test vault, and the shared encoding
//     helpers — they exist for this package's own known-answer-vector tests
//     only. Keeping them off every barrel makes a pinned nonce or a
//     plaintext-in-memory test double unreachable from any app build;
//
//   - a line on `src/browser-entry.ts` — this module is browser-safe by
//     construction (pure `@noble/*` arithmetic, no Node or React Native
//     import reachable from it), but Phase 50's dashboard is read-only
//     today and has no consumer for it. A future plan that needs it there
//     should add the line explicitly, not inherit it implicitly from a
//     widening here.

export {
  ENCRYPTION_KEY_ALG,
  ENVELOPE_ALG,
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_MAX_RECIPIENTS,
  EnvelopeSealError,
  encryptionPublicKeyFromSecret,
  envelopeRecipientUserIds,
  generateEncryptionKeyPair,
  isValidEncryptionPublicKey,
  openEnvelope,
  sealToRecipients,
  serializeEnvelope
} from './envelope.js'
export type {
  EnvelopeBinding,
  EnvelopeOpenFailureReason,
  EnvelopeOpenResult,
  EnvelopeRecipient,
  EnvelopeRecipientSecret,
  EnvelopeSealErrorCode,
  SealedEnvelope,
  SealedEnvelopeRecipientEntry
} from './envelope.js'

export {
  BLOCK_CIPHER_ALG,
  BLOCK_CIPHER_FORMAT_VERSION,
  BlockCipherError,
  decryptBlockContent,
  encryptBlockContent,
  serializeBlockCiphertext
} from './block-cipher.js'
export type {
  BlockCipherBinding,
  BlockCipherErrorCode,
  BlockCiphertext,
  BlockDecryptFailureReason,
  BlockDecryptResult
} from './block-cipher.js'

export {
  KEY_VAULT_ALIAS_PATTERN,
  KEYHOLDER_DKG_RECEIVING_KEY_POLICY,
  KEYHOLDER_SHARE_POLICY,
  KeyVaultError,
  MAX_OFFICER_KEY_GENERATIONS,
  OFFICER_ENCRYPTION_KEY_POLICY,
  assertKeyVaultAlias,
  keyholderDkgReceivingKeyAlias,
  keyholderDkgShareAlias,
  officerEncryptionKeyAlias,
  officerEncryptionKeyGenerationAlias
} from './vault.js'
export type { IKeyVault, KeyVaultErrorCode, KeyVaultPolicy } from './vault.js'

// 62-20: a CURATED subset of the DKG module (`dkg.ts`, 62-05). This barrel
// adds the names the key-release and keyholder-screen layers need —
// identifiers, receiving-key generation, released-share validation and
// reconstruction, plus the error and wire-material types. It deliberately
// leaves off this directory's round drivers and the secret-coefficient
// codecs: those stay reachable only from the one engine (62-17's
// `KeyholderDkgEngine`) that drives DKG rounds and handles an in-progress
// polynomial secret. Confining that handling to a single, reviewed call
// site is the whole point of keeping it off every barrel — widening this
// set to re-export it would make a stray future import able to touch
// coefficients it has no business seeing.
export {
  DkgError,
  assertDkgThreshold,
  dkgIdentifierForUser,
  generateDkgReceivingKey,
  deriveGroupCommitments,
  validateReleasedShare,
  reconstructGroupSecret
} from './dkg.js'
export type {
  DkgErrorCode,
  DkgContext,
  DkgRound1Wire,
  DkgKeyMaterial,
  EncryptedShare,
  ComplaintEvidence,
  ComplaintVerdict,
  ComplaintResult,
  ReleasedShare,
  ReconstructionResult
} from './dkg.js'
