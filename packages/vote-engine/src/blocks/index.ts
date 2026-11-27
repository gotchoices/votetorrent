// blocks/index.ts — phase 65 (D-50/D-51/D-52/D-61).
//
// Role:
//   - Publishes the R5 block Merkle tree, the R6 voter slice checks, the R7 comprehensive block validation
//     and the R8 tally tree for the Voter (through rn-entry), the Authority and the dashboard.
//
// Rules:
//   - Named exports only, never export-star, so a later addition to a module file cannot silently widen
//     the surface. Every declared export of every module in this folder is public (blocks-purity P-3a
//     derives the expected names from the module sources).
//   - pool/pool-block.ts internals (checkPoolPayloadShape and its types) are NOT re-exported here.
//   - rn-entry mirrors this barrel by name (D-61). browser-entry imports block-tree.ts directly (D-52),
//     never this barrel, because R6-R8 reach @noble/curves/secp256k1.js.
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
} from './block-tree.js'
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
} from './block-tree.js'
export {
  checkElectionSecret,
  openCommittedBlock
} from './open-committed-block.js'
export type {
  ElectionKeyLike,
  CommittedBlockRow,
  ElectionSecretCheck,
  OpenedBlockVote,
  OpenCommittedBlockFailure,
  OpenCommittedBlockResult
} from './open-committed-block.js'
export {
  SLICE_CHECK_IDS,
  sliceChecks
} from './slice-checks.js'
export type {
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
  SliceCheckReport
} from './slice-checks.js'
export {
  ANSWER_FINDING_CODES,
  ANSWER_INFO_CODES,
  validateVoteEntryAgainstBallot,
  questionType
} from './answer-checks.js'
export type {
  AnswerFindingCode,
  FindingSeverity,
  AnswerFinding,
  AnswerCheckQuestion,
  AnswerCheckBallot,
  AnswerCheckScope,
  VoteEntryValidity
} from './answer-checks.js'
export {
  VALIDATION_CODES,
  VALIDATION_INFO_CODES,
  validateElectionBlocks
} from './validate-blocks.js'
export type {
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
  ElectionValidationResult
} from './validate-blocks.js'
export {
  TALLY_TREE_DOMAIN,
  tallyNodeHash,
  tallyLeafHash,
  tallyParentHash,
  addHistograms,
  tallyTreeFrom,
  buildTallyTree,
  verifyTallyTree
} from './tally-tree.js'
export type {
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
} from './tally-tree.js'
