/**
 * keys-tasks-tid-namespace.spec.ts (h10 L1 flake, 64-63 part 2)
 *
 * Two keyholders on two devices share ONE replicated database. Their release-key
 * seeding (and task completion) each allocated a Tid from the SAME `TidHighWater`
 * row (`keys-tasks`). On two devices that single primary-key row is written from
 * both replicas: the second device, still on a view that lacks the first device's
 * row, upserts the same key and the commit is refused with
 * "UNIQUE constraint failed: TidHighWater.Namespace". seedReleaseKeyTasks swallows
 * that into `failures`, so the second keyholder silently has no release-key task.
 *
 * This pins the mechanism on one handle: two different keyholders must never write
 * the same TidHighWater row while seeding or completing.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import type { NetworkReference } from '@votetorrent/vote-core'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

const networkRef: NetworkReference = { hash: 'h'.repeat(16), name: 'Test Network', relays: [], primaryAuthorityDomainName: 'authority.example.com' }

async function highWaters (db: Database): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for await (const row of db.eval('select Namespace, HighWater from TidHighWater', {})) out.set(row.Namespace as string, Number(row.HighWater))
  return out
}

/** Namespaces a step created or advanced. */
function touched (before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()].filter(([ns, hw]) => before.get(ns) !== hw).map(([ns]) => ns)
}

describe('keys-tasks Tid allocation is per keyholder (h10 L1 flake)', function () {
  this.timeout(240_000)

  it('two keyholders seeding and completing release-key tasks never write the same TidHighWater row', async () => {
    const seeded = await seedDkgElection({ keyholders: ['Alice', 'Bob'], threshold: 2 })
    await runDkgToQuiescence(seeded.participants, seeded.electionId)
    const db = seeded.auth.ctx.db
    const tl = await db.prepare('select Timeline from ElectionRevision where ElectionId = :e').get({ e: seeded.electionId })
    const at = releasingKeysAt(JSON.parse(tl!.Timeline as string) as Record<string, number>)!
    const [a, b] = seeded.participants as [DkgTestParticipant, DkgTestParticipant]
    const engineFor = (p: DkgTestParticipant): KeysTasksEngine => new KeysTasksEngine(networkRef, { db }, { vault: p.vault, now: () => at + 1 })

    const h0 = await highWaters(db)
    const [taskA] = await engineFor(a).getKeysToRelease(true)
    const h1 = await highWaters(db)
    const [taskB] = await engineFor(b).getKeysToRelease(true)
    const h2 = await highWaters(db)
    expect(taskA?.userId, 'Alice has her task').to.equal(a.userId)
    expect(taskB?.userId, 'Bob has his task').to.equal(b.userId)
    const seedA = touched(h0, h1)
    const seedB = touched(h1, h2)
    expect(seedA.length, 'Alice seeding allocated a Tid').to.be.greaterThan(0)
    expect(seedB.filter((ns) => seedA.includes(ns)), 'seeding: Bob rewrote a TidHighWater row Alice wrote').to.deep.equal([])

    await engineFor(a).completeKeyRelease(taskA!, a.signer)
    const h3 = await highWaters(db)
    await engineFor(b).completeKeyRelease(taskB!, b.signer)
    const h4 = await highWaters(db)
    const doneA = touched(h2, h3)
    const doneB = touched(h3, h4)
    expect(doneA.length, 'Alice completing allocated a Tid').to.be.greaterThan(0)
    expect(doneB.filter((ns) => doneA.includes(ns)), 'completion: Bob rewrote a TidHighWater row Alice wrote').to.deep.equal([])
  })
})
