/**
 * vote-casting.test.ts - D-01 / D-03 / D-04 / D-05 / D-06 / D-07 / D-20 / D-21 proof (Phase 63
 * plan 10): every eligibility gate over fakes, the gate order, the closed reason union and the
 * never-signs invariant. The real seeded engines and the real store are in the sibling
 * real-engine suite.
 */

import type { Ballot, Question } from '@votetorrent/vote-core'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { checkVotingKey } from '@votetorrent/vote-engine/rn'
import { NoElectionError, type VoteContext } from '../election-read'
import type { AttestationProducer } from '../attestation-producer'
import type { VoteGuardResult } from '../vote-record-store'

const mockProducers: Array<{ provisionDeviceKey: jest.Mock; getCurrentDeviceKey: jest.Mock; produce: jest.Mock; signDeviceKeyDigest: jest.Mock }> = []
const mockCreateRealAttestationProducer = jest.fn((_opts: { enablePlayIntegrity: boolean }) => ({
	provisionDeviceKey: jest.fn(),
	getCurrentDeviceKey: jest.fn(),
	produce: jest.fn(),
	signDeviceKeyDigest: jest.fn(),
}))

jest.mock('@votetorrent/attestation-native', () => ({
	createRealAttestationProducer: (opts: { enablePlayIntegrity: boolean }) => mockCreateRealAttestationProducer(opts),
}))

import {
	VOTE_INELIGIBLE_REASONS,
	evaluateVoteEligibility,
	resolveVoteSelections,
	type VoteEligibilityDeps,
	type VoteIneligible,
	type VoteEligible,
	type VoteIneligibleReason,
} from '../vote-casting'

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'
const STUB_KEY = 'STUB_DEVICE_PUBLIC_KEY_PLACEHOLDER_NOT_REAL'

function hexToU8 (hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16))
}

