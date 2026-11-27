/**
 * device-user.ts — Generate-on-first-run secp256k1 device identity (D-05, Phase 44-02),
 * rewritten for D-42 (Phase 62 plan 08): the identity key stays secp256k1, but at rest it is
 * wrapped under a non-exportable OS-keystore AES key, never plaintext.
 *
 * `DefaultUserEngine` stores only a display name (DefaultUser.name) — it does NOT store
 * secp256k1 keys. This helper fills the gap: on first call it generates a real keypair,
 * builds a `User` with a valid `UserKey`, and persists it under `DEVICE_USER_KEY` in
 * AsyncStorage so the same identity survives app restarts.
 *
 * This is the SAME device identity used both as the registrant's signing key
 * (RegistrationEngine.register()) and as the dev-seed's founding-officer key (44-06)
 * — one identity, two roles, matching the project's local-single-device dev posture.
 * It is NOT the libp2p/CadreNode peer key (`loadOrCreateRNPeerKey`) — that key is
 * never inserted into User/Officer/UserKey and `AdminSigning.UserIdValid` rejects it
 * (44-RESEARCH.md Anti-Patterns; T-44-05).
 *
 * AUTH-01 compliance: keys are hex-encoded via `bytesToHex` from @noble/curves/utils.
 * Do NOT call the native Uint8Array serializer — that produces a comma-separated decimal
 * string, not a valid secp256k1 hex key.
 *
 * D-42 design: the private key is wrapped at rest under alias
 * `VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1` (a non-exportable AndroidKeyStore/Keychain AES-256-GCM
 * key, no user auth), and unwrapped in memory ONLY when signing — see `device-signer.ts`. A
 * newly created device user is never persisted in plaintext: if the wrap fails, creation throws
 * `DeviceIdentityKeyUnavailableError` and nothing is written. An existing plaintext
 * `{ user, privHex }` record (pre-D-42) is accepted READ-ONLY and migrated exactly once, at Voter
 * startup, by `migrateLegacyPlaintextIdentityKey` (wired from `VoterAppProvider.tsx`). Per D-40
 * there is no export or backup path for this key, and a record that cannot be unwrapped (lost
 * wrap key after a backup restore, tag mismatch, AAD/key mismatch) fails closed with
 * `DeviceIdentityKeyUnavailableError` and is never SILENTLY regenerated or overwritten — recovery is
 * D-40 re-association, not key recovery. The only replacement path is the user-confirmed
 * `replaceUnrecoverableDeviceIdentity`, which yields a brand-new identity (a new device in protocol
 * terms: re-association under D-40/D-41 or re-registration under D-43) and never recovers, exports
 * or reuses the old key.
 *
 * Scope: this hardens only the enrollment-identity key. The voting-authorization key
 * (`Association.DeviceKey`) is already a hardware P-256 key (`device-key-wrap.ts`'s header
 * comment / 62-RESEARCH-CONTINUITY.md). Real Keystore/Keychain behaviour is code-complete and
 * UNPROVEN on device — D-23 proof debt, recorded in 62-08-SUMMARY.md.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'
import { SecretWrapError, type WrappedSecret } from '@votetorrent/attestation-native'
import { resolveDeviceKeyWrapProvider, type DeviceKeyWrapProvider } from './device-key-wrap'
import {
	identityNotReplaceableError,
	isIdentityNotReplaceable,
	isReplaceableIdentityError,
	type IdentityNotReplaceableReason,
} from './identity-errors'

/** AsyncStorage key under which the device identity record is persisted. */
export const DEVICE_USER_KEY = 'votingDeviceUser'

/** Ten years in milliseconds — expiration epoch for the generated device key. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** Legacy (pre-D-42), read-only shape — never written again. */
interface LegacyStoredDeviceUser {
	user: User
	privHex: string
}

/** Current (D-42) shape. */
interface WrappedStoredDeviceUser {
	v: 2
	user: User
	wrappedPrivKey: WrappedSecret
}

type ClassifiedRecord =
	| { kind: 'absent' }
	| { kind: 'legacy'; user: User; privHex: string }
	| { kind: 'wrapped'; user: User; wrapped: WrappedSecret }
	| { kind: 'unreadable' }

/** Classify a raw AsyncStorage string into exactly one of: absent, legacy, wrapped, unreadable.
 * `unreadable` covers every malformed shape (parse failure, non-object, both `privHex` AND
 * `wrappedPrivKey` present, or a missing `user.activeKeys[0].key`) — callers decide the specific
 * outcome/reason token for their own context. Never throws. */
