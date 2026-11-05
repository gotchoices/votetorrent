/**
 * device-user.provisioning.test.ts — 49-16 Gap A closure coverage.
 *
 * Covers three things:
 *   (1) `getOrCreateDeviceUser`'s unprovisioned rejection now carries a routable
 *       `code: 'NO_KEY_PROVISIONED'`, recognized by `isDeviceSigningError` — the fix that lets
 *       `AddNetworkScreen` (Task 3) route through the shared hook instead of a dead-end raw
 *       error string.
 *   (2) the new device provisioning record (`persistDeviceProvisioningRecord` /
 *       `getDeviceProvisioningRecord`) round-trips under its own AsyncStorage key, and the
 *       `deviceUser` blob itself stays byte-shape-unchanged (`['user']` only — no cert chain, no
 *       recovery key leaked in).
 *   (3) a source-shape guard, in the style of the sibling guards in this directory
 *       (`dev-only-key-gen.releaseGuard.test.ts`), that this task did not regress the D-12
 *       structural boundary: `dev-only-key-gen` appears in `device-user.ts` exactly once, via
 *       `require(...)`, never on an `import` line.
 *
 * Uses the real AsyncStorage jest mock mapped in `jest.config.js`
 * (`@react-native-async-storage/async-storage/jest/async-storage-mock.js`) — not a hand-rolled
 * fake — and clears it between cases, mirroring `registrant-dev-seed.test.ts`'s convention.
 */

import * as fs from 'fs'
import * as path from 'path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { UserKeyType } from '@votetorrent/vote-core'
import {
	DEVICE_USER_KEY,
	DEVICE_PROVISIONING_KEY,
	DEVICE_RECOVERY_IN_PROGRESS_KEY,
	getDeviceUser,
	getOrCreateDeviceUser,
	persistProvisionedDeviceUser,
	persistDeviceProvisioningRecord,
	getDeviceProvisioningRecord,
	markRecoveryInProgress,
	clearRecoveryInProgress,
	isRecoveryInProgress,
	type DeviceProvisioningRecord,
} from '../device-user'
import { isDeviceSigningError } from '../../utils/deviceSigningError'

const DEVICE_USER_PATH = path.join(__dirname, '../device-user.ts')
const DEVICE_USER_SOURCE = fs.readFileSync(DEVICE_USER_PATH, 'utf8')

const SAMPLE_RECORD: DeviceProvisioningRecord = {
	recoveryPublicKeyCompressedHex: 'aa'.repeat(33),
	attestedPublicKeyCompressedHex: 'bb'.repeat(33),
	signingKeyAlias: 'VOTETORRENT_AUTHORITY_SIGNING_KEY_V1',
	certificateChainBase64: ['leaf-cert-b64', 'intermediate-cert-b64'],
	capturedAt: 1_700_000_000_000,
}