function makeKey (): { spki: string; compressed: string } {
	const sk = p256.utils.randomSecretKey()
	const uncompressed = p256.getPublicKey(sk, false)
	const der = new Uint8Array(26 + uncompressed.length)
	der.set(hexToU8(SPKI_PREFIX), 0)
	der.set(uncompressed, 26)
	let bin = ''
	for (const b of der) bin += String.fromCharCode(b)
	return { spki: (globalThis as unknown as { btoa: (s: string) => string }).btoa(bin), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

const KEY_A = makeKey()
const KEY_B = makeKey()

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

function defaultQuestions (): Question[] {
	return [
		question('q-req'),
		question('q-opt', { required: false }),
		question('q-multi', {
			required: false,
			optionRange: { min: 2, max: 3 },
			options: ['a', 'b', 'c', 'd'].map(c => ({ code: c, title: c })),
		} as Partial<Question>),
	]
}

function ctxOf (overrides: Partial<VoteContext> = {}): VoteContext {
	return {
		electionId: 'e-1',
		revision: 3,
		authorityId: 'a-1',
		open: true,
		lifecycleState: 'Open',
		ballots: [ballot('b-1', defaultQuestions())],
		unconfirmedBallotIds: [],
		unsupportedQuestionCount: 0,
		...overrides,
	}
}

function fakeProducer (publicKey: string | (() => Promise<{ publicKey: string }>)) {
	const p = {
		provisionDeviceKey: jest.fn(async () => { throw new Error('a vote-casting lookup must never provision a device key (63-18)') }),
		getCurrentDeviceKey: jest.fn(typeof publicKey === 'function' ? publicKey : async () => ({ publicKey })),
		produce: jest.fn(),
		signDeviceKeyDigest: jest.fn(),
	}
	mockProducers.push(p)
	return p
}

interface Row { registrantId: string; deviceKey: string; attestationCid?: string }
interface Reg { id: string; authorityId: string; status: string; privateCid: string; publicCid?: string }

function fakeEngines (options: { rows?: Row[]; registrants?: Record<string, Reg | undefined>; failAssociation?: boolean; failRegistration?: boolean } = {}) {
	const association = {
		getAssociationsByDeviceKey: jest.fn(async (_key: string) => {
			if (options.failAssociation) throw new Error('boom association')
			return options.rows ?? []
		}),
	}
	const registration = {
		getRegistrant: jest.fn(async (id: string) => {
			if (options.failRegistration) throw new Error('boom registration')
			return options.registrants?.[id]
		}),
	}
	const requested: string[] = []
	const getEngine = (async (name: string) => {
		requested.push(name)
		if (name === 'association') return association
		if (name === 'registration') return registration
		throw new Error(`unexpected engine ${name}`)
	}) as VoteEligibilityDeps['getEngine']
	return { getEngine, association, registration, requested }
}

const GOOD_SELECTION: Record<string, string[]> = { 'b-1:q-req': ['b-1:q-req:x'] }

function activeReg (id: string, overrides: Partial<Reg> = {}): Reg {
	return { id, authorityId: 'a-1', status: 'a', privateCid: `priv-${id}`, ...overrides }
}

const seenReasons = new Set<string>()

function record<T extends { eligible: boolean }> (result: T): T {
	if (!result.eligible) seenReasons.add((result as unknown as VoteIneligible).reason)
	return result
}

/** A fully happy setup; each test breaks one thing. */
function happy (over: Partial<VoteEligibilityDeps> & { ctx?: Partial<VoteContext>; engines?: Parameters<typeof fakeEngines>[0]; guardResult?: VoteGuardResult } = {}) {
	const producer = fakeProducer(KEY_A.spki)
	const engines = fakeEngines(over.engines ?? {
		rows: [{ registrantId: 'r-1', deviceKey: KEY_A.compressed }],
		registrants: { 'r-1': activeReg('r-1') },
	})
	const guard = jest.fn(async (_e: string, _r: number): Promise<VoteGuardResult> => over.guardResult ?? 'ok')
	const readContext = jest.fn(async () => ctxOf(over.ctx))
	const deps: VoteEligibilityDeps = {
		getEngine: engines.getEngine,
		fallbackElectionId: 'fb-1',
		nowMs: 1234,
		selectionMap: GOOD_SELECTION,
		producer: producer as unknown as AttestationProducer,
		readContext,
		guard,
		...(({ ctx, engines: e, guardResult, ...rest }) => rest)(over),
	}
	return { deps, producer, engines, guard, readContext }
}

let consoleSpies: jest.SpyInstance[] = []
beforeEach(() => {
	mockProducers.length = 0
	mockCreateRealAttestationProducer.mockReset()
	consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
	for (const p of mockProducers) {
		expect(p.signDeviceKeyDigest).not.toHaveBeenCalled()
		expect(p.produce).not.toHaveBeenCalled()
	}
	for (const s of consoleSpies) {
		expect(s).not.toHaveBeenCalled()
		s.mockRestore()
	}
})
afterAll(() => {
	for (const r of seenReasons) expect(VOTE_INELIGIBLE_REASONS as readonly string[]).toContain(r)
	expect(seenReasons.size).toBe(15)
})

function expectRefusal (result: unknown, reason: VoteIneligibleReason): VoteIneligible {
	const r = record(result as VoteIneligible)
	expect(r.eligible).toBe(false)
	expect(r.reason).toBe(reason)
	return r
}

function expectEligible (result: unknown): VoteEligible {
	const r = record(result as VoteEligible)
	expect(r.eligible).toBe(true)
	return r
}

describe('G0 dist carries the 63-03 exports', () => {
	it('checkVotingKey is a function', () => {
		expect(typeof checkVotingKey).toBe('function')
	})
})

describe('E1 D-01 window', () => {
	it.each([
		['Upcoming', 'Upcoming'],
		['indeterminate', null],
	] as const)('closed (%s) refuses window-closed without any native or engine call', async (_l, state) => {
		const h = happy({ ctx: { open: false, lifecycleState: state } })
		const r = expectRefusal(await evaluateVoteEligibility(h.deps), 'window-closed')
		expect(r.lifecycleState).toBe(state)
		expect(h.readContext).toHaveBeenCalledTimes(1)
		expect(h.readContext).toHaveBeenCalledWith({ getEngine: h.deps.getEngine, fallbackElectionId: 'fb-1' }, 1234)
		expect(h.producer.getCurrentDeviceKey).not.toHaveBeenCalled()
		expect(h.engines.requested).toEqual([])
		expect(h.guard).not.toHaveBeenCalled()
	})
})

describe('E2 unreadable election', () => {
	it.each([
		['NoElectionError', new NoElectionError()],
		['unreadable revision', new Error('Election e-1 has an unreadable revision')],
	])('%s -> election-unavailable', async (_l, err) => {
		const h = happy({ readContext: jest.fn(async () => { throw err }) })
		const r = expectRefusal(await evaluateVoteEligibility(h.deps), 'election-unavailable')
		expect(r.lifecycleState).toBeNull()
		expect(r.questions).toEqual([])
		expect(r.ballotIds).toEqual([])
	})

	it('the default reader refuses when no election is listed and no fallback exists', async () => {
		const h = happy()
		const getEngine = (async (name: string) => {
			if (name !== 'elections') throw new Error('unexpected')
			return { getElections: async () => [], openElection: async () => { throw new Error('no') } }
		}) as VoteEligibilityDeps['getEngine']
		const { readContext: _drop, ...rest } = h.deps
		expectRefusal(await evaluateVoteEligibility({ ...rest, getEngine, fallbackElectionId: undefined }), 'election-unavailable')
	})
})

describe('E3 D-03 confirmed ballots', () => {
	it('an unconfirmed ballot refuses and lists its id', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ ctx: { unconfirmedBallotIds: ['b-p'] } }).deps), 'ballot-unconfirmed')
		expect(r.ballotIds).toEqual(['b-p'])
	})
	it('no ballots at all refuses no-ballots', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ ctx: { ballots: [] } }).deps), 'no-ballots')
	})
	it('gate 2 precedes the empty check', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ ctx: { ballots: [], unconfirmedBallotIds: ['b-p'] } }).deps), 'ballot-unconfirmed')
		expect(r.ballotIds).toEqual(['b-p'])
	})
})

