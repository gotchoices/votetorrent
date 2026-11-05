/**
 * write-mode.ts — 62-18 Task 2.
 *
 * D-41's compound write (revoke the registrant's old device key(s) with or before inserting the
 * new one) can be shipped two ways. Both always verify the new device's attestation BEFORE any
 * delete (research ruling 2, A5) — the two modes differ only in whether the delete(s) and the
 * insert share one Quereus transaction or run as two separately-committed ceremonies:
 *
 *   - 'single-transaction': the old-key delete(s) and the new Association/AssociationPrivate
 *     insert share ONE `BEGIN`/`COMMIT` — the ideal shape (no observable half-done state), IF
 *     Quereus's deferred-CHECK evaluation (which re-derives a subquery-bearing CHECK against the
 *     transaction's FINAL row state at commit, not per-statement — the same batched-deferred-CHECK
 *     class 62-01's Probe 2 found for `SingleActiveAssociation`) does not mis-evaluate some OTHER
 *     CHECK (e.g. `AssociationCidMatch`/`AssociationPrivate.ChallengeValid`) when a sibling
 *     DELETE on the same table lands inside the same transaction as those inserts.
 *   - 'delete-then-insert': each old key is removed through its OWN committed `removeAssociation`
 *     ceremony FIRST, then the unchanged insert transaction runs. A crash between the two leaves a
 *     real but recoverable half-done state (old device gone, new device not yet associated) rather
 *     than an atomicity violation — the re-read-before-deciding discipline `associate()`'s existing
 *     D-11 challenge-consumption comment already documents for this codebase's established
 *     "two honest, sequential steps, not one atomic unit" pattern.
 *
 * `REASSOCIATION_WRITE_MODE` below is NOT a guess — it is the verdict `association-removal.spec.ts`'s
 * own probe records from actually exercising BOTH modes against the real schema (constructing an
 * `AssociationEngine` with `{ reassociationWriteMode: 'single-transaction' }` explicitly). See that
 * spec's `SINGLE_TRANSACTION_VERDICT` constant and the 62-18-SUMMARY.md "D-41 tier and write mode"
 * section for the recorded raw outcome.
 */

export type ReassociationWriteMode = 'single-transaction' | 'delete-then-insert'

/**
 * The shipped default write mode — PASS -> 'single-transaction', FAIL -> 'delete-then-insert'.
 * `AssociationEngine`'s third constructor argument can override this per-instance (the probe's own
 * mechanism for exercising both modes in the same spec run); every other caller gets this default.
 */
export const REASSOCIATION_WRITE_MODE: ReassociationWriteMode = 'single-transaction'
