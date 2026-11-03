// pairing/index.ts — browser pairing (Phase 66): the officer-signed pairing code a browser scans,
// the statement digests and verifiers, the owner-phone pair-mint wire protocol and service, and the
// officer-signed revocation row. Named exports only (no wildcard), so every name is listed here once.
//
// browser-entry.ts never imports this barrel: it re-exports the browser-safe names from the module
// files, because this barrel also reaches pair-wire.ts and pair-mint-service.ts (owner-phone code).
export {
  PAIRING_CODE_PREFIX,
  PAIRING_QR_BYTE_BUDGET,
  PAIRING_CODE_MAX_CHARS,
  PairingCodeError,
  encodePairingCode,
  decodePairingCode
} from './pairing-code.js'
export type { PairingStatement, DecodedPairingCode, PairingCodeFailure } from './pairing-code.js'
export {
  PAIRING_DIGEST_TAG,
  PAIRING_REMOVE_DIGEST_TAG,
  pairingStatementDigest,
  pairingRemoveDigest,
  verifyPairingStatement,
  verifyPairingRemove,
  isCurrentPairingOfficer
} from './pairing-statement.js'
export type { VerifiablePairingStatement, PairingVerifyFailure, PairingVerifyResult } from './pairing-statement.js'
export {
  PAIR_MINT_PROTOCOL,
  PAIR_MINT_MAX_FRAME_BYTES,
  PAIR_MINT_READ_TIMEOUT_MS,
  PAIR_MINT_REFUSAL_CODES,
  parsePairMintRequest,
  parsePairMintReply,
  PairMintTransportError,
  attachPairMint,
  requestPairMint
} from './pair-wire.js'
export type {
  PairMintRefusalCode,
  PairMintMintRequest,
  PairMintRemoveRequest,
  PairMintRequest,
  PairMintReply,
  PairMintHandler,
  PairMintLibp2pLike
} from './pair-wire.js'
export {
  PAIR_MINT_WINDOW_MS,
  PAIR_MINT_CLOCK_SKEW_MS,
  PAIR_MINT_MAX_LIVE_PER_OFFICER,
  PAIR_MINT_PEER_REQUESTS_PER_MINUTE,
  createPairMintService
} from './pair-mint-service.js'
export type { PairMintOutcome, PairMintLogEntry, PairMintPorts, PairMintService } from './pair-mint-service.js'
export {
  PAIRING_REVOKE_DIGEST_TAG,
  PairingRevocationError,
  pairingRevokeDigest,
  isPairingRevoked,
  revokeDashboardPairing
} from './pairing-revocation.js'
export type { PairingRevocationSigner, PairingRevocationReason } from './pairing-revocation.js'
