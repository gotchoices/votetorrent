/**
 * O-06 app half: planDeviceIdentityRepair / repairDeviceIdentityForkIfNeeded /
 * restoreDeviceIdentityForkBackup / rollbackDeviceIdentityRepair (F1-F6). Real AsyncStorage jest mock; fake inspection engines.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
	DEVICE_USER_KEY,
	DEVICE_USER_FORK_BACKUP_KEY,
	DEVICE_USER_FORK_DECLINED_KEY,
	DEVICE_RECOVERY_IN_PROGRESS_KEY,
} from '../device-user'
import {
	planDeviceIdentityRepair,
	repairDeviceIdentityForkIfNeeded,
	restoreDeviceIdentityForkBackup,
	rollbackDeviceIdentityRepair,
} from '../device-identity-repair'

const R = 'forked-id-r'
const X = 'network-id-x'
const KEY = 'aa'.repeat(33)
const USER = { id: R, name: 'Una', activeKeys: [{ key: KEY, type: 'P', expiration: 1234 }] }
const STORED = JSON.stringify({ user: USER })

function engine(result: { localIsNetworkUser: boolean; officerUserIdsHoldingKey: string[] }) {
	const inspectDeviceIdentity = jest.fn(async () => result)
	return { inspectDeviceIdentity, get: async () => ({ inspectDeviceIdentity }) }
}

function run(
	e: { inspectDeviceIdentity?: unknown } | undefined,
	other: 'yes' | 'no' | 'unknown' = 'no',
	deviceUser: typeof USER = USER,
) {
	return repairDeviceIdentityForkIfNeeded({
		deviceUser: deviceUser as never,
		getUserEngineForCurrentUser: async () => e as never,
		otherNetworkHasUser: async () => other,
	})
}

beforeEach(async () => {
	await AsyncStorage.clear()
	await AsyncStorage.setItem(DEVICE_USER_KEY, STORED)
	jest.spyOn(console, 'info').mockImplementation(() => {})
	jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('planDeviceIdentityRepair (F1)', () => {
	it('classifies', () => {
		expect(planDeviceIdentityRepair({ localIsNetworkUser: true, officerUserIdsHoldingKey: [X] }, R)).toBe('not-forked')
		expect(planDeviceIdentityRepair({ localIsNetworkUser: false, officerUserIdsHoldingKey: [X] }, R)).toBe(`repair:${X}`)
		expect(planDeviceIdentityRepair({ localIsNetworkUser: false, officerUserIdsHoldingKey: [X, 'y'] }, R)).toBe('ambiguous')
		expect(planDeviceIdentityRepair({ localIsNetworkUser: false, officerUserIdsHoldingKey: [] }, R)).toBe('no-match')
		expect(planDeviceIdentityRepair({ localIsNetworkUser: false, officerUserIdsHoldingKey: [R] }, R)).toBe('no-match')
	})
})

describe('repairDeviceIdentityForkIfNeeded (F2/F3)', () => {
	const forked = { localIsNetworkUser: false, officerUserIdsHoldingKey: [X] }

	it('F2: rewrites only user.id, backs up byte-for-byte, returns the repaired user', async () => {
		const e = engine(forked)
		const res = await run(e)
		expect(res.outcome).toBe('repaired')
		expect(res.user).toEqual({ ...USER, id: X })
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!)).toEqual({ user: { ...USER, id: X } })
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBe(STORED)
		expect(e.inspectDeviceIdentity).toHaveBeenCalledWith(R, KEY)
	})

	it('F3: an existing backup is never overwritten', async () => {
		await AsyncStorage.setItem(DEVICE_USER_FORK_BACKUP_KEY, 'EARLIER-BACKUP')
		await run(engine(forked))
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBe('EARLIER-BACKUP')
	})

	it('F3: recovery in progress, missing method, throwing inspection, ambiguous, no-match, empty keys change nothing', async () => {
		await AsyncStorage.setItem(DEVICE_RECOVERY_IN_PROGRESS_KEY, '{}')
		const e1 = engine(forked)
		expect((await run(e1)).outcome).toBe('skipped-recovery')
		expect(e1.inspectDeviceIdentity).not.toHaveBeenCalled()
		await AsyncStorage.removeItem(DEVICE_RECOVERY_IN_PROGRESS_KEY)

		expect((await run({})).outcome).toBe('unsupported')
		const throwing = { inspectDeviceIdentity: async () => { throw new Error('secret-id') } }
		expect((await run(throwing)).outcome).toBe('failed')
		expect((await run(engine({ localIsNetworkUser: false, officerUserIdsHoldingKey: [X, 'y'] }))).outcome).toBe('ambiguous')
		expect((await run(engine({ localIsNetworkUser: false, officerUserIdsHoldingKey: [] }))).outcome).toBe('no-match')
		expect((await run(engine({ localIsNetworkUser: true, officerUserIdsHoldingKey: [X] }))).outcome).toBe('not-forked')
		const e2 = engine(forked)
		expect((await run(e2, 'no', { ...USER, activeKeys: [] })).outcome).toBe('no-local-key')
		expect(e2.inspectDeviceIdentity).not.toHaveBeenCalled()

		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(STORED)
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBeNull()
		const logs = [...(console.warn as jest.Mock).mock.calls, ...(console.info as jest.Mock).mock.calls].flat().join(' ')
		expect(logs).not.toContain('secret-id')
	})

	it('F3c: shouldPersist false after the reads abandons the repair with nothing written (REVIEW WR-R4-04)', async () => {
		const shouldPersist = jest.fn(() => false)
		const e = engine(forked)
		const res = await repairDeviceIdentityForkIfNeeded({
			deviceUser: USER as never,
			getUserEngineForCurrentUser: async () => e as never,
			otherNetworkHasUser: async () => 'no',
			shouldPersist,
		})
		expect(res).toEqual({ outcome: 'abandoned' })
		expect(e.inspectDeviceIdentity).toHaveBeenCalledTimes(1)
		expect(shouldPersist).toHaveBeenCalledTimes(1)
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(STORED)
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBeNull()
		// asked only when a write is next: a not-forked device never asks
		const notForked = jest.fn(() => true)
		await repairDeviceIdentityForkIfNeeded({
			deviceUser: USER as never,
			getUserEngineForCurrentUser: async () => engine({ localIsNetworkUser: true, officerUserIdsHoldingKey: [] }) as never,
			otherNetworkHasUser: async () => 'no',
			shouldPersist: notForked,
		})
		expect(notForked).not.toHaveBeenCalled()
	})

	it('F3b: other networks', async () => {
		expect((await run(engine(forked), 'yes')).outcome).toBe('skipped-legit-elsewhere')
		expect((await run(engine(forked), 'unknown')).outcome).toBe('skipped-unverified-other-network')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(STORED)
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBeNull()
		expect((await run(engine(forked), 'no')).outcome).toBe('repaired')
	})
})

describe('restoreDeviceIdentityForkBackup (F4/F4b)', () => {
	const forked = { localIsNetworkUser: false, officerUserIdsHoldingKey: [X] }

	it('no backup: no-op false', async () => {
		expect(await restoreDeviceIdentityForkBackup()).toBe(false)
	})

	it('F4: restores only the id, keeps other fields, writes the declined marker, keeps the backup', async () => {
		await run(engine(forked))
		// a key replaced after the repair must be kept
		const cur = JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!)
		cur.user.activeKeys = [{ key: 'bb'.repeat(33), type: 'P', expiration: 99 }]
		await AsyncStorage.setItem(DEVICE_USER_KEY, JSON.stringify(cur))

		expect(await restoreDeviceIdentityForkBackup()).toBe(true)
		const after = JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!)
		expect(after.user.id).toBe(R)
		expect(after.user.activeKeys[0].key).toBe('bb'.repeat(33))
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_FORK_DECLINED_KEY))!)).toEqual({ fromUserId: R, toUserId: X })
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBe(STORED)
	})

	it('F4: refuses when the current id is no longer X', async () => {
		await run(engine(forked))
		const cur = JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!)
		cur.user.id = 'someone-else'
		const raw = JSON.stringify(cur)
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		expect(await restoreDeviceIdentityForkBackup()).toBe('restore-refused-id-changed')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_DECLINED_KEY)).toBeNull()
	})

	it('F4c: after R->X then X->Y, restore goes back ONE step to X and declines exactly X->Y (REVIEW WR-R4-02)', async () => {
		await run(engine(forked))
		const Y = 'network-id-y'
		const second = await run(engine({ localIsNetworkUser: false, officerUserIdsHoldingKey: [Y] }), 'no', { ...USER, id: X })
		expect(second.outcome).toBe('repaired')
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!).user.id).toBe(Y)

		expect(await restoreDeviceIdentityForkBackup()).toBe(true)
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!).user.id).toBe(X)
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_FORK_DECLINED_KEY))!)).toEqual({ fromUserId: X, toUserId: Y })
		// the forensic backup still holds the very first record
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBe(STORED)
		// and the declined marker suppresses the X->Y repair it was written for
		const again = await run(engine({ localIsNetworkUser: false, officerUserIdsHoldingKey: [Y] }), 'no', { ...USER, id: X })
		expect(again.outcome).toBe('declined')
		expect(JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!).user.id).toBe(X)
	})

	it('F4d: a corrupt stored record returns false and writes nothing, never throws', async () => {
		await run(engine(forked))
		await AsyncStorage.setItem(DEVICE_USER_KEY, '{not json')
		await expect(restoreDeviceIdentityForkBackup()).resolves.toBe(false)
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe('{not json')
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_DECLINED_KEY)).toBeNull()
	})

	it('F4b: the next repair with the same candidate is declined and writes nothing; a different candidate is still considered', async () => {
		await run(engine(forked))
		await restoreDeviceIdentityForkBackup()
		const before = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const res = await run(engine(forked))
		expect(res.outcome).toBe('declined')
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(before)
		const res2 = await run(engine({ localIsNetworkUser: false, officerUserIdsHoldingKey: ['x-prime'] }))
		expect(res2.outcome).toBe('repaired')
		expect(res2.user?.id).toBe('x-prime')
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_BACKUP_KEY)).toBe(STORED)
	})
})

describe('rollbackDeviceIdentityRepair (F6, REVIEW WR-R4-03)', () => {
	const forked = { localIsNetworkUser: false, officerUserIdsHoldingKey: [X] }

	it('sets only the id back while the stored id is still the repaired one, writes no declined marker', async () => {
		await run(engine(forked))
		expect(await rollbackDeviceIdentityRepair({ fromUserId: R, toUserId: X })).toBe(true)
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(STORED)
		expect(await AsyncStorage.getItem(DEVICE_USER_FORK_DECLINED_KEY)).toBeNull()
		// the next boot may repair again
		expect((await run(engine(forked))).outcome).toBe('repaired')
	})

	it('refuses (writes nothing) when the stored id is no longer the repaired one, and never throws', async () => {
		await run(engine(forked))
		const cur = JSON.parse((await AsyncStorage.getItem(DEVICE_USER_KEY))!)
		cur.user.id = 'someone-else'
		const raw = JSON.stringify(cur)
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
		expect(await rollbackDeviceIdentityRepair({ fromUserId: R, toUserId: X })).toBe(false)
		expect(await AsyncStorage.getItem(DEVICE_USER_KEY)).toBe(raw)
		await AsyncStorage.setItem(DEVICE_USER_KEY, '{not json')
		await expect(rollbackDeviceIdentityRepair({ fromUserId: R, toUserId: X })).resolves.toBe(false)
	})
})
