/**
 * vote-casting.real-engine.test.ts - eligibility over the REAL seeded engines and the REAL vote
 * record store (Phase 63 plan 10): D-03 confirmed dev ballot, D-04 required flags, D-06 exact
 * device-key lookup, D-07 key check, R-1 rotation, D-20 / D-21 guard.
 *
 * The dev fixture binds whatever key `mockFixtureProducer.current` returns; every evaluation passes
 * an explicit producer override, so no native producer is ever constructed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import {
	AssociationEngine,
	ElectionsEngine,
	LocalStorageReact,
	NetworksEngine,
	RegistrationEngine,
	buildVoteEntry,
	makeVoteNonce,
} from '@votetorrent/vote-engine/rn'

const mockFixtureProducer: { current: unknown } = { current: undefined }

jest.mock('../attestation-producer', () => ({
	...jest.requireActual('../attestation-producer'),
	resolveAttestationProducer: () => mockFixtureProducer.current,
}))

import { seedDevNetwork } from '../dev-seed'
import { StubAttestationProducer, type AttestationProducer } from '../attestation-producer'
import { readVoteContext, toVoterBallot } from '../election-read'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'
import { createInMemorySecretWrapperForTests } from '../__fixtures__/in-memory-secret-wrapper'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'
import { isVoteRecord, sealVoteRecord, type VoteRecord } from '../vote-record-vault'
import { buildVoteMarker, writeVoteRecord } from '../vote-record-store'
import { evaluateVoteEligibility, type VoteEligible, type VoteEligibility } from '../vote-casting'

const PROMPT: SecretWrapPrompt = { title: 'Confirm your vote', subtitle: 'Sign your vote with your device key', negativeButton: 'Cancel' }
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'
const TEST_ONLY_SIGNATURE = 'ab'.repeat(64)

function makeKey (): { spki: string, compressed: string } {
	const sk = p256.utils.randomSecretKey()
	const uncompressed = p256.getPublicKey(sk, false)
	const prefix = Uint8Array.from(SPKI_PREFIX.match(/../g) ?? [], h => parseInt(h, 16))
	const der = new Uint8Array(prefix.length + uncompressed.length)
	der.set(prefix, 0)
	der.set(uncompressed, prefix.length)
	let bin = ''
	for (const b of der) bin += String.fromCharCode(b)
	return { spki: (globalThis as unknown as { btoa: (s: string) => string }).btoa(bin), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

const KEY_A = makeKey()
const KEY_B = makeKey()

function keyProducer (publicKey: string) {
	return {
		provisionDeviceKey: jest.fn(async () => { throw new Error('a vote-casting lookup must never provision a device key (63-18)') }),
		getCurrentDeviceKey: jest.fn(async () => ({ publicKey })),
		produce: jest.fn(),
		signDeviceKeyDigest: jest.fn(),
	}
}

const keyWrap = createInMemoryKeyWrapProviderForTests()

beforeEach(async () => {
	await AsyncStorage.clear()
	setDeviceKeyWrapProviderForTests(keyWrap)
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(createInMemorySecretWrapperForTests()))
})
afterAll(() => {
	setDeviceKeyWrapProviderForTests(undefined)
	setVoteRecordWrapProviderForTests(undefined)
})

async function setup (options: { registeredStateFixture: boolean, fixtureProducer: unknown }) {
	mockFixtureProducer.current = options.fixtureProducer
	const networksEngine = new NetworksEngine(new LocalStorageReact())
	const seeded = await seedDevNetwork(networksEngine, { registeredStateFixture: options.registeredStateFixture })
	const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)!
	const engines: Record<string, unknown> = {
		elections: new ElectionsEngine(ctx),
		association: new AssociationEngine(ctx),
		registration: new RegistrationEngine(ctx),
	}
	const getEngine = (async (name: string) => {
		if (name in engines) return engines[name]
		throw new Error(`vote-casting.real-engine.test.ts: unexpected engine "${name}"`)
	}) as never
	const details = await (await new ElectionsEngine(ctx).openElection(seeded.electionId)).getElectionDetails()
	const openAt = details.current.timeline.votingStarts + 60_000
	const deps = { getEngine, fallbackElectionId: seeded.electionId }
	const context = await readVoteContext(deps, openAt)
	const offices = toVoterBallot(context.electionId, context.ballots).offices
	const selectionMap = Object.fromEntries(offices.filter(o => o.required).map(o => [o.id, [o.candidates[0]!.id]]))
	return { ctx, seeded, getEngine, openAt, context, offices, selectionMap }
}

function evaluate (s: Awaited<ReturnType<typeof setup>>, producer: unknown, over: { nowMs?: number, selectionMap?: Record<string, string[]> } = {}): Promise<VoteEligibility> {
	return evaluateVoteEligibility({
		getEngine: s.getEngine,
		fallbackElectionId: s.seeded.electionId,
		nowMs: over.nowMs ?? s.openAt,
		selectionMap: over.selectionMap ?? s.selectionMap,
		producer: producer as AttestationProducer,
	})
}

describe('vote eligibility over the real seeded engines', () => {
	it('RE1 happy path: an SPKI key normalises to compressed hex and the identity comes from the real rows', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: keyProducer(KEY_A.spki) })
		const producer = keyProducer(KEY_A.spki)
		const r = await evaluate(s, producer)
		expect(r.eligible).toBe(true)
		const ok = r as VoteEligible
		expect(ok.voter.currentDeviceKey).toBe(KEY_A.spki)
		expect(ok.voter.compressedDeviceKey).toBe(KEY_A.compressed)
		const rows = await new AssociationEngine(s.ctx).getAssociationsByDeviceKey(KEY_A.spki)
		expect(ok.voter.registrantId).toBe(rows[0]!.registrantId)
		for (const cid of [ok.voter.publicCid, ok.voter.attestationCid]) expect(cid === null || typeof cid === 'string').toBe(true)
		expect(ok.replacesStale).toBe(false)
		expect(ok.blankQuestions.map(q => q.questionCode).sort()).toEqual(['state-senate', 'us-house'])
		expect(Object.keys(ok.selections)).toEqual(ok.context.ballots.map(b => b.id))
		expect(ok.producer).toBe(producer)
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
		expect(producer.produce).not.toHaveBeenCalled()
	})

	it('RE2 D-01: the real clock is before voting, so the window is closed and nothing native runs', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: keyProducer(KEY_A.spki) })
		const producer = keyProducer(KEY_A.spki)
		const r = await evaluate(s, producer, { nowMs: Date.now() })
		expect(r).toMatchObject({ eligible: false, reason: 'window-closed' })
		expect(producer.getCurrentDeviceKey).not.toHaveBeenCalled()
	})

	it('RE3 D-04: an empty selection refuses with the required questions', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: keyProducer(KEY_A.spki) })
		const r = await evaluate(s, keyProducer(KEY_A.spki), { selectionMap: {} })
		expect(r).toMatchObject({ eligible: false, reason: 'required-unanswered' })
		const required = s.offices.filter(o => o.required).map(o => o.questionCode).sort()
		expect((r as { questions: Array<{ questionCode: string }> }).questions.map(q => q.questionCode).sort()).toEqual(required)
		expect(required).toEqual(['governor', 'state-board-education', 'us-senate'])
	})

	it('RE4 R-1: a rotated key misses the exact lookup and reads not-registered', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: keyProducer(KEY_A.spki) })
		const r = await evaluate(s, keyProducer(KEY_B.spki))
		expect(r).toMatchObject({ eligible: false, reason: 'not-registered' })
	})

	it('RE5 D-07: a stub-bound fixture is hit by the lookup and refused as unreadable-key, never signed', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: StubAttestationProducer })
		const spy = jest.spyOn(StubAttestationProducer, 'signDeviceKeyDigest')
		const produceSpy = jest.spyOn(StubAttestationProducer, 'produce')
		try {
			const r = await evaluate(s, StubAttestationProducer)
			expect(r).toMatchObject({ eligible: false, reason: 'unreadable-key' })
			expect(spy).not.toHaveBeenCalled()
			expect(produceSpy).not.toHaveBeenCalled()
		} finally {
			spy.mockRestore()
			produceSpy.mockRestore()
		}
	})

	it('RE6 D-06: no registered-state fixture reads not-registered', async () => {
		const s = await setup({ registeredStateFixture: false, fixtureProducer: keyProducer(KEY_A.spki) })
		const r = await evaluate(s, keyProducer(KEY_A.spki))
		expect(r).toMatchObject({ eligible: false, reason: 'not-registered' })
	})

	it('RE7 D-21 then D-20 over the real store: a newer-revision record is stale, a current one is already-saved', async () => {
		const s = await setup({ registeredStateFixture: true, fixtureProducer: keyProducer(KEY_A.spki) })
		const first = (await evaluate(s, keyProducer(KEY_A.spki))) as VoteEligible
		expect(first.eligible).toBe(true)

		const buildRecord = (electionRevision: number): VoteRecord => {
			const votes = first.context.ballots.map(ballot => buildVoteEntry({
				ballot: ballot as never,
				electionRevision,
				selections: first.selections[ballot.id]!,
				nonce: makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32))),
			}))
			const record: VoteRecord = {
				v: 1,
				electionId: first.context.electionId,
				electionRevision,
				savedAt: '2026-10-06T12:00:00.000Z',
				votes: votes as never,
				voter: {
					v: 1,
					electionId: first.context.electionId,
					electionRevision,
					registrantId: first.voter.registrantId,
					privateCid: first.voter.privateCid,
					publicCid: first.voter.publicCid,
					deviceKey: first.voter.compressedDeviceKey,
					attestationCid: first.voter.attestationCid,
					ballots: votes.map(v => ({ ballotId: v.ballotId, templateDigest: v.templateDigest })),
					signature: TEST_ONLY_SIGNATURE,
				},
			}
			if (!isVoteRecord(record)) throw new Error('test record is not a VoteRecord')
			return record
		}
		const save = async (record: VoteRecord): Promise<void> => {
			await writeVoteRecord(await sealVoteRecord(record, { prompt: PROMPT }), buildVoteMarker(record))
		}

		await save(buildRecord(first.context.revision + 1))
		const producer = keyProducer(KEY_A.spki)
		const stale = await evaluate(s, producer)
		expect(stale).toMatchObject({ eligible: true, replacesStale: true })

		await save(buildRecord(first.context.revision))
		const saved = await evaluate(s, producer)
		expect(saved).toMatchObject({ eligible: false, reason: 'already-saved' })
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
		expect(producer.produce).not.toHaveBeenCalled()
	})
})