describe('E4 D-05 / R-2 unsupported and dependent questions', () => {
	const dependent = (): Ballot[] => [ballot('b-1', [...defaultQuestions(), question('q-dep', { dependsOn: { code: 'q-req' } } as Partial<Question>)])]
	it('unsupportedQuestionCount refuses', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ ctx: { unsupportedQuestionCount: 1 } }).deps), 'unsupported-question')
	})
	it('a dependsOn question refuses and is named', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ ctx: { ballots: dependent() } }).deps), 'dependent-question')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-dep', ballotId: 'b-1', questionCode: 'q-dep' }])
	})
	it('unsupported wins over dependent', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ ctx: { ballots: dependent(), unsupportedQuestionCount: 2 } }).deps), 'unsupported-question')
	})
})

describe('E5 selection-invalid', () => {
	it('WR-01: a non-empty selection for an office not on the ballot is ignored and never signed', async () => {
		const h = happy({ selectionMap: { ...GOOD_SELECTION, 'b-9:q-x': ['b-9:q-x:x'], 'b-1:q-gone': ['b-1:q-gone:x'] } })
		const r = expectEligible(await evaluateVoteEligibility(h.deps))
		expect(r.selections).toEqual({ 'b-1': { 'q-req': ['x'] } })
	})
	it('WR-01: an orphan non-array entry is ignored too', async () => {
		expectEligible(await evaluateVoteEligibility(happy({ selectionMap: { ...GOOD_SELECTION, 'b-9:q-x': 'nope' as unknown as string[] } }).deps))
	})
	it('WR-01: an orphan alongside a bad live selection still refuses, naming only the live question', async () => {
		const h = happy({ selectionMap: { 'b-1:q-req': ['b-1:q-req:zzz'], 'b-9:q-x': ['b-9:q-x:x'] } })
		const r = expectRefusal(await evaluateVoteEligibility(h.deps), 'selection-invalid')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-req', ballotId: 'b-1', questionCode: 'q-req' }])
		expect(h.producer.getCurrentDeviceKey).not.toHaveBeenCalled()
	})
	it('an empty selection for an unknown office is ignored', async () => {
		expectEligible(await evaluateVoteEligibility(happy({ selectionMap: { ...GOOD_SELECTION, 'b-9:q-x': [] } }).deps))
	})
	it('a candidate the office does not offer refuses and names the office', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ selectionMap: { 'b-1:q-req': ['b-1:q-req:zzz'] } }).deps), 'selection-invalid')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-req', ballotId: 'b-1', questionCode: 'q-req' }])
	})
	it('two distinct candidates on a voteFor 1 office refuse', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ selectionMap: { 'b-1:q-req': ['b-1:q-req:x', 'b-1:q-req:y'] } }).deps), 'selection-invalid')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-req', ballotId: 'b-1', questionCode: 'q-req' }])
	})
	it('a duplicated candidate is one option', async () => {
		const r = expectEligible(await evaluateVoteEligibility(happy({ selectionMap: { 'b-1:q-req': ['b-1:q-req:x', 'b-1:q-req:x'] } }).deps))
		expect(r.selections).toEqual({ 'b-1': { 'q-req': ['x'] } })
	})
})

