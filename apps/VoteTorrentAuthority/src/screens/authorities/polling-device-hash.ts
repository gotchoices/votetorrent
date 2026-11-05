/**
 * polling-device-hash.ts — Phase 47 plan 47-17 (D-08/D-13). Pure, dependency-free
 * helpers deciding, in exactly one place, what string may become a
 * `PollingDevice.DeviceHash`.
 *
 * (a) WHAT `PollingDevice` IS. A row on this table is the in-person device
 * whitelist: a matching `(AuthorityId, DeviceHash)` row WAIVES device-uniqueness
 * for the `associate()` ceremony (Phase 42 D-06) — see
 * `packages/vote-engine/src/association/association-engine.ts:287-300`, an
 * exact-match `where AuthorityId = :authorityId and DeviceHash = :deviceHash`
 * that skips the "device already associated with a different registrant"
 * rejection when a row is found. This whitelist is an authorization asset, not
 * a label store.
 *
 * (b) WHAT `DeviceHash` IS. `sha256Hex(deviceId)` =
 * `bytesToHex(sha256(utf8ToBytes(deviceId)))` — see
 * `association-engine.ts:42-44`. `@noble/hashes`' `bytesToHex` emits
 * LOWERCASE hex, always exactly 64 characters. There is no other valid shape.
 *
 * (c) WHY THIS MATTERS. The waiver lookup above is an EXACT STRING MATCH. An
 * uppercase, whitespace-padded, or truncated value inserts a `PollingDevice`
 * row that renders correctly in the UI (the read has no format constraint —
 * `DeviceHash text`, no CHECK on shape) and matches NOTHING at the ceremony.
 * The whitelist looks populated and grants nothing, with no error anywhere.
 * This is why normalization and validation live here, in a pure module with
 * its own truth-table test, instead of inline in the screen where a later
 * edit could silently weaken the gate without a dedicated test noticing.
 */

/**
 * Lowercase hex, anchored both ends, exact 64-character quantifier. Validate
 * only the NORMALIZED value against this pattern — never the raw one.
 */
export const DEVICE_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * `raw.trim().toLowerCase()`. Nothing else, ever.
 *
 * PROHIBITED WIDENINGS — an executor "improving" ergonomics here silently
 * converts a real gate into a decoration. Do not add any of the following:
 *   - `toLocaleLowerCase()` — host-locale dependent under Hermes, which would
 *     make the gate non-deterministic across devices. `toLowerCase()` only.
 *   - Internal-whitespace stripping. A hash with an interior space is a paste
 *     error, and rejecting it is the safe direction — the operator re-pastes.
 *   - `0x` prefix acceptance or stripping. The stored column is bare hex;
 *     accepting a prefixed form would either store a value that never
 *     matches or silently mutate operator input.
 */
export function normalizeDeviceHash(raw: string): string {
	return raw.trim().toLowerCase()
}

/**
 * `DEVICE_HASH_PATTERN.test(normalizeDeviceHash(raw))`. Validates the
 * NORMALIZED value, never the raw one, so `A1B2…` (uppercase) is accepted
 * here and then stored lowercase by the caller.
 *
 * PROHIBITED WIDENINGS, same spirit as `normalizeDeviceHash` above:
 *   - No length-only check, no `startsWith`/prefix match, no "at least N
 *     characters" shortcut. A partial hash is not a device.
 *   - No uppercase character class in `DEVICE_HASH_PATTERN` itself — case
 *     tolerance belongs in `normalizeDeviceHash` so that exactly one function
 *     decides what is stored.
 */
export function isValidDeviceHash(raw: string): boolean {
	return DEVICE_HASH_PATTERN.test(normalizeDeviceHash(raw))
}

/**
 * `hash.length <= 12 ? hash : hash.slice(0, 12) + "..."`.
 *
 * DELIBERATE DIVERGENCE from `HistoryEvent.tsx:109`'s `slice(0, 5) + "..."`
 * convention: there, the truncated key is a decoration beside a resolved
 * user name. Here the truncation IS the row's only identifier when no label
 * is set, AND it is interpolated into `pollingDeviceRemoveBody`'s
 * `{{label}}` — i.e. into a delete confirmation. `2f3ea... will no longer be
 * able to operate as an in-person polling device` is not a confirmable
 * sentence. 12 hex characters is 48 bits of discriminator across a
 * per-authority list, and the full hash is always rendered in the row's
 * `additionalInfo`, so nothing is hidden. Do not "fix" this back to 5.
 */
export function truncateDeviceHash(hash: string): string {
	return hash.length <= 12 ? hash : hash.slice(0, 12) + '...'
}

/**
 * Structurally typed (not a `PollingDevice` import) so this module stays
 * dependency-free. Returns the trimmed, non-empty `label`, else the
 * truncated `deviceHash`. A whitespace-only label falls through to the hash
 * rather than rendering as a blank title.
 */
export function formatDeviceTitle(device: { deviceHash: string; label?: string }): string {
	const trimmedLabel = device.label?.trim() ?? ''
	return trimmedLabel !== '' ? trimmedLabel : truncateDeviceHash(device.deviceHash)
}
