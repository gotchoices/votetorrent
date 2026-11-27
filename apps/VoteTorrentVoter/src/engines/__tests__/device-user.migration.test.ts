/**
 * device-user.migration.test.ts — D-42 (Phase 62 plan 08) proof: migration, idempotency,
 * fail-open/fail-closed behaviour and the wrap-then-sign round-trip for the rewritten
 * `device-user.ts`.
 *
 * Uses `createInMemoryKeyWrapProviderForTests` installed via `setDeviceKeyWrapProviderForTests`
 * (jest-only, real AES-256-GCM — not a mock) so every assertion below proves something: a flipped
 * ciphertext byte genuinely fails the GCM tag, exactly like the native Keystore/Keychain
 * implementation would.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'
import {
	DEVICE_USER_KEY,
	getOrCreateDeviceUser,
	getDevicePrivKeyHex,
	migrateLegacyPlaintextIdentityKey,
	getDeviceIdentityKeyState,
	DeviceIdentityKeyUnavailableError,
} from '../device-user'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests, type InMemoryKeyWrapProvider } from '../__fixtures__/in-memory-key-wrap-provider'
import { createDeviceSigner } from '../device-signer'

function flipFirstByteBase64(b64: string): string {
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	bytes[0] = bytes[0]! ^ 0xff
	let out = ''
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!)
	return btoa(out)
}

function makeLegacyKeypair(): { privBytes: Uint8Array; pubHex: string; privHex: string } {
	const privBytes = secp256k1.utils.randomSecretKey()
	const pubHex = bytesToHex(secp256k1.getPublicKey(privBytes, true))
	const privHex = bytesToHex(privBytes)
	return { privBytes, pubHex, privHex }
}

function makeLegacyRecord(userId = 'legacy-user-id'): { user: User; privHex: string; raw: string } {
	const { pubHex, privHex } = makeLegacyKeypair()
	const user: User = {
		id: userId,
		name: 'Legacy User',
		activeKeys: [{ key: pubHex, type: UserKeyType.mobile, expiration: Date.now() + 10_000_000 }],
	}
	return { user, privHex, raw: JSON.stringify({ user, privHex }) }
}

let provider: InMemoryKeyWrapProvider

beforeEach(async () => {
	await AsyncStorage.clear()
	provider = createInMemoryKeyWrapProviderForTests()
	setDeviceKeyWrapProviderForTests(provider)
})

afterEach(() => {
	setDeviceKeyWrapProviderForTests(undefined)
	jest.restoreAllMocks()
})

describe('migrateLegacyPlaintextIdentityKey — D-42', () => {
	it('absent: no votingDeviceUser item -> absent, 0 wrap calls, setItem not called', async () => {
		;(AsyncStorage.setItem as jest.Mock).mockClear()
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('absent')
		expect(provider.wrapCalls).toBe(0)
		expect((AsyncStorage.setItem as jest.Mock)).not.toHaveBeenCalled()
	})

	it('legacy -> migrated: stores {v:2,user,wrappedPrivKey}, with neither "privHex" nor the raw hex present', async () => {
		const { user, privHex, raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)

		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('migrated')

		const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
		expect(stored).not.toBeNull()
		expect(stored).not.toContain('privHex')
		expect(stored).not.toContain(privHex)
		const parsed = JSON.parse(stored!) as { v: number; user: User; wrappedPrivKey: { keyAlias: string } }
		expect(parsed.v).toBe(2)
		expect(parsed.user).toEqual(user)
		expect(parsed.wrappedPrivKey.keyAlias).toBe('VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1')
	})

	it('round-trip: after migration, createDeviceSigner signs a 32-byte digest that secp256k1.verify accepts', async () => {
		const { user, raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		await migrateLegacyPlaintextIdentityKey()

		const sign = await createDeviceSigner('Test Device')
		const digest = new Uint8Array(32).fill(7)
		const sig = await sign(digest)
		expect(sig.signerKey).toBe(user.activeKeys[0]!.key)
		const ok = secp256k1.verify(hexToBytes(sig.signature), digest, hexToBytes(user.activeKeys[0]!.key))
		expect(ok).toBe(true)
	})

	it('idempotent: a second run returns already-wrapped, the stored string is byte-identical, and setItem is called 0 times', async () => {
		const { raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		await migrateLegacyPlaintextIdentityKey()
		const afterFirst = await AsyncStorage.getItem(DEVICE_USER_KEY)

		;(AsyncStorage.setItem as jest.Mock).mockClear()
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('already-wrapped')
		expect((AsyncStorage.setItem as jest.Mock)).not.toHaveBeenCalled()
		const afterSecond = await AsyncStorage.getItem(DEVICE_USER_KEY)
		expect(afterSecond).toBe(afterFirst)
	})

	it('fail-open on wrap failure: wrap-unavailable, the stored string is byte-identical, and getDevicePrivKeyHex still returns the original hex', async () => {
		const { privHex, raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		setDeviceKeyWrapProviderForTests(createInMemoryKeyWrapProviderForTests({ failWrap: true }))

		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('wrap-unavailable')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
		expect(await getDevicePrivKeyHex()).toBe(privHex)
	})

	it('verify-before-write: a corruptOnWrap stub produces wrap-unavailable and writes nothing', async () => {
		const { raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		setDeviceKeyWrapProviderForTests(createInMemoryKeyWrapProviderForTests({ corruptOnWrap: true }))

		;(AsyncStorage.setItem as jest.Mock).mockClear()
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('wrap-unavailable')
		expect((AsyncStorage.setItem as jest.Mock)).not.toHaveBeenCalled()
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
	})

	it('read-back failure: a truncated persisted value (once) produces read-back-failed, with the final stored string equal to the original', async () => {
		const { raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)

		const realSetItem = AsyncStorage.setItem.bind(AsyncStorage)
		jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key: string, _value: string) => {
			// Simulate a write that "succeeds" (no throw) but persists a corrupt value — the
			// read-back verification step, not the write try/catch, must catch this.
			return realSetItem(key, '{"truncated":true')
		})

		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('read-back-failed')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
	})

	it('unparseable JSON -> unreadable, value left untouched (never removed)', async () => {
		const raw = 'not-json-at-all{{'
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('unreadable')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
	})

	it('a parseable non-object value -> unreadable, untouched', async () => {
		const raw = JSON.stringify([1, 2, 3])
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('unreadable')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
	})

	it('a legacy privHex that does not derive user.activeKeys[0].key -> unreadable, untouched', async () => {
		const { user } = makeLegacyRecord()
		const wrongPrivHex = bytesToHex(secp256k1.utils.randomSecretKey())
		const raw = JSON.stringify({ user, privHex: wrongPrivHex })
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		const outcome = await migrateLegacyPlaintextIdentityKey()
		expect(outcome).toBe('unreadable')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
	})

	it('a rejected AsyncStorage.getItem -> unreadable, and the function never throws', async () => {
		jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage boom'))
		await expect(migrateLegacyPlaintextIdentityKey()).resolves.toBe('unreadable')
	})

	it('across one full migration run, no console.log/warn/error/info argument contains the private hex', async () => {
		const { privHex, raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		const methods = ['log', 'warn', 'error', 'info'] as const
		const spies = methods.map(m => jest.spyOn(console, m).mockImplementation(() => undefined))

		await migrateLegacyPlaintextIdentityKey()

		for (const spy of spies) {
			for (const call of spy.mock.calls) {
				for (const arg of call) {
					expect(String(arg)).not.toContain(privHex)
				}
			}
		}
	})

	it('two concurrent migrations both resolve (migrated then already-wrapped), and the final record unwraps to the original key', async () => {
		const { privHex, raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)

		const [first, second] = await Promise.all([migrateLegacyPlaintextIdentityKey(), migrateLegacyPlaintextIdentityKey()])
		expect(first).toBe('migrated')
		expect(second).toBe('already-wrapped')
		expect(await getDevicePrivKeyHex()).toBe(privHex)
	})
})

describe('getOrCreateDeviceUser — D-42', () => {
	it('creation with a working stub stores the v2 shape (never privHex); getDevicePrivKeyHex derives the stored pubkey', async () => {
		const user = await getOrCreateDeviceUser('Test Device')
		const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
		expect(stored).not.toContain('"privHex"')
		const parsed = JSON.parse(stored!) as { v: number }
		expect(parsed.v).toBe(2)

		const hex = await getDevicePrivKeyHex()
		expect(hex).toBeDefined()
		const derivedPub = bytesToHex(secp256k1.getPublicKey(hexToBytes(hex!), true))
		expect(derivedPub).toBe(user.activeKeys[0]!.key)
	})

	it('creation with a failWrap stub rejects DeviceIdentityKeyUnavailableError(wrap-unavailable), and getItem is still null', async () => {
		setDeviceKeyWrapProviderForTests(createInMemoryKeyWrapProviderForTests({ failWrap: true }))
		await expect(getOrCreateDeviceUser('Test Device')).rejects.toBeInstanceOf(DeviceIdentityKeyUnavailableError)
		await expect(getOrCreateDeviceUser('Test Device')).rejects.toMatchObject({ reason: 'wrap-unavailable' })
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBeNull()
	})

	it('concurrency: Promise.all([getOrCreateDeviceUser(a), getOrCreateDeviceUser(a)]) yields one identical user.id', async () => {
		const [u1, u2] = await Promise.all([getOrCreateDeviceUser('a'), getOrCreateDeviceUser('a')])
		expect(u1.id).toBe(u2.id)
	})
})

describe('getDevicePrivKeyHex — fail-closed reads (D-40)', () => {
	it('a flipped ciphertext byte rejects tag-mismatch, and the stored record is unchanged', async () => {
		await getOrCreateDeviceUser('Test Device')
		const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const parsed = JSON.parse(stored!) as { wrappedPrivKey: { ciphertextBase64: string } }
		const tamperedRaw = JSON.stringify({
			...JSON.parse(stored!),
			wrappedPrivKey: { ...parsed.wrappedPrivKey, ciphertextBase64: flipFirstByteBase64(parsed.wrappedPrivKey.ciphertextBase64) },
		})
		await AsyncStorage.setItem(DEVICE_USER_KEY, tamperedRaw)

		await expect(getDevicePrivKeyHex()).rejects.toMatchObject({ reason: 'tag-mismatch' })
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(tamperedRaw)
	})

	it('a transplanted user.id (AAD mismatch) rejects, and the stored record is unchanged', async () => {
		await getOrCreateDeviceUser('Test Device')
		const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const parsed = JSON.parse(stored!) as { user: User }
		const tamperedRaw = JSON.stringify({ ...JSON.parse(stored!), user: { ...parsed.user, id: 'transplanted-id' } })
		await AsyncStorage.setItem(DEVICE_USER_KEY, tamperedRaw)

		await expect(getDevicePrivKeyHex()).rejects.toBeInstanceOf(DeviceIdentityKeyUnavailableError)
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(tamperedRaw)
	})

	it('a record carrying both privHex and wrappedPrivKey rejects ambiguous-record', async () => {
		await getOrCreateDeviceUser('Test Device')
		const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const tamperedRaw = JSON.stringify({ ...JSON.parse(stored!), privHex: 'deadbeef'.repeat(8) })
		await AsyncStorage.setItem(DEVICE_USER_KEY, tamperedRaw)

		await expect(getDevicePrivKeyHex()).rejects.toMatchObject({ reason: 'ambiguous-record' })
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(tamperedRaw)
	})
})

describe('getDeviceIdentityKeyState — D-42', () => {
	it('absent', async () => {
		expect(await getDeviceIdentityKeyState()).toBe('absent')
	})

	it('legacy-plaintext', async () => {
		const { raw } = makeLegacyRecord()
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		expect(await getDeviceIdentityKeyState()).toBe('legacy-plaintext')
	})

	it('wrapped', async () => {
		await getOrCreateDeviceUser('Test Device')
		expect(await getDeviceIdentityKeyState()).toBe('wrapped')
	})

	it('unreadable', async () => {
		await AsyncStorage.setItem(DEVICE_USER_KEY, 'not json')
		expect(await getDeviceIdentityKeyState()).toBe('unreadable')
	})
})
