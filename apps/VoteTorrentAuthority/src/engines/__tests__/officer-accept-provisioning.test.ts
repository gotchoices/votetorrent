/**
 * officer-accept-provisioning.test.ts (66.1-07, D-12).
 *
 * The officer accept sends the phone's own user id, display name and CURRENT signing key
 * (`activeKeys[0]`, the key every device signature is attributed to). The helper fails closed
 * with the two device-signing codes the shared hook already routes to secure signing setup.
 * A source scan proves it never rotates the key, never imports the native module and never
 * mints an id.
 */

import * as fs from 'fs'
import * as path from 'path'

const mockGetDeviceUser = jest.fn()
const mockIsRecoveryInProgress = jest.fn()
jest.mock('../device-user', () => ({
	getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a),
	isRecoveryInProgress: (...a: unknown[]) => mockIsRecoveryInProgress(...a),
}))

const { getOfficerAcceptProvisioning } = require('../officer-accept-provisioning')

const KEY = '02' + 'ab'.repeat(32)
const EXPIRATION = 2_100_000_000_000

beforeEach(() => {
	jest.clearAllMocks()
	mockIsRecoveryInProgress.mockResolvedValue(false)
	mockGetDeviceUser.mockResolvedValue({
		id: 'dev-1',
		name: 'Asha',
		activeKeys: [{ key: KEY, type: 'P', expiration: EXPIRATION }],
	})
})

describe('getOfficerAcceptProvisioning', () => {
	it('returns the device user id, name and activeKeys[0] exactly', async () => {
		await expect(getOfficerAcceptProvisioning()).resolves.toEqual({
			userId: 'dev-1',
			name: 'Asha',
			signingKey: { key: KEY, type: 'P', expiration: EXPIRATION },
		})
	})

	it('copies only the three key fields, even when the stored key carries more', async () => {
		mockGetDeviceUser.mockResolvedValue({
			id: 'dev-1',
			name: 'Asha',
			activeKeys: [{ key: KEY, type: 'P', expiration: EXPIRATION, extra: 'x' }, { key: 'other', type: 'P', expiration: 1 }],
		})
		const out = await getOfficerAcceptProvisioning()
		expect(Object.keys(out.signingKey).sort()).toEqual(['expiration', 'key', 'type'])
		expect(out.signingKey.key).toBe(KEY)
	})

	it('no stored device user rejects NO_KEY_PROVISIONED', async () => {
		mockGetDeviceUser.mockResolvedValue(undefined)
		await expect(getOfficerAcceptProvisioning()).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
	})

	it('a user with no active key rejects NO_KEY_PROVISIONED', async () => {
		mockGetDeviceUser.mockResolvedValue({ id: 'dev-1', name: 'Asha', activeKeys: [] })
		await expect(getOfficerAcceptProvisioning()).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
	})

	it('an empty key string rejects NO_KEY_PROVISIONED', async () => {
		mockGetDeviceUser.mockResolvedValue({ id: 'dev-1', name: 'Asha', activeKeys: [{ key: '', type: 'P', expiration: 1 }] })
		await expect(getOfficerAcceptProvisioning()).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
	})

	it('a recovery in progress rejects KEY_INVALIDATED_REASSOCIATE before the key is read', async () => {
		mockIsRecoveryInProgress.mockResolvedValue(true)
		await expect(getOfficerAcceptProvisioning()).rejects.toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
		expect(mockGetDeviceUser).not.toHaveBeenCalled()
	})

	it('the error text carries no key material', async () => {
		mockGetDeviceUser.mockResolvedValue({ id: 'dev-1', name: 'Asha', activeKeys: [{ key: '', type: 'P', expiration: 1 }] })
		const err = await getOfficerAcceptProvisioning().catch((e: unknown) => e)
		expect(String((err as Error).message)).not.toContain(KEY)
	})
})

describe('officer-accept-provisioning source scan', () => {
	// Banned tokens are built from fragments so this file cannot satisfy or trip its own scan.
	const BANNED = ['provision' + 'DeviceKey', 'attestation' + '-native', 'random' + 'UUID']

	const codeLines = (src: string): string[] =>
		src.split('\n').filter((line) => {
			const s = line.trim()
			return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))
		})
	const hits = (src: string): string[] =>
		codeLines(src).filter((line) => BANNED.some((tok) => line.includes(tok)))

	it('the helper never rotates the key, imports the native module or mints an id', () => {
		const src = fs.readFileSync(path.join(__dirname, '..', 'officer-accept-provisioning.ts'), 'utf8')
		expect(src).toContain('activeKeys')
		expect(hits(src)).toEqual([])
	})

	it('positive control: the matcher hits a fragment-built offending code line, and skips it as a comment', () => {
		const offending = '\tconst k = await ' + 'provision' + 'DeviceKey' + '()\n'
		const imported = "import { x } from '@votetorrent/" + 'attestation' + "-native'\n"
		const minted = '\tconst id = crypto.' + 'random' + 'UUID' + '()\n'
		expect(hits(offending)).toHaveLength(1)
		expect(hits(imported)).toHaveLength(1)
		expect(hits(minted)).toHaveLength(1)
		expect(hits('\t// ' + offending.trim() + '\n')).toHaveLength(0)
	})
})
