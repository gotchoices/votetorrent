/**
 * vote-casting.ts - the Submit gate for local vote casting (Phase 63). `evaluateVoteEligibility`
 * decides whether Submit may sign; a later plan adds `castVote` to this file and signs only on the
 * producer instance this gate returns.
 *
 * Eight ordered gates, every dependency injected. The cheap, pure gates (1-5) run before any
 * native or engine call, so an unready ballot never touches the keystore:
 *   1. window open, from `readVoteContext` at the injected clock only (D-01);
 *   2. every ballot confirmed, and at least one ballot (D-03);
 *   3. no unsupported question and no `dependsOn` question (D-05, R-2);
 *   4. selections usable, required questions answered, `optionRange.min` met for answered
 *      questions (D-04, R-2); a selection for an office not on the ballot is ignored (WR-01);
 *   5. an all-blank ballot is eligible when nothing is required (R-3);
 *   6. a registered device: the P-256 device key, the exact `Association.DeviceKey` lookup, an
 *      active Registrant of the election's authority (D-06);
 *   7. `checkVotingKey` after the lookup hit (D-07, R-1);
 *   8. the local vote-record guard (D-20, D-21).
 *
 * Fail-closed: any read failure refuses with a closed reason and never enables Submit. The only
 * rejection is a producer override that cannot sign, which is a programming error.
 *
 * It never signs: this function only reads the current key (never provisions). It never uses the secp256k1
 * device user, because that key is not the one an Association names and would read "not
 * registered" forever. It never touches AsyncStorage: the saved-vote state arrives only through
 * the store's guard. It does not log; the closed reason is the only diagnostic.
 *
 * R-1: the D-06 lookup is the exact `Association.DeviceKey` match, so a rotated Android key reads
 * as not-registered. `checkVotingKey` runs after a hit as defence in depth, and no other lookup
 * route exists.
 *
 * castVote is the local Submit: fresh eligibility, then build, ONE signature, self-check, seal and
 * store, in that order (D-23, D-29). Nonces come only from the CSPRNG, one per ballot, with no voter
 * entropy (D-16, D-27). The voter entry carries the normalized compressed key (D-26) and the
 * signature covers only `voterEntryDigest`, never answers or nonces (D-25). Signing uses only the
 * producer instance eligibility returned, which is real in every build (D-08); the dev stub producer
 * is never reachable from here. A failure after signing persists nothing (the store's marker is the
 * commit point) and returns a closed reason; nothing is logged.
 */
import { buildVoteEntry, checkVotingKey, makeVoteNonce, verifySigP256, voterEntryDigest } from '@votetorrent/vote-engine/rn'
import type { VoteEntry, VoterEntry, VoterEntryUnsigned } from '@votetorrent/vote-engine/rn'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import type { IAssociationEngine, IRegistrationEngine } from '@votetorrent/vote-core'
import { readVoteContext, toVoterBallot } from './election-read'
import type { ElectionReadDeps, VoteContext } from './election-read'
import { resolveVoteSigningProducer } from './attestation-producer'
import { isDeviceKeyAbsent, isDeviceKeyInvalidated } from './attestation-failure'
import type { AttestationProducer, VoteSigningProducer } from './attestation-producer'
import { buildVoteMarker, guard as readVoteGuard, VoteStoreWriteError, writeVoteRecord } from './vote-record-store'
import type { VoteGuardResult, VoteStoreWriteReason } from './vote-record-store'
import { sealVoteRecord, VoteRecordUnavailableError } from './vote-record-vault'
import type { VoteRecord, VoteRecordUnavailableReason } from './vote-record-vault'
import type { LifecycleState } from '../providers/types'

export const VOTE_INELIGIBLE_REASONS = [
	'election-unavailable',
	'window-closed',
	'ballot-unconfirmed',
	'no-ballots',
	'unsupported-question',
	'dependent-question',
	'selection-invalid',
	'required-unanswered',
	'below-minimum',
	'device-check-failed',
	'not-registered',
	'registration-ambiguous',
	'device-key-rotated',
	'unreadable-key',
	'already-saved',
] as const

export type VoteIneligibleReason = (typeof VOTE_INELIGIBLE_REASONS)[number]

export interface VoteQuestionRef {
	officeId: string
	ballotId: string
	questionCode: string
}

/** ballotId -> questionCode -> optionCodes (distinct, ascending). Blank questions are absent. */
export type VoteSelections = Record<string, Record<string, string[]>>

