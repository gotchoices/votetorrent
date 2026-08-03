/**
 * skipped-test-ledger.spec.ts
 *
 * D-07 machine-checkable residue ledger (UNSK-01 SC4).
 *
 * Statically counts live `it.skip(` occurrences across the four sweep spec files
 * and asserts the total equals DOCUMENTED_RESIDUE.
 *
 * DOCUMENTED_RESIDUE = 0 means all 15 skipped tests are scoped for un-skip in
 * this phase (plans 34-02..04). The ledger test is EXPECTED to be RED until those
 * plans land — the constant encodes the phase-end target, not the current count.
 * Gates green at phase end (plan 34-05).
 *
 * Fails CI if a skip is added or removed without updating this constant.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

const SPEC_FILES = [
  'authority.spec.ts',
  'elections.spec.ts',
  'tasks-builders.spec.ts',
  'ballot-confirm.spec.ts',
]

/**
 * Phase-end target: all 15 skipped tests are un-skipped by plans 34-02..04.
 * Do NOT change this to a non-zero value to make the test pass prematurely —
 * the RED state is intentional and gates green at phase end (34-05).
 */
const DOCUMENTED_RESIDUE = 0

describe('skipped-test residue ledger (UNSK-01 SC4 / D-07)', () => {
  it('live it.skip() count == DOCUMENTED_RESIDUE', () => {
    let count = 0
    for (const file of SPEC_FILES) {
      const src = readFileSync(join(testDir, file), 'utf8')
      count += (src.match(/^\s*it\.skip\(/gm) ?? []).length
    }
    expect(
      count,
      `${count} it.skip() calls found, DOCUMENTED_RESIDUE is ${DOCUMENTED_RESIDUE}`
    ).to.equal(DOCUMENTED_RESIDUE)
  })
})
