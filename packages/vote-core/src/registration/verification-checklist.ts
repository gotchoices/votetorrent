import type { RegistrationVerificationChecklistItem } from './models.js'

/**
 * verification-checklist.ts — pure D-07/D-09 canonicalization, serialization,
 * digest helper and accept-gate predicate over 48-05's
 * `RegistrationVerificationChecklistItem` vocabulary (`id` | `roll` |
 * `eligibility` | `none`). No React/RN/engine imports — importable from the
 * vote-engine Mocha suite, same shape as `common/district-range.ts`.
 *
 * Vocabulary ownership: `RegistrationVerificationChecklistItem` is declared
 * exactly once, in `./models.js` (48-05). This module imports it (type-only)
 * rather than re-declaring it — two declarations would let the digest this
 * module produces and the gate it evaluates drift apart from what the UI
 * actually renders.
 *
 * Id -> 48-UI-SPEC.md copy-key correspondence (fixed at exactly four ids,
 * recorded here so 48-15 cannot invent a fifth item or rename one):
 *   'id'          -> verificationChecklistItemId
 *   'roll'        -> verificationChecklistItemRoll
 *   'eligibility' -> verificationChecklistItemEligibility
 *   'none'        -> verificationChecklistItemNone
 * No i18n key string appears anywhere in this module's exported values —
 * vote-core has no i18n-key precedent, and the id -> key mapping itself
 * lives in 48-15's component.
 *
 * D-09 negative space: this module ships no rating, score, rank, percentage
 * or weight field of any kind. The checklist is a closed set of text codes.
 */

/** A checklist as a readonly array of D-07 vocabulary ids, in any order. */
export type VerificationChecklist = readonly RegistrationVerificationChecklistItem[]

/** Version tag folded into the canonical serialized form (`{"v":1,...}`). */
export const VERIFICATION_CHECKLIST_VERSION = 1

/**
 * Canonical, load-bearing item order. `serializeVerificationChecklist` and
 * `canonicalizeVerificationChecklist` always emit items in this sequence
 * regardless of input order — this is what makes the serialized bytes (and
 * therefore the digest) order-independent. Matches 48-UI-SPEC.md's own
 * top-to-bottom row order, with `none` last.
 */
export const VERIFICATION_CHECKLIST_ITEM_ORDER = ['id', 'roll', 'eligibility', 'none'] as const

/** The three substantive (non-`none`) items — a valid gate-passing state may contain any non-empty subset of these. */
export const VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS = ['id', 'roll', 'eligibility'] as const

/** The sentinel "I verified nothing" item — mutually exclusive with every substantive item. */
export const VERIFICATION_CHECKLIST_NONE_ITEM = 'none' as const

/** Type guard over `VERIFICATION_CHECKLIST_ITEM_ORDER` — the sole definition of "is a valid checklist id". */
export function isVerificationChecklistItem (value: unknown): value is RegistrationVerificationChecklistItem {
  return typeof value === 'string' && (VERIFICATION_CHECKLIST_ITEM_ORDER as readonly string[]).includes(value)
}

/**
 * Deduplicates `items`, validates every value against
 * `isVerificationChecklistItem`, and emits the result in
 * `VERIFICATION_CHECKLIST_ITEM_ORDER` sequence regardless of input order.
 * Throws a plain `Error` (message prefixed `verificationChecklist: `, naming
 * the offending value) on any unrecognised id — do not add a new error class
 * to vote-core for this. Returns a mutable array so callers can assign
 * directly to `RegistrationRequestDecision.checklist` /
 * `RegistrationRequestRead.verificationChecklist` without a cast.
 */
export function canonicalizeVerificationChecklist (items: readonly string[]): RegistrationVerificationChecklistItem[] {
  const unique = new Set<string>()
  for (const item of items) {
    if (!isVerificationChecklistItem(item)) {
      throw new Error(`verificationChecklist: unrecognised item "${String(item)}"`)
    }
    unique.add(item)
  }
  return VERIFICATION_CHECKLIST_ITEM_ORDER.filter((id) => unique.has(id))
}

/**
 * Serializes `items` to the exact, structurally-fixed byte layout
 * `{"v":1,"checked":["id","roll"]}` — literal key `v` first (carrying
 * `VERIFICATION_CHECKLIST_VERSION`), then literal key `checked` (carrying the
 * canonical id array as JSON), no whitespace, no trailing newline. An empty
 * checklist serializes to `{"v":1,"checked":[]}` (legal; it simply does not
 * satisfy `isChecklistGateMet`). The prefix is concatenated with
 * `JSON.stringify` applied only to the id array, so key order can never
 * silently shift under a future refactor — these bytes are the D-07
 * tamper-evidence anchor, a contract rather than an implementation detail.
 */
