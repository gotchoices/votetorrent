/**
 * vote-receipt.ts - the receipt's read model (Phase 63 plan 12; D-11, D-13, D-15, D-18, D-21, D-22).
 *
 * Status and loss facts come from the 63-08 marker with no keystore call. Choices and nonces come
 * only from `openVoteRecord`, which prompts for a fingerprint, and only when the decrypted record
 * matches the stored marker (WR-02). Storage is reached ONLY through the store's `readVoteMarker`
 * and `readSavedVote` (gate K1). This module never writes, deletes or
 * regenerates anything, and it caches nothing at module level. No logging.
 */

import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import type { Ballot } from '@votetorrent/vote-core'
import { readVoteContext, type ElectionReadDeps } from './election-read'
import { readSavedVote, readVoteMarker, voteRecordMatchesMarker, type VoteMarker } from './vote-record-store'
import {
	openVoteRecord,
	VoteRecordUnavailableError,
	type VoteRecord,
	type VoteRecordEnvelope,
	type VoteRecordUnavailableReason,
} from './vote-record-vault'

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

export type VoteReceiptLoad =
	| { kind: 'none' }
	| { kind: 'unreadable' }
	| { kind: 'saved' | 'stale'; marker: VoteMarker; envelope: VoteRecordEnvelope; revisionKnown: boolean }

/** Marker-driven state: no keystore call, no prompt (D-13). */
export async function loadVoteReceipt(electionId: string, currentRevision: number | null): Promise<VoteReceiptLoad> {
	let revision: number
	let revisionKnown: boolean
	if (currentRevision === null) {
		const cls = await readVoteMarker(electionId)
		if (cls.kind === 'absent') return { kind: 'none' }
		if (cls.kind === 'unreadable') return { kind: 'unreadable' }
		revision = cls.marker.electionRevision
		revisionKnown = false
	} else {
		revision = currentRevision
		revisionKnown = true
	}
	const read = await readSavedVote(electionId, revision)
	if (read.state === 'none') return { kind: 'none' }
	if (read.state === 'unreadable') return { kind: 'unreadable' }
	// A missing or undecryptable record is reported, never silently re-enabled.
	if (read.envelopeState !== 'ok' || read.marker === null || read.envelope === null) return { kind: 'unreadable' }
	return { kind: read.state, marker: read.marker, envelope: read.envelope, revisionKnown }
}

export type VoteReceiptReveal =
	| { kind: 'ok'; record: VoteRecord }
	| { kind: 'canceled' }
	| { kind: 'biometric-unavailable' }
	| { kind: 'unreadable' }
	| { kind: 'failed' }

const REVEAL_BY_REASON: Record<VoteRecordUnavailableReason, VoteReceiptReveal['kind']> = {
	canceled: 'canceled',
	'biometric-unavailable': 'biometric-unavailable',
	'key-invalidated': 'unreadable',
	'no-wrap-key': 'unreadable',
	'policy-mismatch': 'unreadable',
	'tag-mismatch': 'unreadable',
	malformed: 'unreadable',
	'native-error': 'failed',
}

/**
 * The one place choices and nonces are decrypted. Never rejects and never logs.
 *
 * WR-02: the record is shown only if it is the one the stored marker commits. The marker is read
 * fresh before the prompt (absent or unreadable: `unreadable`, no prompt), and the decrypted record
 * must match it (`voteRecordMatchesMarker`: election, revision, save time, ballot ids). A record a
 * failed save left under an older marker is therefore `unreadable`, never revealed.
 */
export async function revealVoteReceipt(
	electionId: string,
	envelope: VoteRecordEnvelope,
	prompt: SecretWrapPrompt,
): Promise<VoteReceiptReveal> {
	try {
		const stored = await readVoteMarker(electionId)
		if (stored.kind !== 'ok') return { kind: 'unreadable' }
		const record = await openVoteRecord(electionId, envelope, { prompt })
		if (
			record.electionId !== electionId ||
			!voteRecordMatchesMarker(record, stored.marker) ||
			!record.votes.every((v) => NONCE_RE.test(v.nonce))
		) {
			return { kind: 'unreadable' }
		}
		return { kind: 'ok', record }
	} catch (err) {
		if (err instanceof VoteRecordUnavailableError) {
			const kind = REVEAL_BY_REASON[err.reason]
			if (kind === 'canceled' || kind === 'biometric-unavailable' || kind === 'unreadable' || kind === 'failed') {
				return { kind }
			}
		}
		return { kind: 'failed' }
	}
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
