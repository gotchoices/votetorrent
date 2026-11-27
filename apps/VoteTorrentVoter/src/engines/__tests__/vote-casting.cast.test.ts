/**
 * vote-casting.cast.test.ts - castVote proof (Phase 63 plan 11): D-08 one sign call on the
 * eligibility producer, D-16 / D-27 CSPRNG nonces with no voter entropy, D-23 entry shapes, D-24
 * template digests, D-26 normalized key, the signature self-check, D-29 sealing and storing through
 * the real vault and store over an in-memory wrapper, D-21 stale replace, every failure stage and
 * the no-secrets / no-logging invariants.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Ballot, Question } from '@votetorrent/vote-core'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { ballotTemplateDigest, verifySigP256, voterEntryDigest } from '@votetorrent/vote-engine/rn'
import type { VoterEntryUnsigned } from '@votetorrent/vote-engine/rn'
import type { VoteContext } from '../election-read'
import type { AttestationProducer } from '../attestation-producer'
import { createInMemorySecretWrapperForTests, type InMemorySecretWrapper } from '../__fixtures__/in-memory-secret-wrapper'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'
import { openVoteRecord } from '../vote-record-vault'
import { guard, readSavedVote, readVoteMarker, voteMarkerKey, voteRecordKey } from '../vote-record-store'
import { loadVoteReceipt, revealVoteReceipt } from '../vote-receipt'

const mockCreateRealAttestationProducer = jest.fn((_opts: { enablePlayIntegrity: boolean }): unknown => undefined)

jest.mock('@votetorrent/attestation-native', () => ({
	...jest.requireActual('@votetorrent/attestation-native'),
	createRealAttestationProducer: (opts: { enablePlayIntegrity: boolean }) => mockCreateRealAttestationProducer(opts),
}))

import { castVote, type CastVoteDeps, type CastVoteResult, type CastVoteSaved } from '../vote-casting'

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'
const SIGN_PROMPT: SecretWrapPrompt = { title: 'Confirm your vote', subtitle: 'Sign your vote with your device key', negativeButton: 'Cancel' }
const RECORD_PROMPT: SecretWrapPrompt = { title: 'Save your vote', subtitle: 'Protect your saved vote', negativeButton: 'Cancel' }
const VIEW_PROMPT: SecretWrapPrompt = { title: 'View your vote', subtitle: 'Open your saved vote', negativeButton: 'Cancel' }

function hexToU8 (hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16))
}

function makeKey (): { sk: Uint8Array, spki: string, compressed: string } {
	const sk = p256.utils.randomSecretKey()
	const uncompressed = p256.getPublicKey(sk, false)
	const prefix = hexToU8(SPKI_PREFIX)
	const der = new Uint8Array(prefix.length + uncompressed.length)
	der.set(prefix, 0)
	der.set(uncompressed, prefix.length)
	let bin = ''
	for (const b of der) bin += String.fromCharCode(b)
	return { sk, spki: (globalThis as unknown as { btoa: (s: string) => string }).btoa(bin), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

const KEY_A = makeKey()
const KEY_B = makeKey()

function b64urlToBytes (s: string): Uint8Array {
	const bin = (globalThis as unknown as { atob: (v: string) => string }).atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=')
	return Uint8Array.from(bin, c => c.charCodeAt(0))
}

function question (code: string, overrides: Partial<Question> = {}): Question {
	return {
		code,
		title: `Title ${code}`,
		instructions: '',
		type: 'select',
		options: [
			{ code: 'x', title: `${code} X` },
			{ code: 'y', title: `${code} Y` },
		],
		...overrides,
	} as Question
}

function ballot (id: string, questions: Question[]): Ballot {
	return { id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions } as Ballot
}

function ctxOf (revision = 3, overrides: Partial<VoteContext> = {}): VoteContext {
	return {
		electionId: 'e-1',
		revision,
		authorityId: 'a-1',
		open: true,
		lifecycleState: 'Open',
		ballots: [
			ballot('b-1', [question('q-req'), question('q-opt', { required: false })]),
			ballot('b-2', [question('q-two', { required: false })]),
		],
		unconfirmedBallotIds: [],
		unsupportedQuestionCount: 0,
		...overrides,
	}
}

type SignFake = (digest: Uint8Array, opts?: unknown) => Promise<{ signature: string, signerKey: string, signerUserId: string }>

function signingProducer (key = KEY_A, sign?: SignFake) {
	return {
		provisionDeviceKey: jest.fn(async () => { throw new Error('a vote-casting lookup must never provision a device key (63-18)') }),
		getCurrentDeviceKey: jest.fn(async () => ({ publicKey: key.spki })),
		produce: jest.fn(),
		signDeviceKeyDigest: jest.fn(sign ?? (async (digest: Uint8Array) => ({
			signature: bytesToHex(p256.sign(digest, key.sk)),
			signerKey: key.spki,
			signerUserId: '',
		}))),
	}
}

function fakeEngines () {
	const association = { getAssociationsByDeviceKey: jest.fn(async (_k: string) => [{ registrantId: 'r-1', deviceKey: KEY_A.compressed, attestationCid: 'att-1' }]) }
	const registration = {
		getRegistrant: jest.fn(async (id: string) => ({ id, authorityId: 'a-1', status: 'a', privateCid: `priv-${id}`, publicCid: 'pub-1' })),
	}
	return (async (name: string) => {
		if (name === 'association') return association
		if (name === 'registration') return registration
		throw new Error(`unexpected engine ${name}`)
	}) as CastVoteDeps['getEngine']
}

const GOOD: Record<string, string[]> = { 'b-1:q-req': ['b-1:q-req:x'] }

let wrapper: InMemorySecretWrapper
let revisionNow = 3
let producer: ReturnType<typeof signingProducer>
const setItem = AsyncStorage.setItem as jest.Mock
const getItem = AsyncStorage.getItem as jest.Mock

function depsOf (over: Partial<CastVoteDeps> & { ctx?: Partial<VoteContext> } = {}): CastVoteDeps {
	const { ctx, ...rest } = over
	return {
		getEngine: fakeEngines(),
		fallbackElectionId: 'e-1',
		nowMs: 1234,
		selectionMap: GOOD,
		producer: producer as unknown as AttestationProducer,
		readContext: jest.fn(async () => ctxOf(revisionNow, ctx)),
		signPrompt: SIGN_PROMPT,
		recordPrompt: RECORD_PROMPT,
		...rest,
	}
}

async function openStored (electionId: string, revision: number) {
	const read = await readSavedVote(electionId, revision)
	return openVoteRecord(electionId, read.envelope!, { prompt: VIEW_PROMPT })
}

function expectSaved (r: CastVoteResult): CastVoteSaved {
	expect(r.ok).toBe(true)
	return r as CastVoteSaved
}

function expectNothingPersisted (): void {
	expect(wrapper.wrapCalls).toBe(0)
	expect(setItem).not.toHaveBeenCalled()
}

let consoleSpies: jest.SpyInstance[] = []

beforeEach(async () => {
	await AsyncStorage.clear()
	setItem.mockClear()
	getItem.mockClear()
	wrapper = createInMemorySecretWrapperForTests()
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(wrapper))
	revisionNow = 3
	producer = signingProducer()
	mockCreateRealAttestationProducer.mockReset()
	consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => {}))
})

afterEach(() => {
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled()
		s.mockRestore()
	}
})

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined)
})

describe('castVote happy path', () => {
	it('C1 saves one vote per confirmed ballot and the marker (D-23, D-29)', async () => {
		const before = Date.now()
		const r = await castVote(depsOf())
		const after = Date.now()
		expect(r).toEqual({
			ok: true,
			electionId: 'e-1',
			electionRevision: 3,
			ballotIds: ['b-1', 'b-2'],
			savedAt: expect.any(String),
			replacedStale: false,
		})
		const saved = r as CastVoteSaved
		const t = Date.parse(saved.savedAt)
		expect(t).toBeGreaterThanOrEqual(before)
		expect(t).toBeLessThanOrEqual(after)
		const marker = await readVoteMarker('e-1')
		expect(marker.kind).toBe('ok')
		expect(marker.kind === 'ok' && marker.marker.electionRevision).toBe(3)
		expect(await guard('e-1', 3)).toBe('already-saved')

		const record = await openStored('e-1', 3)
		expect(record.votes.map(v => v.ballotId)).toEqual(['b-1', 'b-2'])
		expect(record.votes[0]!.answers).toEqual([{ questionCode: 'q-req', optionCodes: ['x'] }])
		expect(record.votes[1]!.answers).toEqual([])
		expect(record.voter.ballots).toEqual(record.votes.map(v => ({ ballotId: v.ballotId, templateDigest: v.templateDigest })))
	})

	it('C2 D-24 template digests are the confirmed read digests at the context revision', async () => {
		await castVote(depsOf())
		const record = await openStored('e-1', 3)
		const ctx = ctxOf(3)
		record.votes.forEach((v, i) => expect(v.templateDigest).toBe(ballotTemplateDigest(ctx.ballots[i]!, 3)))
	})

	it('C3 D-26 the voter entry carries the compressed key and the signature verifies under it only', async () => {
		await castVote(depsOf())
		const { signature, ...rest } = (await openStored('e-1', 3)).voter
		const unsigned = rest as VoterEntryUnsigned
		expect(unsigned.deviceKey).toBe(KEY_A.compressed)
		expect(unsigned.deviceKey).toMatch(/^0[23][0-9a-f]{64}$/)
		expect(unsigned.deviceKey).not.toBe(KEY_A.spki)
		const digest = voterEntryDigest(unsigned)
		expect(verifySigP256(digest, signature, KEY_A.compressed)).toBe(true)
		expect(verifySigP256(digest, signature, KEY_A.spki)).toBe(false)
	})

	it('C4 D-08 signs exactly once on the eligibility producer with the injected prompt', async () => {
		await castVote(depsOf())
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
		const [digestBytes, opts] = producer.signDeviceKeyDigest.mock.calls[0]! as unknown as [Uint8Array, unknown]
		expect(digestBytes).toBeInstanceOf(Uint8Array)
		expect(digestBytes.length).toBe(32)
		const { signature: _s, ...rest } = (await openStored('e-1', 3)).voter
		expect(Array.from(digestBytes)).toEqual(Array.from(b64urlToBytes(voterEntryDigest(rest as VoterEntryUnsigned))))
		expect(opts).toEqual({ prompt: SIGN_PROMPT })
		expect(producer.getCurrentDeviceKey).toHaveBeenCalledTimes(1)
		// 63-18: Submit looks the key up; it must never mint one.
		expect(producer.provisionDeviceKey).not.toHaveBeenCalled()
	})

	it('C4b with no producer override the one real producer both provisions and signs', async () => {
		const real = signingProducer()
		mockCreateRealAttestationProducer.mockReturnValue(real)
		const deps = depsOf()
		delete deps.producer
		expectSaved(await castVote(deps))
		expect(mockCreateRealAttestationProducer).toHaveBeenCalledTimes(1)
		expect(real.getCurrentDeviceKey).toHaveBeenCalledTimes(1)
		expect(real.provisionDeviceKey).not.toHaveBeenCalled()
		expect(real.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
	})

	it('C5 order: provision, sign, wrap, record write, marker write', async () => {
		const wrapSpy = jest.spyOn(wrapper, 'wrapSecret')
		await castVote(depsOf())
		const provision = producer.getCurrentDeviceKey.mock.invocationCallOrder[0]!
		const sign = producer.signDeviceKeyDigest.mock.invocationCallOrder[0]!
		const wrap = wrapSpy.mock.invocationCallOrder[0]!
		const [first, second] = setItem.mock.invocationCallOrder
		expect(provision).toBeLessThan(sign)
		expect(sign).toBeLessThan(wrap)
		expect(wrap).toBeLessThan(first!)
		expect(first!).toBeLessThan(second!)
		expect(setItem.mock.calls[0]![0]).toBe(voteRecordKey('e-1'))
		expect(setItem.mock.calls[1]![0]).toBe(voteMarkerKey('e-1'))
		expect(setItem).toHaveBeenCalledTimes(2)
	})

	it('C6 prompt count today: one sign and one per-use wrap, no unwrap (D-14 fallback)', async () => {
		await castVote(depsOf())
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
		expect(wrapper.promptCount).toBe(1)
		expect(wrapper.wrapCalls).toBe(1)
		expect(wrapper.unwrapCalls).toBe(0)
		for (const c of wrapper.calls) {
			expect(c.requireAuth).toBe(true)
			expect(c.promptTitle).toBe(RECORD_PROMPT.title)
		}
	})

	it('C7 D-16 / D-27 the nonce IS the CSPRNG bytes, one fresh draw per ballot', async () => {
		const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto) as (a: Uint8Array) => Uint8Array
		let n = 0
		const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
			n += 1
			if (n === 1) { a.fill(0x11); return a }
			if (n === 2) { a.fill(0x22); return a }
			return real(a)
		}) as never)
		try {
			expectSaved(await castVote(depsOf()))
		} finally {
			spy.mockRestore()
		}
		const record = await openStored('e-1', 3)
		expect(record.votes[0]!.nonce).toBe('11'.repeat(32))
		expect(record.votes[1]!.nonce).toBe('22'.repeat(32))
	})

	it('C7b nonces are 64 lowercase hex and distinct across ballots and across casts', async () => {
		const seen = new Set<string>()
		for (let i = 0; i < 2; i++) {
			await AsyncStorage.clear()
			expectSaved(await castVote(depsOf()))
			for (const v of (await openStored('e-1', 3)).votes) {
				expect(v.nonce).toMatch(/^[0-9a-f]{64}$/)
				seen.add(v.nonce)
			}
		}
		expect(seen.size).toBe(4)
	})

	it('C8 R-3 all-blank: one vote per ballot, each with answers []', async () => {
		const all = [
			ballot('b-1', [question('q-req', { required: false }), question('q-opt', { required: false })]),
			ballot('b-2', [question('q-two', { required: false })]),
		]
		expectSaved(await castVote(depsOf({ selectionMap: {}, ctx: { ballots: all } })))
		const record = await openStored('e-1', 3)
		expect(record.votes.length).toBe(2)
		for (const v of record.votes) expect(v.answers).toEqual([])
	})
})

describe('castVote refusals and failures', () => {
	it('C9 ineligible: window closed signs, wraps and writes nothing; a repeat is already-saved', async () => {
		const r = await castVote(depsOf({ ctx: { open: false } }))
		expect(r).toMatchObject({ ok: false, stage: 'ineligible', eligibility: { eligible: false, reason: 'window-closed' } })
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
		expectNothingPersisted()

		expectSaved(await castVote(depsOf()))
		const signsBefore = producer.signDeviceKeyDigest.mock.calls.length
		const again = await castVote(depsOf())
		expect(again).toMatchObject({ ok: false, stage: 'ineligible', eligibility: { reason: 'already-saved' } })
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(signsBefore)
	})

	it.each([
		['CANCELED', 'canceled'],
		['SYSTEM_CANCELED', 'canceled'],
		['NO_BIOMETRICS_ENROLLED', 'biometric-unavailable'],
		['LOCKOUT', 'biometric-unavailable'],
		['LOCKOUT_PERMANENT', 'biometric-unavailable'],
		['BIOMETRIC_ERROR', 'biometric-unavailable'],
		['NO_ACTIVITY', 'biometric-unavailable'],
	])('C10 sign rejection %s maps to %s and persists nothing', async (code, reason) => {
		producer = signingProducer(KEY_A, async () => { throw Object.assign(new Error('boom NEEDLE'), { code }) })
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'sign', reason })
		expectNothingPersisted()
		expect(await guard('e-1', 3)).toBe('ok')
		expect(JSON.stringify(r)).not.toContain('NEEDLE')
	})

	it('C10b an unclassified sign error is sign-failed and leaks no text', async () => {
		producer = signingProducer(KEY_A, async () => { throw new Error('boom NEEDLE') })
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'sign', reason: 'sign-failed' })
		expectNothingPersisted()
		expect(await guard('e-1', 3)).toBe('ok')
		expect(JSON.stringify(r)).not.toContain('NEEDLE')
	})

	it.each([
		['the stub placeholder', () => ({ signature: 'STUB_DEVICE_KEY_' + 'SIGNATURE_PLACEHOLDER_NOT_REAL', signerKey: 'k', signerUserId: '' })],
		['a signature by another key', (d: Uint8Array) => ({ signature: bytesToHex(p256.sign(d, KEY_B.sk)), signerKey: KEY_B.spki, signerUserId: '' })],
		['a signature over a different digest', () => ({ signature: bytesToHex(p256.sign(new Uint8Array(32).fill(7), KEY_A.sk)), signerKey: KEY_A.spki, signerUserId: '' })],
	])('C11 self-check refuses %s as signature-invalid and persists nothing', async (_label, make) => {
		producer = signingProducer(KEY_A, async (d: Uint8Array) => make(d))
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'sign', reason: 'signature-invalid' })
		expectNothingPersisted()
		expect(await guard('e-1', 3)).toBe('ok')
	})

	it.each([
		['CANCELED', 'canceled'],
		['plain-error', 'native-error'],
	] as const)('C12 seal failure (%s) after signing writes nothing and leaves the guard unchanged', async (arm, reason) => {
		wrapper.failNextCall('wrap', arm)
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'seal', reason })
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
		expect(setItem).not.toHaveBeenCalled()
		expect((await readVoteMarker('e-1')).kind).toBe('absent')
		expect(await guard('e-1', 3)).toBe('ok')
	})

	it('C13 store failure on the record write leaves no marker', async () => {
		setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full NEEDLE')))
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'store', reason: 'storage-failed' })
		expect((await readVoteMarker('e-1')).kind).toBe('absent')
		expect(await guard('e-1', 3)).toBe('ok')
		expect(JSON.stringify(r)).not.toContain('NEEDLE')
	})

	it('C13b store failure on the marker write leaves no marker, and a retry succeeds', async () => {
		const realImpl = setItem.getMockImplementation() as (k: string, v: string) => Promise<void>
		setItem.mockImplementationOnce(realImpl)
		setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full NEEDLE')))
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'store', reason: 'storage-failed' })
		expect((await readVoteMarker('e-1')).kind).toBe('absent')
		expect(await guard('e-1', 3)).toBe('ok')
		expect(JSON.stringify(r)).not.toContain('NEEDLE')
		expectSaved(await castVote(depsOf()))
		expect(await guard('e-1', 3)).toBe('already-saved')
	})

	it('C14 D-21 a newer revision replaces the stale record and marker', async () => {
		expectSaved(await castVote(depsOf()))
		revisionNow = 4
		const r = await castVote(depsOf())
		expect(r).toMatchObject({ ok: true, replacedStale: true, electionRevision: 4 })
		const marker = await readVoteMarker('e-1')
		expect(marker.kind === 'ok' && marker.marker.electionRevision).toBe(4)
		expect(await guard('e-1', 4)).toBe('already-saved')
		const record = await openStored('e-1', 4)
		expect(record.electionRevision).toBe(4)
		expect(record.voter.electionRevision).toBe(4)
		const ctx = ctxOf(4)
		record.votes.forEach((v, i) => {
			expect(v.electionRevision).toBe(4)
			expect(v.templateDigest).toBe(ballotTemplateDigest(ctx.ballots[i]!, 4))
		})
		expect(await castVote(depsOf())).toMatchObject({ ok: false, stage: 'ineligible', eligibility: { reason: 'already-saved' } })
	})

	it('C18 WR-01 an orphan selection does not block Submit and is not in the signed entries', async () => {
		// q-gone was on the ballot the voter saw, b-9 is another election's office: neither is on this ballot.
		const selectionMap = { ...GOOD, 'b-1:q-gone': ['b-1:q-gone:x'], 'b-9:q-x': ['b-9:q-x:y'] }
		const r = expectSaved(await castVote(depsOf({ selectionMap })))
		expect(r.ballotIds).toEqual(['b-1', 'b-2'])
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
		const record = await openStored('e-1', 3)
		expect(record.votes[0]!.answers).toEqual([{ questionCode: 'q-req', optionCodes: ['x'] }])
		expect(record.votes[1]!.answers).toEqual([])
		const all = JSON.stringify(record)
		expect(all).not.toContain('q-gone')
		expect(all).not.toContain('b-9')
	})

	it('C19 WR-01 a bad selection for a question still on the ballot blocks Submit and names it', async () => {
		const selectionMap = { ...GOOD, 'b-1:q-opt': ['b-1:q-opt:zzz'], 'b-9:q-x': ['b-9:q-x:y'] }
		const r = await castVote(depsOf({ selectionMap }))
		expect(r).toMatchObject({
			ok: false,
			stage: 'ineligible',
			eligibility: { reason: 'selection-invalid', questions: [{ officeId: 'b-1:q-opt', ballotId: 'b-1', questionCode: 'q-opt' }] },
		})
		expect(producer.getCurrentDeviceKey).not.toHaveBeenCalled()
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
		expectNothingPersisted()
	})

	it('C14b WR-02 a stale replace whose marker write fails is not saved and its record is never revealed', async () => {
		expectSaved(await castVote(depsOf()))
		revisionNow = 4
		const realImpl = setItem.getMockImplementation() as (k: string, v: string) => Promise<void>
		setItem.mockImplementationOnce(realImpl)
		setItem.mockImplementationOnce(() => Promise.reject(new Error('disk full NEEDLE')))
		const r = await castVote(depsOf())
		expect(r).toEqual({ ok: false, stage: 'store', reason: 'storage-failed' })
		const marker = await readVoteMarker('e-1')
		expect(marker.kind === 'ok' && marker.marker.electionRevision).toBe(3)
		expect(await guard('e-1', 4)).toBe('stale')

		const load = await loadVoteReceipt('e-1', 4)
		if (load.kind !== 'stale') throw new Error('expected the stale receipt state')
		expect(await revealVoteReceipt('e-1', load.envelope, VIEW_PROMPT)).toEqual({ kind: 'unreadable' })

		// The retry commits both keys, and that record reveals.
		expect(await castVote(depsOf())).toMatchObject({ ok: true, replacedStale: true, electionRevision: 4 })
		const again = await loadVoteReceipt('e-1', 4)
		if (again.kind !== 'saved') throw new Error('expected the saved receipt state')
		const shown = await revealVoteReceipt('e-1', again.envelope, VIEW_PROMPT)
		expect(shown.kind === 'ok' && shown.record.electionRevision).toBe(4)
	})

	it('C15 a digest the builder cannot use is a build failure before any prompt', async () => {
		const sign = jest.fn()
		await jest.isolateModulesAsync(async () => {
			jest.doMock('@votetorrent/vote-engine/rn', () => ({
				...jest.requireActual('@votetorrent/vote-engine/rn'),
				voterEntryDigest: () => 'not-a-digest',
			}))
			const isolated = require('../vote-casting') as typeof import('../vote-casting')
			const isoModule = require('@react-native-async-storage/async-storage') as { default?: typeof AsyncStorage } & typeof AsyncStorage
			const isolatedStorage = isoModule.default ?? isoModule
			const isolatedSetItem = isolatedStorage.setItem as jest.Mock
			isolatedSetItem.mockClear()
			const p = signingProducer(KEY_A, sign as never)
			const r = await isolated.castVote(depsOf({ producer: p as unknown as AttestationProducer, guard: async () => 'ok' }))
			expect(r).toEqual({ ok: false, stage: 'build', reason: 'build-failed' })
			expect(p.signDeviceKeyDigest).not.toHaveBeenCalled()
			expect(isolatedSetItem).not.toHaveBeenCalled()
		})
		jest.dontMock('@votetorrent/vote-engine/rn')
	})
})

describe('castVote programmer errors and secrecy', () => {
	it.each([
		['signPrompt.title', { signPrompt: { ...SIGN_PROMPT, title: '' } }],
		['recordPrompt.negativeButton', { recordPrompt: { ...RECORD_PROMPT, negativeButton: '' } }],
	])('C16 empty %s rejects before eligibility runs', async (_label, over) => {
		const deps = depsOf(over as Partial<CastVoteDeps>)
		await expect(castVote(deps)).rejects.toThrow(/prompt copy must be non-empty/)
		await expect(castVote(deps)).rejects.toBeInstanceOf(TypeError)
		expect(deps.readContext).not.toHaveBeenCalled()
	})

	it('C17 the result carries no nonce, answer, signature, registrant id or key', async () => {
		const r = await castVote(depsOf())
		const record = await openStored('e-1', 3)
		const text = JSON.stringify(r)
		for (const v of record.votes) expect(text).not.toContain(v.nonce)
		expect(text).not.toContain(record.voter.signature)
		expect(text).not.toContain('r-1')
		expect(text).not.toContain(KEY_A.compressed)
		expect(text).not.toContain(KEY_A.spki)
		expect(text).not.toContain('"x"')
		expect(Object.keys(r).sort()).toEqual(['ballotIds', 'electionId', 'electionRevision', 'ok', 'replacedStale', 'savedAt'])
	})
})
