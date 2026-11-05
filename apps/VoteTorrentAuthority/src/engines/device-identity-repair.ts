/**
 * device-identity-repair.ts — O-06 (app half). Repairs a device whose stored identity id was
 * forked by the pre-62-66 Replace Signing Key (it minted a fresh id instead of keeping the
 * network User's id), losing officer standing.
 *
 * Safety contract:
 *  - adopt an id only when EXACTLY ONE current officer on the open network holds this device's
 *    own active key (only this device can sign with it);
 *  - never while a recovery is in progress, never for a stored user without an active key;
 *  - never when the forked id is a User on another recent network of this device, or when that
 *    cannot be verified (fail safe);
 *  - the pre-repair record is backed up byte-for-byte first and the backup is never overwritten;
 *  - `restoreDeviceIdentityForkBackup()` sets only `user.id` back to the last repair's source id
 *    and writes a pair-specific declined marker, so the next boot does not repair again.
 *
 * Logs: the closed outcome token only. Never an id, a key or an error message.
 */
import type { User } from '@votetorrent/vote-core'
import {
	getForkRepairApplied,
	getForkRepairDeclined,
	getRawDeviceUserRecord,
	isRecoveryInProgress,
	replaceDeviceUserId,
	setForkRepairApplied,
	setForkRepairDeclined,
	writeForkRepairBackupIfAbsent,
	DEVICE_USER_KEY,
} from './device-user'
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface DeviceIdentityInspection {
	localIsNetworkUser: boolean
	officerUserIdsHoldingKey: string[]
}

/** Structural: `inspectDeviceIdentity` is NOT on the vote-core IUserEngine interface. */
export interface InspectableUserEngine {
	inspectDeviceIdentity?: (localUserId: string, pubKey: string) => Promise<DeviceIdentityInspection>
}

export type IdentityRepairOutcome =
	| 'not-forked'
	| 'repaired'
	| 'ambiguous'
	| 'no-match'
	| 'no-local-key'
	| 'declined'
	| 'skipped-legit-elsewhere'
	| 'skipped-unverified-other-network'
	| 'skipped-recovery'
	| 'unsupported'
	| 'abandoned'
	| 'failed'

export type OtherNetworkAnswer = 'yes' | 'no' | 'unknown'

export type DeviceIdentityPlan = 'not-forked' | 'ambiguous' | 'no-match' | `repair:${string}`

export function planDeviceIdentityRepair(inspection: DeviceIdentityInspection, localUserId: string): DeviceIdentityPlan {
	if (inspection.localIsNetworkUser) return 'not-forked'
	const candidates = inspection.officerUserIdsHoldingKey.filter((id) => id !== localUserId)
	if (candidates.length === 0) return 'no-match'
	if (candidates.length > 1) return 'ambiguous'
	return `repair:${candidates[0]}`
}

export interface RepairDeps {
	/** The stored device user as read at boot / select. */
	deviceUser: User
	/** A user engine bound to the OPEN network's context (the context user may be the forked one). */
	getUserEngineForCurrentUser: () => Promise<InspectableUserEngine | undefined>
	/** Is `userId` a User on another recent network of this device? `unknown` fails safe. */
	otherNetworkHasUser: (userId: string) => Promise<OtherNetworkAnswer>
	/**
	 * Asked once, after every read and just before the first write. `false` abandons the repair
	 * with nothing written (outcome `abandoned`): the caller stopped waiting (time budget spent,
	 * boot run superseded), so a late answer must not change the stored identity under a session
	 * that already went on without it. Absent means always persist.
	 */
	shouldPersist?: () => boolean
}

export interface RepairResult {
	outcome: IdentityRepairOutcome
	/** Present only for `repaired`. */
	user?: User
}

function done(outcome: IdentityRepairOutcome, user?: User): RepairResult {
	console.info(`[identity-repair] outcome=${outcome}`)
	return user ? { outcome, user } : { outcome }
}

