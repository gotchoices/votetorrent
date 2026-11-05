/**
 * Phase 46-04 (D-04 / D-05) — read-time reconciliation of the two
 * independently-writable, `'mel'`-signed registration policy tables:
 * `ElectionRegistrationField` (field name x tier x requirement) and
 * `ElectionDisclosurePolicy` (selective field name -> audience).
 *
 * This is read-time DETECTION ONLY. It performs no writes, no signing, and
 * no engine calls — the screen that consumes `PolicyReconciliation` is the
 * one that fires the repair (a normal `'mel'`-signed engine call keyed on
 * the `fieldName` this module emits).
 *
 * THE CRITICAL FRAMING, STATED PLAINLY AND NOT HEDGED: there is NO FK and
 * NO cross-table CHECK between `ElectionDisclosurePolicy.FieldName` and
 * `ElectionRegistrationField`, and none is being added this phase. Both
 * tables validate only `ElectionId` existence, enum membership, and the
 * `'mel'` signature digest (`MutationValid`/`DeleteValid`).
 *
 * THESE STATES ARE REACHABLE. Concrete producers (verbatim from CONTEXT.md
 * D-04): a partial failure of the two non-atomic signed writes, a
 * non-cascading remove, a tier flip (a field moved away from `selective`
 * while its disclosure row survives), and any other writer — the voter
 * app, a second officer's device, direct engine use, P2P replication. This
 * module exists precisely because these two states can genuinely occur in
 * a live database, in production, regardless of UI shape — CONTEXT.md
 * withdrew an earlier, mistaken claim to the contrary after the user
 * challenged it. Only a cross-table schema CHECK would remove the
 * possibility structurally, and Deferred Ideas explicitly defers adding one.
 *
 * CASE-FOLDING RULE AND WHY: field names are compared case-insensitively,
 * mirroring `field-policy.ts`'s `publicFixedByLowerName` convention
 * (`packages/vote-engine/src/registration/field-policy.ts:98-105`), so that
 * a `District`/`district` mismatch is not reported as an inconsistency the
 * officer cannot explain. The emitted `fieldName` on every issue keeps its
 * STORED ORIGINAL CASING (never lower-cased) because it is the PK argument
 * the repair engine call (`removeElectionDisclosurePolicy` /
 * `addElectionDisclosurePolicy`) is keyed on — a folded name would produce
 * a repair call that finds no row.
 */

import type { ElectionDisclosurePolicy, ElectionRegistrationField } from '@votetorrent/vote-core'

/** The `'mel'`-signed engine call a flagged row's repair maps to (D-05). */
export type PolicyRepairAction = 'remove-disclosure' | 'set-audience'

/**
 * Why an `ElectionDisclosurePolicy` row was flagged as orphaned (D-04a).
 * `'field-absent'` — no `ElectionRegistrationField` row with this name
 * exists at all. `'field-not-selective'` — a field with this name DOES
 * exist, but its tier was flipped away from `selective` (public/private);
 * the disclosure row was not cascaded away because nothing cascades — there
 * is no FK.
 */
export type OrphanDisclosureReason = 'field-absent' | 'field-not-selective'

/** An `ElectionDisclosurePolicy` row with no matching `selective`-tier field (D-04a). */
export interface OrphanDisclosureIssue {
  disclosure: ElectionDisclosurePolicy
  /** The disclosure row's stored fieldName, ORIGINAL casing — the PK arg `removeElectionDisclosurePolicy` needs. */
  fieldName: string
  reason: OrphanDisclosureReason
  repair: 'remove-disclosure'
}

/** A `selective`-tier `ElectionRegistrationField` row with no disclosure/audience row (D-04b). */
export interface AudienceLessFieldIssue {
  field: ElectionRegistrationField
  /** The field row's stored fieldName, ORIGINAL casing — the PK arg `addElectionDisclosurePolicy` needs. */
  fieldName: string
  repair: 'set-audience'
}

/** The full D-04 reconciliation result over one election's already-fetched policy pair. */
export interface PolicyReconciliation {
  orphanDisclosures: OrphanDisclosureIssue[]
  audienceLessSelectiveFields: AudienceLessFieldIssue[]
  hasIssues: boolean
}

/**
 * Reconciles the two already-fetched policy lists for one election and
 * returns every D-04 inconsistency, each carrying its D-05 repair
 * descriptor. Pure, synchronous, dependency-free: no engine, no signing, no
 * I/O, no React. Never mutates either input array; a consistent pair
 * (`hasIssues: false`) is the case in which 46-08 renders no Policy Issues
 * card at all.
 */
export function reconcilePolicyState (
  fields: readonly ElectionRegistrationField[],
  disclosures: readonly ElectionDisclosurePolicy[]
): PolicyReconciliation {
  // Lower-cased name Sets, not Maps — a Map would let two declarations
  // differing only in case silently produce a last-write-wins result.
  const allFieldLowerNames = new Set<string>(fields.map((f) => f.fieldName.toLowerCase()))
  const selectiveFieldLowerNames = new Set<string>(
    fields.filter((f) => f.tier === 'selective').map((f) => f.fieldName.toLowerCase())
  )
  const disclosureLowerNames = new Set<string>(disclosures.map((d) => d.fieldName.toLowerCase()))

  const orphanDisclosures: OrphanDisclosureIssue[] = disclosures
    .filter((d) => !selectiveFieldLowerNames.has(d.fieldName.toLowerCase()))
    .map((disclosure) => {
      const lowerName = disclosure.fieldName.toLowerCase()
      const reason: OrphanDisclosureReason = allFieldLowerNames.has(lowerName)
        ? 'field-not-selective'
        : 'field-absent'
      return {
        disclosure,
        fieldName: disclosure.fieldName,
        reason,
        repair: 'remove-disclosure'
      }
    })

  const audienceLessSelectiveFields: AudienceLessFieldIssue[] = fields
    .filter((f) => f.tier === 'selective' && !disclosureLowerNames.has(f.fieldName.toLowerCase()))
    .map((field) => ({
      field,
      fieldName: field.fieldName,
      repair: 'set-audience'
    }))

  return {
    orphanDisclosures,
    audienceLessSelectiveFields,
    hasIssues: orphanDisclosures.length > 0 || audienceLessSelectiveFields.length > 0
  }
}
