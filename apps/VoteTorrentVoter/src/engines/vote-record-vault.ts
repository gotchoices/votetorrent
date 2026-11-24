/**
 * vote-record-vault.ts - binding over the shared vote record vault
 * (`packages/workflows/src/voter/vote-record-vault.ts`, phase 67 plan 30). The path stays so every
 * importer and test mock keeps working; this file supplies the platform seams: the native wrap provider
 * (`resolveVoteRecordWrapProvider`), the native error-code reader (`SecretWrapError.code`) and the V1
 * wrap-key alias. The envelope seal/open, the AAD and the reason map live ONLY in the shared file.
 */

import { SecretWrapError, type SecretWrapPrompt } from '@votetorrent/attestation-native'
import { createVoteRecordVault, type VoteRecord, type VoteRecordEnvelope } from '@votetorrent/workflows/voter'
import { resolveVoteRecordWrapProvider, VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1 } from './vote-record-wrap'

export { VOTE_RECORD_AAD_PREFIX, buildVoteRecordAad, VoteRecordUnavailableError, isVoteRecord, isVoteRecordEnvelope } from '@votetorrent/workflows/voter'
export type {
	VoteRecordAnswer,
	VoteRecordVoteEntry,
	VoteRecordVoterEntry,
	VoteRecord,
	VoteRecordEnvelope,
	VoteRecordUnavailableReason,
} from '@votetorrent/workflows/voter'

/** The app's vault: the shared factory over the native wrap provider, resolved at every call. */
const appVault = createVoteRecordVault({
	resolveWrapProvider: () => resolveVoteRecordWrapProvider(),
	readWrapErrorCode: (err) => (err instanceof SecretWrapError ? err.code : null),
	wrapKeyAlias: VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1,
})

export function sealVoteRecord(record: VoteRecord, options: { prompt: SecretWrapPrompt }): Promise<VoteRecordEnvelope> {
	return appVault.sealVoteRecord(record, options)
}

export function openVoteRecord(electionId: string, envelope: VoteRecordEnvelope, options: { prompt: SecretWrapPrompt }): Promise<VoteRecord> {
	return appVault.openVoteRecord(electionId, envelope, options)
}
