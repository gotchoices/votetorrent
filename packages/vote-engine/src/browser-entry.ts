// src/browser-entry.ts — browser-safe subpath entry (D-01/D-02/D-19)
//
// Neither `src/index.ts` (the default '.' subpath) nor `src/rn-entry.ts` (the
// './rn' subpath) is importable from a browser bundle: both re-export
// `LocalStorageReact`, which imports `@react-native-async-storage/async-storage`
// at module scope (`src/local-storage-react.ts:1`), unconditionally. Phase 50
// (the Authority Web Dashboard) is the first consumer that needs the compiled
// engine WITHOUT React Native in the module graph at all, so this is a third,
// narrow subpath rather than a conditional inside an existing one.
//
// The exclusion list below (see the DELIBERATELY NOT EXPORTED block) is
// enforced by `test/browser-entry-purity.spec.ts` — a source-level
// transitive-import-graph walker with a working positive control. Do NOT
// "helpfully" widen this file's exports without updating that spec's
// allowlist; a widening that pulls in a forbidden specifier fails the purity
// gate, not a downstream Vite build.
//
// Per D-01 (Phase 50 steps 1+2 only — read-only dashboard, no panel actions
// yet), this seam deliberately exports NO write-capable domain engine: no
// AuthorityEngine, ElectionsEngine, ElectionEngine, SigningEngine,
// RegistrationEngine, InvitationEngine, AuthorityConfigEngine, NetworksEngine,
// or NetworkEngine.
//
// Do NOT add `export * from './index.js'` or `export * from './rn-entry.js'`
// here — that is exactly the barrel-widening this seam exists to prevent.
// Named exports only, each with an inline comment naming the consuming plan.

// The privilege primitive. `isPrivileged`'s SQL runs unmodified in a browser
// (spikes 075/078). Plan 50-06 wraps it; it must never be re-derived as a
// hand-rolled SQL string, which is what all four spikes did only because this
// barrel-import problem was unsolved.
export { UserEngine } from './user/user-engine.js'

// The per-Database lifecycle. `registerDbPlugins` registers the crypto plugin
// and the `SignatureValid`/`SignatureValidP256` UDFs the schema's CHECK
// constraints call; without it on this seam, plan 50-05's `open-db.ts` would
// have to hand-roll UDF registration. `isSchemaInitialized` is the D-11
// re-attach gate.
export {
	registerDbPlugins,
	initDB,
	prepareDb,
	isSchemaInitialized,
	markSchemaInitialized,
} from './database/initialize.js'

// The single source of truth for the DDL, bundled as a string so no `node:fs`
// or `import.meta` is needed in a browser bundle.
export { VOTETORRENT_SCHEMA_SQL } from './database/schema-sql.js'

// `H16` produces the `networkHash` the browser database name is keyed on; the
// three datetime helpers are the only correct producers/parsers of the
// 19-character, no-`Z` canonical datetime format.
export { H16, toCanonicalDatetime, nowCanonicalDatetime, fromCanonicalDatetime } from './utils.js'

export type { DbFactory, EngineContext } from './types.js'

// The R5 block Merkle tree: SHA-256 over public VoteBlock columns, for the dashboard's recomputation
// of the root. A Cid that several rows name is resolved by consent authentication (T-65-05-03), with the
// crypto plugin's digest and P-256 verify (already in this graph through database/initialize.ts).
// Imported from the module file and NOT from the blocks barrel, because the barrel also carries R6-R8.
export {
	BLOCK_TREE_DOMAIN,
	BLOCK_TREE_EMPTY_ROOT,
	blockLeafData,
	voterListDigest,
	blockLeafHash,
	blockNodeHash,
	isBase32Cid,
	blockCidOf,
	selectBlockRows,
	buildBlockTree,
	verifyInclusion,
	blockTreeStatus,
	finalBlockTree,
	blockConsentDigest,
	verifyBlockConsent,
	blockAuthorizer,
	judgeBlockVoters
} from './blocks/block-tree.js'
export type {
	BlockTreeRow,
	BlockTreeScope,
	BlockTreeLeaf,
	BlockTreeNode,
	BlockProofStep,
	BlockInclusionProof,
	BlockProofResult,
	BlockTree,
	BlockTreeRefusal,
	BlockTreeRejectReason,
	BlockTreeRejection,
	BlockRowSelection,
	BlockTreeResult,
	InclusionCheck,
	BlockTreeTimeline,
	BlockTreeStatus,
	FinalBlockTreeResult,
	BlockVoterRow,
	BlockRegistrantRow,
	BlockAssociationRow,
	BlockAuthorizationTimeline,
	BlockAuthorization,
	BlockConsentScope,
	BlockAuthorizer,
	BlockVoterProblemCode,
	BlockVoterProblem,
	BlockVoterRepresentative,
	BlockVoterExtra,
	BlockVoterJudgement
} from './blocks/block-tree.js'

