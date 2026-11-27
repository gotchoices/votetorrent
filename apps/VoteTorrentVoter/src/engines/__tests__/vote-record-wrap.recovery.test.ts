/**
 * vote-record-wrap.recovery.test.ts — Phase 63 review CR-02 and WR-04.
 *
 * CR-02: a biometric enrollment change invalidates the vote-record wrap key for good. Sealing a NEW
 * record must then delete that key (and only that key) and wrap exactly once more. An old record
 * stays unreadable and the receipt shows its unreadable state. The read path never deletes.
 *
 * WR-04: on Android below API 30 the effective window is 0 (per-use); API 30+ keeps 10.
 */

const mockPlatform = { OS: 'ios' as string, Version: 17 as number | string }

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		wrapSecret: jest.fn(),
		unwrapSecret: jest.fn(),
		deleteWrapKey: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => (name === 'AttestationNative' ? attestationNativeFake : target.getEnforcing(name))
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === 'Platform') return mockPlatform
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

import {
	createNativeSecretWrapper,
	VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
	type SecretWrapPrompt,
} from '@votetorrent/attestation-native'
import { createInMemorySecretWrapperForTests } from '../__fixtures__/in-memory-secret-wrapper'
import {
	MIN_ANDROID_API_FOR_AUTH_WINDOW,
	VOTE_RECORD_AUTH_WINDOW_SECONDS,
	VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1,
	createNativeVoteRecordWrapProvider,
	createVoteRecordWrapProvider,
	setVoteRecordWrapProviderForTests,
	voteRecordAuthWindowSeconds,
	voteRecordWrapOptions,
} from '../vote-record-wrap'
import { openVoteRecord, sealVoteRecord, VoteRecordUnavailableError, type VoteRecord } from '../vote-record-vault'
import { revealVoteReceipt } from '../vote-receipt'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { wrapSecret: jest.Mock; unwrapSecret: jest.Mock; deleteWrapKey: jest.Mock }
}

const PROMPT: SecretWrapPrompt = { title: 'Title', subtitle: 'Subtitle', negativeButton: 'Cancel' }
const AAD = new Uint8Array([4, 4])
const ALIAS = VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1

function b64(bytes: Uint8Array): string {
	let s = ''
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
	return btoa(s)
}

function hex(n: number): string {
	return Array.from({ length: n }, (_, i) => ((i * 7 + 3) % 16).toString(16)).join('')
}

function record(electionId: string): VoteRecord {
	return {
		v: 1,
		electionId,
		electionRevision: 1,
		savedAt: '2026-10-06T12:00:00.000Z',
		votes: [{ v: 1, electionId, electionRevision: 1, ballotId: 'b1', templateDigest: 'td', answers: [], nonce: hex(64) }],
		voter: {
			v: 1,
			electionId,
			electionRevision: 1,
			registrantId: 'r',
			privateCid: 'p',
			publicCid: null,
			deviceKey: 'k',
			attestationCid: null,
			ballots: [{ ballotId: 'b1', templateDigest: 'td' }],
			signature: 's',
		},
	}
}

afterEach(() => {
	mockPlatform.OS = 'ios'
	mockPlatform.Version = 17
	setVoteRecordWrapProviderForTests(undefined)
})

