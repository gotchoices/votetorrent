// voting/index.ts — phase 63 plan 03 (D-23/D-26/D-28/D-07).
//
// Role:
//   - Publishes the 63-01 vote/voter entry builders and canonical ordering rule, plus the 63-02
//     voting-key normalisation, for the Voter (63-10/63-11), the device-proof probe (63-15) and
//     the future block builder, so they all share one implementation.
//
// Rules:
//   - Named exports only, so a later addition to a module file cannot silently widen the surface.
//   - Deliberately NOT on browser-entry.ts (owner resolution R-6): the browser-entry purity
//     allowlist does not carry the noble nist curves subpath, and the dashboard holds no key and
//     has no consumer.
export { VOTE_ENTRY_KEYS, VOTER_ENTRY_KEYS, ballotTemplateDigest, makeVoteNonce, buildVoteEntry, voterEntryDigest } from './vote-entries.js'
export type { VoteAnswer, VoteEntry, VoterEntryUnsigned, VoterEntry, TemplateBallot } from './vote-entries.js'
export { canonicalJson, sortByCanonicalBytes } from './canonical.js'
export { p256KeyToCompressedHex, checkVotingKey } from './vote-signing.js'
export type { VotingKeyCheck } from './vote-signing.js'
