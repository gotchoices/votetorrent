/**
 * saved-vote-status.test.ts - the marker-driven saved-vote read for Home and Timeline (Phase 63
 * plan 14; D-12, D-19, D-21). Real store over the AsyncStorage jest mock, real vault with the
 * in-memory wrapper. The engine election read is injected.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import * as fs from 'fs'
import * as path from 'path'
import { createInMemorySecretWrapperForTests, type InMemorySecretWrapper } from '../__fixtures__/in-memory-secret-wrapper'
import type { ElectionReadDeps } from '../election-read'
import { loadVoteReceipt, type ReceiptElection } from '../vote-receipt'
import { readSavedVoteStatus, type SavedVoteStatus } from '../saved-vote-status'
import { buildVoteMarker, deriveSavedVoteState, readVoteMarker, voteMarkerKey, voteRecordKey, writeVoteRecord } from '../vote-record-store'
import * as vault from '../vote-record-vault'
import { readVoteSent, recordVoteSent } from '../vote-sent-store'
import { createVoteRecordWrapProvider, setVoteRecordWrapProviderForTests } from '../vote-record-wrap'

const PROMPT: SecretWrapPrompt = { title: 'Save your vote', subtitle: 'Use your fingerprint to protect your saved vote', negativeButton: 'Cancel' }
const E = 'e1'

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(a)
	return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

function makeRecord(args: { electionId?: string; electionRevision?: number } = {}): vault.VoteRecord {
	const electionId = args.electionId ?? E
	const electionRevision = args.electionRevision ?? 2
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

async function save(record: vault.VoteRecord): Promise<void> {
	const env = await vault.sealVoteRecord(record, { prompt: PROMPT })
	await writeVoteRecord(env, buildVoteMarker(record))
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined))

let wrapper: InMemorySecretWrapper
const deps: ElectionReadDeps = { getEngine: jest.fn(), fallbackElectionId: undefined }

function reading(revision: number | null): jest.Mock<Promise<ReceiptElection | null>, [ElectionReadDeps, number, string]> {
	return jest.fn(async (_d: ElectionReadDeps, _n: number, _id: string): Promise<ReceiptElection | null> =>
		revision === null ? null : { revision, ballots: [] },
	)
}

function counters() {
	return { p: wrapper.promptCount, w: wrapper.wrapCalls, u: wrapper.unwrapCalls }
}

function clearStorageSpies() {
	for (const m of ['setItem', 'removeItem', 'multiSet', 'mergeItem'] as const) (AsyncStorage[m] as jest.Mock).mockClear()
}

function expectNoWrites() {
	for (const m of ['setItem', 'removeItem', 'multiSet', 'mergeItem'] as const) expect(AsyncStorage[m]).not.toHaveBeenCalled()
}

beforeEach(async () => {
	await AsyncStorage.clear()
	wrapper = createInMemorySecretWrapperForTests()
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(wrapper))
	for (const s of consoleSpies) s.mockClear()
})

afterEach(() => {
	for (const s of consoleSpies) expect(s).not.toHaveBeenCalled()
})

afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined)
	for (const s of consoleSpies) s.mockRestore()
})

describe('readSavedVoteStatus', () => {
	it('SV1: no marker reads none and never touches the engine', async () => {
		const read = reading(2)
		await expect(readSavedVoteStatus(deps, 1000, E, read)).resolves.toEqual({ state: 'none' })
		expect(read).not.toHaveBeenCalled()
	})

	it('SV2: a vote saved at the current revision is saved', async () => {
		await save(makeRecord({ electionRevision: 2 }))
		await expect(readSavedVoteStatus(deps, 1000, E, reading(2))).resolves.toEqual({ state: 'saved', revisionKnown: true })
	})

	it.each([3, 1])('SV3: revision %i differs from the saved revision 2, so stale (D-21)', async (rev) => {
		await save(makeRecord({ electionRevision: 2 }))
		await expect(readSavedVoteStatus(deps, 1000, E, reading(rev))).resolves.toEqual({ state: 'stale', revisionKnown: true })
	})

	it('SV4: an unreadable revision reads saved with revisionKnown false, resolving null or rejecting', async () => {
		await save(makeRecord({ electionRevision: 2 }))
		await expect(readSavedVoteStatus(deps, 1000, E, reading(null))).resolves.toEqual({ state: 'saved', revisionKnown: false })
		const rejecting = jest.fn(async (_d: ElectionReadDeps, _n: number, _id: string): Promise<ReceiptElection | null> => {
			throw new Error('boom')
		})
		await expect(readSavedVoteStatus(deps, 1000, E, rejecting)).resolves.toEqual({ state: 'saved', revisionKnown: false })
	})

	it.each([2, null])('SV5: a missing record reads unreadable (revision %s)', async (rev) => {
		await save(makeRecord({ electionRevision: 2 }))
		await AsyncStorage.removeItem(voteRecordKey(E))
		clearStorageSpies()
		await expect(readSavedVoteStatus(deps, 1000, E, reading(rev))).resolves.toEqual({ state: 'unreadable' })
		expectNoWrites()
	})

	it('SV6: a corrupt record reads unreadable', async () => {
		await save(makeRecord({ electionRevision: 2 }))
		await AsyncStorage.setItem(voteRecordKey(E), '{garbage')
		await expect(readSavedVoteStatus(deps, 1000, E, reading(2))).resolves.toEqual({ state: 'unreadable' })
	})

	it.each([
		['corrupt', () => '{garbage'],
		[
			'extra key',
			() => JSON.stringify({ ...buildVoteMarker(makeRecord()), nonce: 'x' }),
		],
		['foreign election', () => JSON.stringify(buildVoteMarker(makeRecord({ electionId: 'other' })))],
	])('SV7: a %s marker reads unreadable without an engine read', async (_n, raw) => {
		await AsyncStorage.setItem(voteMarkerKey(E), raw())
		const read = reading(2)
		await expect(readSavedVoteStatus(deps, 1000, E, read)).resolves.toEqual({ state: 'unreadable' })
		expect(read).not.toHaveBeenCalled()
	})

	it('SV8: a storage failure on the marker read reads unreadable', async () => {
		;(AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'))
		await expect(readSavedVoteStatus(deps, 1000, E, reading(2))).resolves.toEqual({ state: 'unreadable' })
	})

	it('SV9: passes (deps, nowMs, electionId) through and rejects a bad id before any read', async () => {
		const read = reading(2)
		await save(makeRecord())
		await readSavedVoteStatus(deps, 4242, E, read)
		expect(read).toHaveBeenCalledTimes(1)
		const [d, n, id] = read.mock.calls[0]
		expect(d).toBe(deps)
		expect(n).toBe(4242)
		expect(id).toBe(E)

		const read2 = reading(2)
		;(AsyncStorage.getItem as jest.Mock).mockClear()
		await expect(readSavedVoteStatus(deps, 0, '', read2)).rejects.toBeInstanceOf(TypeError)
		expect(AsyncStorage.getItem).not.toHaveBeenCalled()
		expect(read2).not.toHaveBeenCalled()
	})

	it('SV10: zero prompts, zero keystore calls and zero writes across every scenario (D-19)', async () => {
		await save(makeRecord({ electionRevision: 2 }))
		const snap = counters()
		clearStorageSpies()
		await readSavedVoteStatus(deps, 1, E, reading(2))
		await readSavedVoteStatus(deps, 1, E, reading(3))
		await readSavedVoteStatus(deps, 1, E, reading(null))
		await AsyncStorage.getItem(voteMarkerKey(E))
		await readSavedVoteStatus(deps, 1, 'nothing-here', reading(2))
		;(AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'))
		await readSavedVoteStatus(deps, 1, E, reading(2))
		expect(counters()).toEqual(snap)
		expectNoWrites()
	})

	it('SV11: never cached, every call reads fresh', async () => {
		await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'none' })
		await save(makeRecord({ electionRevision: 2 }))
		await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'saved', revisionKnown: true })
		await AsyncStorage.setItem(voteMarkerKey(E), '{garbage')
		await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'unreadable' })
	})

	describe('SV12: parity with loadVoteReceipt', () => {
		const scenarios: Array<[string, number | null, () => Promise<void>]> = [
			['none', 2, async () => undefined],
			['saved', 2, () => save(makeRecord({ electionRevision: 2 }))],
			['stale', 5, () => save(makeRecord({ electionRevision: 2 }))],
			['revision unknown', null, () => save(makeRecord({ electionRevision: 2 }))],
			[
				'record missing',
				2,
				async () => {
					await save(makeRecord({ electionRevision: 2 }))
					await AsyncStorage.removeItem(voteRecordKey(E))
				},
			],
			[
				'record corrupt',
				2,
				async () => {
					await save(makeRecord({ electionRevision: 2 }))
					await AsyncStorage.setItem(voteRecordKey(E), '{garbage')
				},
			],
			[
				'marker corrupt',
				2,
				async () => {
					await save(makeRecord({ electionRevision: 2 }))
					await AsyncStorage.setItem(voteMarkerKey(E), '{garbage')
				},
			],
		]
		it.each(scenarios)('%s', async (_n, rev, seed) => {
			await seed()
			const status: SavedVoteStatus = await readSavedVoteStatus(deps, 1, E, reading(rev))
			const receipt = await loadVoteReceipt(E, rev)
			expect(status.state).toBe(receipt.kind)
			if ((receipt.kind === 'saved' || receipt.kind === 'stale') && (status.state === 'saved' || status.state === 'stale')) {
				expect(status.revisionKnown).toBe(receipt.revisionKnown)
			}
		})
	})

	it.each([2, 3])('SV13: parity with deriveSavedVoteState at revision %i', async (rev) => {
		await save(makeRecord({ electionRevision: 2 }))
		const status = await readSavedVoteStatus(deps, 1, E, reading(rev))
		expect(status.state).toBe(deriveSavedVoteState(await readVoteMarker(E), rev))
	})

	describe('SV16: sent state (D-96)', () => {
		it('every marker ballot sent reads sent', async () => {
			await save(makeRecord({ electionRevision: 2 }))
			await recordVoteSent(E, 2, 'ballot-1', 'cid-1')
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'sent' })
		})

		it('only some ballots sent stays saved', async () => {
			const record = makeRecord({ electionRevision: 2 })
			record.votes.push({ ...record.votes[0], ballotId: 'ballot-2', nonce: randHex(32) })
			record.voter.ballots.push({ ballotId: 'ballot-2', templateDigest: 'td' })
			await save(record)
			await recordVoteSent(E, 2, 'ballot-1', 'cid-1')
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'saved', revisionKnown: true })
			await recordVoteSent(E, 2, 'ballot-2', 'cid-2')
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'sent' })
		})

		it('two ballots recorded at the same moment are both kept, so the vote reads sent (lost update)', async () => {
			// sendSavedVote pools every ballot in parallel and records each as it lands; two that land
			// together must not overwrite each other in the sent store
			const record = makeRecord({ electionRevision: 2 })
			record.votes.push({ ...record.votes[0], ballotId: 'ballot-2', nonce: randHex(32) })
			record.voter.ballots.push({ ballotId: 'ballot-2', templateDigest: 'td' })
			await save(record)
			await Promise.all([recordVoteSent(E, 2, 'ballot-1', 'cid-1'), recordVoteSent(E, 2, 'ballot-2', 'cid-2')])
			await expect(readVoteSent(E, 2)).resolves.toEqual({ 'ballot-1': 'cid-1', 'ballot-2': 'cid-2' })
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'sent' })
		})

		it('stale keeps priority over sent', async () => {
			await save(makeRecord({ electionRevision: 2 }))
			await recordVoteSent(E, 2, 'ballot-1', 'cid-1')
			await expect(readSavedVoteStatus(deps, 1, E, reading(3))).resolves.toEqual({ state: 'stale', revisionKnown: true })
		})

		it('unreadable keeps priority over sent', async () => {
			await save(makeRecord({ electionRevision: 2 }))
			await recordVoteSent(E, 2, 'ballot-1', 'cid-1')
			await AsyncStorage.removeItem(voteRecordKey(E))
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'unreadable' })
			await AsyncStorage.setItem(voteRecordKey(E), '{garbage')
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'unreadable' })
		})

		it('a sent store for an older revision reads saved', async () => {
			await save(makeRecord({ electionRevision: 2 }))
			await recordVoteSent(E, 1, 'ballot-1', 'cid-1')
			await expect(readSavedVoteStatus(deps, 1, E, reading(2))).resolves.toEqual({ state: 'saved', revisionKnown: true })
		})

		it('an empty ballotIds marker never reads sent', async () => {
			const record = makeRecord({ electionRevision: 2 })
			await save(record)
			const marker = { ...buildVoteMarker(record), ballotIds: [] as string[] }
			await AsyncStorage.setItem(voteMarkerKey(E), JSON.stringify(marker))
			await recordVoteSent(E, 2, 'ballot-1', 'cid-1')
			const status = await readSavedVoteStatus(deps, 1, E, reading(2))
			expect(status.state).not.toBe('sent')
		})
	})

	it('SV14: never logs', async () => {
		await save(makeRecord())
		await readSavedVoteStatus(deps, 1, E, reading(2))
		await readSavedVoteStatus(deps, 1, E, reading(null))
		for (const s of consoleSpies) expect(s).not.toHaveBeenCalled()
	})

	describe('SV15: source discipline', () => {
		const src = fs
			.readFileSync(path.join(__dirname, '..', 'saved-vote-status.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
		it.each(['readVoteMarker(', 'readSavedVote(', 'readReceiptElection'])('contains %s', (needle) => {
			expect(src).toContain(needle)
		})
		it.each(['AsyncStorage', 'voteMarkerKey', 'voteRecordKey', 'openVoteRecord', 'writeVoteRecord', 'console.', 'let cache', 'new Map('])(
			'does not contain %s',
			(needle) => {
				expect(src).not.toContain(needle)
			},
		)
	})
})
