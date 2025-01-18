import { expect } from 'aegir/chai'
import { Log } from '../src/log/index.js'
import { TestLogStore } from './test-log-store.js'
import type { TrxRev } from '../src/index.js'
import { randomUUID } from 'crypto'

// Helper function to generate deterministic UUIDs for testing
function generateTrxId(num: number): `${string}-${string}-${string}-${string}-${string}` {
  // For testing, we'll use a fixed UUID and just change the last characters
  // This makes tests more deterministic while still using valid UUIDs
  return `00000000-0000-4000-a000-${num.toString().padStart(12, '0')}` as const
}

describe('Log', () => {
  let store: TestLogStore

  beforeEach(() => {
    store = new TestLogStore()
  })

  it('should create and open a log', async () => {
    const log = await Log.create<string>(store)
    expect(log.id).to.be.a('string')

    const openedLog = Log.open<string>(store, log.id)
    expect(openedLog.id).to.equal(log.id)
  })

  it('should add and retrieve actions', async () => {
    const log = await Log.create<string>(store)
    const actions = ['action1', 'action2']
    const trxId = randomUUID() as `${string}-${string}-${string}-${string}-${string}`
    const rev = 1

    const result = await log.addActions(actions, trxId, rev)
    expect(result.entry.action?.actions).to.deep.equal(actions)
    expect(result.entry.action?.trxId).to.equal(trxId)
    expect(result.entry.rev).to.equal(rev)

    // Test retrieval
    const retrieved = await log.getFrom(0)
    expect(retrieved.entries[0].actions).to.deep.equal(actions)
    expect(retrieved.entries[0].trxId).to.equal(trxId)
  })

  it('should handle checkpoints', async () => {
    const log = await Log.create<string>(store)
    const pendings: TrxRev[] = [
      { trxId: generateTrxId(1), rev: 1 },
      { trxId: generateTrxId(2), rev: 2 }
    ]

    const result = await log.addCheckpoint(pendings, 2)
    expect(result.entry.checkpoint?.pendings).to.deep.equal(pendings)
    expect(result.entry.rev).to.equal(2)

    const context = await log.getTrxContext()
    expect(context?.committed).to.deep.equal(pendings)
    expect(context?.rev).to.equal(2)
  })

  it('should handle mixed actions and checkpoints', async () => {
    const log = await Log.create<string>(store)

    // Add initial actions
    await log.addActions(['action1'], generateTrxId(1), 1)
    await log.addActions(['action2'], generateTrxId(2), 2)

    // Add checkpoint
    const pendings: TrxRev[] = [
      { trxId: generateTrxId(1), rev: 1 },
      { trxId: generateTrxId(2), rev: 2 }
    ]
    await log.addCheckpoint(pendings, 2)

    // Add more actions
    await log.addActions(['action3'], generateTrxId(3), 3)

    // Test retrieval from different revisions
    const fromStart = await log.getFrom(0)
    expect(fromStart.entries.length).to.equal(3)
    expect(fromStart.context?.committed.length).to.equal(3)

    const fromMiddle = await log.getFrom(1)
    expect(fromMiddle.entries.length).to.equal(2)
    expect(fromMiddle.context?.committed.length).to.equal(3)
  })

  it('should handle reverse iteration', async () => {
    const log = await Log.create<string>(store)

    await log.addActions(['action1'], generateTrxId(1), 1)
    await log.addActions(['action2'], generateTrxId(2), 2)
    await log.addActions(['action3'], generateTrxId(3), 3)

    const entries: string[] = []
    for await (const entry of log.select(undefined, true)) {
      if (entry.action) {
        entries.push(...entry.action.actions)
      }
    }

    expect(entries).to.deep.equal(['action3', 'action2', 'action1'])
  })

  it('should maintain block hashes correctly', async () => {
    const log = await Log.create<string>(store)

    const result1 = await log.addActions(['action1'], generateTrxId(1), 1)
    const result2 = await log.addActions(['action2'], generateTrxId(2), 2)

    // Get the blocks directly from store to check hashes
    const block1 = await store.tryGet(result1.tailPath.block.header.id)
    const block2 = await store.tryGet(result2.tailPath.block.header.id)

    expect(block2?.nextHash).to.be.a('string')
    expect(block1?.nextHash).to.be.undefined // Last block should not have nextHash
  })

  it('should handle empty log operations', async () => {
    const log = await Log.create<string>(store)

    const context = await log.getTrxContext()
    expect(context?.committed).to.deep.equal([])
    expect(context?.rev).to.equal(0)

    const entries = await log.getFrom(0)
    expect(entries.entries).to.deep.equal([])
    expect(entries.context?.committed).to.deep.equal([])
  })

  it('should handle large number of sequential actions', async () => {
    const log = await Log.create<string>(store)
    const actionCount = 100

    // Add actions
    for (let i = 0; i < actionCount; i++) {
      await log.addActions([`action${i}`], generateTrxId(i), i + 1)
    }

    // Verify retrieval
    const retrieved = await log.getFrom(0)
    expect(retrieved.entries.length).to.equal(actionCount)
    expect(retrieved.context?.committed.length).to.equal(actionCount)

    // Verify last action
    const lastAction = retrieved.entries[actionCount - 1]
    expect(lastAction.actions[0]).to.equal(`action${actionCount - 1}`)
  })

  it('should handle multiple checkpoints', async () => {
    const log = await Log.create<string>(store)

    // Add actions and checkpoints alternately
    await log.addActions(['action1'], generateTrxId(1), 1)
    await log.addCheckpoint([{ trxId: generateTrxId(1), rev: 1 }], 1)

    await log.addActions(['action2'], generateTrxId(2), 2)
    await log.addCheckpoint([
      { trxId: generateTrxId(1), rev: 1 },
      { trxId: generateTrxId(2), rev: 2 }
    ], 2)

    // Verify that we get the most recent checkpoint
    const context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(2)
    expect(context?.rev).to.equal(2)
  })

  it('should handle retrieval from middle revisions', async () => {
    const log = await Log.create<string>(store)

    // Add several actions
    for (let i = 1; i <= 5; i++) {
      await log.addActions([`action${i}`], generateTrxId(i), i)
    }

    // Retrieve from different points
    const fromRev2 = await log.getFrom(2)
    expect(fromRev2.entries.length).to.equal(3) // Should get actions 3,4,5
    expect(fromRev2.entries[0].actions[0]).to.equal('action3')

    const fromRev4 = await log.getFrom(4)
    expect(fromRev4.entries.length).to.equal(1) // Should only get action5
    expect(fromRev4.entries[0].actions[0]).to.equal('action5')
  })
})
