// src/key-release/release-window.ts — pure `releasingKeys` window detection
// (62-20: D-20). No DB, no `node:`, no `Buffer`, no `console`.
//
// D-20's release task is created only once the election timeline has
// ENTERED `releasingKeys` (`now >= Timeline.releasingKeys`). This module is
// the discretion choice this plan documents: detection is pull-and-seed —
// `KeyReleaseEngine.seedReleaseKeyTasks` calls `hasEnteredReleasingKeys` at
// the head of `KeysTasksEngine.getKeysToRelease`, which the Authority
// already calls on app open (`useTaskCount`) and on task-inbox focus
// (`TasksScreen`). There is no scheduler, no background timer and no
// cron-shaped job anywhere in this plan.
//
// Why a non-positive `releasingKeys` value means "unset": the schema's
// `network-engine.ts` seeds one election-creation template with
// `releasingKeys: 0`, and `0`/negative are never valid wall-clock epoch-ms
// values for a real deadline. Treating them as "no window configured" (null)
// rather than "already open" is the fail-closed reading — D-20 requires
// seeding to never fire before the window is genuinely set and open.
//
// The boundary is INCLUSIVE: `now === releasingKeysAt` already counts as
// entered (`now >= Timeline.releasingKeys`, not `>`), so a task seeds on the
// exact millisecond the window opens rather than one tick late.
//
// `releasingKeysAt` reads the key through `ElectionEvent.releasingKeys`
// (`@votetorrent/vote-core`), never a bare `'releasingKeys'` string literal
// duplicated here — a rename of the enum member is a single-source-of-truth
// change, not a grep-and-replace across modules.
//
// `releasingKeysAt` accepts an already-PARSED `Timeline` object only — the
// engine is responsible for `JSON.parse`-ing the persisted
// `ElectionRevision.Timeline` column text before calling this function.
// Passing the raw JSON-text string here returns `null` (fails the
// "must be an object" structural check), by design: this module does no
// JSON parsing of its own, keeping it trivially pure and DB-agnostic.

import { ElectionEvent } from '@votetorrent/vote-core'

const ISO_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * Extract `Timeline.releasingKeys` as epoch ms, or `null` when unset/absent/
 * malformed. `timeline` must already be a parsed object (see header). The
 * stored value may be either a positive epoch-ms number, or a strict ISO-Z
 * datetime string (decoded via `Date.parse`) — any other shape (a
 * non-positive number, `NaN`, `Infinity`, a non-ISO-Z string, a JSON-text
 * string in place of an object, or a missing/non-object `timeline`) is
 * `null`. Fail-closed: a `null` result means "never seed, never open the
 * release window".
 */
export function releasingKeysAt (timeline: unknown): number | null {
  if (timeline === null || typeof timeline !== 'object' || Array.isArray(timeline)) return null
  const raw = (timeline as Record<string, unknown>)[ElectionEvent.releasingKeys]

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw
  }

  if (typeof raw === 'string') {
    if (!ISO_Z_PATTERN.test(raw)) return null
    const ms = Date.parse(raw)
    if (!Number.isFinite(ms)) return null
    return ms
  }

  return null
}

/**
 * True iff `timeline`'s `releasingKeys` is set AND `now >= releasingKeysAt`
 * (inclusive boundary). A `null` `releasingKeysAt` is always `false` —
 * fail-closed: an unset window is never "entered".
 */
export function hasEnteredReleasingKeys (timeline: unknown, now: number): boolean {
  const at = releasingKeysAt(timeline)
  if (at === null) return false
  return now >= at
}
