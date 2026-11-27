/**
 * vote-workflows-parity.test.ts (phase 67 plan 22).
 *
 * `@votetorrent/workflows/voter` COPIES the vote record, marker, guard, write-reason, unavailable-reason
 * and reveal types from the app's vote-record-vault / vote-record-store / vote-receipt (the shared package
 * cannot import them: they value-import the native secret-wrap errors and the device storage). This file is
 * where both sides are in scope, so it pins the copies with a strict compile-time `Equal<>` and the app
 * module surfaces' assignability to the two record ports, the producer-resolver seam and the debug sink:
 * any drift fails `yarn typecheck` on this file. The runtime cases pin the shared file-local device-key
 * reject codes to the app's constants, through the binding.
 */

import type { VoteGuardResult as AppVoteGuardResult, VoteMarker as AppVoteMarker, VoteStoreWriteReason as AppVoteStoreWriteReason, buildVoteMarker, guard, VoteStoreWriteError, writeVoteRecord } from '../vote-record-store'
import type { VoteRecord as AppVoteRecord, VoteRecordEnvelope as AppVoteRecordEnvelope, VoteRecordUnavailableReason as AppVoteRecordUnavailableReason, sealVoteRecord, VoteRecordUnavailableError } from '../vote-record-vault'
import type { VoteReceiptReveal as AppVoteReceiptReveal } from '../vote-receipt'
import type { resolveVoteSigningProducer } from '../attestation-producer'
import type { idPrefix, vtDebug } from '../vt-debug'
import type {
	VoteCastingSeams,
	VoteGuardResult as SharedVoteGuardResult,
	VoteMarker as SharedVoteMarker,
	VoteRecord as SharedVoteRecord,
	VoteRecordEnvelope as SharedVoteRecordEnvelope,
	VoteRecordReveal as SharedVoteRecordReveal,
	VoteRecordStorePort,
	VoteRecordUnavailableReason as SharedVoteRecordUnavailableReason,
	VoteRecordVaultPort,
	VoteSendDebug,
	VoteStoreWriteReason as SharedVoteStoreWriteReason,
} from '@votetorrent/workflows/voter'
import type { Ballot, Question } from '@votetorrent/vote-core'
import type { VoteContext } from '../election-read'
import type { AttestationProducer } from '../attestation-producer'

jest.mock('@votetorrent/attestation-native', () => ({
	...jest.requireActual('@votetorrent/attestation-native'),
	createRealAttestationProducer: jest.fn(),
}))

import { DEVICE_KEY_ABSENT_CODE, DEVICE_KEY_INVALIDATED_CODE } from '../attestation-failure'
import { evaluateVoteEligibility } from '../vote-casting'

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

const voteRecordParity: Equal<AppVoteRecord, SharedVoteRecord> = true
const voteRecordEnvelopeParity: Equal<AppVoteRecordEnvelope, SharedVoteRecordEnvelope> = true
const voteRecordUnavailableReasonParity: Equal<AppVoteRecordUnavailableReason, SharedVoteRecordUnavailableReason> = true
const voteMarkerParity: Equal<AppVoteMarker, SharedVoteMarker> = true
const voteStoreWriteReasonParity: Equal<AppVoteStoreWriteReason, SharedVoteStoreWriteReason> = true
const voteGuardResultParity: Equal<AppVoteGuardResult, SharedVoteGuardResult> = true
const voteRecordRevealParity: Equal<AppVoteReceiptReveal, SharedVoteRecordReveal> = true
const appStoreIsStorePort: Assignable<{ guard: typeof guard, buildVoteMarker: typeof buildVoteMarker, writeVoteRecord: typeof writeVoteRecord, VoteStoreWriteError: typeof VoteStoreWriteError }, VoteRecordStorePort> = true
const appVaultIsVaultPort: Assignable<{ sealVoteRecord: typeof sealVoteRecord, VoteRecordUnavailableError: typeof VoteRecordUnavailableError }, VoteRecordVaultPort> = true
const appResolverIsSeam: Assignable<typeof resolveVoteSigningProducer, VoteCastingSeams['resolveVoteSigningProducer']> = true
const appDebugIsSink: Assignable<{ vtDebug: typeof vtDebug, idPrefix: typeof idPrefix }, VoteSendDebug> = true

function question (code: string, overrides: Partial<Question> = {}): Question {
	return { code, title: `Title ${code}`, instructions: '', type: 'select', options: [{ code: 'x', title: `${code} X` }, { code: 'y', title: `${code} Y` }], ...overrides } as Question
}

function ballot (id: string, questions: Question[]): Ballot {
	return { id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions } as Ballot
}

const OPEN_CONTEXT: VoteContext = {
	electionId: 'e-1',
	revision: 3,
	authorityId: 'a-1',
	open: true,
	lifecycleState: 'Open',
	ballots: [ballot('b-1', [question('q-req'), question('q-opt', { required: false })])],
	unconfirmedBallotIds: [],
	unsupportedQuestionCount: 0,
}

describe('vote workflows parity (Voter)', () => {
	it('P2 the record types and ports are pinned (compile-time)', () => {
		expect([
			voteRecordParity,
			voteRecordEnvelopeParity,
			voteRecordUnavailableReasonParity,
			voteMarkerParity,
			voteStoreWriteReasonParity,
			voteGuardResultParity,
			voteRecordRevealParity,
			appStoreIsStorePort,
			appVaultIsVaultPort,
			appResolverIsSeam,
			appDebugIsSink,
		]).toEqual([true, true, true, true, true, true, true, true, true, true, true])
	})

	it.each([
		[DEVICE_KEY_ABSENT_CODE, 'not-registered'],
		[DEVICE_KEY_INVALIDATED_CODE, 'device-key-rotated'],
		['OTHER', 'device-check-failed'],
	])('P1 the shared device-key code %s reads as %s through the binding', async (code, reason) => {
		const producer = {
			provisionDeviceKey: jest.fn(),
			getCurrentDeviceKey: jest.fn(async () => { throw { code } }),
			produce: jest.fn(),
			signDeviceKeyDigest: jest.fn(),
		}
		const eligibility = await evaluateVoteEligibility({
			getEngine: jest.fn(async () => { throw new Error('no engine is reached after a device-key failure') }) as never,
			nowMs: 1234,
			selectionMap: { 'b-1:q-req': ['b-1:q-req:x'] },
			producer: producer as unknown as AttestationProducer,
			readContext: async () => OPEN_CONTEXT,
			guard: async () => 'ok',
		})
		expect(eligibility.eligible).toBe(false)
		expect(eligibility.eligible === false && eligibility.reason).toBe(reason)
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
	})
})
