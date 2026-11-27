/**
 * device-user.replace.test.ts — user-confirmed replacement of a permanently unrecoverable
 * identity (D-40 stays true: nothing is recovered, exported or reused).
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { SecretWrapError } from '@votetorrent/attestation-native'
import type { User } from '@votetorrent/vote-core'
import {
	DEVICE_USER_KEY,
	REPLACEABLE_IDENTITY_REASONS,
	DeviceIdentityKeyUnavailableError,
	buildIdentityKeyAad,
	getDevicePrivKeyHex,
	getOrCreateDeviceUser,
	isIdentityNotReplaceable,
	isReplaceableIdentityError,
	replaceUnrecoverableDeviceIdentity,
} from '../device-user'
import * as identityErrors from '../identity-errors'
import { setDeviceKeyWrapProviderForTests, type DeviceKeyWrapProvider } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'

let inner: ReturnType<typeof createInMemoryKeyWrapProviderForTests>
let mode: 'ok' | 'no-wrap-key' | 'native-error' | 'wrap-fails'
// ciphertexts whose Keystore key was lost; freshly wrapped secrets (new key) still unwrap
let lost: Set<string>
let provider: DeviceKeyWrapProvider

beforeEach(async () => {
	await AsyncStorage.clear()
	inner = createInMemoryKeyWrapProviderForTests()
	mode = 'ok'
	lost = new Set()
	provider = {
		wrap: async (p, a) => {
			if (mode === 'wrap-fails') throw new Error('wrap unavailable')
			return inner.wrap(p, a)
		},
		unwrap: async (w, a) => {
			if (mode === 'no-wrap-key' && lost.has(w.ciphertextBase64)) throw new SecretWrapError('NO_WRAP_KEY', 'gone')
			if (mode === 'native-error') throw new Error('transient')
			return inner.unwrap(w, a)
		},
	}
	setDeviceKeyWrapProviderForTests(provider)
})

afterEach(() => {
	setDeviceKeyWrapProviderForTests(undefined)
})

async function loseWrapKey(): Promise<void> {
	const rec = JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!) as {
		wrappedPrivKey: { ciphertextBase64: string }
	}
	lost.add(rec.wrappedPrivKey.ciphertextBase64)
	mode = 'no-wrap-key'
}

async function stored(): Promise<string | null> {
	return AsyncStorage.getItem(DEVICE_USER_KEY)
}

describe('replaceUnrecoverableDeviceIdentity', () => {
	it('no-wrap-key -> new id, new key, v2 wrapped record, no plaintext', async () => {
		const old = await getOrCreateDeviceUser('Voter')
		await loseWrapKey()
		await expect(getDevicePrivKeyHex()).rejects.toMatchObject({ reason: 'no-wrap-key' })
		const replaced = await replaceUnrecoverableDeviceIdentity('Voter')
		expect(replaced.id).not.toBe(old.id)
		expect(replaced.activeKeys[0]!.key).not.toBe(old.activeKeys[0]!.key)

		const raw = (await stored())!
		expect(raw).not.toContain('privHex')
		const parsed = JSON.parse(raw) as { v: number; user: User; wrappedPrivKey: unknown }
		expect(parsed.v).toBe(2)
		expect(parsed.user.id).toBe(replaced.id)
		expect(parsed.wrappedPrivKey).toBeDefined()
	})

	it('tag-mismatch (ciphertext bound to another identity) is replaceable', async () => {
		const old = await getOrCreateDeviceUser('Voter')
		const rec = JSON.parse((await stored())!) as { user: User }
		rec.user = { ...rec.user, id: 'someone-else' } // AAD no longer matches
		await AsyncStorage.setItem(DEVICE_USER_KEY, JSON.stringify(rec))
		const replaced = await replaceUnrecoverableDeviceIdentity('Voter')
		expect(replaced.id).not.toBe(old.id)
		expect(replaced.id).not.toBe('someone-else')
	})

	it('key-mismatch (wrapped key differs from the stored public key) is replaceable', async () => {
		const otherPriv = secp256k1.utils.randomSecretKey()
		const claimedPriv = secp256k1.utils.randomSecretKey()
		const claimedPub = bytesToHex(secp256k1.getPublicKey(claimedPriv, true))
		const user: User = {
			id: 'u1',
			name: 'Voter',
			activeKeys: [{ key: claimedPub, type: 0 as never, expiration: Date.now() + 1e7 }],
		}
		const wrapped = await inner.wrap(otherPriv, buildIdentityKeyAad('u1', claimedPub))
		await AsyncStorage.setItem(DEVICE_USER_KEY, JSON.stringify({ v: 2, user, wrappedPrivKey: wrapped }))
		await expect(getDevicePrivKeyHex()).rejects.toMatchObject({ reason: 'key-mismatch' })
		const replaced = await replaceUnrecoverableDeviceIdentity('Voter')
		expect(replaced.id).not.toBe('u1')
	})

	it('a readable record is refused (reason readable, message unchanged) and left byte-identical', async () => {
		await getOrCreateDeviceUser('Voter')
		const before = await stored()
		await expect(replaceUnrecoverableDeviceIdentity('Voter')).rejects.toMatchObject({
			name: 'IdentityNotReplaceableError',
			reason: 'readable',
			message: 'identity is readable',
		})
		expect(await stored()).toBe(before)
	})

	it('a transient unwrap failure (native-error) is refused, record untouched', async () => {
		await getOrCreateDeviceUser('Voter')
		const before = await stored()
		mode = 'native-error'
		await expect(replaceUnrecoverableDeviceIdentity('Voter')).rejects.toMatchObject({
			name: 'IdentityNotReplaceableError',
			reason: 'not-permanent',
			message: 'identity failure is not permanent',
		})
		expect(await stored()).toBe(before)
	})

	it('wrap unavailable while replacing: rejects and the old record is restored byte-identical', async () => {
		await getOrCreateDeviceUser('Voter')
		const before = await stored()
		await loseWrapKey()
		const wrapSpy = jest.spyOn(provider, 'wrap').mockRejectedValue(new Error('wrap unavailable'))
		await expect(replaceUnrecoverableDeviceIdentity('Voter')).rejects.toBeInstanceOf(
			DeviceIdentityKeyUnavailableError,
		)
		wrapSpy.mockRestore()
		expect(await stored()).toBe(before)
	})

	it('an absent record is refused', async () => {
		await expect(replaceUnrecoverableDeviceIdentity('Voter')).rejects.toMatchObject({
			name: 'IdentityNotReplaceableError',
			reason: 'no-identity',
			message: 'no identity to replace',
		})
		expect(await stored()).toBeNull()
	})

	it('a legacy plaintext or unreadable record is never replaced', async () => {
		await AsyncStorage.setItem(DEVICE_USER_KEY, '{not json')
		await expect(replaceUnrecoverableDeviceIdentity('Voter')).rejects.toMatchObject({
			name: 'IdentityNotReplaceableError',
			reason: 'not-wrapped',
			message: 'identity record is not a permanently locked wrapped record',
		})
		expect(await stored()).toBe('{not json')
	})
})

describe('isReplaceableIdentityError', () => {
	it('is true only for the three permanent reasons', () => {
		for (const reason of REPLACEABLE_IDENTITY_REASONS) {
			expect(isReplaceableIdentityError(new DeviceIdentityKeyUnavailableError(reason))).toBe(true)
		}
		for (const reason of ['ambiguous-record', 'wrap-unavailable', 'native-error'] as const) {
			expect(isReplaceableIdentityError(new DeviceIdentityKeyUnavailableError(reason))).toBe(false)
		}
		expect(isReplaceableIdentityError(new Error('no-wrap-key'))).toBe(false)
		expect(isReplaceableIdentityError('no-wrap-key')).toBe(false)
		expect(isReplaceableIdentityError(null)).toBe(false)
	})
})

describe('isIdentityNotReplaceable (typed refusal reason, WR-03)', () => {
	it('matches the readable refusal only when asked for readable', async () => {
		await getOrCreateDeviceUser('Voter')
		const readable = await replaceUnrecoverableDeviceIdentity('Voter').catch((e: unknown) => e)
		expect(isIdentityNotReplaceable(readable)).toBe(true)
		expect(isIdentityNotReplaceable(readable, 'readable')).toBe(true)
		expect(isIdentityNotReplaceable(readable, 'not-permanent')).toBe(false)

		await AsyncStorage.clear()
		const absent = await replaceUnrecoverableDeviceIdentity('Voter').catch((e: unknown) => e)
		expect(isIdentityNotReplaceable(absent, 'no-identity')).toBe(true)
		expect(isIdentityNotReplaceable(absent, 'readable')).toBe(false)
	})

	it('never matches on message text or on an unrelated error', () => {
		expect(isIdentityNotReplaceable(new Error('identity is readable'), 'readable')).toBe(false)
		expect(isIdentityNotReplaceable(new DeviceIdentityKeyUnavailableError('no-wrap-key'))).toBe(false)
		expect(isIdentityNotReplaceable(null)).toBe(false)
		expect(isIdentityNotReplaceable('readable', 'readable')).toBe(false)
	})

	it('device-user re-exports the dependency-free predicates unchanged', () => {
		expect(isReplaceableIdentityError).toBe(identityErrors.isReplaceableIdentityError)
		expect(isIdentityNotReplaceable).toBe(identityErrors.isIdentityNotReplaceable)
		expect(REPLACEABLE_IDENTITY_REASONS).toBe(identityErrors.REPLACEABLE_IDENTITY_REASONS)
	})
})
