import type { PrivateDetail } from '@votetorrent/vote-core'

/**
 * The ONE producer of `RegistrantAccessEvent.Fields` in
 * `packages/vote-engine/src` (D-01/D-02): both `RegistrationEngine` and
 * `MockRegistrationEngine` import this module, and nothing else may assemble
 * that payload — a second, unfiltered assembly path would make the
 * names-only guarantee a convention again, not a structural one.
 * `RegistrantAccessEvent` records app-mediated access only, for
 * accountability, deterrence, and regulatory posture; it is not a security control.
 * A caller-supplied entry that fails the intersection below is
 * dropped SILENTLY and on purpose: a rejected entry is, by construction, the
 * exact class of string that might be a private VALUE (SSN/DOB/phone), so
 * naming it in a log line, an Error message, or any diagnostic string would
 * be the precise leak this module is built to avoid — strictly worse than
 * the silent drop, since it would leave the value in a crash payload.
 */

const MAX_DEPTH = 8

/**
 * Every attribute NAME reachable in `details`, recursing into any element
 * whose `value` is itself an array of `PrivateDetail`-shaped objects (groups
 * nest, per `PrivateDetail.value`'s union type). Defensive about shape
 * rather than throwing: `details` is a JSON column parsed with
 * `parseJsonOr`, so a malformed row must degrade to "no names allowed"
 * (which records nothing) instead of taking down the caller. A depth cap
 * guards against a cyclic/pathological structure.
 *
 * THE VOCABULARY CONTRACT (D-14). Names are **qualified**: a nested leaf is
 * collected as its full dotted path from the root (`'address.street'`), NOT
 * as its bare segment (`'street'`). This module is the single authority for
 * that vocabulary, and it deliberately matches what the reveal UI emits —
 * `flattenPrivateDetails` in the Authority app builds exactly the same dotted
 * path (`namePrefix + '.' + detail.name`) and `PrivateFieldRow.onReveal`
 * hands that string straight to `recordRegistrantAccessEvent`. Collecting the
 * bare segment instead makes `sanitizeAccessTrailFields`' intersection empty
 * for every nested reveal, and because a failed intersection is dropped
 * silently (by design, see the header), the audit row simply never appears.
 *
 * A group node contributes its own qualified name too (`'address'`), so a
 * caller that reveals a whole group rather than a leaf still records. The
 * bare child segment is intentionally NOT collected: it is ambiguous the
 * moment two groups carry a leaf of the same name, and no producer emits it.
 *
 * `registrant-access-trail.spec.ts` locks this seam end-to-end by feeding the
 * flattener's own output through `sanitizeAccessTrailFields`.
 */
export function collectPrivateFieldNames (details: PrivateDetail[] | undefined, depth = 0, prefix = ''): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(details) || depth >= MAX_DEPTH) return names
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || name.length === 0) continue
    const qualified = prefix.length > 0 ? prefix + '.' + name : name
    names.add(qualified)
    const value = (entry as { value?: unknown }).value
    if (Array.isArray(value)) {
      for (const nested of collectPrivateFieldNames(value as PrivateDetail[], depth + 1, qualified)) {
        names.add(nested)
      }
    }
  }
  return names
}

/**
 * The intersection of `requested` and `allowed`, de-duplicated, sorted
 * ascending with a plain relational comparison — never a locale-aware
 * string-collation comparator, which would make the mock and the real
 * engine disagree on stored ordering.
 */
export function sanitizeAccessTrailFields (requested: readonly string[] | undefined, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(requested) || requested.length === 0 || allowed.size === 0) return []
  const kept = new Set<string>()
  for (const name of requested) {
    if (allowed.has(name)) kept.add(name)
  }
  return [...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
