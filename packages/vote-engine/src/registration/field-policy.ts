/**
 * Phase 42-07 (D-09) — Register-time field-policy enforcement, the
 * deliberate no-CHECK-backstop gate. `ElectionRegistrationField` (42-07
 * Task 1) only DECLARES which registrant fields an election expects, in
 * which tier, and whether furnishing them is Required — the schema itself
 * has NO CHECK constraint enforcing this. `validateFieldPolicy` is the
 * SOLE gate: a caller that bypasses the engine (a raw signed `Registrant`
 * insert) can still write a policy-violating row (see
 * `field-policy.spec.ts`'s "no DB CHECK backstop" block) — this is the
 * accepted residual documented in the plan's threat model (T-42-07-01).
 *
 * PURE function over the submission + a db handle — no signing, no writes.
 * `RegistrationEngine.register()` calls this BEFORE opening its
 * BEGIN/COMMIT/ROLLBACK ceremony envelope so a policy violation never
 * strands a partial row.
 */

import { BuilderValidationError } from '@votetorrent/vote-core'
import type { BuilderError, RegisterInit } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'

/** A single field-policy violation found while validating a Register submission. */
export interface FieldPolicyViolation {
  fieldName: string
  tier: string
  reason: 'missing-required' | 'wrong-tier'
}

/**
 * Thrown by `validateFieldPolicy` when a Register submission omits a
 * policy-Required field or furnishes a policy-governed field in a tier
 * other than its declared one. Aligns with `BuilderValidationError`
 * (extends it) so callers that already catch builder validation errors
 * also catch this — but carries a structured `violations` list distinct
 * from the generic `BuilderError[]` shape.
 */
export class FieldPolicyViolationError extends BuilderValidationError {
  readonly violations: readonly FieldPolicyViolation[]

  constructor (violations: FieldPolicyViolation[]) {
    const errors: BuilderError[] = violations.map((v) => ({
      path: `fieldPolicy.${v.fieldName}`,
      code: v.reason === 'missing-required' ? 'MISSING_REQUIRED_FIELD' : 'WRONG_TIER_FIELD',
      message: v.reason === 'missing-required'
        ? `Field "${v.fieldName}" (${v.tier}) is required by election policy but was not furnished`
        : `Field "${v.fieldName}" was furnished in a tier other than its policy-declared tier (${v.tier})`,
      kind: 'cross-field'
    }))
    super(errors)
    this.name = 'FieldPolicyViolationError'
    this.violations = Object.freeze(violations)
  }
}

/** The three `ElectionRegistrationField.Tier` codes a field policy row may declare (D-08). */
type PolicyTier = 'public' | 'selective' | 'private'

function isPolicyTier (value: string): value is PolicyTier {
  return value === 'public' || value === 'selective' || value === 'private'
}

/**
 * D-09: resolve each `ElectionRegistrationField` policy row for `electionId`
 * against the submission's actual field values and REJECT (throw
 * `FieldPolicyViolationError`, all violations accumulated — not fail-fast)
 * when:
 *   - a Required field is absent from its declared tier (missing-required), or
 *   - a policy-governed field (Required OR Optional) is present in a tier
 *     OTHER than its declared tier (wrong-tier).
 * An Optional field that is simply absent is NOT a violation.
 *
 * Tier resolution operates directly over the in-memory `submission`
 * (`RegisterInit`) — `public.extraFields`/`private.details`/
 * `selective.details` are already-parsed JS values at this layer (never
 * JSON-serialized text), so no `parseJsonOr`/`JSON.parse` round-trip is
 * needed here (that helper is for reading already-persisted DB rows, e.g.
 * `getRegistrantPublicField`'s `json_extract` path — not this pre-ceremony
 * submission check).
 */
export async function validateFieldPolicy (
  ctx: EngineContext,
  electionId: string,
  submission: RegisterInit
): Promise<void> {
  const policyRows: Array<{ fieldName: string; tier: string; requirement: string }> = []
  for await (const row of ctx.db.eval(
    'select FieldName, Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId',
    { electionId }
  )) {
    policyRows.push({
      fieldName: String(row.FieldName),
      tier: String(row.Tier),
      requirement: String(row.Requirement)
    })
  }
  if (policyRows.length === 0) return

  // Fixed RegistrantPublic columns are resolved case-insensitively (mirrors
  // getRegistrantPublicField's fixedColumns lookup); ExtraFields/PrivateDetails/
  // SelectiveDetails top-level names are resolved case-sensitively (exact key).
  const publicFixedByLowerName: Record<string, string | undefined> = {
    lastname: submission.public?.lastName,
    firstname: submission.public?.firstName,
    district: submission.public?.district
  }
  const publicExtraKeys = new Set(Object.keys(submission.public?.extraFields ?? {}))
  const privateNames = new Set((submission.private?.details ?? []).map((d) => d.name))
  const selectiveNames = new Set((submission.selective?.details ?? []).map((d) => d.name))

  const isFurnishedInPublic = (fieldName: string): boolean => {
    const fixedValue = publicFixedByLowerName[fieldName.toLowerCase()]
    if (fixedValue !== undefined && fixedValue !== null && fixedValue !== '') return true
    return publicExtraKeys.has(fieldName)
  }
  const isFurnishedInPrivate = (fieldName: string): boolean => privateNames.has(fieldName)
  const isFurnishedInSelective = (fieldName: string): boolean => selectiveNames.has(fieldName)

  const violations: FieldPolicyViolation[] = []

  for (const { fieldName, tier, requirement } of policyRows) {
    if (!isPolicyTier(tier)) {
      throw new Error(`validateFieldPolicy: internal error — unrecognized RegistrantTier code "${tier}" for field "${fieldName}"`)
    }

    let presentTier: PolicyTier | undefined
    if (isFurnishedInPublic(fieldName)) presentTier = 'public'
    else if (isFurnishedInPrivate(fieldName)) presentTier = 'private'
    else if (isFurnishedInSelective(fieldName)) presentTier = 'selective'

    if (presentTier === undefined) {
      if (requirement === 'required') {
        violations.push({ fieldName, tier, reason: 'missing-required' })
      }
      // Optional and absent — not a violation.
      continue
    }

    if (presentTier !== tier) {
      violations.push({ fieldName, tier, reason: 'wrong-tier' })
    }
  }

  if (violations.length > 0) {
    throw new FieldPolicyViolationError(violations)
  }
}
