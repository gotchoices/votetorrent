/**
 * vote-casting.cast.real-engine.test.ts - castVote end to end over the REAL seeded, confirmed dev
 * election and the REAL vote record store (Phase 63 plan 11): D-23 one vote per confirmed ballot,
 * D-24 template digests over the confirmed read, D-26 the SPKI key normalized and the signature
 * verifying under it (and not under the SPKI form), D-29 sealed and stored, D-20 a second Submit
 * refused, D-21 a newer revision replaced.
 *
 * Every castVote passes an explicit producer, so no native producer is ever constructed.
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
	ballotTemplateDigest,
	verifySigP256,
	voterEntryDigest,
} from '@votetorrent/vote-engine/rn'
import type { VoterEntryUnsigned } from '@votetorrent/vote-engine/rn'

const mockFixtureProducer: { current: unknown } = { current: undefined }

jest.mock('../attestation-producer', () => ({
	...jest.requireActual('../attestation-producer'),
	resolveAttestationProducer: () => mockFixtureProducer.current,
}))

import { seedDevNetwork } from '../dev-seed'
import type { AttestationProducer } from '../attestation-producer'
import { readVoteContext, toVoterBallot } from '../election-read'
import type { VoteContext } from '../election-read'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'
import { createInMemorySecretWrapperForTests } from '../__fixtures__/in-memory-secret-wrapper'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'
import { openVoteRecord } from '../vote-record-vault'
import { readSavedVote, readVoteMarker } from '../vote-record-store'
import { castVote, type CastVoteSaved } from '../vote-casting'

const SIGN_PROMPT: SecretWrapPrompt = { title: 'Confirm your vote', subtitle: 'Sign your vote with your device key', negativeButton: 'Cancel' }
const RECORD_PROMPT: SecretWrapPrompt = { title: 'Save your vote', subtitle: 'Protect your saved vote', negativeButton: 'Cancel' }
const VIEW_PROMPT: SecretWrapPrompt = { title: 'View your vote', subtitle: 'Open your saved vote', negativeButton: 'Cancel' }
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'

function makeKey (): { sk: Uint8Array, spki: string, compressed: string } {
	const sk = p256.utils.randomSecretKey()
	const uncompressed = p256.getPublicKey(sk, false)
	const prefix = Uint8Array.from(SPKI_PREFIX.match(/../g) ?? [], h => parseInt(h, 16))
	const der = new Uint8Array(prefix.length + uncompressed.length)
	der.set(prefix, 0)
	der.set(uncompressed, prefix.length)
	let bin = ''
	for (const b of der) bin += String.fromCharCode(b)
	return { sk, spki: (globalThis as unknown as { btoa: (s: string) => string }).btoa(bin), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

const KEY_A = makeKey()

function keyProducer (key = KEY_A) {
	return {
		provisionDeviceKey: jest.fn(async () => { throw new Error('a vote-casting lookup must never provision a device key (63-18)') }),
		getCurrentDeviceKey: jest.fn(async () => ({ publicKey: key.spki })),
		produce: jest.fn(),
		signDeviceKeyDigest: jest.fn(async (digest: Uint8Array) => ({
			signature: bytesToHex(p256.sign(digest, key.sk)),
			signerKey: key.spki,
			signerUserId: '',
		})),
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

async function setup (options: { registeredStateFixture: boolean }) {
	mockFixtureProducer.current = keyProducer()
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
		throw new Error(`vote-casting.cast.real-engine.test.ts: unexpected engine "${name}"`)
	}) as never
	const details = await (await new ElectionsEngine(ctx).openElection(seeded.electionId)).getElectionDetails()
	const openAt = details.current.timeline.votingStarts + 60_000
	const deps = { getEngine, fallbackElectionId: seeded.electionId }
	const context = await readVoteContext(deps, openAt)
	const offices = toVoterBallot(context.electionId, context.ballots).offices
	const selectionMap = Object.fromEntries(offices.filter(o => o.required).map(o => [o.id, [o.candidates[0]!.id]]))
	return { ctx, seeded, getEngine, openAt, context, offices, selectionMap }
}

function cast (s: Awaited<ReturnType<typeof setup>>, producer: unknown, readContext?: (d: never, n: number) => Promise<VoteContext>) {
	return castVote({
		getEngine: s.getEngine,
		fallbackElectionId: s.seeded.electionId,
		nowMs: s.openAt,
		selectionMap: s.selectionMap,
		producer: producer as AttestationProducer,
		signPrompt: SIGN_PROMPT,
		recordPrompt: RECORD_PROMPT,
		...(readContext !== undefined ? { readContext: readContext as never } : {}),
	})
}

async function openStored (electionId: string, revision: number) {
	const read = await readSavedVote(electionId, revision)
	return openVoteRecord(electionId, read.envelope!, { prompt: VIEW_PROMPT })
}

describe('castVote over the real seeded engines', () => {
	it('RC1 saves the confirmed dev ballots with D-24 digests and a signature that verifies under the compressed key', async () => {
		const s = await setup({ registeredStateFixture: true })
		const producer = keyProducer()
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => {}))
		let r
		try {
			r = await cast(s, producer)
			for (const spy of spies) expect(spy).not.toHaveBeenCalled()
		} finally {
			for (const spy of spies) spy.mockRestore()
		}
		expect(r).toMatchObject({ ok: true, replacedStale: false, electionId: s.seeded.electionId, electionRevision: s.context.revision })
		expect((r as CastVoteSaved).ballotIds).toEqual(s.context.ballots.map(b => b.id))
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)

		const record = await openStored(s.seeded.electionId, s.context.revision)
		expect(record.votes.length).toBe(s.context.ballots.length)
		record.votes.forEach((v, i) => {
			const b = s.context.ballots[i]!
			expect(v.ballotId).toBe(b.id)
			expect(v.templateDigest).toBe(ballotTemplateDigest(b, s.context.revision))
			expect(v.electionRevision).toBe(s.context.revision)
			expect(v.nonce).toMatch(/^[0-9a-f]{64}$/)
			const codes = v.answers.map(a => a.questionCode)
			expect(codes).not.toContain('us-house')
			expect(codes).not.toContain('state-senate')
		})
		const answered = record.votes.flatMap(v => v.answers.map(a => a.questionCode)).sort()
		expect(answered).toEqual(s.offices.filter(o => o.required).map(o => o.questionCode).sort())

		const rows = await new AssociationEngine(s.ctx).getAssociationsByDeviceKey(KEY_A.spki)
		expect(record.voter.registrantId).toBe(rows[0]!.registrantId)
		expect(record.voter.deviceKey).toBe(KEY_A.compressed)
		const { signature, ...rest } = record.voter
		const digest = voterEntryDigest(rest as VoterEntryUnsigned)
		expect(verifySigP256(digest, signature, KEY_A.compressed)).toBe(true)
		expect(verifySigP256(digest, signature, KEY_A.spki)).toBe(false)
	})

	it('RC2 D-20: a second Submit is already-saved and signs nothing more', async () => {
		const s = await setup({ registeredStateFixture: true })
		const producer = keyProducer()
		expect((await cast(s, producer)).ok).toBe(true)
		const again = await cast(s, producer)
		expect(again).toMatchObject({ ok: false, stage: 'ineligible', eligibility: { reason: 'already-saved' } })
		expect(producer.signDeviceKeyDigest).toHaveBeenCalledTimes(1)
	})

	it('RC3 D-21: a newer revision replaces the saved vote', async () => {
		const s = await setup({ registeredStateFixture: true })
		const producer = keyProducer()
		expect((await cast(s, producer)).ok).toBe(true)
		const next = s.context.revision + 1
		const real = readVoteContext as unknown as (d: unknown, n: number) => Promise<VoteContext>
		const r = await cast(s, producer, async (d, n) => ({ ...(await real(d, n)), revision: next }))
		expect(r).toMatchObject({ ok: true, replacedStale: true, electionRevision: next })
		const marker = await readVoteMarker(s.seeded.electionId)
		expect(marker.kind === 'ok' && marker.marker.electionRevision).toBe(next)
		const record = await openStored(s.seeded.electionId, next)
		expect(record.electionRevision).toBe(next)
		expect(record.voter.electionRevision).toBe(next)
		for (const v of record.votes) expect(v.electionRevision).toBe(next)
	})

	it('RC4 not registered: refuses with no signature and no marker', async () => {
		const s = await setup({ registeredStateFixture: false })
		const producer = keyProducer()
		const r = await cast(s, producer)
		expect(r).toMatchObject({ ok: false, stage: 'ineligible', eligibility: { reason: 'not-registered' } })
		expect(producer.signDeviceKeyDigest).not.toHaveBeenCalled()
		expect((await readVoteMarker(s.seeded.electionId)).kind).toBe('absent')
	})
})