describe('WR-04: effective vote-record window by platform level', () => {
	it.each([
		['android', 24, 0],
		['android', 29, 0],
		['android', 30, 10],
		['android', 37, 10],
		['android', '29', 0],
		['android', '33', 10],
		['android', 'not-a-number', 0],
		['ios', '17.4', 10],
		['ios', 12, 10],
	] as const)('%s API %s -> %s', (OS, Version, expected) => {
		expect(voteRecordAuthWindowSeconds({ OS, Version })).toBe(expected)
	})

	it('the threshold is API 30 and API >= 30 keeps the pinned 10 s window', () => {
		expect(MIN_ANDROID_API_FOR_AUTH_WINDOW).toBe(30)
		expect(VOTE_RECORD_AUTH_WINDOW_SECONDS).toBe(10)
		expect(voteRecordAuthWindowSeconds({ OS: 'android', Version: MIN_ANDROID_API_FOR_AUTH_WINDOW })).toBe(VOTE_RECORD_AUTH_WINDOW_SECONDS)
		expect(voteRecordAuthWindowSeconds({ OS: 'android', Version: MIN_ANDROID_API_FOR_AUTH_WINDOW - 1 })).toBe(0)
	})

	it('voteRecordWrapOptions defaults to the running platform', () => {
		mockPlatform.OS = 'android'
		mockPlatform.Version = 29
		expect(voteRecordWrapOptions(AAD, PROMPT).authWindowSeconds).toBe(0)
		mockPlatform.Version = 30
		expect(voteRecordWrapOptions(AAD, PROMPT).authWindowSeconds).toBe(10)
	})

	it.each([
		[29, 0],
		[30, 10],
		[37, 10],
	])('the native wrap and unwrap receive window %s -> %s on Android', async (level, expected) => {
		mockPlatform.OS = 'android'
		mockPlatform.Version = level
		nativeFake.wrapSecret.mockReset().mockImplementation(async (alias: string, ptB64: string) => ({
			ciphertextBase64: b64(new Uint8Array(atob(ptB64).length + 16).fill(7)),
			ivBase64: b64(new Uint8Array(12).fill(1)),
			keyAlias: alias,
			securityLevel: 'tee',
		}))
		nativeFake.unwrapSecret.mockReset().mockResolvedValue({ plaintextBase64: b64(new Uint8Array([1])) })
		const provider = createNativeVoteRecordWrapProvider()
		const wrapped = await provider.wrap(new Uint8Array([1, 2]), AAD, PROMPT)
		await provider.unwrap(wrapped, AAD, PROMPT)
		expect(nativeFake.wrapSecret.mock.calls[0]![7]).toBe(expected)
		expect(nativeFake.unwrapSecret.mock.calls[0]![8]).toBe(expected)
	})

	it('an existing per-use key (created below API 30, OS since upgraded) is used per-use, never as a mismatch', async () => {
		const fx = createInMemorySecretWrapperForTests()
		await fx.wrapSecret(ALIAS, new Uint8Array([1]), { requireAuth: true, aad: AAD, prompt: PROMPT, authWindowSeconds: 0 })
		const provider = createVoteRecordWrapProvider(fx)
		const wrapped = await provider.wrap(new Uint8Array([9]), AAD, PROMPT)
		expect(Array.from(await provider.unwrap(wrapped, AAD, PROMPT))).toEqual([9])
		expect(fx.aliasPolicy(ALIAS)).toEqual({ requireAuth: true, authWindowSeconds: 0 })
	})

	it('a windowed key is never weakened: a per-use request against it still mismatches', async () => {
		const fx = createInMemorySecretWrapperForTests()
		await fx.wrapSecret(ALIAS, new Uint8Array([1]), { requireAuth: true, aad: AAD, prompt: PROMPT, authWindowSeconds: 10 })
		mockPlatform.OS = 'android'
		mockPlatform.Version = 29
		await expect(createVoteRecordWrapProvider(fx).wrap(new Uint8Array([9]), AAD, PROMPT)).rejects.toMatchObject({
			code: 'WRAP_KEY_POLICY_MISMATCH',
		})
	})
})

