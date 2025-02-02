import { expect } from 'aegir/chai'
import { Log } from '../src/log/index.js'
import type { LogBlock } from '../src/log/index.js'
import { TestLogStore } from './test-log-store.js'
import type { TrxId, TrxRev } from '../src/index.js'
import { randomBytes } from '@libp2p/crypto'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

// Helper function to generate deterministic UUIDs for testing
function generateTrxId(num: number): `${string}-${string}-${string}-${string}-${string}` {
  // For testing, we'll use a fixed UUID and just change the last characters
  // This makes tests more deterministic while still using valid UUIDs
  return `00000000-0000-4000-a000-${num.toString().padStart(12, '0')}` as const
}

// Helper function to generate random UUIDs
function generateRandomTrxId(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = randomBytes(16)
  // Set version (4) and variant (2) bits as per UUID v4 spec
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  // Convert to hex and format as UUID
  const hex = uint8ArrayToString(bytes, 'hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as const
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
    const trxId = generateRandomTrxId()
    const rev = 1

    const result = await log.addActions(actions, trxId, rev)
    expect(result.entry.action?.actions).to.deep.equal(actions)
    expect(result.entry.action?.trxId).to.equal(trxId)
    expect(result.entry.rev).to.equal(rev)

    // Test retrieval
    const retrieved = await log.getFrom(0)
    expect(retrieved.entries[0]?.actions).to.deep.equal(actions)
    expect(retrieved.entries[0]?.trxId).to.equal(trxId)
    expect(retrieved.context?.rev).to.equal(rev)
    // Verify implicit commit behavior
    expect(retrieved.context?.committed.length).to.equal(1)
    expect(retrieved.context?.committed[0]?.trxId).to.equal(trxId)
    expect(retrieved.context?.committed[0]?.rev).to.equal(rev)
  })

  it('should handle checkpoints', async () => {
    const log = await Log.create<string>(store)

    // Add some actions first
    const trx1Id = generateTrxId(1)
    const trx2Id = generateTrxId(2)
    const trx3Id = generateTrxId(3)

    await log.addActions(['action1'], trx1Id, 1)
    await log.addActions(['action2'], trx2Id, 2)
    await log.addActions(['action3'], trx3Id, 3)

    // Verify implicit commits
    let context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(3)

    // Add checkpoint that excludes the last action
    const pendings: TrxRev[] = [
      { trxId: trx1Id, rev: 1 },
      { trxId: trx2Id, rev: 2 }
    ]

    const result = await log.addCheckpoint(pendings, 4)
    expect(result.entry.checkpoint?.pendings).to.deep.equal(pendings)
    expect(result.entry.rev).to.equal(4)

    // Verify checkpoint properly reset committed set
    context = await log.getTrxContext()
    expect(context?.committed).to.deep.equal(pendings)
    expect(context?.rev).to.equal(4)
  })

  it('should handle mixed actions and checkpoints', async () => {
    const log = await Log.create<string>(store)

    // Add initial actions
    const trx1 = generateTrxId(1)
    await log.addActions(['action1'], trx1, 1)
    const trx2 = generateTrxId(2)
    await log.addActions(['action2'], trx2, 2)

    // Verify implicit commits
    let context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(2)
    expect(context?.rev).to.equal(2)

    // Add checkpoint that only includes first action
    const pendings: TrxRev[] = [
      { trxId: trx1, rev: 1 }
    ]
    await log.addCheckpoint(pendings, 3)

    // Add more actions
    const trx3 = generateTrxId(3)
    await log.addActions(['action3'], trx3, 4)

    // Test retrieval and verify commit state
    const fromStart = await log.getFrom(0)
    expect(fromStart.entries.length).to.equal(3)
    // Should include checkpoint's action plus new action
    expect(fromStart.context?.committed.length).to.equal(2)
    expect(fromStart.context?.committed[0]).to.deep.equal({ trxId: trx1, rev: 1 })
    expect(fromStart.context?.committed[1]).to.deep.equal({ trxId: trx3, rev: 4 })

    const fromMiddle = await log.getFrom(2)	// (exclusive of 2)
    expect(fromMiddle.entries.length).to.equal(1)
    expect(fromMiddle.context?.committed.length).to.equal(2)
  })

  it('should handle reverse iteration', async () => {
    const log = await Log.create<string>(store)

    await log.addActions(['action1'], generateTrxId(1), 1)
    await log.addActions(['action2'], generateTrxId(2), 2)
    await log.addActions(['action3'], generateTrxId(3), 3)

    const entries: string[] = []
    for await (const entry of log.select(undefined, false)) {
      if (entry.action) {
        entries.push(...entry.action.actions)
      }
    }

    expect(entries).to.deep.equal(['action3', 'action2', 'action1'])
  })

  it('should maintain block hashes correctly', async () => {
    const log = await Log.create<string>(store)

    // Fill first block (32 entries) and start second block
    const actions = Array.from({ length: 33 }, (_, i) => `action${i + 1}`)
    const results = []
    for (let i = 0; i < actions.length; i++) {
      results.push(await log.addActions([actions[i]!], generateTrxId(i + 1), i + 1))
    }

    // Get the blocks directly from store to check hashes
    const firstBlock = (await store.tryGet(results[0]!.tailPath.block.header.id))! as LogBlock<string>
    const secondBlock = (await store.tryGet(results[32]!.tailPath.block.header.id))! as LogBlock<string>

    // Second block should have nextHash containing the hash of the first block
    expect(secondBlock.nextHash).to.exist
    expect(typeof secondBlock.nextHash).to.equal('string')
    // First block should not have nextHash since nothing points to it
    expect(firstBlock.nextHash).to.be.undefined
  })

  it('should handle empty log operations', async () => {
    const log = await Log.create<string>(store)

    const context = await log.getTrxContext()
    expect(context).to.be.undefined

    const entries = await log.getFrom(0)
    expect(entries.entries).to.deep.equal([])
    expect(entries.context).to.be.undefined
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
    expect(lastAction?.actions[0]).to.equal(`action${actionCount - 1}`)
  })

  it('should handle multiple checkpoints', async () => {
    const log = await Log.create<string>(store)

    // Add several actions first - these will be implicitly committed
    await log.addActions(['action1'], generateTrxId(1), 1)
    await log.addActions(['action2'], generateTrxId(2), 2)
    await log.addActions(['action3'], generateTrxId(3), 3)

    // Verify implicit commits include all actions
    let context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(3)
    expect(context?.rev).to.equal(3)

    // Add a checkpoint that only includes the first two actions
    // This explicitly states what's committed, overriding the implicit behavior
    await log.addCheckpoint([
      { trxId: generateTrxId(1), rev: 1 },
      { trxId: generateTrxId(2), rev: 2 }
    ], 4)

    // Verify the checkpoint reduced the committed set
    context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(2)
    expect(context?.rev).to.equal(4)

    // Add more actions
    await log.addActions(['action4'], generateTrxId(4), 5)
    await log.addActions(['action5'], generateTrxId(5), 6)

    // Without a new checkpoint, these are implicitly added to committed set
    context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(4)
    expect(context?.rev).to.equal(6)

    // Add a new checkpoint that only keeps the most recent actions
    await log.addCheckpoint([
      { trxId: generateTrxId(4), rev: 5 },
      { trxId: generateTrxId(5), rev: 6 }
    ], 7)

    // Verify final state only includes explicitly checkpointed actions
    context = await log.getTrxContext()
    expect(context?.committed.length).to.equal(2)
    expect(context?.rev).to.equal(7)
  })

  it('should handle retrieval from middle revisions', async () => {
    const log = await Log.create<string>(store)

    // Add several actions
    const trxIds: TrxId[] = []
    for (let i = 1; i <= 5; i++) {
      const trxId = generateTrxId(i)
      trxIds.push(trxId)
      await log.addActions([`action${i}`], trxId, i)
    }

    // Add a checkpoint that only keeps first two actions
    await log.addCheckpoint([
      { trxId: trxIds[0]!, rev: 1 },
      { trxId: trxIds[1]!, rev: 2 }
    ], 6)

    // Retrieve from different points
    const fromRev2 = await log.getFrom(2)
    expect(fromRev2.entries.length).to.equal(3) // Actions 3,4,5
    expect(fromRev2.entries[0]?.actions?.[0]).to.equal('action3')
    // Context should reflect checkpoint state
    expect(fromRev2.context?.committed.length).to.equal(2)

		const trx6 = generateTrxId(6)
    trxIds.push(trx6)
    await log.addActions(['action6'], trx6, 7)

    const fromRev4 = await log.getFrom(4)
    expect(fromRev4.entries.length).to.equal(2) // Action 5,6
    expect(fromRev4.entries[0]?.actions?.[0]).to.equal('action5')
    expect(fromRev4.entries[1]?.actions?.[0]).to.equal('action6')

		expect(fromRev4.context?.committed.length).to.equal(3)
    expect(fromRev4.context?.committed[0]).to.deep.equal({ trxId: trxIds[0]!, rev: 1 })
    expect(fromRev4.context?.committed[1]).to.deep.equal({ trxId: trxIds[1]!, rev: 2 })
    expect(fromRev4.context?.committed[2]).to.deep.equal({ trxId: trx6, rev: 7 })
  })
})