function classify(raw: string | null): ClassifiedRecord {
	if (raw === null) return { kind: 'absent' }

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { kind: 'unreadable' }
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { kind: 'unreadable' }
	}

	const fields = parsed as Record<string, unknown>
	const user = fields.user as User | undefined
	const pubKey = user?.activeKeys?.[0]?.key
	if (!user || typeof pubKey !== 'string' || pubKey === '') {
		return { kind: 'unreadable' }
	}

	const hasPrivHex = typeof fields.privHex === 'string'
	const hasWrapped = typeof fields.wrappedPrivKey === 'object' && fields.wrappedPrivKey !== null

	if (hasPrivHex && hasWrapped) return { kind: 'unreadable' } // ambiguous — never pick one
	if (hasPrivHex) return { kind: 'legacy', user, privHex: fields.privHex as string }
	if (hasWrapped && fields.v === 2) {
		return { kind: 'wrapped', user, wrapped: fields.wrappedPrivKey as WrappedSecret }
	}
	return { kind: 'unreadable' }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

/**
 * `TextEncoder` is a global on both Hermes/RN and Node — accessed via a `globalThis` cast, same
 * idiom as `real-attestation-producer.ts`'s `Base64GlobalEnv` (avoids an ambient declaration that
 * would collide with `@types/node` wherever it IS present elsewhere in the monorepo).
 */
type TextEncoderGlobalEnv = { TextEncoder: new () => { encode(input: string): Uint8Array } }
const { TextEncoder: TextEncoderCtor } = globalThis as unknown as TextEncoderGlobalEnv

/** UTF-8 bytes of `votetorrent/voter-identity/v2|${userId}|${pubKeyHex}` — the AAD bound into the
 * GCM tag, so a ciphertext can never be silently transplanted onto a different user/key pair
 * (T-62-08-05). */
export function buildIdentityKeyAad(userId: string, pubKeyHex: string): Uint8Array {
	return new TextEncoderCtor().encode(`votetorrent/voter-identity/v2|${userId}|${pubKeyHex}`)
}

export type DeviceIdentityKeyUnavailableReason =
	| 'no-wrap-key'
	| 'tag-mismatch'
	| 'key-mismatch'
	| 'ambiguous-record'
	| 'wrap-unavailable'
	| 'native-error'

/** D-40: a key that cannot be unwrapped fails closed. Never caught-and-regenerated — recovery is
 * re-association, not key recovery. */
export class DeviceIdentityKeyUnavailableError extends Error {
	readonly reason: DeviceIdentityKeyUnavailableReason

	constructor(reason: DeviceIdentityKeyUnavailableReason) {
		super(`device identity key unavailable (${reason})`)
		this.name = 'DeviceIdentityKeyUnavailableError'
		this.reason = reason
	}
}

export type IdentityKeyMigrationOutcome =
	| 'absent'
	| 'already-wrapped'
	| 'migrated'
	| 'unreadable'
	| 'wrap-unavailable'
	| 'read-back-failed'

export type DeviceIdentityKeyState = 'absent' | 'legacy-plaintext' | 'wrapped' | 'unreadable'

/**
 * Module-level promise-chain lock. Every exported function that reads-then-writes, or unwraps,
 * runs inside it, so `getOrCreateDeviceUser`/`getDevicePrivKeyHex`/`migrateLegacyPlaintextIdentityKey`
 * never interleave against the same AsyncStorage record (T-62-08-03). A rejection inside a locked
 * section does NOT poison the chain for the next caller — `queueTail` only ever resolves.
 *
 * This is a LOCK, not an "already ran" flag (mirrors `purgeLegacyStagedPayload`'s analog):
 * idempotency comes from the stored record's shape, not from module state. Locked sections call
 * only internal unlocked helpers (`classify`, `bytesEqual`, ...) and never another exported
 * locked function, so there is no re-entrant deadlock.
 */
let queueTail: Promise<void> = Promise.resolve()
function withDeviceUserLock<T>(fn: () => Promise<T>): Promise<T> {
	const runPromise = queueTail.then(fn)
	queueTail = runPromise.then(
		() => undefined,
		() => undefined,
	)
	return runPromise
}