export type VoteSelectionResult =
	| { ok: true, selections: VoteSelections, blankQuestions: VoteQuestionRef[] }
	| { ok: false, reason: 'selection-invalid' | 'required-unanswered' | 'below-minimum', questions: VoteQuestionRef[] }

export interface VotingIdentity {
	registrantId: string
	privateCid: string
	publicCid: string | null
	attestationCid: string | null
	/** The raw string `getCurrentDeviceKey` returned (SPKI base64 on Android). */
	currentDeviceKey: string
	/** `checkVotingKey`'s compressed key, the value the voter entry carries. */
	compressedDeviceKey: string
}

export interface VoteEligibilityDeps {
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	fallbackElectionId?: string
	/** `useVoterApp().nowMs()`, read fresh by the caller per evaluation. */
	nowMs: number
	/** `Office.id` -> selected `Candidate.id[]`. */
	selectionMap: Readonly<Record<string, readonly string[]>>
	/** DI seam; always passes through `resolveVoteSigningProducer`. */
	producer?: AttestationProducer
	readContext?: (deps: ElectionReadDeps, nowMs: number) => Promise<VoteContext>
	guard?: (electionId: string, currentRevision: number) => Promise<VoteGuardResult>
}

export interface VoteEligible {
	eligible: true
	context: VoteContext
	selections: VoteSelections
	blankQuestions: VoteQuestionRef[]
	voter: VotingIdentity
	/** The instance whose `getCurrentDeviceKey()` produced `voter.currentDeviceKey`; sign on it. */
	producer: VoteSigningProducer
	replacesStale: boolean
}

export interface VoteIneligible {
	eligible: false
	reason: VoteIneligibleReason
	questions: VoteQuestionRef[]
	ballotIds: string[]
	lifecycleState: LifecycleState | null
}

export type VoteEligibility = VoteEligible | VoteIneligible

