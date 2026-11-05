/**
 * Keyholder invitee names (62-104).
 *
 * REVIEW/IN-06: a keyholder slot binds to its invitee by NAME (the revision's Keyholders JSON holds names
 * only), so names must be unique within one election. The comparison key is trimmed, NFC-normalized and
 * lower-cased, so "Kay", " kay " and a decomposed "Káy" are one name.
 *
 * O-11: a keyholder invitation lives at most 7 days (the Authority app's presets go up to 7 days), plus a
 * small allowance for clock skew between the officer's device and the engine's clock.
 */

/** The comparison key of a keyholder name: trimmed, NFC, case-insensitive. */
export function normalizeKeyholderName (name: string): string {
  return name.trim().normalize('NFC').toLowerCase()
}

/** The first name (as written) whose normalized form repeats an earlier one, or undefined when all are distinct. */
export function findDuplicateKeyholderName (names: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>()
  for (const name of names) {
    const key = normalizeKeyholderName(name)
    if (seen.has(key)) return name
    seen.add(key)
  }
  return undefined
}

/** The longest lifetime of a keyholder invitation: 7 days. */
export const KEYHOLDER_INVITE_MAX_LIFETIME_MS = 7 * 24 * 3600 * 1000

/** Allowed clock skew on top of the lifetime cap: 5 minutes. */
export const KEYHOLDER_INVITE_EXPIRY_SKEW_MS = 5 * 60 * 1000