/**
 * Return the persisted device `User`, generating a real secp256k1 keypair on first run.
 *
 * Idempotent: subsequent calls return the same `user.id` and `user.activeKeys[0].key`. A newly
 * generated key is wrapped and verified (unwrap-and-compare) BEFORE it is ever written — any wrap
 * or verify failure throws `DeviceIdentityKeyUnavailableError('wrap-unavailable')` with nothing
 * written (D-42). An existing `unreadable` record throws `('ambiguous-record')` and is never
 * overwritten.
 *
 * @param displayName - Display name to embed in the generated User (from DefaultUserEngine.get().name).
 */
export async function getOrCreateDeviceUser(displayName: string): Promise<User> {
	return withDeviceUserLock(async () => {
		const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const classified = classify(raw)

		if (classified.kind === 'legacy' || classified.kind === 'wrapped') {
			return classified.user
		}
		if (classified.kind === 'unreadable') {
			throw new DeviceIdentityKeyUnavailableError('ambiguous-record')
		}

		// absent — generate a real secp256k1 keypair (CSPRNG), wrap, verify, write.
		return createAndStoreWrappedIdentity(displayName)
	})
}

/** Generate a fresh identity, wrap + verify it BEFORE writing, then write it. Caller holds the lock. */
async function createAndStoreWrappedIdentity(displayName: string): Promise<User> {
	const privKey = secp256k1.utils.randomSecretKey()
	const pubKey = secp256k1.getPublicKey(privKey, true) // compressed (33 bytes)

	// AUTH-01: hex-encode via bytesToHex (not the native Uint8Array serializer).
	const pubHex = bytesToHex(pubKey)

	// Hermes (RN 0.78+) exposes crypto.randomUUID() at runtime; cast to satisfy
	// the app's TS config which omits the dom lib declarations.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const userId: string = (globalThis as any).crypto.randomUUID()
	const user: User = {
		id: userId,
		name: displayName,
		activeKeys: [
			{
				key: pubHex,
				type: UserKeyType.mobile,
				expiration: Date.now() + TEN_YEARS_MS,
			},
		],
	}

	const provider = resolveDeviceKeyWrapProvider()
	const aad = buildIdentityKeyAad(userId, pubHex)
	let wrapped: WrappedSecret
	try {
		wrapped = await provider.wrap(privKey, aad)
		// Verify before writing: unwrap the fresh wrap and require byte equality.
		const verifyBytes = await provider.unwrap(wrapped, aad)
		if (!bytesEqual(verifyBytes, privKey)) {
			throw new Error('wrap verify mismatch')
		}
		verifyBytes.fill(0)
	} catch {
		throw new DeviceIdentityKeyUnavailableError('wrap-unavailable')
	}

	const record: WrappedStoredDeviceUser = { v: 2, user, wrappedPrivKey: wrapped }
	await AsyncStorage.setItem(DEVICE_USER_KEY, JSON.stringify(record))
	privKey.fill(0)

	return user
}

/** Unwrap a wrapped record's private key and prove it matches the stored public key. Throws
 * `DeviceIdentityKeyUnavailableError` with the specific reason. Caller holds the lock. */
async function unwrapWrappedRecord(user: User, wrappedSecret: WrappedSecret): Promise<Uint8Array> {
	const pubHex = user.activeKeys[0]!.key
	const provider = resolveDeviceKeyWrapProvider()
	const aad = buildIdentityKeyAad(user.id, pubHex)

	let privBytes: Uint8Array
	try {
		privBytes = await provider.unwrap(wrappedSecret, aad)
	} catch (err) {
		if (err instanceof SecretWrapError) {
			if (err.code === 'NO_WRAP_KEY') throw new DeviceIdentityKeyUnavailableError('no-wrap-key')
			if (err.code === 'UNWRAP_TAG_MISMATCH') throw new DeviceIdentityKeyUnavailableError('tag-mismatch')
		}
		throw new DeviceIdentityKeyUnavailableError('native-error')
	}

	const derivedPub = bytesToHex(secp256k1.getPublicKey(privBytes, true))
	if (derivedPub !== pubHex) {
		privBytes.fill(0)
		throw new DeviceIdentityKeyUnavailableError('key-mismatch')
	}
	return privBytes
}

/**
 * Return the persisted device private key as a hex string, or `undefined` if the device user has
 * not yet been created. Never writes.
 *
 *   - absent -> `undefined`.
 *   - legacy (pre-migration) -> the plaintext hex, fail-open (UI-SPEC Surface 10: an unmigrated
 *     key keeps working until the startup sweep migrates it).
 *   - wrapped -> unwrapped in memory via the resolved `DeviceKeyWrapProvider`, with the AAD
 *     rebuilt from the stored user, then verified against `user.activeKeys[0].key` before being
 *     returned.
 *   - unreadable -> throws `DeviceIdentityKeyUnavailableError('ambiguous-record')`.
 *
 * Used by device-signer.ts to produce real secp256k1 signatures for the registration
 * and association ceremonies.
 */
