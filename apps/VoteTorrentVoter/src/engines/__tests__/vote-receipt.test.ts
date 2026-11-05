/**
 * vote-receipt.test.ts - receipt read model proof (Phase 63 plan 12): nonce grouping, ballot rows
 * keyed by questionCode, the election read, the zero-prompt marker load, and the closed reveal
 * mapping. Real store over the AsyncStorage jest mock, real vault with the in-memory wrapper.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SecretWrapErrorCode, SecretWrapPrompt } from '@votetorrent/attestation-native'
import type { Ballot } from '@votetorrent/vote-core'
import { createInMemorySecretWrapperForTests, type InMemorySecretWrapper } from '../__fixtures__/in-memory-secret-wrapper'
import { NoElectionError, type VoteContext } from '../election-read'
import {
	buildReceiptBallots,
	formatNonceGroups,
	loadVoteReceipt,
	NONCE_GROUP_COUNT,
	NONCE_GROUP_SIZE,
	readReceiptElection,
	revealVoteReceipt,
} from '../vote-receipt'
import * as vault from '../vote-record-vault'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'
import { buildVoteMarker, voteMarkerKey, voteRecordKey, writeVoteRecord } from '../vote-record-store'

const PROMPT: SecretWrapPrompt = { title: 'Show your saved vote', subtitle: 'Use your fingerprint', negativeButton: 'Cancel' }

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(a)
	return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

function makeRecord(args: { electionId?: string; electionRevision?: number } = {}): vault.VoteRecord {
	const electionId = args.electionId ?? 'e1'
	const electionRevision = args.electionRevision ?? 3
	const record: vault.VoteRecord = {
		v: 1,
		electionId,
		electionRevision,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: [
			{
				v: 1,
				electionId,
				electionRevision,
				ballotId: 'ballot-1',
				templateDigest: 'td-' + randHex(8),
				answers: [{ questionCode: 'q-a', optionCodes: ['o-1'] }],
				nonce: randHex(32),
			},
		],
		voter: {
			v: 1,
			electionId,
			electionRevision,
			registrantId: 'reg-' + randHex(8),
			privateCid: 'cid-' + randHex(8),
			publicCid: null,
			deviceKey: 'dk-' + randHex(8),
			attestationCid: null,
			ballots: [{ ballotId: 'ballot-1', templateDigest: 'td' }],
			signature: 'sig-' + randHex(16),
		},
	}
	if (!vault.isVoteRecord(record)) throw new Error('makeRecord produced an invalid record')
	return record
}

async function save(record: vault.VoteRecord): Promise<vault.VoteRecordEnvelope> {
	const env = await vault.sealVoteRecord(record, { prompt: PROMPT })
	await writeVoteRecord(env, buildVoteMarker(record))
	return env
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined))

let wrapper: InMemorySecretWrapper

beforeEach(async () => {
	await AsyncStorage.clear()
	wrapper = createInMemorySecretWrapperForTests()
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(wrapper))
})

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined)
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled()
		s.mockRestore()
	}
})

afterEach(() => {
	jest.restoreAllMocks()
	for (const s of consoleSpies) s.mockImplementation(() => undefined)
})

const NONCE = 'a0b1c2d3'.repeat(8)

describe('formatNonceGroups', () => {
	it('splits 64 lowercase hex into 16 groups of 4', () => {
		const g = formatNonceGroups(NONCE)!
		expect(NONCE_GROUP_COUNT).toBe(16)
		expect(NONCE_GROUP_SIZE).toBe(4)
		expect(g).toHaveLength(16)
		for (const x of g) expect(x).toMatch(/^[0-9a-f]{4}$/)
		expect(g.join('')).toBe(NONCE)
	})

	it.each([
		['uppercase', NONCE.toUpperCase()],
		['63 chars', NONCE.slice(1)],
		['65 chars', NONCE + 'a'],
		['space', NONCE.slice(0, 10) + ' ' + NONCE.slice(11)],
		['non-hex', 'g' + NONCE.slice(1)],
		['non-string', 42 as unknown as string],
	])('returns null for %s', (_n, v) => {
		expect(formatNonceGroups(v)).toBeNull()
	})
})

describe('buildReceiptBallots', () => {
	const ballot: Ballot = {
		id: 'ballot-1',
		electionId: 'e1',
		authorityId: 'a1',
		description: 'City ballot',
		districts: [],
		questions: [
			{ code: 'q-b', title: 'Second question', instructions: '', options: [{ code: 'x', title: 'Ex' }], type: 'select' },
			{
				code: 'q-a',
				title: 'First question',
				instructions: '',
				options: [
					{ code: 'o-1', title: 'Option one' },
					{ code: 'o-2', title: 'Option two' },
				],
				type: 'select',
			},
			{ code: 'q-c', title: 'Third', instructions: '', options: [], type: 'select' },
		],
	} as unknown as Ballot

	function recordWith(answers: vault.VoteRecordAnswer[], ballotId = 'ballot-1'): vault.VoteRecord {
		const r = makeRecord()
		r.votes[0] = { ...r.votes[0]!, ballotId, answers }
		return r
	}

	it('follows the ballot question order, keyed by questionCode', () => {
		const [view] = buildReceiptBallots(
			recordWith([
				{ questionCode: 'q-a', optionCodes: ['o-2', 'o-1'] },
				{ questionCode: 'q-b', optionCodes: ['x'] },
			]),
			[ballot],
		)
		expect(view!.description).toBe('City ballot')
		expect(view!.questions.map((q) => q.questionCode)).toEqual(['q-b', 'q-a', 'q-c'])
		expect(view!.questions[1]).toEqual({ questionCode: 'q-a', title: 'First question', choices: ['Option two', 'Option one'], blank: false })
		expect(view!.questions[0]!.choices).toEqual(['Ex'])
	})

	it('marks an unanswered question blank', () => {
		const [view] = buildReceiptBallots(recordWith([{ questionCode: 'q-a', optionCodes: ['o-1'] }]), [ballot])
		expect(view!.questions.find((q) => q.questionCode === 'q-c')).toEqual({ questionCode: 'q-c', title: 'Third', choices: [], blank: true })
	})

	it('appends an answer whose question is not on the ballot with raw codes', () => {
		const [view] = buildReceiptBallots(recordWith([{ questionCode: 'q-zzz', optionCodes: ['c1', 'c2'] }]), [ballot])
		expect(view!.questions[view!.questions.length - 1]).toEqual({ questionCode: 'q-zzz', title: null, choices: ['c1', 'c2'], blank: false })
	})

	it('falls back to the code when an option is unknown', () => {
		const [view] = buildReceiptBallots(recordWith([{ questionCode: 'q-a', optionCodes: ['o-missing'] }]), [ballot])
		expect(view!.questions.find((q) => q.questionCode === 'q-a')!.choices).toEqual(['o-missing'])
	})

	it('handles a vote whose ballot is unknown', () => {
		const [view] = buildReceiptBallots(
			recordWith(
				[
					{ questionCode: 'q2', optionCodes: ['b'] },
					{ questionCode: 'q1', optionCodes: ['a'] },
				],
				'nope',
			),
			[ballot],
		)
		expect(view!.description).toBeNull()
		expect(view!.questions).toEqual([
			{ questionCode: 'q2', title: null, choices: ['b'], blank: false },
			{ questionCode: 'q1', title: null, choices: ['a'], blank: false },
		])
	})

	it('marks every question blank for an all-blank vote', () => {
		const [view] = buildReceiptBallots(recordWith([]), [ballot])
		expect(view!.questions).toHaveLength(3)
		expect(view!.questions.every((q) => q.blank && q.choices.length === 0)).toBe(true)
	})

	it('carries the nonce and its groups', () => {
		const r = recordWith([])
		const [view] = buildReceiptBallots(r, [ballot])
		expect(view!.nonce).toBe(r.votes[0]!.nonce)
		expect(view!.nonceGroups).toEqual(formatNonceGroups(r.votes[0]!.nonce))
	})
})

describe('readReceiptElection', () => {
	const deps = { getEngine: jest.fn() } as never
	const ctx = (electionId: string): VoteContext => ({ electionId, revision: 5, ballots: [] } as unknown as VoteContext)

	it('returns revision and the same ballots reference', async () => {
		const c = ctx('e1')
		const read = jest.fn().mockResolvedValue(c)
		const out = await readReceiptElection(deps, 123, 'e1', read)
		expect(out).toEqual({ revision: 5, ballots: c.ballots })
		expect(out!.ballots).toBe(c.ballots)
		expect(read).toHaveBeenCalledWith(deps, 123)
		expect(read.mock.calls[0]).toHaveLength(2)
	})

	it('returns null for a different election', async () => {
		expect(await readReceiptElection(deps, 1, 'e1', jest.fn().mockResolvedValue(ctx('e2')))).toBeNull()
	})

	it.each([
		['NoElectionError', new NoElectionError()],
		['plain error', new Error('unreadable revision')],
	])('returns null when the read rejects (%s)', async (_n, err) => {
		expect(await readReceiptElection(deps, 1, 'e1', jest.fn().mockRejectedValue(err))).toBeNull()
	})
})

describe('loadVoteReceipt', () => {
	it.each([[3], [null]])('is none on an empty store (revision %s)', async (rev) => {
		expect(await loadVoteReceipt('e1', rev)).toEqual({ kind: 'none' })
		expect(wrapper.promptCount).toBe(0)
	})

	it('is saved at the matching revision', async () => {
		const record = makeRecord()
		await save(record)
		const out = await loadVoteReceipt('e1', 3)
		expect(out.kind).toBe('saved')
		if (out.kind !== 'saved' && out.kind !== 'stale') throw new Error('unreachable')
		expect(out.revisionKnown).toBe(true)
		expect(out.marker).toEqual(buildVoteMarker(record))
		expect(out.envelope.v).toBe(1)
	})

	it('is stale at a different revision', async () => {
		await save(makeRecord())
		const out = await loadVoteReceipt('e1', 4)
		expect(out.kind).toBe('stale')
		expect(out.kind === 'stale' && out.revisionKnown).toBe(true)
	})

	it('is saved with revisionKnown false when the revision is null', async () => {
		await save(makeRecord())
		const out = await loadVoteReceipt('e1', null)
		expect(out.kind).toBe('saved')
		expect(out.kind === 'saved' && out.revisionKnown).toBe(false)
	})

	it('is unreadable when the record key is removed', async () => {
		await save(makeRecord())
		await AsyncStorage.removeItem(voteRecordKey('e1'))
		expect(await loadVoteReceipt('e1', 3)).toEqual({ kind: 'unreadable' })
	})

	it('is unreadable when the record is garbage', async () => {
		await save(makeRecord())
		await AsyncStorage.setItem(voteRecordKey('e1'), '{garbage')
		expect(await loadVoteReceipt('e1', 3)).toEqual({ kind: 'unreadable' })
	})

	it.each([[3], [null]])('is unreadable when the marker is garbage (revision %s)', async (rev) => {
		await save(makeRecord())
		await AsyncStorage.setItem(voteMarkerKey('e1'), '{garbage')
		expect(await loadVoteReceipt('e1', rev)).toEqual({ kind: 'unreadable' })
	})

	it('never prompts or unwraps (D-13)', async () => {
		await save(makeRecord())
		const before = { p: wrapper.promptCount, u: wrapper.unwrapCalls }
		await loadVoteReceipt('e1', 3)
		await loadVoteReceipt('e1', 4)
		await loadVoteReceipt('e1', null)
		await loadVoteReceipt('nothing', 3)
		expect({ p: wrapper.promptCount, u: wrapper.unwrapCalls }).toEqual(before)
	})
})

describe('revealVoteReceipt', () => {
	it('opens the saved record with exactly one prompt', async () => {
		const record = makeRecord()
		const env = await save(record)
		const before = wrapper.promptCount
		const out = await revealVoteReceipt('e1', env, PROMPT)
		expect(out).toEqual({ kind: 'ok', record })
		expect(wrapper.promptCount).toBe(before + 1)
	})

	it('reads another election envelope as unreadable', async () => {
		const env = await save(makeRecord())
		expect(await revealVoteReceipt('e2', env, PROMPT)).toEqual({ kind: 'unreadable' })
	})

	it.each<[SecretWrapErrorCode | 'plain-error', string]>([
		['CANCELED', 'canceled'],
		['NO_BIOMETRICS_ENROLLED', 'biometric-unavailable'],
		['LOCKOUT', 'biometric-unavailable'],
		['DEVICE_LOCKED', 'biometric-unavailable'],
		['KEY_INVALIDATED', 'unreadable'],
		['NO_WRAP_KEY', 'unreadable'],
		['WRAP_KEY_POLICY_MISMATCH', 'unreadable'],
		['UNWRAP_TAG_MISMATCH', 'unreadable'],
		['INVALID_ENCODING', 'unreadable'],
		['UNWRAP_FAILED', 'failed'],
		['NATIVE_UNAVAILABLE', 'failed'],
		['plain-error', 'failed'],
	])('maps an unwrap failure %s to %s without rejecting', async (code, kind) => {
		const env = await save(makeRecord())
		wrapper.failNextCall('unwrap', code)
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind })
	})

	it('WR-02: a stale replace whose marker write failed never reveals the new record', async () => {
		await save(makeRecord({ electionRevision: 3 }))
		const second = { ...makeRecord({ electionRevision: 4 }), savedAt: '2026-10-06T13:00:00.000Z' }
		const env2 = await vault.sealVoteRecord(second, { prompt: PROMPT })
		const setItem = AsyncStorage.setItem as jest.Mock
		const realImpl = setItem.getMockImplementation() as (k: string, v: string) => Promise<void>
		setItem.mockImplementationOnce(realImpl)
		setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full')))
		await expect(writeVoteRecord(env2, buildVoteMarker(second))).rejects.toMatchObject({ reason: 'storage-failed' })

		// The marker still says revision 3, so the receipt is stale; the record key now holds revision 4.
		const load = await loadVoteReceipt('e1', 4)
		expect(load.kind).toBe('stale')
		if (load.kind !== 'stale') throw new Error('unreachable')
		expect(load.marker.electionRevision).toBe(3)
		expect(load.envelope).toEqual(env2)
		const out = await revealVoteReceipt('e1', load.envelope, PROMPT)
		expect(out).toEqual({ kind: 'unreadable' })
		expect(JSON.stringify(out)).not.toContain(second.votes[0]!.nonce)
	})

	it('WR-02 negative control: a record under a marker of another revision is unreadable', async () => {
		const record = makeRecord({ electionRevision: 4 })
		const env = await vault.sealVoteRecord(record, { prompt: PROMPT })
		await AsyncStorage.setItem(voteRecordKey('e1'), JSON.stringify(env))
		await AsyncStorage.setItem(voteMarkerKey('e1'), JSON.stringify({ ...buildVoteMarker(record), electionRevision: 3 }))
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind: 'unreadable' })
	})

	it('WR-02 negative control: the same revision with another save time is unreadable', async () => {
		const record = makeRecord({ electionRevision: 3 })
		const env = await vault.sealVoteRecord(record, { prompt: PROMPT })
		await AsyncStorage.setItem(voteMarkerKey('e1'), JSON.stringify({ ...buildVoteMarker(record), savedAt: '2026-10-06T11:59:59.000Z' }))
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind: 'unreadable' })
	})

	it('WR-02: with no readable marker the reveal is unreadable and never prompts', async () => {
		const env = await vault.sealVoteRecord(makeRecord(), { prompt: PROMPT })
		const before = wrapper.promptCount
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind: 'unreadable' })
		await AsyncStorage.setItem(voteMarkerKey('e1'), '{garbage')
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind: 'unreadable' })
		expect(wrapper.promptCount).toBe(before)
	})

	it('treats an opened record with a malformed nonce as unreadable', async () => {
		const env = await save(makeRecord())
		const bad = makeRecord()
		bad.votes[0] = { ...bad.votes[0]!, nonce: bad.votes[0]!.nonce.toUpperCase() }
		jest.spyOn(vault, 'openVoteRecord').mockResolvedValueOnce(bad)
		expect(await revealVoteReceipt('e1', env, PROMPT)).toEqual({ kind: 'unreadable' })
	})
})
