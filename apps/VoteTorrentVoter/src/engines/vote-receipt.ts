/**
 * vote-receipt.ts - the receipt's read model (Phase 63 plan 12; D-11, D-13, D-15, D-18, D-21, D-22).
 *
 * Status and loss facts come from the 63-08 marker with no keystore call. Choices and nonces come
 * only from `openVoteRecord`, which prompts for a fingerprint, and only when the decrypted record
 * matches the stored marker (WR-02). Storage is reached ONLY through the store's `readVoteMarker`
 * and `readSavedVote` (gate K1). This module never writes, deletes or
 * regenerates anything, and it caches nothing at module level. No logging.
 *
 * Phase 67 plan 30: the reveal workflow moved to `@votetorrent/workflows/voter` (`vote-receipt-read.ts`);
 * `loadVoteReceipt` and `revealVoteReceipt` below forward to a reader built per call over this app's store
 * and vault. The presentation helpers (nonce groups, the election read, the ballot rows) stay here.
 */

import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import type { Ballot } from '@votetorrent/vote-core'
import { createVoteReceiptReader, type VoteReceiptLoad, type VoteReceiptReader, type VoteRecordReveal } from '@votetorrent/workflows/voter'
import { readVoteContext, type ElectionReadDeps } from './election-read'
import { readSavedVote, readVoteMarker, voteRecordMatchesMarker } from './vote-record-store'
import { openVoteRecord, VoteRecordUnavailableError, type VoteRecord, type VoteRecordEnvelope } from './vote-record-vault'

export const NONCE_GROUP_COUNT = 16
export const NONCE_GROUP_SIZE = 4

const NONCE_RE = /^[0-9a-f]{64}$/

/** 16 groups of 4 lowercase hex, the exact stored characters (D-18); null when the nonce is not that shape. */
export function formatNonceGroups(nonce: string): string[] | null {
	if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null
	const groups: string[] = []
	for (let i = 0; i < NONCE_GROUP_COUNT; i++) groups.push(nonce.slice(i * NONCE_GROUP_SIZE, (i + 1) * NONCE_GROUP_SIZE))
	return groups
}

export interface ReceiptElection {
	revision: number
	ballots: Ballot[]
}

/**
 * The election's current revision and ballots. A null result means "cannot be checked", and the
 * screen states that rather than claiming the vote is current (D-21).
 */
export async function readReceiptElection(
	deps: ElectionReadDeps,
	nowMs: number,
	electionId: string,
	read: typeof readVoteContext = readVoteContext,
): Promise<ReceiptElection | null> {
	try {
		const ctx = await read(deps, nowMs)
		if (ctx.electionId !== electionId) return null
		return { revision: ctx.revision, ballots: ctx.ballots }
	} catch {
		return null
	}
}

/**
 * The reveal workflow (`loadVoteReceipt`, `revealVoteReceipt`) lives in the shared package
 * (`packages/workflows/src/voter/vote-receipt-read.ts`, phase 67 plan 30); this binding builds the reader
 * per call over the app's store and vault, so module mocks and spies on those paths stay effective.
 */
export type { VoteReceiptLoad } from '@votetorrent/workflows/voter'
export type VoteReceiptReveal = VoteRecordReveal

function appReceiptReader(): VoteReceiptReader {
	return createVoteReceiptReader({
		readVoteMarker: (id) => readVoteMarker(id),
		readSavedVote: (id, r) => readSavedVote(id, r),
		voteRecordMatchesMarker: (rec, m) => voteRecordMatchesMarker(rec, m),
		openVoteRecord: (id, env, o) => openVoteRecord(id, env, o),
		unavailableReasonOf: (err) => (err instanceof VoteRecordUnavailableError ? err.reason : null),
	})
}

/** Marker-driven state: no keystore call, no prompt (D-13). */
export function loadVoteReceipt(electionId: string, currentRevision: number | null): Promise<VoteReceiptLoad> {
	return appReceiptReader().loadVoteReceipt(electionId, currentRevision)
}

/** The one place choices and nonces are decrypted (WR-02 marker match). Never rejects and never logs. */
export function revealVoteReceipt(electionId: string, envelope: VoteRecordEnvelope, prompt: SecretWrapPrompt): Promise<VoteReceiptReveal> {
	return appReceiptReader().revealVoteReceipt(electionId, envelope, prompt)
}

export interface ReceiptQuestionView {
	questionCode: string
	title: string | null
	choices: string[]
	blank: boolean
}

export interface ReceiptBallotView {
	ballotId: string
	description: string | null
	questions: ReceiptQuestionView[]
	nonce: string
	nonceGroups: string[] | null
}

/** Rows follow the ballot's question order and are keyed by questionCode, never by position. */
export function buildReceiptBallots(record: VoteRecord, ballots: readonly Ballot[]): ReceiptBallotView[] {
	const ballotById = new Map<string, Ballot>()
	for (const b of ballots) ballotById.set(b.id, b)

	return record.votes.map((vote): ReceiptBallotView => {
		const ballot = ballotById.get(vote.ballotId)
		const answerByCode = new Map<string, string[]>()
		for (const a of vote.answers) answerByCode.set(a.questionCode, a.optionCodes)
		const questions: ReceiptQuestionView[] = []

		if (ballot === undefined) {
			for (const a of vote.answers) {
				questions.push({ questionCode: a.questionCode, title: null, choices: [...a.optionCodes], blank: a.optionCodes.length === 0 })
			}
		} else {
			const seen = new Set<string>()
			for (const q of ballot.questions) {
				seen.add(q.code)
				const codes = answerByCode.get(q.code)
				if (codes === undefined || codes.length === 0) {
					questions.push({ questionCode: q.code, title: q.title, choices: [], blank: true })
					continue
				}
				const titleByCode = new Map<string, string>()
				for (const o of q.options) titleByCode.set(o.code, o.title)
				questions.push({
					questionCode: q.code,
					title: q.title,
					choices: codes.map((c) => titleByCode.get(c) ?? c),
					blank: false,
				})
			}
			for (const a of vote.answers) {
				if (seen.has(a.questionCode)) continue
				questions.push({ questionCode: a.questionCode, title: null, choices: [...a.optionCodes], blank: a.optionCodes.length === 0 })
			}
		}

		return {
			ballotId: vote.ballotId,
			description: ballot === undefined ? null : ballot.description,
			questions,
			nonce: vote.nonce,
			nonceGroups: formatNonceGroups(vote.nonce),
		}
	})
}