export async function getDevicePrivKeyHex(): Promise<string | undefined> {
	return withDeviceUserLock(async () => {
		const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const classified = classify(raw)

		if (classified.kind === 'absent') return undefined
		if (classified.kind === 'legacy') return classified.privHex
		if (classified.kind === 'unreadable') {
			throw new DeviceIdentityKeyUnavailableError('ambiguous-record')
		}

		// wrapped
		const privBytes = await unwrapWrappedRecord(classified.user, classified.wrapped)
		const hex = bytesToHex(privBytes)
		privBytes.fill(0)
		return hex
	})
}

/**
 * One-shot, idempotent, NEVER-THROW sweep that migrates a legacy plaintext `{ user, privHex }`
 * record to the D-42 wrapped-at-rest shape. Wired at Voter startup (`VoterAppProvider.tsx`'s
 * empty-dependency mount effect) with zero UI (UI-SPEC Surface 10). Deliberately diverges from
 * the `purgeLegacyStagedPayload` analog: an unparseable/unrecognised `votingDeviceUser` value is
 * NEVER removed — it may be the only copy of the identity key (D-40).
 *
 * Verified before writing (unwrap the fresh wrap, compare bytes) and read back after writing
 * (re-fetch, re-classify as `wrapped`, re-unwrap, re-derive the pubkey) — any failure at any step
 * restores the original raw string (best effort) and returns a closed outcome token. Idempotent:
 * a second run against an already-wrapped record returns `'already-wrapped'` and calls
 * `AsyncStorage.setItem` zero times.
 */
export async function migrateLegacyPlaintextIdentityKey(
	provider: DeviceKeyWrapProvider = resolveDeviceKeyWrapProvider(),
): Promise<IdentityKeyMigrationOutcome> {
	return withDeviceUserLock(async (): Promise<IdentityKeyMigrationOutcome> => {
		try {
			let raw: string | null
			try {
				raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
			} catch {
				return 'unreadable'
			}
			if (raw === null) return 'absent'

			const classified = classify(raw)
			if (classified.kind === 'wrapped') return 'already-wrapped'
			if (classified.kind === 'unreadable') return 'unreadable'
			// classified.kind === 'absent' is unreachable here (raw !== null), but satisfy the
			// exhaustiveness check without a fallthrough write.
			if (classified.kind === 'absent') return 'absent'

			const { user, privHex } = classified
			const expectedPub = user.activeKeys[0]?.key
			if (typeof expectedPub !== 'string' || !/^[0-9a-f]{64}$/i.test(privHex)) {
				return 'unreadable'
			}

			let privBytes: Uint8Array
			let derivedPub: string
			try {
				privBytes = hexToBytes(privHex)
				derivedPub = bytesToHex(secp256k1.getPublicKey(privBytes, true))
			} catch {
				return 'unreadable'
			}
			if (derivedPub !== expectedPub) return 'unreadable'

			const aad = buildIdentityKeyAad(user.id, expectedPub)

			let wrapped: WrappedSecret
			try {
				wrapped = await provider.wrap(privBytes, aad)
			} catch {
				return 'wrap-unavailable'
			}

			// Verify before writing.
			try {
				const verifyBytes = await provider.unwrap(wrapped, aad)
				if (!bytesEqual(verifyBytes, privBytes)) return 'wrap-unavailable'
				verifyBytes.fill(0)
			} catch {
				return 'wrap-unavailable'
			}

			const record: WrappedStoredDeviceUser = { v: 2, user, wrappedPrivKey: wrapped }
			const serialized = JSON.stringify(record)
			try {
				await AsyncStorage.setItem(DEVICE_USER_KEY, serialized)
			} catch {
				await restoreBestEffort(raw)
				return 'read-back-failed'
			}

			// Read back and prove the result.
			try {
				const readBack = await AsyncStorage.getItem(DEVICE_USER_KEY)
				if (readBack === null) throw new Error('read-back-missing')
				if (readBack.includes('privHex') || readBack.includes(privHex)) {
					throw new Error('read-back leaked plaintext')
				}
				const readBackClassified = classify(readBack)
				if (readBackClassified.kind !== 'wrapped') throw new Error('read-back did not classify as wrapped')
				const readBackBytes = await provider.unwrap(readBackClassified.wrapped, aad)
				if (!bytesEqual(readBackBytes, privBytes)) throw new Error('read-back bytes mismatch')
				const readBackPub = bytesToHex(secp256k1.getPublicKey(readBackBytes, true))
				if (readBackPub !== expectedPub) throw new Error('read-back pubkey mismatch')
				readBackBytes.fill(0)
			} catch {
				await restoreBestEffort(raw)
				return 'read-back-failed'
			}

			privBytes.fill(0)
			return 'migrated'
		} catch {
			// This function must NEVER throw — any unexpected failure reports 'unreadable' rather
			// than propagating (the record itself was never touched by anything above this catch
			// that didn't already restore it on failure).
			return 'unreadable'
		}
	})
}

