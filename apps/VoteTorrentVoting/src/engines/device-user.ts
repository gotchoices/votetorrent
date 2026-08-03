/**
 * device-user.ts — Generate-on-first-run secp256k1 device identity (D-05, Phase 44-02).
 *
 * `DefaultUserEngine` stores only a display name (DefaultUser.name) — it does NOT store
 * secp256k1 keys. This helper fills the gap: on first call it generates a real keypair,
 * builds a `User` with a valid `UserKey`, and persists `{ user, privHex }` under
 * `DEVICE_USER_KEY` in AsyncStorage so the same identity survives app restarts.
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
 * Security note (T-16-01 parity): the private key is stored in plaintext AsyncStorage.
 * Android Keystore migration is a deferred hardening task, matching the authority app.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'

/** AsyncStorage key under which `{ user: User, privHex: string }` is persisted. */
export const DEVICE_USER_KEY = 'votingDeviceUser'

/** Ten years in milliseconds — expiration epoch for the generated device key. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

interface StoredDeviceUser {
	user: User
	privHex: string
}

/**
 * Return the persisted device `User`, generating a real secp256k1 keypair on first run.
 *
 * Idempotent: subsequent calls return the same `user.id` and `user.activeKeys[0].key`.
 *
 * @param displayName - Display name to embed in the generated User (from DefaultUserEngine.get().name).
 */
export async function getOrCreateDeviceUser(displayName: string): Promise<User> {
	const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
	if (stored !== null) {
		const parsed = JSON.parse(stored) as StoredDeviceUser
		return parsed.user
	}

	// Generate a real secp256k1 keypair (CSPRNG)
	const privKey = secp256k1.utils.randomSecretKey()
	const pubKey = secp256k1.getPublicKey(privKey, true) // compressed (33 bytes)

	// AUTH-01: hex-encode via bytesToHex (not the native Uint8Array serializer)
	const pubHex = bytesToHex(pubKey)
	const privHex = bytesToHex(privKey)

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

	const entry: StoredDeviceUser = { user, privHex }
	await AsyncStorage.setItem(DEVICE_USER_KEY, JSON.stringify(entry))

	return user
}

/**
 * Return the persisted device private key as a hex string, or `undefined` if the device
 * user has not yet been created.
 *
 * Used by device-signer.ts to produce real secp256k1 signatures for the registration
 * and association ceremonies.
 */
export async function getDevicePrivKeyHex(): Promise<string | undefined> {
	const stored = await AsyncStorage.getItem(DEVICE_USER_KEY)
	if (stored === null) return undefined
	const parsed = JSON.parse(stored) as StoredDeviceUser
	return parsed.privHex
}
