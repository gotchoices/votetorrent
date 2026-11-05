/**
 * keyholder-accept-tid-namespace.spec.ts (h7 accept, 64-63 part 2; notes 19 E35)
 *
 * Same shape as the h10 L1 flake (keys-tasks-tid-namespace.spec.ts): two keyholders
 * on two devices share ONE replicated database, and each keyholder accept allocated
 * its Tid from the SAME `TidHighWater` row (`user`). In 64-63's h7 the two accepts
 * land ~0.2 s apart, and the second device can still be on a view without the first
 * device's row. Its commit is then refused (UNIQUE on a fresh row, or a concurrent
 * modification on an existing one), and the accept fails.
 *
 * This pins the mechanism on one handle: two different keyholders' accepts must never
 * write the same TidHighWater row.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { inviteAndAcceptKeyholder, seedDkgElection } from './fixtures/dkg-keyholders.js'

async function highWaters (db: Database): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for await (const row of db.eval('select Namespace, HighWater from TidHighWater', {})) out.set(row.Namespace as string, Number(row.HighWater))
  return out
}

/** Namespaces a step created or advanced. */
function touched (before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()].filter(([ns, hw]) => before.get(ns) !== hw).map(([ns]) => ns)
}

describe('keyholder accept Tid allocation is per keyholder (h7 accept)', function () {
  this.timeout(240_000)

  it('two keyholders accepting their invitations never write the same TidHighWater row', async () => {
    // Both slots are invited first, so each accept below is the accept alone (no officer-side invite write).
    const seeded = await seedDkgElection({ keyholders: [], threshold: 2, pendingInvites: ['Alice', 'Bob'] })
    const db = seeded.auth.ctx.db

    const h0 = await highWaters(db)
    const alice = await inviteAndAcceptKeyholder(seeded.auth, seeded.electionEngine, seeded.electionId, 'Alice')
    const h1 = await highWaters(db)
    const bob = await inviteAndAcceptKeyholder(seeded.auth, seeded.electionEngine, seeded.electionId, 'Bob')
    const h2 = await highWaters(db)

    expect(alice.userId, 'two distinct keyholders').to.not.equal(bob.userId)
    const acceptA = touched(h0, h1)
    const acceptB = touched(h1, h2)
    expect(acceptA.length, 'Alice accepting allocated a Tid').to.be.greaterThan(0)
    expect(acceptB.length, 'Bob accepting allocated a Tid').to.be.greaterThan(0)
    expect(acceptB.filter((ns) => acceptA.includes(ns)), 'accept: Bob rewrote a TidHighWater row Alice wrote').to.deep.equal([])
  })
})