describe('device-user.ts — 49-16 provisioning record + typed unprovisioned rejection', () => {
	beforeEach(async () => {
		await AsyncStorage.clear()
	})

	describe('getOrCreateDeviceUser — typed NO_KEY_PROVISIONED rejection', () => {
		it('rejects with code === "NO_KEY_PROVISIONED" on an unprovisioned device', async () => {
			await expect(getOrCreateDeviceUser('Officer One')).rejects.toMatchObject({
				code: 'NO_KEY_PROVISIONED',
			})
		})

		it('isDeviceSigningError(err) is true for that same rejection', async () => {
			let caught: unknown
			try {
				await getOrCreateDeviceUser('Officer One')
			} catch (err) {
				caught = err
			}
			expect(caught).toBeDefined()
			expect(isDeviceSigningError(caught)).toBe(true)
		})

		it('resolves the same User as getDeviceUser() on a provisioned device, and does not throw', async () => {
			const persisted = await persistProvisionedDeviceUser('Officer One', 'cc'.repeat(33))
			const resolved = await getOrCreateDeviceUser('Officer One')
			const direct = await getDeviceUser()
			expect(resolved).toEqual(persisted)
			expect(resolved).toEqual(direct)
		})
	})

	describe('persistProvisionedDeviceUser — deviceUser blob shape unchanged', () => {
		it('writes { user } under "deviceUser" with a single p256 activeKeys[0]', async () => {
			const signingHex = 'dd'.repeat(33)
			await persistProvisionedDeviceUser('Officer One', signingHex)

			const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
			expect(raw).not.toBeNull()
			const parsed = JSON.parse(raw as string)

			expect(Object.keys(parsed)).toEqual(['user'])
			expect(parsed.user.activeKeys).toHaveLength(1)
			expect(parsed.user.activeKeys[0].key).toBe(signingHex)
			expect(parsed.user.activeKeys[0].type).toBe(UserKeyType.p256)
		})

		it('never writes any private key material (no privHex-shaped field)', async () => {
			await persistProvisionedDeviceUser('Officer One', 'ee'.repeat(33))
			const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
			expect(raw).not.toMatch(/priv/i)
		})
	})

	describe('persistDeviceProvisioningRecord / getDeviceProvisioningRecord — round trip', () => {
		it('resolves undefined before anything is written', async () => {
			await expect(getDeviceProvisioningRecord()).resolves.toBeUndefined()
		})

		it('round-trips the recovery public key and the cert chain under their own key', async () => {
			await persistDeviceProvisioningRecord(SAMPLE_RECORD)
			const roundTripped = await getDeviceProvisioningRecord()
			expect(roundTripped).toEqual(SAMPLE_RECORD)

			const raw = await AsyncStorage.getItem(DEVICE_PROVISIONING_KEY)
			expect(raw).not.toBeNull()
		})

		it('is stored under its own AsyncStorage key, distinct from deviceUser, and leaks nothing into the deviceUser blob', async () => {
			await persistProvisionedDeviceUser('Officer One', 'ff'.repeat(33))
			await persistDeviceProvisioningRecord(SAMPLE_RECORD)

			const deviceUserRaw = await AsyncStorage.getItem(DEVICE_USER_KEY)
			const parsedDeviceUser = JSON.parse(deviceUserRaw as string)
			expect(Object.keys(parsedDeviceUser)).toEqual(['user'])
			expect(deviceUserRaw).not.toMatch(/certificateChainBase64/)
			expect(deviceUserRaw).not.toMatch(/recoveryPublicKeyCompressedHex/)

			const provisioningRaw = await AsyncStorage.getItem(DEVICE_PROVISIONING_KEY)
			expect(provisioningRaw).not.toBeNull()
			expect(provisioningRaw).toMatch(/certificateChainBase64/)
		})
	})

	describe('persistProvisionedDeviceUser — kept user id (UAT 62 gap 5)', () => {
		it('P1: persists and returns the supplied user id (recovery keeps the network identity)', async () => {
			const user = await persistProvisionedDeviceUser('Una', 'ab'.repeat(33), { userId: 'u-1' })
			expect(user.id).toBe('u-1')
			expect(user.activeKeys[0]).toMatchObject({ key: 'ab'.repeat(33), type: UserKeyType.p256 })
			expect((await getDeviceUser())?.id).toBe('u-1')
		})

		it('P2: without options it still mints a fresh id (first run)', async () => {
			const a = await persistProvisionedDeviceUser('Una', 'ab'.repeat(33))
			expect(typeof a.id).toBe('string')
			expect(a.id.length).toBeGreaterThan(0)
			expect(a.id).not.toBe('u-1')
			const b = await persistProvisionedDeviceUser('Una', 'ab'.repeat(33), { userId: '' })
			expect(b.id).not.toBe('')
		})
	})

	describe('49-14 follow-up — recovery-in-progress marker (device-signer.ts fail-closed check)', () => {
		it('isRecoveryInProgress() is false before anything is written', async () => {
			await expect(isRecoveryInProgress()).resolves.toBe(false)
		})

		it('markRecoveryInProgress() makes isRecoveryInProgress() true', async () => {
			await markRecoveryInProgress()
			await expect(isRecoveryInProgress()).resolves.toBe(true)
		})

		it('clearRecoveryInProgress() makes isRecoveryInProgress() false again', async () => {
			await markRecoveryInProgress()
			await clearRecoveryInProgress()
			await expect(isRecoveryInProgress()).resolves.toBe(false)
		})

		it('clearRecoveryInProgress() is a safe no-op when no marker was ever written', async () => {
			await expect(clearRecoveryInProgress()).resolves.toBeUndefined()
			await expect(isRecoveryInProgress()).resolves.toBe(false)
		})

		it('is stored under its own AsyncStorage key, distinct from deviceUser and the provisioning record', async () => {
			await persistProvisionedDeviceUser('Officer One', 'aa'.repeat(33))
			await markRecoveryInProgress()

			const markerRaw = await AsyncStorage.getItem(DEVICE_RECOVERY_IN_PROGRESS_KEY)
			expect(markerRaw).not.toBeNull()

			const deviceUserRaw = await AsyncStorage.getItem(DEVICE_USER_KEY)
			expect(deviceUserRaw).not.toMatch(/startedAt/)
		})
	})

	describe('D-12 source-shape guard — this task does not regress the dev-only-key-gen boundary', () => {
		it('references dev-only-key-gen exactly once, via require(...), never on an import line', () => {
			const importLines = DEVICE_USER_SOURCE
				.split('\n')
				.filter((line) => /^import.*dev-only-key-gen/.test(line))
			expect(importLines).toEqual([])

			const requireMatches = DEVICE_USER_SOURCE.match(/require\('\.\/dev-only-key-gen'\)/g) ?? []
			expect(requireMatches).toHaveLength(1)
		})
	})
})
