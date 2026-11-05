/**
 * vote-record-store.test.ts - D-19 / D-20 / D-21 / D-29 proof (Phase 63 plan 08): marker shape and
 * secrecy, record-then-marker write order, both crash windows, the fail-closed guard matrix, the
 * stale replace, never-throwing classify, zero prompts on reads, and an end-to-end sweep with the
 * real vault.
 *
 * Real RKStorage behaviour (restart persistence, the on-device sweep, `pm clear`) is proven on
 * device only by the 63-18 legs; this suite proves the JS contract against the jest AsyncStorage mock.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import { createInMemorySecretWrapperForTests, type InMemorySecretWrapper } from '../__fixtures__/in-memory-secret-wrapper'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'
import {
	isVoteRecord,
	isVoteRecordEnvelope,
	openVoteRecord,
	sealVoteRecord,
	type VoteRecord,
	type VoteRecordEnvelope,
} from '../vote-record-vault'
import {
	VOTE_MARKER_KEY_PREFIX,
	VOTE_RECORD_KEY_PREFIX,
	VoteStoreWriteError,
	buildVoteMarker,
	classifyVoteMarker,
	classifyVoteRecordEnvelope,
	deriveSavedVoteState,
	guard,
	isVoteMarker,
	readSavedVote,
	readVoteMarker,
	voteMarkerKey,
	voteRecordKey,
	voteRecordMatchesMarker,
	writeVoteRecord,
	type VoteMarker,
} from '../vote-record-store'

const PROMPT: SecretWrapPrompt = { title: 'Confirm your vote', subtitle: 'Sign your vote with your device key', negativeButton: 'Cancel' }

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(a)
	return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Needles {
	nonces: string[]
	registrantId: string
	signature: string
	deviceKey: string
	privateCid: string
	templateDigest: string
	questionCode: string
	optionCode: string
}

function makeRecord(args: { electionId?: string; electionRevision?: number; ballots?: number } = {}): { record: VoteRecord; needles: Needles } {
	const electionId = args.electionId ?? 'e1'
	const electionRevision = args.electionRevision ?? 1
	const nBallots = args.ballots ?? 2
	const needles: Needles = {
		nonces: Array.from({ length: nBallots }, () => randHex(32)),
		registrantId: 'reg-' + randHex(8),
		signature: 'sig-' + randHex(16),
		deviceKey: 'dk-' + randHex(8),
		privateCid: 'cid-' + randHex(8),
		templateDigest: 'td-' + randHex(8),
		questionCode: 'qq' + randHex(6),
		optionCode: 'oo' + randHex(6),
	}
	const ballotIds = Array.from({ length: nBallots }, (_, i) => `ballot-${i + 1}`)
	const record: VoteRecord = {
		v: 1,
		electionId,
		electionRevision,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: ballotIds.map((ballotId, i) => ({
			v: 1 as const,
			electionId,
			electionRevision,
			ballotId,
			templateDigest: needles.templateDigest,
			answers: [{ questionCode: needles.questionCode, optionCodes: [needles.optionCode] }],
			nonce: needles.nonces[i]!,
		})),
		voter: {
			v: 1,
			electionId,
			electionRevision,
			registrantId: needles.registrantId,
			privateCid: needles.privateCid,
			publicCid: null,
			deviceKey: needles.deviceKey,
			attestationCid: null,
			ballots: ballotIds.map((ballotId) => ({ ballotId, templateDigest: needles.templateDigest })),
			signature: needles.signature,
		},
	}
	if (!isVoteRecord(record)) throw new Error('makeRecord produced an invalid record')
	return { record, needles }
}

function allNeedles(n: Needles): string[] {
	return [...n.nonces, n.registrantId, n.signature, n.deviceKey, n.privateCid, n.templateDigest, n.questionCode, n.optionCode]
}

const setItem = AsyncStorage.setItem as jest.Mock
const getItem = AsyncStorage.getItem as jest.Mock

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined))

let fixture: InMemorySecretWrapper

async function sealed(record: VoteRecord): Promise<VoteRecordEnvelope> {
	return sealVoteRecord(record, { prompt: PROMPT })
}

async function save(record: VoteRecord): Promise<VoteRecordEnvelope> {
	const env = await sealed(record)
	await writeVoteRecord(env, buildVoteMarker(record))
	return env
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
	try {
		await p
	} catch (e) {
		if (e instanceof VoteStoreWriteError) return e.reason
		throw e
	}
	throw new Error('expected rejection')
}

beforeEach(async () => {
	await AsyncStorage.clear()
	for (const fn of [AsyncStorage.setItem, AsyncStorage.getItem, AsyncStorage.multiSet, AsyncStorage.mergeItem, AsyncStorage.removeItem]) {
		;(fn as jest.Mock).mockClear()
	}
	fixture = createInMemorySecretWrapperForTests()
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(fixture))
})

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined)
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled()
		s.mockRestore()
	}
})

describe('keys', () => {
	it('builds the two per-election keys', () => {
		expect(VOTE_MARKER_KEY_PREFIX).toBe('votetorrent.voteMarker.')
		expect(VOTE_RECORD_KEY_PREFIX).toBe('votetorrent.voteRecord.')
		expect(voteMarkerKey('e1')).toBe('votetorrent.voteMarker.e1')
		expect(voteRecordKey('e1')).toBe('votetorrent.voteRecord.e1')
	})

	it('rejects an empty or non-string election id', () => {
		expect(() => voteMarkerKey('')).toThrow(TypeError)
		expect(() => voteRecordKey('')).toThrow(TypeError)
		expect(() => voteMarkerKey(undefined as unknown as string)).toThrow(TypeError)
	})
})

describe('buildVoteMarker / isVoteMarker', () => {
	it('builds exactly the six non-secret fields', () => {
		const { record, needles } = makeRecord()
		const marker = buildVoteMarker(record)
		expect(marker).toEqual({
			v: 1,
			electionId: 'e1',
			electionRevision: 1,
			ballotIds: ['ballot-1', 'ballot-2'],
			savedAt: record.savedAt,
			status: 'saved-not-sent',
		})
		expect(Object.keys(marker).sort()).toEqual(['ballotIds', 'electionId', 'electionRevision', 'savedAt', 'status', 'v'])
		const json = JSON.stringify(marker)
		for (const n of allNeedles(needles)) expect(json).not.toContain(n)
		expect(isVoteMarker(marker)).toBe(true)
	})

	it('does not alias the record', () => {
		const { record } = makeRecord()
		const marker = buildVoteMarker(record)
		marker.ballotIds.push('x')
		expect(record.voter.ballots.map((b) => b.ballotId)).toEqual(['ballot-1', 'ballot-2'])
	})

	it('rejects an invalid record', () => {
		const { record } = makeRecord()
		expect(() => buildVoteMarker({ ...record, votes: [] })).toThrow(VoteStoreWriteError)
		try {
			buildVoteMarker({ ...record, votes: [] })
		} catch (e) {
			expect((e as VoteStoreWriteError).reason).toBe('invalid-input')
		}
	})

	const good = (): VoteMarker => buildVoteMarker(makeRecord().record)
	it.each([
		['extra nonce key', () => ({ ...good(), nonce: 'x' })],
		['status sent', () => ({ ...good(), status: 'sent' })],
		['v 2', () => ({ ...good(), v: 2 })],
		['revision -1', () => ({ ...good(), electionRevision: -1 })],
		['revision 1.5', () => ({ ...good(), electionRevision: 1.5 })],
		['empty ballotIds', () => ({ ...good(), ballotIds: [] })],
		['empty-string ballot id', () => ({ ...good(), ballotIds: [''] })],
		['empty savedAt', () => ({ ...good(), savedAt: '' })],
		['null', () => null],
		['array', () => []],
		['string', () => 'x'],
	])('isVoteMarker rejects %s', (_name, make) => {
		expect(isVoteMarker(make())).toBe(false)
	})
})

describe('classify (never throws)', () => {
	const marker = buildVoteMarker(makeRecord().record)
	it.each([
		['the string null', 'null'],
		['empty array', '[]'],
		['open brace', '{'],
		['quoted string', '"x"'],
		['number', '42'],
		['wrong version', '{"v":2}'],
		['extra key', JSON.stringify({ ...marker, nonce: 'n' })],
		['foreign election', JSON.stringify({ ...marker, electionId: 'other' })],
	])('classifyVoteMarker: %s is unreadable', (_n, raw) => {
		expect(classifyVoteMarker(raw, 'e1')).toEqual({ kind: 'unreadable' })
	})

	it('classifyVoteMarker: null absent, valid ok', () => {
		expect(classifyVoteMarker(null, 'e1')).toEqual({ kind: 'absent' })
		expect(classifyVoteMarker(JSON.stringify(marker), 'e1')).toEqual({ kind: 'ok', marker })
	})

	it('classifyVoteRecordEnvelope: absent, garbage, ok', async () => {
		const env = await sealed(makeRecord().record)
		expect(classifyVoteRecordEnvelope(null)).toEqual({ kind: 'absent' })
		for (const raw of ['null', '[]', '{', '"x"', '42', '{"v":1}']) {
			expect(classifyVoteRecordEnvelope(raw)).toEqual({ kind: 'unreadable' })
		}
		expect(classifyVoteRecordEnvelope(JSON.stringify(env))).toEqual({ kind: 'ok', envelope: env })
	})
})

describe('deriveSavedVoteState', () => {
	const marker = { ...buildVoteMarker(makeRecord({ electionRevision: 3 }).record) }
	it('maps the table', () => {
		expect(deriveSavedVoteState({ kind: 'absent' }, 3)).toBe('none')
		expect(deriveSavedVoteState({ kind: 'ok', marker }, 3)).toBe('saved')
		expect(deriveSavedVoteState({ kind: 'ok', marker }, 4)).toBe('stale')
		expect(deriveSavedVoteState({ kind: 'ok', marker }, 2)).toBe('stale')
		expect(deriveSavedVoteState({ kind: 'unreadable' }, 3)).toBe('unreadable')
	})
})

describe('writeVoteRecord order and crash windows (D-19, D-29)', () => {
	it('writes the record first and the marker second, as two setItem calls', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		const marker = buildVoteMarker(record)
		await writeVoteRecord(env, marker)
		expect(setItem).toHaveBeenCalledTimes(2)
		expect(setItem.mock.calls[0]![0]).toBe(voteRecordKey('e1'))
		expect(setItem.mock.calls[1]![0]).toBe(voteMarkerKey('e1'))
		// multiSet is invoked internally by the mock's own setItem; the source gate (63-08 task 2) forbids it in the store.
		expect(AsyncStorage.mergeItem).not.toHaveBeenCalled()
		expect(AsyncStorage.removeItem).not.toHaveBeenCalled()
		expect(JSON.parse((await AsyncStorage.getItem(voteRecordKey('e1')))!)).toEqual(env)
		expect(JSON.parse((await AsyncStorage.getItem(voteMarkerKey('e1')))!)).toEqual(marker)
	})

	it('crash window 1: a failed record write leaves no marker and the guard open', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full NEEDLE-TEXT')))
		let err: unknown
		try {
			await writeVoteRecord(env, buildVoteMarker(record))
		} catch (e) {
			err = e
		}
		expect(err).toBeInstanceOf(VoteStoreWriteError)
		expect((err as VoteStoreWriteError).reason).toBe('storage-failed')
		expect((err as Error).message).toBe('vote record store write failed (storage-failed)')
		expect((err as Error).message).not.toContain('NEEDLE-TEXT')
		expect(setItem).toHaveBeenCalledTimes(1)
		expect(await AsyncStorage.getItem(voteMarkerKey('e1'))).toBeNull()
		expect(await guard('e1', 1)).toBe('ok')
	})

	it('crash window 2: an orphan record keeps the guard open and is overwritten by the next save', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		const realImpl = setItem.getMockImplementation() as (k: string, v: string) => Promise<void>
		setItem.mockImplementationOnce(realImpl)
		setItem.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		await expect(writeVoteRecord(env, buildVoteMarker(record))).rejects.toMatchObject({ reason: 'storage-failed' })
		expect(await AsyncStorage.getItem(voteRecordKey('e1'))).toBe(JSON.stringify(env))
		expect(await AsyncStorage.getItem(voteMarkerKey('e1'))).toBeNull()
		expect(await guard('e1', 1)).toBe('ok')

		const env2 = await sealed(record)
		await writeVoteRecord(env2, buildVoteMarker(record))
		const stored = JSON.parse((await AsyncStorage.getItem(voteRecordKey('e1')))!) as VoteRecordEnvelope
		expect(stored.ct).toBe(env2.ct)
		expect(stored.ct).not.toBe(env.ct)
		expect(await guard('e1', 1)).toBe('already-saved')
	})
})

describe('guard matrix (D-20, fail closed)', () => {
	it('empty store is ok', async () => {
		expect(await guard('e1', 1)).toBe('ok')
	})

	it('a saved marker at the current revision is already-saved, even if the record is gone or garbage', async () => {
		await save(makeRecord().record)
		expect(await guard('e1', 1)).toBe('already-saved')
		await AsyncStorage.removeItem(voteRecordKey('e1'))
		expect(await guard('e1', 1)).toBe('already-saved')
		await AsyncStorage.setItem(voteRecordKey('e1'), '{garbage')
		expect(await guard('e1', 1)).toBe('already-saved')
	})

	it.each([
		['garbage marker', () => '{garbage'],
		['extra key', () => JSON.stringify({ ...buildVoteMarker(makeRecord().record), nonce: 'n' })],
		['foreign election', () => JSON.stringify(buildVoteMarker(makeRecord({ electionId: 'other' }).record))],
	])('%s fails closed', async (_n, make) => {
		await AsyncStorage.setItem(voteMarkerKey('e1'), make())
		expect(await guard('e1', 1)).toBe('already-saved')
	})

	it('a rejecting marker read fails closed', async () => {
		getItem.mockImplementationOnce(() => Promise.reject(new Error('read failed')))
		expect(await guard('e1', 1)).toBe('already-saved')
	})

	it('an orphan record without a marker is ok', async () => {
		await AsyncStorage.setItem(voteRecordKey('e1'), JSON.stringify(await sealed(makeRecord().record)))
		expect(await guard('e1', 1)).toBe('ok')
	})

	it('isolates elections', async () => {
		await save(makeRecord({ electionId: 'e1' }).record)
		expect(await guard('e2', 0)).toBe('ok')
		expect((await readSavedVote('e2', 0)).state).toBe('none')
	})
})

describe('stale replace (D-21)', () => {
	it('replaces both keys at a new revision', async () => {
		const first = makeRecord({ electionRevision: 1 }).record
		const env1 = await save(first)
		expect(await guard('e1', 2)).toBe('stale')
		expect((await readSavedVote('e1', 2)).state).toBe('stale')

		const second = makeRecord({ electionRevision: 2 }).record
		const env2 = await sealed(second)
		await writeVoteRecord(env2, buildVoteMarker(second))
		const marker = JSON.parse((await AsyncStorage.getItem(voteMarkerKey('e1')))!) as VoteMarker
		expect(marker.electionRevision).toBe(2)
		const stored = JSON.parse((await AsyncStorage.getItem(voteRecordKey('e1')))!) as VoteRecordEnvelope
		expect(stored).toEqual(env2)
		expect(stored.ct).not.toBe(env1.ct)
		expect(await guard('e1', 2)).toBe('already-saved')
	})
})

describe('WR-02 marker write failure on the stale replace', () => {
	function failMarkerWrite(after?: 'land'): void {
		const realImpl = setItem.getMockImplementation() as (k: string, v: string) => Promise<void>
		setItem.mockImplementationOnce(realImpl)
		setItem.mockImplementationOnce(async (k: string, v: string) => {
			if (after === 'land') await realImpl(k, v)
			throw new Error('disk full NEEDLE-TEXT')
		})
	}

	it('fails storage-failed, keeps the old marker, and the new record is not what the marker commits', async () => {
		const first = makeRecord({ electionRevision: 1 }).record
		await save(first)
		const second = { ...makeRecord({ electionRevision: 2 }).record, savedAt: '2026-10-06T13:00:00.000Z' }
		const env2 = await sealed(second)
		failMarkerWrite()
		expect(await reasonOf(writeVoteRecord(env2, buildVoteMarker(second)))).toBe('storage-failed')

		const kept = await readVoteMarker('e1')
		expect(kept.kind === 'ok' && kept.marker).toEqual(buildVoteMarker(first))
		// The record key holds the uncommitted second record; the marker does not describe it.
		const read = await readSavedVote('e1', 2)
		expect(read.state).toBe('stale')
		const opened = await openVoteRecord('e1', read.envelope!, { prompt: PROMPT })
		expect(opened).toEqual(second)
		expect(voteRecordMatchesMarker(opened, read.marker!)).toBe(false)
		// The guard reads only the marker, so a retry is allowed and commits both keys.
		expect(await guard('e1', 2)).toBe('stale')
		await writeVoteRecord(await sealed(second), buildVoteMarker(second))
		const now = await readSavedVote('e1', 2)
		expect(now.state).toBe('saved')
		expect(voteRecordMatchesMarker(await openVoteRecord('e1', now.envelope!, { prompt: PROMPT }), now.marker!)).toBe(true)
	})

	it('a marker write that lands and then rejects is reported as committed', async () => {
		const { record } = makeRecord()
		failMarkerWrite('land')
		await expect(writeVoteRecord(await sealed(record), buildVoteMarker(record))).resolves.toBeUndefined()
		expect(await guard('e1', 1)).toBe('already-saved')
	})

	it('a rejected marker write whose read-back also fails is storage-failed', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		failMarkerWrite('land')
		const realGet = getItem.getMockImplementation() as (k: string) => Promise<string | null>
		getItem.mockImplementationOnce(realGet) // the pre-write guard read
		getItem.mockImplementationOnce(() => Promise.reject(new Error('read failed')))
		expect(await reasonOf(writeVoteRecord(env, buildVoteMarker(record)))).toBe('storage-failed')
	})
})

describe('WR-02 voteRecordMatchesMarker', () => {
	const { record } = makeRecord({ electionRevision: 4 })
	const marker = buildVoteMarker(record)
	it('matches the marker built from the record', () => {
		expect(voteRecordMatchesMarker(record, marker)).toBe(true)
	})
	it.each<[string, Partial<VoteMarker>]>([
		['revision', { electionRevision: 3 }],
		['savedAt', { savedAt: '2026-10-06T12:00:00.001Z' }],
		['ballot ids', { ballotIds: ['ballot-1'] }],
		['ballot order', { ballotIds: ['ballot-2', 'ballot-1'] }],
		['election', { electionId: 'e2' }],
	])('a %s mismatch does not match', (_n, change) => {
		expect(voteRecordMatchesMarker(record, { ...marker, ...change })).toBe(false)
	})
	it('invalid inputs are false, never a throw', () => {
		expect(voteRecordMatchesMarker({} as VoteRecord, marker)).toBe(false)
		expect(voteRecordMatchesMarker(record, null as unknown as VoteMarker)).toBe(false)
	})
})

describe('the store never overwrites a current vote', () => {
	it('refuses a second write at the same revision', async () => {
		const { record } = makeRecord()
		await save(record)
		const recBefore = await AsyncStorage.getItem(voteRecordKey('e1'))
		const markBefore = await AsyncStorage.getItem(voteMarkerKey('e1'))
		setItem.mockClear()
		const env2 = await sealed(record)
		expect(await reasonOf(writeVoteRecord(env2, buildVoteMarker(record)))).toBe('already-saved')
		expect(setItem).not.toHaveBeenCalled()
		expect(await AsyncStorage.getItem(voteRecordKey('e1'))).toBe(recBefore)
		expect(await AsyncStorage.getItem(voteMarkerKey('e1'))).toBe(markBefore)
	})

	it('refuses when the marker is unreadable', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		await AsyncStorage.setItem(voteMarkerKey('e1'), '{garbage')
		setItem.mockClear()
		expect(await reasonOf(writeVoteRecord(env, buildVoteMarker(record)))).toBe('unreadable')
		expect(setItem).not.toHaveBeenCalled()
	})

	it('rejects invalid input with zero writes', async () => {
		const { record } = makeRecord()
		const env = await sealed(record)
		const marker = buildVoteMarker(record)
		const { ct: _ct, ...noCt } = env
		expect(await reasonOf(writeVoteRecord(noCt as unknown as VoteRecordEnvelope, marker))).toBe('invalid-input')
		expect(await reasonOf(writeVoteRecord(env, { ...marker, nonce: 'x' } as unknown as VoteMarker))).toBe('invalid-input')
		expect(await reasonOf(writeVoteRecord(env, { ...marker, status: 'sent' } as unknown as VoteMarker))).toBe('invalid-input')
		expect(setItem).not.toHaveBeenCalled()
	})
})

describe('readSavedVote', () => {
	it('returns marker and envelope for a saved vote', async () => {
		const { record } = makeRecord()
		const env = await save(record)
		expect(await readSavedVote('e1', 1)).toEqual({ state: 'saved', marker: buildVoteMarker(record), envelope: env, envelopeState: 'ok' })
	})

	it('survives a missing or garbage record', async () => {
		await save(makeRecord().record)
		await AsyncStorage.removeItem(voteRecordKey('e1'))
		const a = await readSavedVote('e1', 1)
		expect(a).toMatchObject({ state: 'saved', envelope: null, envelopeState: 'absent' })
		await AsyncStorage.setItem(voteRecordKey('e1'), '{garbage')
		const b = await readSavedVote('e1', 1)
		expect(b).toMatchObject({ state: 'saved', envelope: null, envelopeState: 'unreadable' })
	})

	it('reports an unreadable marker', async () => {
		await AsyncStorage.setItem(voteMarkerKey('e1'), '{garbage')
		expect(await readSavedVote('e1', 1)).toMatchObject({ state: 'unreadable', marker: null })
	})

	it.each(['null', '[]', '{', '"x"', '42', '{"v":2}'])('never rejects for stored content %s', async (raw) => {
		await AsyncStorage.setItem(voteMarkerKey('e1'), raw)
		await AsyncStorage.setItem(voteRecordKey('e1'), raw)
		await expect(readSavedVote('e1', 1)).resolves.toMatchObject({ state: 'unreadable' })
		await expect(readVoteMarker('e1')).resolves.toEqual({ kind: 'unreadable' })
	})

	it('a storage rejection gives unreadable', async () => {
		getItem.mockImplementationOnce(() => Promise.reject(new Error('x')))
		expect((await readSavedVote('e1', 1)).state).toBe('unreadable')
	})
})

describe('argument validation', () => {
	it('rejects programmer errors before any storage read', async () => {
		await expect(guard('', 0)).rejects.toThrow(TypeError)
		await expect(guard('e1', -1)).rejects.toThrow(TypeError)
		await expect(guard('e1', 1.5)).rejects.toThrow(TypeError)
		await expect(readSavedVote('', 0)).rejects.toThrow(TypeError)
		await expect(readVoteMarker('')).rejects.toThrow(TypeError)
		expect(getItem).not.toHaveBeenCalled()
	})
})

describe('end to end with the real vault', () => {
	it('reads never prompt or touch the keystore', async () => {
		const { record } = makeRecord()
		await save(record)
		const before = { p: fixture.promptCount, w: fixture.wrapCalls, u: fixture.unwrapCalls }
		for (let i = 0; i < 2; i++) {
			await guard('e1', 1)
			await readVoteMarker('e1')
			await readSavedVote('e1', 1)
		}
		expect({ p: fixture.promptCount, w: fixture.wrapCalls, u: fixture.unwrapCalls }).toEqual(before)
	})

	it('persists only ciphertext and a six-key marker, and the stored ciphertext is the record', async () => {
		const { record, needles } = makeRecord()
		await save(record)
		const keys = await AsyncStorage.getAllKeys()
		const pairs = await AsyncStorage.multiGet(keys)
		const joined = pairs.map(([, v]) => v ?? '').join('\n')
		for (const n of allNeedles(needles)) expect(joined).not.toContain(n)
		const markerRaw = await AsyncStorage.getItem(voteMarkerKey('e1'))
		expect(Object.keys(JSON.parse(markerRaw!)).sort()).toEqual(['ballotIds', 'electionId', 'electionRevision', 'savedAt', 'status', 'v'])
		const recordRaw = JSON.parse((await AsyncStorage.getItem(voteRecordKey('e1')))!)
		expect(isVoteRecordEnvelope(recordRaw)).toBe(true)
		const read = await readSavedVote('e1', 1)
		await expect(openVoteRecord('e1', read.envelope!, { prompt: PROMPT })).resolves.toEqual(record)
	})
})