function compareText (a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function compareRefs (a: VoteQuestionRef, b: VoteQuestionRef): number {
	return compareText(a.ballotId, b.ballotId) || compareText(a.questionCode, b.questionCode)
}

/**
 * Maps the UI selection map to structured codes through the confirmed ballots' offices
 * (`Office.ballotId` / `questionCode`, `Candidate.optionCode`); an id is never split. Pure: never
 * mutates its input and never throws on map contents.
 *
 * WR-01: an entry whose office is not on the confirmed ballots is an orphan (a question dropped or
 * re-coded by a later revision, or another election's selection). It is ignored, so it is never
 * signed and never blocks Submit; the voter cannot see or clear it. An entry for an office that IS
 * on the ballot but is unusable (not an array, a candidate the office does not offer, more options
 * than `voteFor`) still refuses `selection-invalid`, and always names that question.
 */
export function resolveVoteSelections (
	context: Pick<VoteContext, 'electionId' | 'ballots'>,
	selectionMap: Readonly<Record<string, readonly string[]>>
): VoteSelectionResult {
	const offices = toVoterBallot(context.electionId, context.ballots).offices
	const byId = new Map(offices.map(o => [o.id, o]))
	const codesByOffice = new Map<string, string[]>()
	const invalid = new Map<string, VoteQuestionRef>()

	for (const [officeId, ids] of Object.entries(selectionMap)) {
		const office = byId.get(officeId)
		// WR-01: an orphan office is not on this ballot, so nothing of it can be signed.
		if (office === undefined) continue
		const ref = { officeId, ballotId: office.ballotId, questionCode: office.questionCode }
		if (!Array.isArray(ids)) {
			invalid.set(officeId, ref)
			continue
		}
		if (ids.length === 0) continue
		const codes = new Set<string>()
		let bad = false
		for (const id of ids) {
			const candidate = office.candidates.find(c => c.id === id)
			if (candidate === undefined) {
				bad = true
				break
			}
			codes.add(candidate.optionCode)
		}
		if (bad || codes.size > office.voteFor) {
			invalid.set(officeId, ref)
			continue
		}
		codesByOffice.set(officeId, [...codes].sort(compareText))
	}

	if (invalid.size > 0) {
		// Every invalid entry is on the ballot, so every refusal names at least one question.
		return { ok: false, reason: 'selection-invalid', questions: [...invalid.values()].sort(compareRefs) }
	}

	const selections: VoteSelections = {}
	for (const ballot of context.ballots) selections[ballot.id] = {}
	const blank: Array<{ ref: VoteQuestionRef, required: boolean }> = []
	for (const o of offices) {
		const ref = { officeId: o.id, ballotId: o.ballotId, questionCode: o.questionCode }
		const codes = codesByOffice.get(o.id)
		if (codes === undefined || codes.length === 0) {
			blank.push({ ref, required: o.required })
			continue
		}
		selections[o.ballotId][o.questionCode] = codes
	}

	const missing = blank.filter(b => b.required).map(b => b.ref).sort(compareRefs)
	if (missing.length > 0) return { ok: false, reason: 'required-unanswered', questions: missing }

	const belowMin: VoteQuestionRef[] = []
	for (const o of offices) {
		const codes = codesByOffice.get(o.id)
		if (codes === undefined || codes.length === 0) continue
		const q = context.ballots.find(b => b.id === o.ballotId)?.questions.find(x => x.code === o.questionCode)
		const min = q?.optionRange?.min
		if (typeof min === 'number' && codes.length < min) {
			belowMin.push({ officeId: o.id, ballotId: o.ballotId, questionCode: o.questionCode })
		}
	}
	if (belowMin.length > 0) return { ok: false, reason: 'below-minimum', questions: belowMin.sort(compareRefs) }

	return { ok: true, selections, blankQuestions: blank.map(b => b.ref).sort(compareRefs) }
}

function findUnvotableReason (context: VoteContext): { reason: 'unsupported-question' | 'dependent-question', questions: VoteQuestionRef[] } | null {
	if (context.unsupportedQuestionCount > 0) return { reason: 'unsupported-question', questions: [] }
	const questions: VoteQuestionRef[] = []
	for (const ballot of context.ballots) {
		for (const q of ballot.questions) {
			if (q.dependsOn != null) questions.push({ officeId: ballot.id + ':' + q.code, ballotId: ballot.id, questionCode: q.code })
		}
	}
	return questions.length > 0 ? { reason: 'dependent-question', questions: questions.sort(compareRefs) } : null
}

async function resolveVotingRegistrant (
	producer: VoteSigningProducer,
	getEngine: VoteEligibilityDeps['getEngine'],
	authorityId: string
): Promise<
	| { ok: true, voter: VotingIdentity }
	| { ok: false, reason: 'device-check-failed' | 'not-registered' | 'registration-ambiguous' | 'device-key-rotated' | 'unreadable-key' }
> {
	let publicKey: string
	try {
		// LOOKUP, never creation: `provisionDeviceKey` regenerates the key on Android, so using it
		// here made every registered voter read as `not-registered` (63-18 device evidence).
		const current = await producer.getCurrentDeviceKey()
		publicKey = current.publicKey
	} catch (err) {
		// No key under the alias: this device never registered. A permanently invalidated key is
		// the registered key being unusable, i.e. the registration no longer matches the device.
		if (isDeviceKeyAbsent(err)) return { ok: false, reason: 'not-registered' }
		if (isDeviceKeyInvalidated(err)) return { ok: false, reason: 'device-key-rotated' }
		return { ok: false, reason: 'device-check-failed' }
	}
	if (typeof publicKey !== 'string' || publicKey === '') return { ok: false, reason: 'device-check-failed' }

	const matches: Array<{ row: { registrantId: string, deviceKey: string, attestationCid?: string | null }, registrant: { id: string, privateCid: string, publicCid?: string | null } }> = []
	try {
		const rows = await (await getEngine<IAssociationEngine>('association')).getAssociationsByDeviceKey(publicKey)
		if (rows.length === 0) return { ok: false, reason: 'not-registered' }
		const registration = await getEngine<IRegistrationEngine>('registration')
		for (const row of rows) {
			const registrant = await registration.getRegistrant(row.registrantId)
			if (registrant !== undefined && registrant.status === 'a' && registrant.authorityId === authorityId) {
				matches.push({ row, registrant })
			}
		}
	} catch {
		return { ok: false, reason: 'device-check-failed' }
	}

	if (matches.length === 0) return { ok: false, reason: 'not-registered' }
	if (matches.length > 1) return { ok: false, reason: 'registration-ambiguous' }
	const match = matches[0]

	const check = checkVotingKey(publicKey, match.row.deviceKey)
	if (!check.ok) return { ok: false, reason: check.reason }

	return {
		ok: true,
		voter: {
			registrantId: match.registrant.id,
			privateCid: match.registrant.privateCid,
			publicCid: match.registrant.publicCid ?? null,
			attestationCid: match.row.attestationCid ?? null,
			currentDeviceKey: publicKey,
			compressedDeviceKey: check.compressedKey,
		},
	}
}

export async function evaluateVoteEligibility (deps: VoteEligibilityDeps): Promise<VoteEligibility> {
	const refuse = (
		reason: VoteIneligibleReason,
		extras: { questions?: VoteQuestionRef[], ballotIds?: string[], lifecycleState?: LifecycleState | null } = {}
	): VoteIneligible => ({
		eligible: false,
		reason,
		questions: extras.questions ?? [],
		ballotIds: extras.ballotIds ?? [],
		lifecycleState: extras.lifecycleState ?? null,
	})

	const read = deps.readContext ?? readVoteContext
	let context: VoteContext
	try {
		context = await read({ getEngine: deps.getEngine, fallbackElectionId: deps.fallbackElectionId }, deps.nowMs)
	} catch {
		return refuse('election-unavailable')
	}
	const lifecycleState = context.lifecycleState

	if (!context.open) return refuse('window-closed', { lifecycleState })
	if (context.unconfirmedBallotIds.length > 0) return refuse('ballot-unconfirmed', { ballotIds: [...context.unconfirmedBallotIds], lifecycleState })
	if (context.ballots.length === 0) return refuse('no-ballots', { lifecycleState })

	const unvotable = findUnvotableReason(context)
	if (unvotable !== null) return refuse(unvotable.reason, { questions: unvotable.questions, lifecycleState })

	const resolved = resolveVoteSelections(context, deps.selectionMap)
	if (!resolved.ok) return refuse(resolved.reason, { questions: resolved.questions, lifecycleState })

	const producer = resolveVoteSigningProducer(deps.producer)
	const registrant = await resolveVotingRegistrant(producer, deps.getEngine, context.authorityId)
	if (!registrant.ok) return refuse(registrant.reason, { lifecycleState })

	let saved: VoteGuardResult
	try {
		saved = await (deps.guard ?? readVoteGuard)(context.electionId, context.revision)
	} catch {
		return refuse('already-saved', { lifecycleState })
	}
	if (saved !== 'ok' && saved !== 'stale') return refuse('already-saved', { lifecycleState })

	return {
		eligible: true,
		context,
		selections: resolved.selections,
		blankQuestions: resolved.blankQuestions,
		voter: registrant.voter,
		producer,
		replacesStale: saved === 'stale',
	}
}

export interface CastVoteDeps extends VoteEligibilityDeps {
	signPrompt: SecretWrapPrompt
	recordPrompt: SecretWrapPrompt
}

export type CastVoteFailureStage = 'ineligible' | 'build' | 'sign' | 'seal' | 'store'

export type CastVoteSignFailureReason = 'canceled' | 'biometric-unavailable' | 'sign-failed' | 'signature-invalid'

export interface CastVoteSaved {
	ok: true
	electionId: string
	electionRevision: number
	ballotIds: string[]
	savedAt: string
	replacedStale: boolean
}

export type CastVoteFailure =
	| { ok: false, stage: 'ineligible', eligibility: VoteIneligible }
	| { ok: false, stage: 'build', reason: 'build-failed' }
	| { ok: false, stage: 'sign', reason: CastVoteSignFailureReason }
	| { ok: false, stage: 'seal', reason: VoteRecordUnavailableReason }
	| { ok: false, stage: 'store', reason: VoteStoreWriteReason }

export type CastVoteResult = CastVoteSaved | CastVoteFailure

function assertPromptCopy (prompt: SecretWrapPrompt): void {
	const ok = (v: unknown): boolean => typeof v === 'string' && v !== ''
	if (prompt == null || !ok(prompt.title) || !ok(prompt.subtitle) || !ok(prompt.negativeButton)) {
		throw new TypeError('castVote prompt copy must be non-empty')
	}
}

function freshVoteNonce (): string {
	const random = (globalThis as unknown as { crypto: { getRandomValues<T extends Uint8Array> (a: T): T } }).crypto.getRandomValues(new Uint8Array(32))
	return makeVoteNonce(random)
}

/** A `Digest()` output (43 base64url characters) as its 32 bytes, for the native signer. */
export function digestBytesFromBase64Url (digest: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) throw new Error('digest is not 43 base64url characters')
	const padded = digest.replace(/-/g, '+').replace(/_/g, '/') + '='
	const binary = (globalThis as unknown as { atob: (s: string) => string }).atob(padded)
	if (binary.length !== 32) throw new Error('digest is not 32 bytes')
	const out = new Uint8Array(32)
	for (let i = 0; i < 32; i++) out[i] = binary.charCodeAt(i)
	return out
}

