// src/rn-entry.ts — RN-safe subpath entry (D-01/D-02)
//
// NetworksEngine is intentionally NOT in src/index.ts or networks/index.ts:
// we export it ONLY here so there is a single controlled re-export path.
// Phase-14 proved Metro CAN bundle NetworksEngine; the omission from the main
// barrel is deliberate to avoid pulling it into non-RN consumers via the default
// '.' subpath.
//
// Do NOT add `export * from './networks/index.js'` here — that would
// double-export MockNetworksEngine alongside NetworksEngine.
// 49-D26a-LOCAL: the canonical P-256 verifier, exported so on-device proofs can assert a real
// Keystore signature against THE SAME function the schema's SignatureValidP256 CHECK calls.
// Verifying with a hand-rolled noble call instead would prove nothing about schema agreement —
// which is the whole point of the encoding contract (base64url digest / hex sig / hex key).
export { verifySigP256 } from './database/initialize.js'
// The per-Database UDF lifecycle (`SignatureValid`/`SignatureValidP256`/`isISODatetime` + the
// crypto plugin) that every schema CHECK calls. NetworksEngine runs it on every handle it opens;
// the P2P-11 replication proof opens its strand handle directly through the DbFactory, so it must
// run it too — without it, the first signed insert fails `Function not found: SignatureValidP256/3`.
export { registerDbPlugins } from './database/initialize.js'
export { NetworksEngine } from './networks/networks-engine.js'
// Spike 100: a voter joins an authority's network from a join code.
export { NETWORK_JOIN_CODE_PREFIX, NETWORK_JOIN_CODE_PREFIX_V2, CADRE_INVITATION_PREFIX_EXPECTED, encodeNetworkJoinCode, decodeNetworkJoinCode, looksLikeJoinCode } from './networks/join-code.js'
export type { NetworkJoinCode, NetworkJoinCodeDecodeResult, NetworkJoinCodeDecodeFailure } from './networks/join-code.js'
export { joinNetwork } from './networks/network-join.js'
export type { NetworkJoinNode, NetworkJoinOptions, NetworkJoinResult, NetworkJoinFailureReason, NetworkJoinStep } from './networks/network-join.js'
export { NetworkEngine } from './network/network-engine.js'
// Phones pass `createEdgeReaderRefusal().hook` as cadre-core's `strandCohortRefusal`, keeping strand peers
// that declared themselves read-only edge readers out of write cohorts and coordinator choice.
export { EDGE_READER_PROTOCOL, EDGE_READER_REFUSAL_MAX_PEERS, createEdgeReaderRefusal } from './network/edge-reader-refusal.js'
export type { EdgeReaderRefusal, EdgeReaderRefusalOptions, EdgeReaderStrandRefusal } from './network/edge-reader-refusal.js'
export { ElectionsEngine, peekNextElectionTid } from './elections/elections-engine.js'
export { ElectionEngine } from './election/election-engine.js'
export type { ElectionSubject } from './election/election-engine.js'
export { AuthorityEngine } from './authority/authority-engine.js'
export { SigningEngine } from './signing/signing-engine.js'
export { UserEngine } from './user/user-engine.js'
export { DefaultUserEngine } from './user/default-user-engine.js'
export { KeysTasksEngine } from './tasks/keys-tasks-engine.js'
export { SignatureTasksEngine } from './tasks/signature-tasks-engine.js'
export { OnboardingTasksEngine } from './tasks/onboarding-tasks-engine.js'
export { InvitationEngine } from './invite/invitation-engine.js'
export { LocalStorageReact } from './local-storage-react.js'
// Phase 44-02 (D-01, voter-app net-new): the voter app's EngineFactory builds a
// 'registration' engine case — RegistrationEngine was previously reachable only
// from the default '.' subpath (registration/index.js), which is not RN-safe
// per this file's own header convention. Export it here so the RN app layer
// never has to reach past the controlled rn-entry.ts seam. As of Phase 46
// (D-06) BOTH RN apps (voter + authority) build a 'registration' case, so this
// single export serves both.
export { RegistrationEngine } from './registration/registration-engine.js'
// Phase 47 (D-09/Pattern 2): the authority app's EngineFactory builds an
// 'authorityConfig' case (AuthorityPeer / PollingDevice administration), so
// AuthorityConfigEngine must be reachable from this controlled RN-safe seam
// rather than the default '.' subpath. Export the REAL engine only — per this
// file's header rule, the Mock sibling class is NOT re-exported here (screen
// tests reach mocks through the relative dist/ require, and a barrel
// re-export would pull the Mock siblings in).
export { AuthorityConfigEngine } from './authority-config/authority-config-engine.js'
// Phase 43 (D-13/D-14): the device-attestation seam — EngineFactory's
// 'association' case imports these to construct the real verifier by
// default, dev-gated to the stub (never a silent prod fallback).
export { AssociationEngine } from './association/association-engine.js'
export { PlayIntegrityVerifier } from './association/play-integrity-verifier.js'
export { StubAttestationVerifier } from './association/stub-attestation-verifier.js'
// Phase 51: the iOS half of that same seam. `engine-factory.ts` constructs BOTH platform
// verifiers and injects the dispatcher — never a bare PlayIntegrityVerifier — so an iOS
// submission is routed rather than rejected by the Android verifier's platform gate.
export { AppAttestVerifier, NO_PRIOR_ASSERTIONS } from './association/app-attest-verifier.js'
export type { IAssertionCounterStore } from './association/app-attest-verifier.js'
export { PlatformDispatchingAttestationVerifier } from './association/platform-dispatching-verifier.js'
// "Make permanent" on media URL fields: download once, record `{ url, cid }` so the reference is
// tamper-evident. Pure (fetch is injectable); no storage, no network-side hosting.
export {
  fingerprintMedia,
  verifyMediaFingerprint,
  isFingerprintableUrl,
  mediaCid,
  MediaFingerprintError,
  MAX_MEDIA_BYTES
} from './media/media-fingerprint.js'
export type { MediaFetch, MediaFingerprintFailure, MediaFingerprintOptions, MediaResponse } from './media/media-fingerprint.js'
export { LocalConfigKeyProvider } from './association/key-provider.js'
export type { IIntegrityKeyProvider } from './association/key-provider.js'
export type { ExpectedAppIdentity } from './association/verifiers/app-identity.js'
export type { DbFactory, EngineContext } from './types.js'
export { H16 } from './utils.js'
// WR-15 (17-REVIEW): single source of truth for the DEBT-04 digest golden
// vectors — the on-device parity gate (persistence-proof.ts) imports these
// instead of carrying an inline copy that could silently drift.
export { DIGEST_VECTORS } from './database/digest-vectors.js'
export type { DigestVector } from './database/digest-vectors.js'
// Single source of truth for the votetorrent schema DDL (generated from
// vote-core/schema/votetorrent.qsql). The app-layer strand-backed DbFactory
// passes this into CadreNode.addStrand's sAppConfig.schema (P2P-03) so the
// strand DB and the LevelDB path declare the SAME schema — no drift.
export { VOTETORRENT_SCHEMA_SQL } from './database/schema-sql.js'
// Phase 62 Plan 04 (D-03/D-04/D-13/D-18/D-25): the crypto module, re-exported
// by name (never `export *`) for its RN consumers — 62-14 (intake
// sealer/opener and officer key registration), 62-21 (the Authority native
// vault adapter) and 62-22 (voter sealing). Mirrors the exact name list on
// src/crypto/index.ts; the deterministic/test-only entry points stay off
// this seam too.
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
	serializeEnvelope,
	BLOCK_CIPHER_ALG,
	BLOCK_CIPHER_FORMAT_VERSION,
	BlockCipherError,
	decryptBlockContent,
	encryptBlockContent,
	serializeBlockCiphertext,
	KEY_VAULT_ALIAS_PATTERN,
	KEYHOLDER_DKG_RECEIVING_KEY_POLICY,
	KEYHOLDER_SHARE_POLICY,
	KeyVaultError,
	OFFICER_ENCRYPTION_KEY_POLICY,
	assertKeyVaultAlias,
	keyholderDkgReceivingKeyAlias,
	keyholderDkgShareAlias,
	officerEncryptionKeyAlias
} from './crypto/index.js'
export type {
	EnvelopeBinding,
	EnvelopeOpenFailureReason,
	EnvelopeOpenResult,
	EnvelopeRecipient,
	EnvelopeRecipientSecret,
	EnvelopeSealErrorCode,
	SealedEnvelope,
	SealedEnvelopeRecipientEntry,
	BlockCipherBinding,
	BlockCipherErrorCode,
	BlockCiphertext,
	BlockDecryptFailureReason,
	BlockDecryptResult,
	IKeyVault,
	KeyVaultErrorCode,
	KeyVaultPolicy
} from './crypto/index.js'
// Phase 62 Plan 17 (D-13/D-14/D-16/D-19/D-25/D-26): the keyholder DKG round
// driver, re-exported by name for its RN consumer — 62-26 (the Authority
// keyholder app, which stores the DKG receiving key at accept and drives
// rounds on keyholder-screen focus). Mirrors 62-17's own instruction for
// this exact name list.
export {
	KeyholderDkgEngine,
	KeyholderDkgError,
	keyholderDkgRoundSecretAlias,
	KEYHOLDER_DKG_ROUND_SECRET_POLICY,
	encodeDkgRoundVaultRecord,
	decodeDkgRoundVaultRecord
} from './keyholder/index.js'
export type { KeyholderDkgErrorCode, DkgRoundVaultRecord } from './keyholder/index.js'
// Phase 62 Plan 20 (D-13/D-14/D-17/D-18/D-20): the key-release engine and
// its pure window/block-payload helpers, re-exported by name for its RN
// consumers — 62-26 (KeyTaskScreen's signer wiring) and 62-29
// (KeyReleaseScreen, Voter releasedCount).
export {
	KeyReleaseEngine,
	KeyReleaseError,
	releaseKeyTaskId,
	hasEnteredReleasingKeys,
	releasingKeysAt,
	encryptElectionBlock,
	openElectionBlock,
	encryptVoteEntry,
	openVoteEntries
} from './key-release/index.js'
export type { KeyReleaseErrorCode, KeyReleaseEngineDeps } from './key-release/index.js'
// Election results (decrypt + validate + tally after the key release), for the Authority and Voter results screens.
export { ElectionResultsEngine, summarizeBallot } from './results/index.js'
export type { ElectionResults, ElectionResultsEngineDeps, BallotResult, QuestionResult, OptionResult } from './results/index.js'
export type { KeysTasksEngineDeps } from './tasks/keys-tasks-engine.js'
// Phase 62 Plan 20: a curated DKG surface, named from `./crypto/index.js` —
// 62-26 mints the receiving key at accept (`generateDkgReceivingKey`) and
// reads the same identifier/validation/reconstruction primitives the
// key-release engine uses.
export { DkgError, dkgIdentifierForUser, generateDkgReceivingKey, validateReleasedShare, reconstructGroupSecret } from './crypto/index.js'
export type { DkgErrorCode, ReleasedShare, ReconstructionResult } from './crypto/index.js'
// Phase 62 Plan 14 (D-03/D-04/D-29/D-32/D-46): the intake module, re-exported
// by name (never `export *`) for its RN consumers — the Authority's officer
// key step and peer intake (62-21), the bridge URL card (62-25) and the
// re-association toggle (62-27), and the Voter's sealing (62-22). Mirrors
// the exact name list on src/intake/index.ts.
export {
	IntakeError,
	REASSOCIATION_MODES,
	DEFAULT_REASSOCIATION_MODE,
	REST_BRIDGE_URL_MAX_LENGTH,
	intakeQueryPortFromDb,
	intakeQueryPortFromStrandPort,
	resolveIntakeRecipients,
	createIntakeSealer,
	createIntakeOpener,
	isValidRestBridgeUrl,
	normalizeIntakePolicyRow,
	readIntakePolicyFrom,
	reassociationRouteFor,
	IntakeEngine
} from './intake/index.js'
export type {
	IntakeErrorCode,
	IntakeSignCallback,
	ReassociationMode,
	ReassociationMatchMethod,
	ReassociationRoute,
	IntakeRecipientDroppedKey,
	IntakeRecipientSet,
	OfficerEncryptionKeyRegistration,
	OfficerEncryptionKeyStatus,
	IntakeSealer,
	IntakeOpenFailureReason,
	IntakeOpenResult,
	IntakeOpener,
	AuthorityIntakePolicyView,
	AuthorityIntakePolicyInput,
	IntakeQueryPort
} from './intake/index.js'
// Phase 62 Plan 14: these two `export *` lines are a DELIBERATE exception to
// this file's named-export convention — each transport's whole exported
// surface (class + options/strand-port types, and registration's re-exported
// staging-seam names) IS its consumers' contract. Consumers: 62-21 (Authority
// strand-port adapter, peer intake) and 62-22 (Voter sealing) import
// `P2pRegistrationTransport`/`P2pAssociationTransport` from
// `@votetorrent/vote-engine/rn` in wave 5. NEVER copy either line into
// `src/index.ts` — src/registration/index.ts and src/association/transport/index.ts already reach it (62-15 Task 3).
export * from './registration/transport/p2p-registration-transport.js'
export * from './association/transport/p2p-association-transport.js'
// Phase 63 Plan 03 (D-23/D-26/D-28/D-07): the voting module, re-exported by name (never `export *`)
// for its RN consumers. Those are 63-10/63-11 (Voter eligibility and castVote) and 63-15 (the
// device-proof probe). Mirrors the exact name list on src/voting/index.ts. Deliberately NOT on
// browser-entry.ts (owner resolution R-6): its purity allowlist does not carry
// @noble/curves/nist.js, and the dashboard has no consumer.
export {
	VOTE_ENTRY_KEYS,
	VOTER_ENTRY_KEYS,
	ballotTemplateDigest,
	makeVoteNonce,
	buildVoteEntry,
	voterEntryDigest,
	canonicalJson,
	sortByCanonicalBytes,
	p256KeyToCompressedHex,
	checkVotingKey
} from './voting/index.js'
export type {
	VoteAnswer,
	VoteEntry,
	VoterEntryUnsigned,
	VoterEntry,
	TemplateBallot,
	VotingKeyCheck
} from './voting/index.js'
// Spike 102: vote pools — the Voter runs a PoolAgent through the authority's rendezvous; the
// Authority serves the rendezvous on its control node.
export {
	PoolAgent,
	POOL_MIN_BLOCK_SIZE,
	POOL_SIGN_TIMEOUT_MS,
	createConsentQueue,
	ConsentAbandonedError,
	isConsentAbandonedError,
	POOL_MIN_PROMPT_MS,
	poolTopic,
	commitPoolBlock,
	poolIdentityFromRawKey,
	createPoolIdentity,
	PoolRendezvous,
	createInMemoryRendezvousClient,
	poolRequests,
	POOL_RENDEZVOUS_PROTOCOL,
	attachPoolRendezvous,
	createLibp2pRendezvousClient,
	createFailoverRendezvousClient,
	rendezvousDiscovery,
	matchmakingDiscovery,
	mergedDiscovery,
	POOL_MATCH_TOPIC_KIND,
	poolMatchTopic
} from './pool/index.js'
export type {
	PoolAgentOptions,
	PoolAgentStatus,
	PoolOutcome,
	ConsentQueueOptions,
	ConsentCallControl,
	ConsentQueue,
	ConsentAbandonReason,
	PoolContribution,
	PoolBallot,
	FormedPoolBlock,
	ConsentSignature,
	PoolIdentity,
	PoolRendezvousClient,
	RendezvousRequest,
	RendezvousReply,
	FailoverRendezvousClient,
	PoolDiscovery,
	PoolMatchEntry,
	PoolMatchProvider,
	PoolMatchmakingPorts
} from './pool/index.js'
// The published tally: an officer's device writes one signed ElectionTally row; any device reads and checks it.
export { TallyPublicationEngine } from './tally/index.js'
export type { TallyPublisher, PublishTallyOutcome, PublishedTally, BlockCoverage } from './tally/index.js'
// Reactivity: screens subscribe to strand table changes (cadre-core watchTables) through one hub.
export { StrandChangeHub, STRAND_CHANGE_BACKSTOP_MS } from './reactivity/index.js'
export type { StrandChangeSource, StrandTableWatch, StrandChangeSubscribeOptions } from './reactivity/index.js'
// Phase 65 Plan 09 (D-61/D-52): the block tree (R5), voter slice checks (R6), comprehensive block
// validation (R7) and tally tree (R8), re-exported by name (never `export *`). This is the Voter's engine
// port for these checks; no screen calls it yet. Mirrors the exact name list on src/blocks/index.ts. R6-R8
// are deliberately NOT on browser-entry.ts (they reach @noble/curves/secp256k1.js); R5 is, from its module file.
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
	judgeBlockVoters,
	checkElectionSecret,
	openCommittedBlock,
	SLICE_CHECK_IDS,
	sliceChecks,
	ANSWER_FINDING_CODES,
	ANSWER_INFO_CODES,
	validateVoteEntryAgainstBallot,
	questionType,
	VALIDATION_CODES,
	VALIDATION_INFO_CODES,
	validateElectionBlocks,
	TALLY_TREE_DOMAIN,
	tallyNodeHash,
	tallyLeafHash,
	tallyParentHash,
	addHistograms,
	tallyTreeFrom,
	buildTallyTree,
	verifyTallyTree
} from './blocks/index.js'
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
	BlockVoterJudgement,
	ElectionKeyLike,
	CommittedBlockRow,
	ElectionSecretCheck,
	OpenedBlockVote,
	OpenCommittedBlockFailure,
	OpenCommittedBlockResult,
	SliceCheckId,
	SliceCheckStatus,
	SliceReceipt,
	SliceBlockRow,
	SliceVoterRow,
	SliceTreeAnchor,
	SliceRelease,
	SliceAuthorization,
	SlicePendingPart,
	SliceFailReason,
	SliceNotApplicableReason,
	SliceCheckResult,
	SliceBallotReport,
	SliceCheckRefusal,
	SliceCheckReport,
	AnswerFindingCode,
	FindingSeverity,
	AnswerFinding,
	AnswerCheckQuestion,
	AnswerCheckBallot,
	AnswerCheckScope,
	VoteEntryValidity,
	ValidationCode,
	ValidationFinding,
	VoteVerdict,
	BlockFinding,
	ValidationTotals,
	ValidationBlockRow,
	ValidationVoterRow,
	ValidationRegistrantRow,
	ValidationAssociationRow,
	ValidationTimeline,
	ValidationRelease,
	ValidateElectionBlocksInput,
	ValidationRefusal,
	ElectionValidationResult,
	TallyQuestionCounts,
	TallyBallotCounts,
	TallyHistogram,
	TallyLeafDisposition,
	TallyLeaf,
	TallyNode,
	TallyTree,
	TallyTreeRefusal,
	ReleasedValidation,
	TallyTreeResult,
	TallyTreeInput,
	BuildTallyTreeResult,
	TallyVerifyFailure,
	TallyVerifyResult
} from './blocks/index.js'
// Phase 66: browser pairing. The Authority's officer phone signs a pairing statement and asks an owner
// phone to mint the browser's invitation (pair-mint); the owner phone hosts pair-mint and acts on
// officer-signed revocation rows. Re-exported by name (never `export *`); mirrors the exact name list
// on src/pairing/index.ts.
export {
	PAIRING_CODE_PREFIX,
	PAIRING_QR_BYTE_BUDGET,
	PAIRING_CODE_MAX_CHARS,
	PairingCodeError,
	encodePairingCode,
	decodePairingCode,
	PAIRING_DIGEST_TAG,
	PAIRING_REMOVE_DIGEST_TAG,
	pairingStatementDigest,
	pairingRemoveDigest,
	verifyPairingStatement,
	verifyPairingRemove,
	isCurrentPairingOfficer,
	PAIR_MINT_PROTOCOL,
	PAIR_MINT_MAX_FRAME_BYTES,
	PAIR_MINT_READ_TIMEOUT_MS,
	PAIR_MINT_REFUSAL_CODES,
	parsePairMintRequest,
	parsePairMintReply,
	PairMintTransportError,
	attachPairMint,
	requestPairMint,
	PAIR_MINT_WINDOW_MS,
	PAIR_MINT_CLOCK_SKEW_MS,
	PAIR_MINT_MAX_LIVE_PER_OFFICER,
	PAIR_MINT_PEER_REQUESTS_PER_MINUTE,
	createPairMintService,
	PAIRING_REVOKE_DIGEST_TAG,
	PairingRevocationError,
	pairingRevokeDigest,
	isPairingRevoked,
	revokeDashboardPairing
} from './pairing/index.js'
export type {
	PairingStatement,
	DecodedPairingCode,
	PairingCodeFailure,
	VerifiablePairingStatement,
	PairingVerifyFailure,
	PairingVerifyResult,
	PairMintRefusalCode,
	PairMintMintRequest,
	PairMintRemoveRequest,
	PairMintRequest,
	PairMintReply,
	PairMintHandler,
	PairMintLibp2pLike,
	PairMintOutcome,
	PairMintLogEntry,
	PairMintPorts,
	PairMintService,
	PairingRevocationSigner,
	PairingRevocationReason
} from './pairing/index.js'
