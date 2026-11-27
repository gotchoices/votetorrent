/**
 * keys-tasks-seed-failure-visible.spec.ts (h10 L1 flake follow-up, 64-63 part 2; notes 19 E35)
 *
 * getKeysToRelease seeds release-key tasks at the head of every read. A seed failure (e.g. the
 * keys-tasks TidHighWater refusal fixed in 274774c1) went into `result.failures` and was dropped,
 * so a keyholder silently had no task and the only symptom was an empty list. A failure must be
 * logged with the keyholder, the election and the error, while the read itself still returns.
 */

import { expect } from 'chai'
import type { NetworkReference } from '@votetorrent/vote-core'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { seedDkgElection } from './fixtures/dkg-keyholders.js'

const networkRef: NetworkReference = { hash: 'h'.repeat(16), name: 'Test Network', relays: [], primaryAuthorityDomainName: 'authority.example.com' }

describe('keys-tasks seed failures are visible (h10 L1 follow-up)', function () {
  this.timeout(240_000)

  it('getKeysToRelease logs each seedReleaseKeyTasks failure instead of dropping it', async () => {
    const seeded = await seedDkgElection({ keyholders: ['Alice'], threshold: 1 })
    const [alice] = seeded.participants
    const engine = new KeysTasksEngine(networkRef, { db: seeded.auth.ctx.db }, { vault: alice!.vault })

    const originalSeed = KeyReleaseEngine.prototype.seedReleaseKeyTasks
    const originalWarn = console.warn
    const captured: string[] = []
    KeyReleaseEngine.prototype.seedReleaseKeyTasks = async () => ({
      seeded: [],
      alreadySeeded: 0,
      failures: [{ userId: alice!.userId, electionId: seeded.electionId, detail: 'UNIQUE constraint failed: TidHighWater.Namespace' }]
    })
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
    let tasks: unknown[]
    try {
      tasks = await engine.getKeysToRelease(true)
    } finally {
      KeyReleaseEngine.prototype.seedReleaseKeyTasks = originalSeed
      console.warn = originalWarn
    }

    expect(tasks, 'the read still returns').to.be.an('array')
    const line = captured.find((l) => l.includes('UNIQUE constraint failed: TidHighWater.Namespace'))
    expect(line, `a warning names the seed failure (captured: ${JSON.stringify(captured)})`).to.be.a('string')
    expect(line).to.include(alice!.userId)
    expect(line).to.include(seeded.electionId)
  })
})
