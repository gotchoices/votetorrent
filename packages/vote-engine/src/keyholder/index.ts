// src/keyholder/index.ts — named-export barrel for the keyholder DKG module
// (62-17). Named exports only — never `export *` — matching `src/crypto/index.ts`'s
// discipline. The pure evaluator (`dkg-evaluator.ts`) and the wire-payload
// codecs (`dkg-payloads.ts`) stay DEEP-PATH (not re-exported here): they are
// internal to `keyholder-dkg-engine.ts` and 62-24's own direct import of
// `../src/keyholder/index.js`, not part of the app-facing surface.
//
// This plan edits NO top-level barrel: 62-14 owns `src/index.ts` and
// `src/rn-entry.ts` in wave 4, and 62-04 owns `src/crypto/index.ts`. 62-20
// (wave 5) adds exactly:
//   - in `packages/vote-engine/src/index.ts`: `export * from './keyholder/index.js'`;
//   - in `packages/vote-engine/src/rn-entry.ts`: named re-exports of
//     `KeyholderDkgEngine`, `KeyholderDkgError`, `keyholderDkgRoundSecretAlias`,
//     `KEYHOLDER_DKG_ROUND_SECRET_POLICY`, `encodeDkgRoundVaultRecord` and
//     `decodeDkgRoundVaultRecord`, plus `export type { KeyholderDkgErrorCode,
//     DkgRoundVaultRecord }`.
// Until 62-20 lands, 62-24's vote-engine tests import `../src/keyholder/index.js`
// directly; 62-26 (wave 6) runs after 62-20.

export {
  KEYHOLDER_DKG_ROUND_SECRET_POLICY,
  keyholderDkgRoundSecretAlias,
  encodeDkgRoundVaultRecord,
  decodeDkgRoundVaultRecord
} from './dkg-vault.js'
export type { DkgRoundVaultRecord } from './dkg-vault.js'

export { KeyholderDkgEngine, KeyholderDkgError } from './keyholder-dkg-engine.js'
export type { KeyholderDkgErrorCode } from './keyholder-dkg-engine.js'