// Phase 66 browser pairing. Every name below comes from its MODULE file, never from
// './pairing/index.js': that barrel also reaches pair-wire.ts and pair-mint-service.ts (owner-phone
// libp2p code), which test/browser-entry-purity.spec.ts BROWSER-PAIRING-a proves unreachable here.
//
// The network join code a pairing code embeds (66-14 pairing flow): decode only. It returns a result
// union (NetworkJoinCodeDecodeFailure), it does not throw.
export { decodeNetworkJoinCode, looksLikeJoinCode, NETWORK_JOIN_CODE_PREFIX_V2 } from './networks/join-code.js'
export type { NetworkJoinCode, NetworkJoinCodeDecodeResult, NetworkJoinCodeDecodeFailure } from './networks/join-code.js'
// The founding content digest the browser recomputes over its replicated founding rows (66-14).
export { computeContentDigest } from './bootstrap/snapshot-manifest.js'
// The pairing code (66-22 pairing screen + scanner limits, 66-14 pairing flow): decode, never encode.
export {
	PAIRING_CODE_PREFIX,
	PAIRING_CODE_MAX_CHARS,
	PAIRING_QR_BYTE_BUDGET,
	decodePairingCode,
	PairingCodeError
} from './pairing/pairing-code.js'
export type { PairingStatement, DecodedPairingCode, PairingCodeFailure } from './pairing/pairing-code.js'
// The officer's signed pairing statement, verified against the replicated Officer and UserKey rows
// (66-14 pairing flow and per-pass validity check).
export { PAIRING_DIGEST_TAG, PAIRING_REMOVE_DIGEST_TAG, verifyPairingStatement } from './pairing/pairing-statement.js'
export type { VerifiablePairingStatement, PairingVerifyFailure, PairingVerifyResult } from './pairing/pairing-statement.js'
// The revocation row check: a paired browser unpairs itself once its pairing is revoked (66-14, 66-19).
export { PAIRING_REVOKE_DIGEST_TAG, isPairingRevoked } from './pairing/pairing-revocation.js'

// -----------------------------------------------------------------------
// DELIBERATELY NOT EXPORTED (enforced by test/browser-entry-purity.spec.ts)
// -----------------------------------------------------------------------
//
// - LocalStorageReact — imports `@react-native-async-storage/async-storage`
//   at module scope (src/local-storage-react.ts:1).
// - AssociationEngine, PlayIntegrityVerifier, LocalConfigKeyProvider — import
//   `Buffer` from the `buffer` package.
// - verifySigP256 — rn-entry.ts exports it for on-device proof code; the
//   browser holds no key and can never sign (D-04), so it has no consumer
//   here.
// - Every write-capable domain engine — AuthorityEngine, ElectionsEngine,
//   ElectionEngine, SigningEngine, RegistrationEngine, InvitationEngine,
//   AuthorityConfigEngine, NetworksEngine, NetworkEngine — because Phase 50
//   is read-only (D-01: panel actions are step 3, explicitly OUT) and
//   because the outline's binding cross-plan contract 2 fixes the
//   dashboard's only engine-class import as UserEngine.
// - The R6-R8 functions (slice checks, validation, tally tree) — they import election-block.ts, which
//   reaches `@noble/curves/secp256k1.js`, outside the 7-entry allowlist, and the dashboard has no consumer.
// - encodePairingCode — the browser never mints a pairing code; the officer's phone does.
// - Everything in pairing/pair-wire.ts and pairing/pair-mint-service.ts — the owner phone's pair-mint
//   protocol and service (libp2p streams, mint policy); the browser never hosts or dials pair-mint.
// - revokeDashboardPairing, PairingRevocationError, PairingRevocationSigner and the digest builders
//   (pairingStatementDigest, pairingRemoveDigest, pairingRevokeDigest), plus verifyPairingRemove and
//   isCurrentPairingOfficer — signing and owner-side paths; the browser holds no officer key (D-04).
// - The founding-row reader, its table order and the founding descriptor derivation — guard G-5 in
//   test/founding-bundle-guards.spec.ts keeps every barrel, this one included, off the genesis-row
//   and founding-bundle modules. Exporting them needs a narrow, user-approved change to that guard.