export function serializeVerificationChecklist (items: readonly string[]): string {
  const canonical = canonicalizeVerificationChecklist(items)
  return `{"v":${VERIFICATION_CHECKLIST_VERSION},"checked":${JSON.stringify(canonical)}}`
}

/**
 * The round-trip half of `serializeVerificationChecklist`, used to re-render
 * a decided request's checklist read-only and to re-derive its digest for
 * verification. Throws an `Error` prefixed `verificationChecklist: ` on:
 * malformed JSON; a missing or non-matching `v`; a missing or non-array
 * `checked`; any element failing `isVerificationChecklistItem`. Returns the
 * canonicalized array, so parse and canonicalize agree by construction.
 */
export function parseVerificationChecklist (serialized: string): RegistrationVerificationChecklistItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error(`verificationChecklist: malformed JSON "${serialized}"`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('verificationChecklist: expected a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.v !== VERIFICATION_CHECKLIST_VERSION) {
    throw new Error(`verificationChecklist: unsupported version ${JSON.stringify(obj.v)}`)
  }
  if (!Array.isArray(obj.checked)) {
    throw new Error('verificationChecklist: missing or non-array "checked"')
  }
  return canonicalizeVerificationChecklist(obj.checked as unknown[] as string[])
}

/**
 * Computes the content-addressed `VerificationCid` for `items` by serializing
 * to the canonical bytes and awaiting the caller-supplied `digest`.
 *
 * The digest is a deliberate, injected parameter rather than a hash computed
 * in this module — a documented refinement of the outline's
 * `verificationCid(checklist)` shorthand. Every content-addressed value in
 * this codebase is produced by the SAME primitive the schema's own
 * `Digest()`/`cid()` uses (see `computeRegistrantPrivateCid` /
 * `computeRegistrantSelectiveCid` in `registration-engine.ts`, and
 * `digest-vectors.ts`'s standing rule: "NO independent createHash
 * reimplementation — the expected values come from the same code path that
 * the schema constraints use at runtime"). A JS-side sha256 here would
 * produce a `VerificationCid` that silently disagrees with what the schema
 * re-derives. Injection keeps this module both pure AND byte-compatible.
 * 48-11/48-12 supply `digest` by wrapping the engine's existing
 * `select cid(Digest(:canonical)) as c` call shape.
 */
export async function verificationCid (
  items: readonly string[],
  digest: (canonical: string) => Promise<string>
): Promise<string> {
  const canonical = serializeVerificationChecklist(items)
  return await digest(canonical)
}

/**
 * The UI-SPEC accept-gate predicate, encoded exactly, as a single pure
 * function — the same "one exported predicate drives the gate, tested
 * independently of the component" discipline `LifecycleConfirmCard`'s
 * `matchesConfirmationName` already establishes.
 *
 * This is a UI legibility/convenience control, NOT a security boundary —
 * nothing in the schema enforces it, and a caller that ignores it entirely
 * is not thereby prevented from writing. This function makes no claim that
 * the `'vrg'` scope gate is enforced anywhere.
 *
 * Rules:
 *   - Unrecognised values are ignored (fails closed rather than throwing —
 *     this predicate runs on the approval screen's render path, so it must
 *     not call `canonicalizeVerificationChecklist`, whose throw-on-unknown
 *     behaviour is wrong for this call site).
 *   - `false` when nothing recognised is checked — zero checked is the ONLY
 *     blocking state arising from item count.
 *   - `false` when `none` is checked together with any substantive item —
 *     "I verified nothing" and "I verified X" cannot both be true. (48-15's
 *     toggle handler also enforces this; the predicate enforcing it too is
 *     deliberate defence in depth, not redundancy.)
 *   - `true` for any non-empty subset of the substantive items, including a
 *     single one — partial substantive completion is a valid, complete state
 *     and must never block (different registrants are legitimately verified
 *     through different subsets of methods per `doc/registration.md:9`).
 *   - `true` for `none` alone.
 */
export function isChecklistGateMet (items: readonly RegistrationVerificationChecklistItem[]): boolean {
  const recognised = items.filter((item) => isVerificationChecklistItem(item))
  if (recognised.length === 0) return false
  const hasNone = recognised.includes(VERIFICATION_CHECKLIST_NONE_ITEM)
  const hasSubstantive = recognised.some((item) =>
    (VERIFICATION_CHECKLIST_SUBSTANTIVE_ITEMS as readonly string[]).includes(item)
  )
  if (hasNone && hasSubstantive) return false
  return true
}