describe('CR-02: replace an invalidated vote-record key on seal, exactly once', () => {
	it('invalidated -> delete -> one retry that succeeds, under the same alias', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		const provider = createVoteRecordWrapProvider(fx)
		await provider.wrap(new Uint8Array([1]), AAD, PROMPT)
		fx.invalidateAlias(ALIAS)
		const wrapped = await provider.wrap(new Uint8Array([2, 3]), AAD, PROMPT)
		expect(wrapped.keyAlias).toBe(ALIAS)
		expect(fx.deleteCalls).toEqual([ALIAS])
		expect(fx.wrapCalls).toBe(3)
		expect(Array.from(await provider.unwrap(wrapped, AAD, PROMPT))).toEqual([2, 3])
	})

	it("iOS's NO_WRAP_KEY on seal is replaced the same way", async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		fx.failNextCall('wrap', 'NO_WRAP_KEY')
		await createVoteRecordWrapProvider(fx).wrap(new Uint8Array([1]), AAD, PROMPT)
		expect(fx.deleteCalls).toEqual([ALIAS])
		expect(fx.wrapCalls).toBe(2)
	})

	it('a second failure after the replacement propagates and does not loop', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		const provider = createVoteRecordWrapProvider(fx)
		await provider.wrap(new Uint8Array([1]), AAD, PROMPT)
		fx.invalidateAlias(ALIAS)
		fx.failNextCall('wrap', 'KEY_INVALIDATED')
		await expect(provider.wrap(new Uint8Array([2]), AAD, PROMPT)).rejects.toMatchObject({ code: 'KEY_INVALIDATED' })
		expect(fx.deleteCalls).toEqual([ALIAS])
		expect(fx.wrapCalls).toBe(3)
	})

	it('a failed delete reports the original seal error, with no retry', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		const provider = createVoteRecordWrapProvider(fx)
		await provider.wrap(new Uint8Array([1]), AAD, PROMPT)
		fx.invalidateAlias(ALIAS)
		fx.failNextDelete()
		await expect(provider.wrap(new Uint8Array([2]), AAD, PROMPT)).rejects.toMatchObject({ code: 'KEY_INVALIDATED' })
		expect(fx.wrapCalls).toBe(2)
	})

	it.each(['CANCELED', 'WRAP_FAILED', 'LOCKOUT', 'UNWRAP_TAG_MISMATCH'] as const)('%s on seal never deletes a key', async (code) => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		fx.failNextCall('wrap', code)
		await expect(createVoteRecordWrapProvider(fx).wrap(new Uint8Array([1]), AAD, PROMPT)).rejects.toMatchObject({ code })
		expect(fx.deleteCalls).toEqual([])
	})

	it('the read path never deletes: an invalidated key on unwrap stays and reports KEY_INVALIDATED', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		const provider = createVoteRecordWrapProvider(fx)
		const wrapped = await provider.wrap(new Uint8Array([1]), AAD, PROMPT)
		fx.invalidateAlias(ALIAS)
		await expect(provider.unwrap(wrapped, AAD, PROMPT)).rejects.toMatchObject({ code: 'KEY_INVALIDATED' })
		expect(fx.deleteCalls).toEqual([])
	})

	it('a wrapper without deleteWrapKey keeps the old behaviour (no retry)', async () => {
		const fx = createInMemorySecretWrapperForTests()
		const provider = createVoteRecordWrapProvider(fx)
		await provider.wrap(new Uint8Array([1]), AAD, PROMPT)
		fx.invalidateAlias(ALIAS)
		await expect(provider.wrap(new Uint8Array([2]), AAD, PROMPT)).rejects.toMatchObject({ code: 'KEY_INVALIDATED' })
		expect(fx.wrapCalls).toBe(2)
	})

	it('vault: a new seal succeeds after the replacement; the old record opens as unreadable, never as try-again', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		setVoteRecordWrapProviderForTests(createVoteRecordWrapProvider(fx))
		const oldEnv = await sealVoteRecord(record('e-old'), { prompt: PROMPT })
		fx.invalidateAlias(ALIAS)

		// Before any replacement the old record reports the invalidated key, mapped to unreadable.
		await expect(openVoteRecord('e-old', oldEnv, { prompt: PROMPT })).rejects.toMatchObject({ reason: 'key-invalidated' })
		expect(await revealVoteReceipt('e-old', oldEnv, PROMPT)).toEqual({ kind: 'unreadable' })

		const newEnv = await sealVoteRecord(record('e-new'), { prompt: PROMPT })
		expect(fx.deleteCalls).toEqual([ALIAS])
		expect((await openVoteRecord('e-new', newEnv, { prompt: PROMPT })).electionId).toBe('e-new')

		// After the replacement the old record fails its tag under the new key: still unreadable.
		let err: unknown
		try {
			await openVoteRecord('e-old', oldEnv, { prompt: PROMPT })
		} catch (e) {
			err = e
		}
		expect(err).toBeInstanceOf(VoteRecordUnavailableError)
		expect((err as VoteRecordUnavailableError).reason).toBe('tag-mismatch')
		expect(await revealVoteReceipt('e-old', oldEnv, PROMPT)).toEqual({ kind: 'unreadable' })
		// The read path never deleted anything more.
		expect(fx.deleteCalls).toEqual([ALIAS])
	})
})