/** Best-effort restore of the original raw string — never throws. */
async function restoreBestEffort(raw: string): Promise<void> {
	try {
		await AsyncStorage.setItem(DEVICE_USER_KEY, raw)
	} catch {
		// Best effort only.
	}
}

// The recognition predicates live in the dependency-free `identity-errors` module (the failure
// classifier imports them without pulling in storage or native crypto); re-exported here so every
// existing `device-user` import keeps working.
export {
	REPLACEABLE_IDENTITY_REASONS,
	isIdentityNotReplaceable,
	isReplaceableIdentityError,
} from './identity-errors'
export type { IdentityNotReplaceableReason } from './identity-errors'

function identityNotReplaceable(message: string, reason: IdentityNotReplaceableReason): Error {
	return identityNotReplaceableError(message, reason)
}

/**
 * User-confirmed replacement of a permanently unrecoverable identity with a brand-new one.
 * Runs in ONE lock body: re-attempts the unwrap, and proceeds ONLY when it fails with a
 * permanent reason (`REPLACEABLE_IDENTITY_REASONS`). Readable records, transient failures and an
 * absent record are refused with `IdentityNotReplaceableError` (typed `reason`), record untouched. On any failure
 * after removal the original raw string is restored byte-identical. No old key byte is ever
 * returned or logged. Never called from a boot path — only from an explicit confirm tap.
 */
export async function replaceUnrecoverableDeviceIdentity(displayName: string): Promise<User> {
	return withDeviceUserLock(async () => {
		const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const classified = classify(raw)
		if (raw === null || classified.kind === 'absent') {
			throw identityNotReplaceable('no identity to replace', 'no-identity')
		}

		if (classified.kind === 'wrapped') {
			try {
				const bytes = await unwrapWrappedRecord(classified.user, classified.wrapped)
				bytes.fill(0)
				throw identityNotReplaceable('identity is readable', 'readable')
			} catch (err) {
				if (!isReplaceableIdentityError(err)) {
					if (isIdentityNotReplaceable(err)) throw err
					throw identityNotReplaceable('identity failure is not permanent', 'not-permanent')
				}
			}
		} else {
			// legacy plaintext is readable; an unreadable record is ambiguous — never replaced.
			throw identityNotReplaceable('identity record is not a permanently locked wrapped record', 'not-wrapped')
		}

		await AsyncStorage.removeItem(DEVICE_USER_KEY)
		try {
			const user = await createAndStoreWrappedIdentity(displayName)
			// Read back and prove the new record is wrapped and unwrappable.
			const readBack = classify(await AsyncStorage.getItem(DEVICE_USER_KEY))
			if (readBack.kind !== 'wrapped') throw new Error('replacement read-back failed')
			const bytes = await unwrapWrappedRecord(readBack.user, readBack.wrapped)
			bytes.fill(0)
			return user
		} catch (err) {
			await restoreBestEffort(raw)
			throw err
		}
	})
}

/**
 * Read-only state probe — never unwraps, never writes, never throws (catches to 'unreadable').
 * Does NOT need `withDeviceUserLock`: it neither reads-then-writes nor unwraps.
 */
export async function getDeviceIdentityKeyState(): Promise<DeviceIdentityKeyState> {
	try {
		const raw = await AsyncStorage.getItem(DEVICE_USER_KEY)
		const classified = classify(raw)
		switch (classified.kind) {
			case 'absent':
				return 'absent'
			case 'legacy':
				return 'legacy-plaintext'
			case 'wrapped':
				return 'wrapped'
			case 'unreadable':
				return 'unreadable'
		}
	} catch {
		return 'unreadable'
	}
}