describe('E6 D-04 required', () => {
	it('an empty selection map refuses required-unanswered, listing only required questions', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ selectionMap: {} }).deps), 'required-unanswered')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-req', ballotId: 'b-1', questionCode: 'q-req' }])
	})
	it('answering the required question is eligible; blanks are sorted', async () => {
		const r = expectEligible(await evaluateVoteEligibility(happy().deps))
		expect(r.blankQuestions).toEqual([
			{ officeId: 'b-1:q-multi', ballotId: 'b-1', questionCode: 'q-multi' },
			{ officeId: 'b-1:q-opt', ballotId: 'b-1', questionCode: 'q-opt' },
		])
	})
})

describe('E7 R-2 optionRange.min', () => {
	it('one option on q-multi refuses below-minimum', async () => {
		const r = expectRefusal(await evaluateVoteEligibility(happy({ selectionMap: { ...GOOD_SELECTION, 'b-1:q-multi': ['b-1:q-multi:a'] } }).deps), 'below-minimum')
		expect(r.questions).toEqual([{ officeId: 'b-1:q-multi', ballotId: 'b-1', questionCode: 'q-multi' }])
	})
	it('two options are eligible and sorted', async () => {
		const r = expectEligible(await evaluateVoteEligibility(happy({ selectionMap: { ...GOOD_SELECTION, 'b-1:q-multi': ['b-1:q-multi:c', 'b-1:q-multi:a'] } }).deps))
		expect(r.selections['b-1']['q-multi']).toEqual(['a', 'c'])
	})
	it('a blank q-multi is governed by required alone', async () => {
		expectEligible(await evaluateVoteEligibility(happy().deps))
	})
})

describe('E8 R-3 all blank', () => {
	it('nothing required: an all-blank selection is eligible', async () => {
		const ballots = [ballot('b-1', defaultQuestions().map(q => ({ ...q, required: false })))]
		const r = expectEligible(await evaluateVoteEligibility(happy({ ctx: { ballots }, selectionMap: {} }).deps))
		expect(r.selections).toEqual({ 'b-1': {} })
		expect(r.blankQuestions).toHaveLength(3)
	})
	it('two ballots both appear, empty', async () => {
		const mk = (id: string) => ballot(id, [question('q', { required: false })])
		const r = expectEligible(await evaluateVoteEligibility(happy({ ctx: { ballots: [mk('b-1'), mk('b-2')] }, selectionMap: {} }).deps))
		expect(r.selections).toEqual({ 'b-1': {}, 'b-2': {} })
	})
})

