/**
 * officer-swap.js -- which officer a browser holds for a network, and what a
 * new pairing code for that network means (D-09).
 *
 *   | Situation                                            | kind            |
 *   |-------------------------------------------------------|-----------------|
 *   | no registry entry for the network                      | new-network     |
 *   | legacy entry from before pairing, any officer          | legacy-replace  |
 *   | paired entry, same officer                             | same-officer    |
 *   | paired entry, a different officer                      | officer-swap    |
 *
 * `classifyPairing` takes the statement's CLAIMED user id. The caller
 * (`peer/pairing.js`) verifies that claim against the held local copy BEFORE
 * anything is deleted, so every destructive branch acts on a verified id:
 * swapping officers compares verified ids, never a code's unsigned label.
 * `classifyPairing` reads nothing itself; it asks the registry functions it
 * is handed.
 *
 * This module imports nothing. `DashboardShell.tsx` imports it statically,
 * and a peer import here would pull the node stack into the entry chunk.
 */

/** The four pairing-era kinds, in table order. */
export const PAIRING_KINDS = Object.freeze(
	/** @type {const} */ (['new-network', 'same-officer', 'officer-swap', 'legacy-replace']),
);

/**
 * @typedef {object} PairingRegistryPort
 * @property {(networkHash: string) => unknown} findNetwork
 * @property {(entry: unknown) => boolean} isLegacyEntry
 */

/**
 * Classify a pairing code against this browser's registry (D-09). Pure and
 * synchronous. Throws `TypeError` with fixed text naming the argument, never
 * its value.
 *
 * @param {{ networkHash: string, claimedUserId: string, registry: PairingRegistryPort }} options
 * @returns {(typeof PAIRING_KINDS)[number]}
 */
export function classifyPairing(options) {
	const { networkHash, claimedUserId, registry } = options ?? /** @type {any} */ ({});
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('classifyPairing: networkHash must be a non-empty string');
	}
	if (typeof claimedUserId !== 'string' || claimedUserId.length === 0) {
		throw new TypeError('classifyPairing: claimedUserId must be a non-empty string');
	}
	if (
		registry === null ||
		typeof registry !== 'object' ||
		typeof registry.findNetwork !== 'function' ||
		typeof registry.isLegacyEntry !== 'function'
	) {
		throw new TypeError('classifyPairing: registry must provide findNetwork and isLegacyEntry');
	}
	const entry = registry.findNetwork(networkHash);
	if (entry === undefined || entry === null) return 'new-network';
	if (registry.isLegacyEntry(entry)) return 'legacy-replace';
	if (/** @type {{ officerUserId?: unknown }} */ (entry).officerUserId === claimedUserId) return 'same-officer';
	return 'officer-swap';
}