/** Never throws. */
export async function repairDeviceIdentityForkIfNeeded(deps: RepairDeps): Promise<RepairResult> {
	try {
		if (await isRecoveryInProgress()) return done('skipped-recovery')
		const localId = deps.deviceUser.id
		const pubKey = deps.deviceUser.activeKeys?.[0]?.key
		if (typeof pubKey !== 'string' || pubKey.length === 0) return done('no-local-key')

		const engine = await deps.getUserEngineForCurrentUser()
		if (!engine || typeof engine.inspectDeviceIdentity !== 'function') return done('unsupported')

		const plan = planDeviceIdentityRepair(await engine.inspectDeviceIdentity(localId, pubKey), localId)
		if (plan === 'not-forked') return done('not-forked')
		if (plan === 'ambiguous') return done('ambiguous')
		if (plan === 'no-match') return done('no-match')
		const toUserId = plan.slice('repair:'.length)

		const declined = await getForkRepairDeclined()
		if (declined && declined.fromUserId === localId && declined.toUserId === toUserId) return done('declined')

		const other = await deps.otherNetworkHasUser(localId)
		if (other === 'yes') return done('skipped-legit-elsewhere')
		if (other === 'unknown') return done('skipped-unverified-other-network')

		const raw = await getRawDeviceUserRecord()
		if (raw === null) return done('failed')
		if (deps.shouldPersist && !deps.shouldPersist()) return done('abandoned')
		await writeForkRepairBackupIfAbsent(raw)
		await setForkRepairApplied({ fromUserId: localId, toUserId })
		const user = await replaceDeviceUserId(toUserId)
		return done('repaired', user)
	} catch (err) {
		console.warn(`[identity-repair] outcome=failed name=${err instanceof Error ? err.name : 'unknown'}`)
		return { outcome: 'failed' }
	}
}

/**
 * Roll back a repair that was persisted but could not be bound into the running session (the
 * network re-open or engine rebuild after it failed). Sets only `user.id` back to `fromUserId`,
 * and only while the stored id is still `toUserId`. Writes no declined marker: the failure was in
 * this session's rebind, not a decision against the pair, so the next boot may repair again.
 * Returns `true` when the stored id was set back. Never throws.
 */
export async function rollbackDeviceIdentityRepair(pair: { fromUserId: string; toUserId: string }): Promise<boolean> {
	try {
		const currentRaw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		if (currentRaw === null) return false
		const currentId = (JSON.parse(currentRaw) as { user?: { id?: unknown } }).user?.id
		if (currentId !== pair.toUserId) return false
		await replaceDeviceUserId(pair.fromUserId)
		console.info('[identity-repair] outcome=rolled-back')
		return true
	} catch (err) {
		console.warn(`[identity-repair] rollback=failed name=${err instanceof Error ? err.name : 'unknown'}`)
		return false
	}
}

/**
 * Undo the most recent repair: sets only `user.id` back to that repair's `fromUserId` and writes
 * the declined marker for exactly that pair, so the next boot does not make the same repair again.
 * Returns `false` when there is no applied repair to undo (or the stored record cannot be read),
 * `'restore-refused-id-changed'` (nothing written) when the stored id is no longer the one the
 * repair wrote, `true` on success. Never throws.
 *
 * The undo target is the APPLIED pair, never the backup: the backup is written once and never
 * overwritten, so after a repair R->X and a later X->Y it still holds R, and going back to it
 * would skip X. The byte-exact backup is kept as a forensic record only.
 */
export async function restoreDeviceIdentityForkBackup(): Promise<boolean | 'restore-refused-id-changed'> {
	try {
		const applied = await getForkRepairApplied()
		if (!applied) return false
		const currentRaw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		if (currentRaw === null) return false
		const currentId = (JSON.parse(currentRaw) as { user?: { id?: unknown } }).user?.id
		if (currentId !== applied.toUserId) return 'restore-refused-id-changed'
		await replaceDeviceUserId(applied.fromUserId)
		await setForkRepairDeclined({ fromUserId: applied.fromUserId, toUserId: applied.toUserId })
		return true
	} catch (err) {
		console.warn(`[identity-repair] restore=failed name=${err instanceof Error ? err.name : 'unknown'}`)
		return false
	}
}
