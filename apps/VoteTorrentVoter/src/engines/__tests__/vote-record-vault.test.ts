/**
 * vote-record-vault.test.ts - D-29 / D-13 proof (Phase 63 plan 07): no plaintext in the envelope,
 * election-bound AAD, tamper rejection, records above the 4,096 B direct-wrap cap, per-use prompt
 * count, data-key zeroing, closed reason mapping, and no logging.
 *
 * Real Keystore auth behaviour is proven on device only by 63-18 (`prompts`, `persist`, `tamper`,
 * `sweep` legs); this suite proves the JS contract against a real-AES in-memory wrapper.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
	SECRET_WRAP_ERROR_CODES,
	VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
	type SecretWrapErrorCode,
	type SecretWrapPrompt,
} from '@votetorrent/attestation-native'
import { createInMemorySecretWrapperForTests, type InMemorySecretWrapper } from '../__fixtures__/in-memory-secret-wrapper'
import {
	VOTE_RECORD_AUTH_WINDOW_SECONDS,
	VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1,
	createVoteRecordWrapProvider,
	setVoteRecordWrapProviderForTests,
} from '../vote-record-wrap'
import {
	VoteRecordUnavailableError,
	buildVoteRecordAad,
	isVoteRecord,
	isVoteRecordEnvelope,
	openVoteRecord,
	sealVoteRecord,
	type VoteRecord,
	type VoteRecordEnvelope,
	type VoteRecordUnavailableReason,
} from '../vote-record-vault'

const PROMPT: SecretWrapPrompt = { title: 'T', subtitle: 'S', negativeButton: 'N' }
const OPTS = { prompt: PROMPT }

function randHex(bytes: number): string {
	const a = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(a)
	return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

function utf8Len(s: string): number {
	return new TextEncoder().encode(s).length
}

interface Needles {
	nonce: string
	registrantId: string
	signature: string
	questionCode: string
	optionCode: string
}

function makeRecord(args: { electionId?: string; questions?: number; codeLen?: number } = {}): { record: VoteRecord; needles: Needles } {
	const electionId = args.electionId ?? 'election-A'
	const n = args.questions ?? 2
	const needles: Needles = {
		nonce: randHex(32),
		registrantId: 'reg-' + randHex(8),
		signature: 'sig-' + randHex(16),
		questionCode: 'qq' + randHex(6),
		optionCode: 'oo' + randHex(6),
	}
	const answers = Array.from({ length: n }, (_, i) =>
		i === 0
			? { questionCode: needles.questionCode, optionCodes: [needles.optionCode] }
			: {
					questionCode: ('Q' + String(i).padStart(3, '0') + 'x'.repeat(18)).slice(0, 22),
					optionCodes: ['optionAAAAAAAAAA', 'optionBBBBBBBBBB', 'optionCCCCCCCCCC'],
				},
	)
	const record: VoteRecord = {
		v: 1,
		electionId,
		electionRevision: 3,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: [{ v: 1, electionId, electionRevision: 3, ballotId: 'ballot-1', templateDigest: 'td-1', answers, nonce: needles.nonce }],
		voter: {
			v: 1,
			electionId,
			electionRevision: 3,
			registrantId: needles.registrantId,
			privateCid: 'cid-private',
			publicCid: null,
			deviceKey: 'dk-1',
			attestationCid: null,
			ballots: [{ ballotId: 'ballot-1', templateDigest: 'td-1' }],
			signature: needles.signature,
		},
	}
	return { record, needles }
}

function flipFirstByteBase64(b64: string): string {
	const bin = atob(b64)
	const out = String.fromCharCode(bin.charCodeAt(0) ^ 0xff) + bin.slice(1)
	return btoa(out)
}

async function reasonOf(p: Promise<unknown>): Promise<VoteRecordUnavailableReason> {
	try {
		await p
	} catch (e) {
		if (e instanceof VoteRecordUnavailableError) return e.reason
		throw e
	}
	throw new Error('expected rejection')
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined))

let fixture: InMemorySecretWrapper

beforeEach(() => {
	fixture = createInMemorySecretWrapperForTests()
	setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(fixture))
})
afterAll(() => {
	setVoteRecordWrapProviderForTests(undefined)
	for (const s of consoleSpies) s.mockRestore()
})

describe('seal/open round trip', () => {
	it('round trips and shapes the envelope', async () => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		expect(env.v).toBe(1)
		expect(env.wrappedKey.keyAlias).toBe(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
		expect(env.wrappedKey.securityLevel).toBe('test-stub')
		expect(atob(env.iv).length).toBe(12)
		expect(isVoteRecordEnvelope(env)).toBe(true)
		expect(isVoteRecord(record)).toBe(true)
		await expect(openVoteRecord(record.electionId, env, OPTS)).resolves.toEqual(record)
	})

	it('the serialized envelope carries no plaintext needle', async () => {
		const { record, needles } = makeRecord()
		const json = JSON.stringify(await sealVoteRecord(record, OPTS))
		for (const needle of Object.values(needles)) expect(json).not.toContain(needle)
	})

	it('AAD is the election-bound prefix', () => {
		expect(new TextDecoder().decode(buildVoteRecordAad('e1'))).toBe('votetorrent-vote-record-v1:e1')
		expect(() => buildVoteRecordAad('')).toThrow(TypeError)
	})
})

describe('tamper and transplant', () => {
	it('another election id rejects tag-mismatch', async () => {
		const { record } = makeRecord({ electionId: 'election-A' })
		const env = await sealVoteRecord(record, OPTS)
		expect(await reasonOf(openVoteRecord('election-B', env, OPTS))).toBe('tag-mismatch')
	})

	it.each(['ct', 'iv', 'wrappedKey'] as const)('a flipped %s byte rejects tag-mismatch', async (which) => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		const t: VoteRecordEnvelope = JSON.parse(JSON.stringify(env))
		if (which === 'wrappedKey') t.wrappedKey.ciphertextBase64 = flipFirstByteBase64(t.wrappedKey.ciphertextBase64)
		else t[which] = flipFirstByteBase64(t[which])
		expect(await reasonOf(openVoteRecord(record.electionId, t, OPTS))).toBe('tag-mismatch')
	})
})

describe('record above the 4,096 B direct-wrap cap', () => {
	it('seals and opens intact', async () => {
		const { record } = makeRecord({ questions: 60 })
		expect(utf8Len(JSON.stringify(record))).toBeGreaterThan(4096)
		const env = await sealVoteRecord(record, OPTS)
		await expect(openVoteRecord(record.electionId, env, OPTS)).resolves.toEqual(record)
	})

	it('control: the fixture really rejects a 4,097 B direct wrap', async () => {
		await expect(
			fixture.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, new Uint8Array(4097).fill(1), {
				requireAuth: true,
				aad: buildVoteRecordAad('x'),
				prompt: PROMPT,
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
	})
})

describe('prompt count (D-13, per-use)', () => {
	it('one prompt per seal and one per open, nothing cached', async () => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		expect(fixture.promptCount).toBe(1)
		expect(fixture.wrapCalls).toBe(1)
		expect(fixture.unwrapCalls).toBe(0)
		await openVoteRecord(record.electionId, env, OPTS)
		expect(fixture.promptCount).toBe(2)
		await openVoteRecord(record.electionId, env, OPTS)
		expect(fixture.promptCount).toBe(3)
		for (const c of fixture.calls) {
			expect(c.requireAuth).toBe(true)
			expect(c.keyAlias).toBe(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
		}
	})
})

describe('zeroing', () => {
	it('zero-fills the data key after seal', async () => {
		const { record } = makeRecord()
		await sealVoteRecord(record, OPTS)
		expect(fixture.lastWrapPlaintext!.length).toBe(32)
		expect(fixture.lastWrapPlaintext!.every((b) => b === 0)).toBe(true)
	})

	it('zero-fills the unwrapped key after a successful open', async () => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		await openVoteRecord(record.electionId, env, OPTS)
		expect(fixture.lastUnwrapResult!.length).toBe(32)
		expect(fixture.lastUnwrapResult!.every((b) => b === 0)).toBe(true)
	})

	it('zero-fills the unwrapped key when GCM fails', async () => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		const t: VoteRecordEnvelope = { ...env, ct: flipFirstByteBase64(env.ct) }
		await expect(openVoteRecord(record.electionId, t, OPTS)).rejects.toBeInstanceOf(VoteRecordUnavailableError)
		expect(fixture.lastUnwrapResult!.every((b) => b === 0)).toBe(true)
	})
})

const REASON_TABLE: Record<SecretWrapErrorCode, VoteRecordUnavailableReason> = {
	CANCELED: 'canceled',
	NO_BIOMETRICS_ENROLLED: 'biometric-unavailable',
	LOCKOUT: 'biometric-unavailable',
	LOCKOUT_PERMANENT: 'biometric-unavailable',
	BIOMETRIC_ERROR: 'biometric-unavailable',
	DEVICE_LOCKED: 'biometric-unavailable',
	NO_ACTIVITY: 'biometric-unavailable',
	KEY_INVALIDATED: 'key-invalidated',
	NO_WRAP_KEY: 'no-wrap-key',
	WRAP_KEY_POLICY_MISMATCH: 'policy-mismatch',
	UNWRAP_TAG_MISMATCH: 'tag-mismatch',
	INVALID_ARGUMENT: 'malformed',
	INVALID_ENCODING: 'malformed',
	MALFORMED_NATIVE_RESULT: 'malformed',
	WRAP_FAILED: 'native-error',
	UNWRAP_FAILED: 'native-error',
	NATIVE_UNAVAILABLE: 'native-error',
}

describe('reason mapping', () => {
	it.each(SECRET_WRAP_ERROR_CODES)('unwrap code %s maps to the table reason with a fixed message', async (code) => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		fixture.failNextCall('unwrap', code)
		let err: unknown
		try {
			await openVoteRecord(record.electionId, env, OPTS)
		} catch (e) {
			err = e
		}
		expect(err).toBeInstanceOf(VoteRecordUnavailableError)
		const e = err as VoteRecordUnavailableError
		expect(e.reason).toBe(REASON_TABLE[code])
		expect(e.name).toBe('VoteRecordUnavailableError')
		expect(e.message).toBe('vote record unavailable (' + e.reason + ')')
		expect(e.message).not.toContain('in-memory-secret-wrapper')
	})

	it('a plain error maps to native-error', async () => {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		fixture.failNextCall('unwrap', 'plain-error')
		expect(await reasonOf(openVoteRecord(record.electionId, env, OPTS))).toBe('native-error')
	})

	it('a cancelled wrap on seal maps to canceled', async () => {
		const { record } = makeRecord()
		fixture.failNextCall('wrap', 'CANCELED')
		let err: unknown
		try {
			await sealVoteRecord(record, OPTS)
		} catch (e) {
			err = e
		}
		expect((err as VoteRecordUnavailableError).reason).toBe('canceled')
		expect((err as Error).message).toBe('vote record unavailable (canceled)')
	})
})

describe('malformed input costs zero prompts', () => {
	async function sealed(): Promise<{ env: VoteRecordEnvelope; id: string }> {
		const { record } = makeRecord()
		const env = await sealVoteRecord(record, OPTS)
		fixture = createInMemorySecretWrapperForTests()
		setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(fixture))
		return { env, id: record.electionId }
	}

	it('rejects bad envelopes with malformed and no prompt', async () => {
		const { env, id } = await sealed()
		const cases: unknown[] = [
			{ ...env, v: 2 },
			{ v: 1, wrappedKey: env.wrappedKey, iv: env.iv },
			{ ...env, iv: '!!not-base64!!' },
			{ ...env, iv: btoa('x'.repeat(11)) },
			{ ...env, wrappedKey: { ...env.wrappedKey, keyAlias: VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1 } },
			{ ...env, ct: btoa('short') },
			null,
		]
		for (const c of cases) {
			expect(await reasonOf(openVoteRecord(id, c as VoteRecordEnvelope, OPTS))).toBe('malformed')
		}
		expect(fixture.promptCount).toBe(0)
		expect(fixture.calls.length).toBe(0)
	})

	it('rejects bad records on seal with malformed and no prompt', async () => {
		const { record } = makeRecord()
		const badNonce = { ...record, votes: [{ ...record.votes[0]!, nonce: 'abc' }] }
		const noVotes = { ...record, votes: [] }
		expect(await reasonOf(sealVoteRecord(badNonce, OPTS))).toBe('malformed')
		expect(await reasonOf(sealVoteRecord(noVotes, OPTS))).toBe('malformed')
		expect(fixture.promptCount).toBe(0)
	})

	it('an empty prompt title throws TypeError with zero wrapper calls', async () => {
		const { record } = makeRecord()
		const bad = { prompt: { ...PROMPT, title: '' } }
		await expect(sealVoteRecord(record, bad)).rejects.toBeInstanceOf(TypeError)
		const env = await sealVoteRecord(record, OPTS)
		const before = fixture.calls.length
		await expect(openVoteRecord(record.electionId, env, bad)).rejects.toBeInstanceOf(TypeError)
		expect(fixture.calls.length).toBe(before)
	})
})

describe('no logging', () => {
	const strip = (src: string): string =>
		src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '')
	const TOKEN = 'console' + '.'

	it('the stripper keeps a code-line occurrence and removes a comment-only one', () => {
		expect(strip(`// ${TOKEN}log(1)\n/* ${TOKEN}log */\nconst a = 1`)).not.toContain(TOKEN)
		expect(strip(`${TOKEN}log(1)`)).toContain(TOKEN)
	})

	it.each(['vote-record-vault.ts', 'vote-record-wrap.ts'])('%s has no console calls', (file) => {
		const src = readFileSync(resolve(__dirname, '..', file), 'utf8')
		expect(strip(src)).not.toContain(TOKEN)
	})

	it('no console method was called during this suite so far', () => {
		for (const s of consoleSpies) expect(s).not.toHaveBeenCalled()
	})
})

describe('auth window model (D-14, R-4)', () => {
	let t: number
	let clocked: InMemorySecretWrapper

	beforeEach(() => {
		t = 5_000_000
		clocked = createInMemorySecretWrapperForTests({ nowMs: () => t })
		setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(clocked))
	})

	it('signing opened the window: seal is unprompted, an open at +2 s is unprompted, an open after the window lapses prompts once', async () => {
		const { record } = makeRecord()
		clocked.noteExternalAuthentication()
		const env = await sealVoteRecord(record, OPTS)
		expect(clocked.promptCount).toBe(0)
		t += 2000
		await openVoteRecord(record.electionId, env, OPTS)
		expect(clocked.promptCount).toBe(0)
		t += VOTE_RECORD_AUTH_WINDOW_SECONDS * 1000 + 1000
		await openVoteRecord(record.electionId, env, OPTS)
		expect(clocked.promptCount).toBe(1)
	})

	it('without an external authentication the seal itself prompts once', async () => {
		const { record } = makeRecord()
		await sealVoteRecord(record, OPTS)
		expect(clocked.promptCount).toBe(1)
	})
})
