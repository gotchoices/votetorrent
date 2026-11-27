/**
 * threshold-policies-valid.spec.ts — schema regression spec for
 * `Admin.ThresholdPoliciesValid` / `ProposedAdmin.ThresholdPoliciesValid`.
 *
 * Background: both tables carried `-- TODO: constraint ThresholdPoliciesValid`
 * for the whole project's life, so nothing validated the JSON. That silence is
 * what hid a real defect — `ProposedAdministrationScreen`'s `SCOPE_ORDER` fed
 * the `proposeAdmin` payload as well as the rendered rows, so the app wrote
 * `policy: 'rnp'` (a code that has never existed in `view Scope`) into Admin
 * rows, and `'ik'` thresholds were unsettable. See the 2026-08-25 scope
 * reconcile.
 *
 * Each entry must be `{ policy: <a view Scope code>, threshold: <integer >= 1> }`.
 * `policy` names the scope being GOVERNED (how many officer signatures an action
 * at that scope requires) — it is not a scope that governs.
 *
 * Every negative case asserts the constraint NAME, not merely that something
 * threw: a bare `expect(...).to.be.rejected` would score a typo'd datetime or an
 * FK failure as a pass. Paired with positive controls proving valid input is
 * accepted, so the gate cannot pass by rejecting everything.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize.js'

const NO_CTX =
  'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1'

/** The schema's nine `view Scope` codes (votetorrent.qsql:56-69). */
const SCOPE_CODES = ['rn', 'rad', 'vrg', 'iad', 'uai', 'ceb', 'mel', 'cap', 'ik']

describe('Admin.ThresholdPoliciesValid (schema CHECK)', () => {
  let authorityId: string
  let day = 0

  // 62-03 (D-48): formulation A admits only the FIRST Admin of a single-Authority
  // network unsigned. Every case below therefore inserts the FIRST (and ONLY) Admin of
  // a BRAND-NEW founding-shaped database — never a second Admin on a shared, already-
  // founded one (the pre-62-03 shape, which the D-48 hole alone admitted).
  const insertAdmin = async (thresholdPolicies: string): Promise<void> => {
    day += 1
    const db = new Database()
    await prepareDb(db)
    authorityId = `authority-${day}`
    await db.exec(
      `insert into Authority (Id, Name, DomainName, ImageRef) ${NO_CTX}
       values (:id, 'Test Authority', 'test.example.com', null)`,
      { id: authorityId }
    )
    const effectiveAt = `2027-03-${String(day).padStart(2, '0')}T00:00:00.000Z`
    await db.exec(
      `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX}
       values (:authorityId, :effectiveAt, :thresholdPolicies)`,
      { authorityId, effectiveAt, thresholdPolicies }
    )
  }

  /** Assert the insert is rejected BY THIS CONSTRAINT, not by anything else. */
  const expectRejectedByConstraint = async (thresholdPolicies: string, label: string): Promise<void> => {
    let message: string | undefined
    try {
      await insertAdmin(thresholdPolicies)
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message, `${label}: expected a rejection, but the insert was ACCEPTED`).to.be.a('string')
    expect(
      message,
      `${label}: rejected, but not by ThresholdPoliciesValid — got: ${message}`
    ).to.contain('ThresholdPoliciesValid')
  }

  beforeEach(() => {
    day = 0
  })

  // ---- positive controls: the gate must not pass by rejecting everything ----

  it('accepts the schema default (empty array)', async () => {
    await insertAdmin('[]')
  })

  it('accepts a well-formed policy set', async () => {
    await insertAdmin(JSON.stringify([
      { policy: 'rn', threshold: 1 },
      { policy: 'ik', threshold: 2 }
    ]))
  })

  it('accepts every one of the nine view Scope codes', async () => {
    await insertAdmin(JSON.stringify(SCOPE_CODES.map(policy => ({ policy, threshold: 1 }))))
  })

  // ---- negative cases, each asserting the constraint name ----

  it("rejects the phantom 'rnp' code (never in view Scope)", async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rnp', threshold: 1 }]), "phantom 'rnp'"
    )
  })

  it('rejects a non-integer threshold', async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rn', threshold: 'two' }]), 'string threshold'
    )
  })

  it('rejects a zero threshold', async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rn', threshold: 0 }]), 'zero threshold'
    )
  })

  it('rejects a negative threshold', async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rn', threshold: -3 }]), 'negative threshold'
    )
  })

  it('rejects a missing threshold', async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rn' }]), 'missing threshold'
    )
  })

  it("rejects the wrong field name ({ scope } instead of { policy })", async () => {
    // Load-bearing: json_extract('$.policy') yields NULL here, and
    // `NULL not in (select Code from Scope)` is NULL rather than true — so
    // without the constraint's explicit `is null` guard this silently passes.
    await expectRejectedByConstraint(
      JSON.stringify([{ scope: 'rn', threshold: 1 }]), 'misnamed policy field'
    )
  })

  it('rejects a bare string element', async () => {
    await expectRejectedByConstraint(JSON.stringify(['rn']), 'bare string element')
  })

  it('rejects a JSON object instead of an array', async () => {
    await expectRejectedByConstraint(
      JSON.stringify({ policy: 'rn', threshold: 1 }), 'object not array'
    )
  })

  it('rejects a set where only ONE entry is bad', async () => {
    await expectRejectedByConstraint(
      JSON.stringify([{ policy: 'rn', threshold: 1 }, { policy: 'rnp', threshold: 1 }]),
      'one good one bad'
    )
  })
})