describe('CR-02 negative control: only the vote-record alias can ever be deleted', () => {
	beforeEach(() => nativeFake.deleteWrapKey.mockReset().mockResolvedValue({ deleted: true }))

	it.each([
		VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
		'VOTETORRENT_DEVICE_KEY_V1',
		'VOTETORRENT_AUTHORITY_SIGNING_KEY_V1',
		'VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1_X',
	])('the native wrapper refuses %s before reaching native', async (alias) => {
		await expect(createNativeSecretWrapper().deleteWrapKey(alias)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(nativeFake.deleteWrapKey).not.toHaveBeenCalled()
	})

	it('the fixture refuses the identity alias too, and its key survives', async () => {
		const fx = createInMemorySecretWrapperForTests({ replaceable: true })
		await fx.wrapSecret(VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1, new Uint8Array([1]), { requireAuth: false, aad: AAD })
		await expect(fx.deleteWrapKey(VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(fx.aliasPolicy(VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1)).toEqual({ requireAuth: false, authWindowSeconds: 0 })
	})

	it('the native wrapper passes the vote-record alias through and parses { deleted }', async () => {
		await expect(createNativeSecretWrapper().deleteWrapKey(ALIAS)).resolves.toBe(true)
		expect(nativeFake.deleteWrapKey).toHaveBeenCalledWith(ALIAS)
		nativeFake.deleteWrapKey.mockResolvedValueOnce({})
		await expect(createNativeSecretWrapper().deleteWrapKey(ALIAS)).rejects.toMatchObject({ code: 'MALFORMED_NATIVE_RESULT' })
		nativeFake.deleteWrapKey.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'WRAP_FAILED' }))
		await expect(createNativeSecretWrapper().deleteWrapKey(ALIAS)).rejects.toMatchObject({ code: 'WRAP_FAILED' })
	})

	it('end to end through the native provider: invalidated seal deletes ONLY the vote-record alias, then retries once', async () => {
		let n = 0
		nativeFake.wrapSecret.mockReset().mockImplementation(async (alias: string, ptB64: string) => {
			n += 1
			if (n === 1) throw Object.assign(new Error('invalidated'), { code: 'KEY_INVALIDATED' })
			return {
				ciphertextBase64: b64(new Uint8Array(atob(ptB64).length + 16).fill(7)),
				ivBase64: b64(new Uint8Array(12).fill(1)),
				keyAlias: alias,
				securityLevel: 'tee',
			}
		})
		await createNativeVoteRecordWrapProvider().wrap(new Uint8Array([1]), AAD, PROMPT)
		expect(nativeFake.deleteWrapKey.mock.calls).toEqual([[ALIAS]])
		expect(nativeFake.wrapSecret).toHaveBeenCalledTimes(2)
		for (const call of nativeFake.wrapSecret.mock.calls) expect(call[0]).toBe(ALIAS)
	})
})