describe('E9 D-06 registered device', () => {
	const rowA: Row = { registrantId: 'r-1', deviceKey: KEY_A.compressed }

	it('getCurrentDeviceKey rejecting -> device-check-failed', async () => {
		const h = happy()
		h.producer.getCurrentDeviceKey.mockRejectedValue(new Error('native'))
		expectRefusal(await evaluateVoteEligibility(h.deps), 'device-check-failed')
	})
	it('DEVICE_KEY_ABSENT -> not-registered, and never provisions a key (63-18)', async () => {
		const h = happy()
		h.producer.getCurrentDeviceKey.mockRejectedValue(Object.assign(new Error('absent'), { code: 'DEVICE_KEY_ABSENT' }))
		expectRefusal(await evaluateVoteEligibility(h.deps), 'not-registered')
		expect(h.producer.provisionDeviceKey).not.toHaveBeenCalled()
		expect(h.engines.requested).toEqual([])
	})
	it('DEVICE_KEY_INVALIDATED -> device-key-rotated, and never provisions a key (63-18)', async () => {
		const h = happy()
		h.producer.getCurrentDeviceKey.mockRejectedValue(Object.assign(new Error('invalid'), { code: 'DEVICE_KEY_INVALIDATED' }))
		expectRefusal(await evaluateVoteEligibility(h.deps), 'device-key-rotated')
		expect(h.producer.provisionDeviceKey).not.toHaveBeenCalled()
	})
	it('a lookup that DOES provision is caught by the spy (negative control)', async () => {
		const h = happy()
		await h.producer.provisionDeviceKey().catch(() => undefined)
		expect(h.producer.provisionDeviceKey).toHaveBeenCalledTimes(1)
	})
	it('an empty public key -> device-check-failed', async () => {
		const h = happy()
		h.producer.getCurrentDeviceKey.mockResolvedValue({ publicKey: '' })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'device-check-failed')
	})
	it('the association read rejecting -> device-check-failed', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { failAssociation: true } }).deps), 'device-check-failed')
	})
	it('the registrant read rejecting -> device-check-failed', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { rows: [rowA], registrants: { 'r-1': activeReg('r-1') }, failRegistration: true } }).deps), 'device-check-failed')
	})
	it('no rows -> not-registered', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { rows: [] } }).deps), 'not-registered')
	})
	it('a dangling registrant -> not-registered', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { rows: [rowA], registrants: {} } }).deps), 'not-registered')
	})
	it.each(['r', 's'])('registrant status %s -> not-registered', async (status) => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { rows: [rowA], registrants: { 'r-1': activeReg('r-1', { status }) } } }).deps), 'not-registered')
	})
	it('another authority -> not-registered', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ engines: { rows: [rowA], registrants: { 'r-1': activeReg('r-1', { authorityId: 'a-other' }) } } }).deps), 'not-registered')
	})
	it('two active registrants -> registration-ambiguous', async () => {
		const h = happy({ engines: { rows: [rowA, { registrantId: 'r-2', deviceKey: KEY_A.compressed }], registrants: { 'r-1': activeReg('r-1'), 'r-2': activeReg('r-2') } } })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'registration-ambiguous')
	})
	it('the lookup is called once with the raw key', async () => {
		const h = happy()
		expectEligible(await evaluateVoteEligibility(h.deps))
		expect(h.engines.association.getAssociationsByDeviceKey).toHaveBeenCalledTimes(1)
		expect(h.engines.association.getAssociationsByDeviceKey).toHaveBeenCalledWith(KEY_A.spki)
	})
})

describe('E10 D-07 key check', () => {
	it('SPKI current key vs compressed row key is eligible and compresses', async () => {
		const r = expectEligible(await evaluateVoteEligibility(happy().deps))
		expect(r.voter.currentDeviceKey).toBe(KEY_A.spki)
		expect(r.voter.compressedDeviceKey).toBe(KEY_A.compressed)
	})
	it('a different valid key -> device-key-rotated', async () => {
		const h = happy({ engines: { rows: [{ registrantId: 'r-1', deviceKey: KEY_B.compressed }], registrants: { 'r-1': activeReg('r-1') } } })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'device-key-rotated')
		expect(h.guard).not.toHaveBeenCalled()
	})
	it('the stub key on both sides -> unreadable-key', async () => {
		const h = happy({ engines: { rows: [{ registrantId: 'r-1', deviceKey: STUB_KEY }], registrants: { 'r-1': activeReg('r-1') } } })
		h.producer.getCurrentDeviceKey.mockResolvedValue({ publicKey: STUB_KEY })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'unreadable-key')
		expect(h.guard).not.toHaveBeenCalled()
	})
})

