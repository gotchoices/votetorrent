// mock-registration-duplicate-closure.spec.ts — UAT 62 test 12 (62-56)
//
// The mock must model D-44 duplicate closure so screens can be tested against the
// real list-row path: a closed request keeps Status 'p', carries duplicateClosure on
// the unfiltered list, and is excluded from the pending filter.

import { expect } from 'chai'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'

const A = 'fixture-request-pending-duplicate-a'
const B = 'fixture-request-pending-duplicate-b'

describe('MockRegistrationEngine duplicate closure (62-56)', () => {
  for (const state of ['closed', 'closing'] as const) {
    it(`marks a ${state} row, excludes it from pending, and omits the key elsewhere`, async () => {
      const engine = new MockRegistrationEngine()
      const pendingBefore = await engine.listRegistrationRequests({ status: 'p' })
      engine.markDuplicateClosure(A, state, state === 'closing' ? { closedByRequestId: B } : undefined)

      const all = await engine.listRegistrationRequests()
      const row = all.rows.find((r) => r.requestId === A)!
      expect(row.status).to.equal('p')
      expect(row.duplicateClosure).to.equal(state)
      for (const other of all.rows.filter((r) => r.requestId !== A)) {
        expect('duplicateClosure' in other, other.requestId).to.equal(false)
      }

      const pending = await engine.listRegistrationRequests({ status: 'p' })
      expect(pending.rows.some((r) => r.requestId === A)).to.equal(false)
      expect(pending.rows.some((r) => r.requestId === B)).to.equal(true)
      expect(pending.total).to.equal(pendingBefore.total! - 1)
    })
  }

  it('getDuplicateClosure returns the marked state and undefined otherwise', async () => {
    const engine = new MockRegistrationEngine()
    engine.markDuplicateClosure(A, 'closed')
    const c = await engine.getDuplicateClosure(A)
    expect(c?.state).to.equal('closed')
    expect(c?.requestId).to.equal(A)
    expect(await engine.getDuplicateClosure(B)).to.equal(undefined)
  })

  describe('stats and closure shape parity with the real engine (WR-04, IN-06)', () => {
    async function twoPendingOfOneAuthority (engine: MockRegistrationEngine): Promise<{ authorityId: string }> {
      const pending = await engine.listRegistrationRequests({ status: 'p' })
      const row = pending.rows.find((r) => r.requestId === A)!
      return { authorityId: row.authorityId }
    }

    for (const state of ['closed', 'closing'] as const) {
      it(`K-1: a ${state} row is not pending and is counted as closedAsDuplicate`, async () => {
        const engine = new MockRegistrationEngine()
        const { authorityId } = await twoPendingOfOneAuthority(engine)
        const before = await engine.getRegistrationTransparencyStats(authorityId)
        engine.markDuplicateClosure(A, state, state === 'closing' ? { closedByRequestId: B } : undefined)
        const after = await engine.getRegistrationTransparencyStats(authorityId)
        expect(after.pending).to.equal(before.pending - 1)
        expect(after.closedAsDuplicate).to.equal(1)
      })
    }

    it('K-2: with nothing closed the stats carry no closedAsDuplicate key', async () => {
      const engine = new MockRegistrationEngine()
      const { authorityId } = await twoPendingOfOneAuthority(engine)
      const stats = await engine.getRegistrationTransparencyStats(authorityId)
      expect('closedAsDuplicate' in stats).to.equal(false)
      expect(Object.keys(stats).sort()).to.deep.equal(['approved', 'medianTimeToDecisionMs', 'pending', 'rejected'])
    })

    it('K-3: closed carries the given closer and time; defaults are null closer and an ISO time', async () => {
      const engine = new MockRegistrationEngine()
      engine.markDuplicateClosure(A, 'closed', { closedByRequestId: B, closedAt: '2026-01-01T00:00:00.000Z' })
      expect(await engine.getDuplicateClosure(A)).to.deep.equal({
        requestId: A, state: 'closed', closedByRequestId: B, closedAt: '2026-01-01T00:00:00.000Z'
      })
      engine.markDuplicateClosure(B, 'closed')
      const c = await engine.getDuplicateClosure(B)
      expect(c?.closedByRequestId).to.equal(null)
      expect(c?.closedAt).to.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    })

    it('K-3: closing without a closer throws and never carries closedAt', () => {
      const engine = new MockRegistrationEngine()
      expect(() => engine.markDuplicateClosure(A, 'closing')).to.throw()
    })

    it('K-3: closing with a closer has no closedAt', async () => {
      const engine = new MockRegistrationEngine()
      engine.markDuplicateClosure(A, 'closing', { closedByRequestId: B, closedAt: '2026-01-01T00:00:00.000Z' })
      const c = await engine.getDuplicateClosure(A)
      expect(c).to.deep.equal({ requestId: A, state: 'closing', closedByRequestId: B })
    })
  })
})
