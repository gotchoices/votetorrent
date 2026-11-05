/**
 * Behavioral pin for `reconcilePolicyState` (D-04 detection / D-05 repair
 * descriptors). Covers the four D-04 inconsistency cases plus the
 * case-folding and original-casing contracts.
 *
 * These states are genuinely reachable through a partial write failure
 * across the two non-atomic signed calls, a non-cascading remove, a tier
 * flip, or any other writer (the voter app, a second officer's device,
 * direct engine use, P2P replication) — do not read any test below as
 * exercising a state the app prevents; the whole point of this module is
 * that the app does not, and cannot, prevent it at the schema layer.
 *
 * Plain Jest unit test over a pure function: no render harness, no mocking
 * of any kind — the subject needs none of it.
 */

import { reconcilePolicyState } from '../registration-policy-reconciliation'
import type { ElectionDisclosurePolicy, ElectionRegistrationField } from '@votetorrent/vote-core'

const ELECTION_ID = 'election-1'

function field (
  fieldName: string,
  tier: ElectionRegistrationField['tier'],
  requirement: ElectionRegistrationField['requirement'] = 'optional'
): ElectionRegistrationField {
  return { electionId: ELECTION_ID, fieldName, tier, requirement }
}

function disclosure (
  fieldName: string,
  audience: ElectionDisclosurePolicy['audience'] = 'everyone'
): ElectionDisclosurePolicy {
  return { electionId: ELECTION_ID, fieldName, audience }
}

describe('reconcilePolicyState — D-04 detection / D-05 repair descriptors', () => {
  it('flags an orphan disclosure whose field is absent entirely (D-04a)', () => {
    const result = reconcilePolicyState([], [disclosure('ZipCode')])

    expect(result.orphanDisclosures).toHaveLength(1)
    expect(result.orphanDisclosures[0].fieldName).toBe('ZipCode')
    expect(result.orphanDisclosures[0].reason).toBe('field-absent')
    expect(result.orphanDisclosures[0].repair).toBe('remove-disclosure')
    expect(result.hasIssues).toBe(true)
  })

  it('flags an orphan disclosure whose field was tier-flipped away from selective (D-04a)', () => {
    // Concrete producer: an officer flipped a selective field to public in
    // the Fields section and the matching disclosure row was not cascaded
    // away, because nothing cascades — there is no FK.
    const result = reconcilePolicyState(
      [field('ZipCode', 'public')],
      [disclosure('ZipCode')]
    )

    expect(result.orphanDisclosures).toHaveLength(1)
    expect(result.orphanDisclosures[0].reason).toBe('field-not-selective')
  })

  it('flags a selective field with no audience row (D-04b)', () => {
    const result = reconcilePolicyState([field('ZipCode', 'selective')], [])

    expect(result.audienceLessSelectiveFields).toHaveLength(1)
    expect(result.audienceLessSelectiveFields[0].fieldName).toBe('ZipCode')
    expect(result.audienceLessSelectiveFields[0].repair).toBe('set-audience')
    expect(result.orphanDisclosures).toHaveLength(0)
    expect(result.hasIssues).toBe(true)
  })

  it('reports no issues for a consistent policy pair', () => {
    // This is the input for which 46-08 renders no Policy Issues card at all.
    const result = reconcilePolicyState(
      [field('LastName', 'public', 'required'), field('ZipCode', 'selective')],
      [disclosure('ZipCode', 'everyone')]
    )

    expect(result.orphanDisclosures).toHaveLength(0)
    expect(result.audienceLessSelectiveFields).toHaveLength(0)
    expect(result.hasIssues).toBe(false)
  })

  it('matches field names case-insensitively', () => {
    // Same field per field-policy.ts's publicFixedByLowerName convention.
    // A case-sensitive implementation flags this input twice (one orphan
    // AND one audience-less) — assert both lengths are 0 explicitly.
    const result = reconcilePolicyState(
      [field('ZipCode', 'selective')],
      [disclosure('zipcode')]
    )

    expect(result.orphanDisclosures).toHaveLength(0)
    expect(result.audienceLessSelectiveFields).toHaveLength(0)
  })

  it('carries the stored original casing on repair descriptors, not a folded name', () => {
    // fieldName is the PK argument removeElectionDisclosurePolicy(electionId,
    // fieldName, sign) is keyed on, so a folded name would produce a repair
    // call that finds no row.
    const result = reconcilePolicyState(
      [field('MailingAddress', 'public')],
      [disclosure('MAILINGADDRESS')]
    )

    expect(result.orphanDisclosures).toHaveLength(1)
    expect(result.orphanDisclosures[0].fieldName).toBe('MAILINGADDRESS')
    expect(result.orphanDisclosures[0].reason).toBe('field-not-selective')
  })

  it('returns clean, empty results for empty inputs without throwing', () => {
    // The first-load state of a brand-new election.
    const result = reconcilePolicyState([], [])

    expect(result.orphanDisclosures).toHaveLength(0)
    expect(result.audienceLessSelectiveFields).toHaveLength(0)
    expect(result.hasIssues).toBe(false)
  })
})