describe('E11 D-20 / D-21 guard', () => {
	it('already-saved refuses', async () => {
		expectRefusal(await evaluateVoteEligibility(happy({ guardResult: 'already-saved' }).deps), 'already-saved')
	})
	it('stale is eligible with replacesStale', async () => {
		expect(expectEligible(await evaluateVoteEligibility(happy({ guardResult: 'stale' }).deps)).replacesStale).toBe(true)
	})
	it('ok is eligible without replacesStale', async () => {
		const h = happy()
		expect(expectEligible(await evaluateVoteEligibility(h.deps)).replacesStale).toBe(false)
		expect(h.guard).toHaveBeenCalledTimes(1)
		expect(h.guard).toHaveBeenCalledWith('e-1', 3)
	})
	it('a rejecting guard fails closed to already-saved', async () => {
		const h = happy({ guard: jest.fn(async () => { throw new Error('storage') }) })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'already-saved')
	})
})

describe('E12 identity', () => {
	it('absent cids read as null', async () => {
		const h = happy()
		const r = expectEligible(await evaluateVoteEligibility(h.deps))
		expect(r.voter).toEqual({ registrantId: 'r-1', privateCid: 'priv-r-1', publicCid: null, attestationCid: null, currentDeviceKey: KEY_A.spki, compressedDeviceKey: KEY_A.compressed })
		expect(r.producer).toBe(h.producer)
		expect(h.producer.getCurrentDeviceKey).toHaveBeenCalledTimes(1)
	})
	it('present cids are carried', async () => {
		const h = happy({ engines: { rows: [{ registrantId: 'r-1', deviceKey: KEY_A.compressed, attestationCid: 'att-1' }], registrants: { 'r-1': activeReg('r-1', { publicCid: 'pub-1' }) } } })
		const r = expectEligible(await evaluateVoteEligibility(h.deps))
		expect(r.voter.publicCid).toBe('pub-1')
		expect(r.voter.attestationCid).toBe('att-1')
	})
})

describe('E13 gate order', () => {
	function build (i: number) {
		const order = VOTE_INELIGIBLE_REASONS
		const failing = (reason: VoteIneligibleReason) => order.indexOf(reason) >= i
		const questions = defaultQuestions()
		if (failing('dependent-question')) questions.push(question('q-dep', { dependsOn: { code: 'q-req' } } as Partial<Question>))
		const ballots = i <= 3 ? [] : [ballot('b-1', questions)]
		let selectionMap: Record<string, string[]> = { 'b-1:q-req': ['b-1:q-req:x'] }
		if (failing('below-minimum')) selectionMap['b-1:q-multi'] = ['b-1:q-multi:a']
		if (failing('required-unanswered')) selectionMap = { ...(failing('below-minimum') ? { 'b-1:q-multi': ['b-1:q-multi:a'] } : {}) }
		// A candidate a live office does not offer (an orphan office is ignored since WR-01).
		if (failing('selection-invalid')) selectionMap['b-1:q-opt'] = ['b-1:q-opt:zzz']
		const stubMode = i === 13
		const rowKey = stubMode ? STUB_KEY : i === 12 ? KEY_B.compressed : KEY_A.compressed
		let engines: Parameters<typeof fakeEngines>[0]
		if (i === 11) engines = { rows: [{ registrantId: 'r-1', deviceKey: rowKey }, { registrantId: 'r-2', deviceKey: rowKey }], registrants: { 'r-1': activeReg('r-1'), 'r-2': activeReg('r-2') } }
		else if (i >= 12) engines = { rows: [{ registrantId: 'r-1', deviceKey: rowKey }], registrants: { 'r-1': activeReg('r-1') } }
		else engines = { rows: [] }
		const h = happy({
			ctx: { open: !failing('window-closed'), lifecycleState: failing('window-closed') ? 'Upcoming' : 'Open', ballots, unconfirmedBallotIds: failing('ballot-unconfirmed') ? ['b-p'] : [], unsupportedQuestionCount: failing('unsupported-question') ? 1 : 0 },
			selectionMap,
			engines,
			guardResult: 'already-saved',
			...(failing('election-unavailable') ? { readContext: jest.fn(async () => { throw new Error('x') }) } : {}),
		})
		h.producer.getCurrentDeviceKey.mockImplementation(async () => {
			if (failing('device-check-failed') && i === 9) throw new Error('native')
			return { publicKey: stubMode ? STUB_KEY : KEY_A.spki }
		})
		return h
	}
	it.each(VOTE_INELIGIBLE_REASONS.map((reason, i) => [reason, i] as const))('%s is the first refusal (#%d)', async (reason, i) => {
		const h = build(i)
		expectRefusal(await evaluateVoteEligibility(h.deps), reason)
		if (i <= VOTE_INELIGIBLE_REASONS.indexOf('below-minimum')) expect(h.producer.getCurrentDeviceKey).not.toHaveBeenCalled()
		if (i <= VOTE_INELIGIBLE_REASONS.indexOf('unreadable-key')) expect(h.guard).not.toHaveBeenCalled()
	})
})

