import type { OfficerAcceptProvisioning } from '@votetorrent/vote-core'
import { getDeviceUser, isRecoveryInProgress } from './device-user'

/**
 * getOfficerAcceptProvisioning (66.1-07, D-12): what an officer's Accept sends with the
 * InviteResult so the officer's User and UserKey exist on the network.
 *
 * - `userId` is the stored device user id. It is never randomised here: officer standing is
 *   matched by `o.userId === deviceUser.id` (C6, `useCurrentOfficerScopes`), so a minted id would
 *   make an officer the network does not recognise as this phone.
 * - `signingKey` is the device's CURRENT signing key, `activeKeys[0]` (R-26). It is the same key
 *   `createDeviceSigner` attributes every officer signature to and self-verifies against, so the
 *   key the network learns at accept is the key later admin signatures check against.
 * - The accept itself has no signing prompt; this only reads local storage.
 * - This helper must never call the native key-provisioning method to "read" the key: on Android
 *   that call rotates the hardware key, which would orphan the key already on record.
 *
 * Failures use the coded shape the shared `useDeviceSigningErrorHandler` already routes to the
 * secure signing setup screen. Messages are fixed developer text with no key material.
 */
export async function getOfficerAcceptProvisioning(): Promise<OfficerAcceptProvisioning> {
	// Same fail-closed rule as createDeviceSigner: a half-finished recovery means the hardware key
	// may no longer match the recorded key, so nothing recorded can be trusted yet.
	if (await isRecoveryInProgress()) {
		throw coded('officer-accept-provisioning: a signing-key recovery was started but not completed', 'KEY_INVALIDATED_REASSOCIATE')
	}
	const user = await getDeviceUser()
	if (!user) {
		throw coded('officer-accept-provisioning: no device signing key provisioned', 'NO_KEY_PROVISIONED')
	}
	const current = user.activeKeys?.[0]
	if (!current || typeof current.key !== 'string' || current.key.length === 0) {
		throw coded('officer-accept-provisioning: device user has no active key', 'NO_KEY_PROVISIONED')
	}
	return {
		userId: user.id,
		name: user.name,
		signingKey: { key: current.key, type: current.type, expiration: current.expiration },
	}
}

function coded(message: string, code: string): Error & { code: string } {
	return Object.assign(new Error(message), { code })
}
