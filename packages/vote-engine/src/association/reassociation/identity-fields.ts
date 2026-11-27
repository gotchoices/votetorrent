/**
 * identity-fields.ts — 62-113 Task 1 (initial/G1 WR-01, D-45).
 *
 * A staged re-association request's `identityFields` is attacker-controlled plaintext once the
 * officer opens it: any strand writer can seal anything under a request id. The ranking code
 * calls `.trim()` / `.normalize()` on every element, so one `null` or a numeric `name` used to
 * throw out of the officer's whole pending list. This module is the single decode boundary:
 * it keeps only well-formed `{ name, value }` string pairs and bounds the work an unbounded
 * payload can cause. Pure — no IO, no logging.
 */

import type { AssociationIdentityField } from '@votetorrent/vote-core'

/** At most this many valid fields are kept (the first ones, in staged order). */
export const MAX_IDENTITY_FIELDS = 64
/** A name or value longer than this is dropped (bounds the normalize cost per field). */
export const MAX_IDENTITY_FIELD_TEXT_LENGTH = 1024

/** `undefined` for a non-array; otherwise the first {@link MAX_IDENTITY_FIELDS} elements that are
 * objects with a non-empty string `name` and a non-empty string `value`, each within
 * {@link MAX_IDENTITY_FIELD_TEXT_LENGTH} characters. Never throws on plain data. */
export function sanitizeIdentityFields (raw: unknown): AssociationIdentityField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const kept: AssociationIdentityField[] = []
  for (const element of raw as unknown[]) {
    if (kept.length >= MAX_IDENTITY_FIELDS) break
    if (element === null || typeof element !== 'object') continue
    const { name, value } = element as { name?: unknown; value?: unknown }
    if (typeof name !== 'string' || typeof value !== 'string') continue
    if (name.length === 0 || value.length === 0) continue
    if (name.length > MAX_IDENTITY_FIELD_TEXT_LENGTH || value.length > MAX_IDENTITY_FIELD_TEXT_LENGTH) continue
    kept.push({ name, value })
  }
  return kept
}