describe('E14 producer resolution', () => {
	it('an override that cannot sign rejects loudly once gates 1-5 pass', async () => {
		const h = happy({ producer: { getCurrentDeviceKey: async () => ({ publicKey: KEY_A.spki }), produce: jest.fn() } as unknown as AttestationProducer })
		await expect(evaluateVoteEligibility(h.deps)).rejects.toThrow(/cannot sign/)
	})
	it('the same override with the window closed still refuses window-closed (lazy)', async () => {
		const h = happy({ ctx: { open: false }, producer: { getCurrentDeviceKey: async () => ({ publicKey: KEY_A.spki }), produce: jest.fn() } as unknown as AttestationProducer })
		expectRefusal(await evaluateVoteEligibility(h.deps), 'window-closed')
	})
	it('an omitted producer is the real one, created exactly once', async () => {
		const real = fakeProducer(KEY_A.spki)
		mockCreateRealAttestationProducer.mockReturnValue(real as never)
		const h = happy()
		const { producer: _p, ...rest } = h.deps
		const r = expectEligible(await evaluateVoteEligibility(rest))
		expect(mockCreateRealAttestationProducer).toHaveBeenCalledTimes(1)
		expect(r.producer).toBe(real)
		expect(real.getCurrentDeviceKey).toHaveBeenCalledTimes(1)
	})
})

describe('E15 closed union', () => {
	it('lists the fifteen reasons in gate order', () => {
		expect([...VOTE_INELIGIBLE_REASONS]).toEqual([
			'election-unavailable', 'window-closed', 'ballot-unconfirmed', 'no-ballots', 'unsupported-question',
			'dependent-question', 'selection-invalid', 'required-unanswered', 'below-minimum', 'device-check-failed',
			'not-registered', 'registration-ambiguous', 'device-key-rotated', 'unreadable-key', 'already-saved',
		])
	})
})

describe('E16 resolveVoteSelections purity', () => {
	const c = () => ({ electionId: 'e-1', ballots: [ballot('b-1', defaultQuestions())] })
	it('is insensitive to key insertion order', () => {
		const a = { 'b-1:q-req': ['b-1:q-req:x'], 'b-1:q-opt': ['b-1:q-opt:y'] }
		const b = { 'b-1:q-opt': ['b-1:q-opt:y'], 'b-1:q-req': ['b-1:q-req:x'] }
		expect(resolveVoteSelections(c(), a)).toEqual(resolveVoteSelections(c(), b))
	})
	it('does not throw on a deeply frozen input and returns fresh arrays', () => {
		const ids = Object.freeze(['b-1:q-req:x'])
		const input = Object.freeze({ 'b-1:q-req': ids })
		const result = resolveVoteSelections(c(), input)
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.selections['b-1']['q-req']).not.toBe(ids)
	})
	it('a non-array value is invalid, never a throw', () => {
		const r = resolveVoteSelections(c(), { 'b-1:q-req': 'nope' as unknown as string[] })
		expect(r).toMatchObject({ ok: false, reason: 'selection-invalid', questions: [{ officeId: 'b-1:q-req', ballotId: 'b-1', questionCode: 'q-req' }] })
	})
})
