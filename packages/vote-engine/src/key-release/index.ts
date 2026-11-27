// src/key-release/index.ts — named-export barrel for the key-release module
// (62-20: D-13, D-14, D-17, D-18, D-20). Named exports only — never
// `export *` — matching `src/crypto/index.ts` and `src/keyholder/index.ts`'s
// discipline.
//
// The evaluator (`key-release-evaluator.ts`) stays DEEP-PATH, exactly like
// 62-17's `dkg-evaluator.ts`: it is internal to `key-release-engine.ts`
// (Task 2) and this package's own tests, not part of the app-facing
// surface.
//
// Reconstruction (`reconstructGroupSecret`) lives in THIS module's engine
// and never in `src/keyholder/` — 62-17's D-16 grep gate over
// `src/keyholder/*.ts` requires zero `combineSecret`/`reconstructGroupSecret`
// uses; custody code never reconstructs.

export { hasEnteredReleasingKeys, releasingKeysAt } from './release-window.js'
export {
  encryptElectionBlock,
  openElectionBlock,
  parseElectionBlockPayload,
  serializeElectionBlockPayload,
  encryptVoteEntry,
  openVoteEntries,
  voteEntryBinding,
  encryptPoolBlock,
  reencryptElectionBlock
} from './election-block.js'
export type { OpenedVoteEntry, DisclosedBlockRandomness } from './election-block.js'
export { KeyReleaseEngine, KeyReleaseError, releaseKeyTaskId } from './key-release-engine.js'
export type { KeyReleaseErrorCode, KeyReleaseEngineDeps } from './key-release-engine.js'