function classifySignFailure (err: unknown): CastVoteSignFailureReason {
	const code = (err as { code?: unknown } | null)?.code
	// SYSTEM_CANCELED (review CR-01): the system, not the voter, ended the prompt (app backgrounded,
	// screen locked). Casting is a foreground action the voter retries, so it gets the cancel copy.
	if (code === 'CANCELED' || code === 'SYSTEM_CANCELED') return 'canceled'
	if (
		code === 'NO_BIOMETRICS_ENROLLED' || code === 'LOCKOUT' || code === 'LOCKOUT_PERMANENT'
		|| code === 'BIOMETRIC_ERROR' || code === 'NO_ACTIVITY' || code === 'DEVICE_LOCKED'
	) return 'biometric-unavailable'
	return 'sign-failed'
}

export async function castVote (deps: CastVoteDeps): Promise<CastVoteResult> {
	assertPromptCopy(deps.signPrompt)
	assertPromptCopy(deps.recordPrompt)

	const eligibility = await evaluateVoteEligibility(deps)
	if (!eligibility.eligible) return { ok: false, stage: 'ineligible', eligibility }

	const revision = eligibility.context.revision
	let votes: VoteEntry[]
	let unsigned: VoterEntryUnsigned
	let digest: string
	let digestBytes: Uint8Array
	try {
		const nonces = eligibility.context.ballots.map(() => freshVoteNonce())
		votes = eligibility.context.ballots.map((ballot, i) => buildVoteEntry({
			ballot,
			electionRevision: revision,
			selections: eligibility.selections[ballot.id] ?? {},
			nonce: nonces[i] as string,
		}))
		unsigned = {
			v: 1,
			electionId: eligibility.context.electionId,
			electionRevision: revision,
			registrantId: eligibility.voter.registrantId,
			privateCid: eligibility.voter.privateCid,
			publicCid: eligibility.voter.publicCid,
			deviceKey: eligibility.voter.compressedDeviceKey,
			attestationCid: eligibility.voter.attestationCid,
			ballots: votes.map(v => ({ ballotId: v.ballotId, templateDigest: v.templateDigest })),
		}
		digest = voterEntryDigest(unsigned)
		digestBytes = digestBytesFromBase64Url(digest)
	} catch {
		return { ok: false, stage: 'build', reason: 'build-failed' }
	}

	let signed: { signature: string }
	try {
		signed = await eligibility.producer.signDeviceKeyDigest(digestBytes, { prompt: deps.signPrompt })
	} catch (err) {
		return { ok: false, stage: 'sign', reason: classifySignFailure(err) }
	}

	let valid = false
	try {
		valid = typeof signed?.signature === 'string' && verifySigP256(digest, signed.signature, eligibility.voter.compressedDeviceKey)
	} catch {
		valid = false
	}
	if (!valid) return { ok: false, stage: 'sign', reason: 'signature-invalid' }

	const voter: VoterEntry = { ...unsigned, signature: signed.signature }
	const record: VoteRecord = {
		v: 1,
		electionId: unsigned.electionId,
		electionRevision: revision,
		savedAt: new Date().toISOString(),
		votes,
		voter,
	}

	let envelope: Awaited<ReturnType<typeof sealVoteRecord>>
	try {
		envelope = await sealVoteRecord(record, { prompt: deps.recordPrompt })
	} catch (err) {
		return { ok: false, stage: 'seal', reason: err instanceof VoteRecordUnavailableError ? err.reason : 'native-error' }
	}

	let marker: ReturnType<typeof buildVoteMarker>
	try {
		marker = buildVoteMarker(record)
		await writeVoteRecord(envelope, marker)
	} catch (err) {
		return { ok: false, stage: 'store', reason: err instanceof VoteStoreWriteError ? err.reason : 'storage-failed' }
	}

	return {
		ok: true,
		electionId: marker.electionId,
		electionRevision: marker.electionRevision,
		ballotIds: [...marker.ballotIds],
		savedAt: marker.savedAt,
		replacedStale: eligibility.replacesStale,
	}
}
