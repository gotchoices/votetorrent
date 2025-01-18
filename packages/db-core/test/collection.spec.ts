import { expect } from 'aegir/chai'
import { Collection } from '../src/collection/index.js'
import { TestNetwork } from './test-network.js'
import type { Action, ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface TestAction {
  value: string
  timestamp: number
}

describe('Collection', () => {
  let network: TestNetwork
  const collectionId = 'test-collection'

  // Action handlers for testing
  const handlers: Record<string, ActionHandler<TestAction>> = {
    'set': async (action, store) => {
      const blockId = store.generateId()
      store.insert({
        header: store.createBlockHeader('TEST', blockId)
      })
    },
    'update': async (action, store) => {
      // No-op for testing
    }
  }

  // Collection initialization options
  const initOptions = {
    modules: handlers,
    createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
      header: store.createBlockHeader('TEST', id)
    })
  }

  beforeEach(() => {
    network = new TestNetwork()
  })

  it('should create a new collection', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)
    expect(collection.id).to.equal(collectionId)
    expect(collection.isNew).to.be.true
  })

  it('should open an existing collection', async () => {
    // Create first instance
    const collection1 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)
    expect(collection1.isNew).to.be.true

    // Open existing collection
    const collection2 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)
    expect(collection2.isNew).to.be.false
    expect(collection2.id).to.equal(collection1.id)
    expect(collection2.logId).to.equal(collection1.logId)
  })

  it('should handle single action transaction', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    const action: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'test value',
        timestamp: Date.now()
      }
    }

    await collection.transact(action)
    await collection.updateAndSync()

    // Verify action is in the log
    const actions: Action<TestAction>[] = []
    for await (const logAction of collection.selectLog()) {
      actions.push(logAction)
    }

    expect(actions).to.have.lengthOf(1)
    expect(actions[0]).to.deep.equal(action)
  })

  it('should handle multiple action transactions', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    await collection.transact(...actions)
    await collection.updateAndSync()

    // Verify actions are in the log
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actions.length)
    expect(logActions).to.deep.equal(actions)
  })

  it('should handle reverse log iteration', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    await collection.transact(...actions)
    await collection.updateAndSync()

    // Verify reverse order
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog(true)) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actions.length)
    expect(logActions).to.deep.equal([...actions].reverse())
  })

  it('should handle update and sync operations', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    // Add action to first collection
    const action1: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'value 1',
        timestamp: Date.now()
      }
    }
    await collection1.transact(action1)
    await collection1.updateAndSync()

    // Update second collection
    await collection2.update()

    // Verify second collection sees the action
    const actions: Action<TestAction>[] = []
    for await (const action of collection2.selectLog()) {
      actions.push(action)
    }

    expect(actions).to.have.lengthOf(1)
    expect(actions[0]).to.deep.equal(action1)
  })

  it('should handle concurrent modifications', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    // Add actions to both collections concurrently
    const action1: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'value 1',
        timestamp: Date.now()
      }
    }

    const action2: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'value 2',
        timestamp: Date.now() + 1
      }
    }

    await Promise.all([
      collection1.transact(action1).then(() => collection1.updateAndSync()),
      collection2.transact(action2).then(() => collection2.updateAndSync())
    ])

    // Both collections should see both actions
    const actions1: Action<TestAction>[] = []
    for await (const action of collection1.selectLog()) {
      actions1.push(action)
    }

    const actions2: Action<TestAction>[] = []
    for await (const action of collection2.selectLog()) {
      actions2.push(action)
    }

    expect(actions1).to.have.lengthOf(2)
    expect(actions2).to.have.lengthOf(2)
    expect(new Set(actions1.map(a => a.data.value)))
      .to.deep.equal(new Set(['value 1', 'value 2']))
    expect(new Set(actions2.map(a => a.data.value)))
      .to.deep.equal(new Set(['value 1', 'value 2']))
  })

  it('should handle multiple action types', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    const actions: Action<TestAction>[] = [
      {
        type: 'set',
        data: {
          value: 'initial value',
          timestamp: Date.now()
        }
      },
      {
        type: 'update',
        data: {
          value: 'updated value',
          timestamp: Date.now() + 1
        }
      }
    ]

    await collection.transact(...actions)
    await collection.updateAndSync()

    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(2)
    expect(logActions.map(a => a.type)).to.deep.equal(['set', 'update'])
  })

  it('should handle large number of actions', async () => {
    const collection = await Collection.createOrOpen<TestAction>(network, collectionId, initOptions)

    const actionCount = 100
    const actions: Action<TestAction>[] = Array(actionCount).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    // Add actions in batches
    const batchSize = 10
    for (let i = 0; i < actions.length; i += batchSize) {
      const batch = actions.slice(i, i + batchSize)
      await collection.transact(...batch)
      await collection.updateAndSync()
    }

    // Verify all actions are present
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actionCount)
    expect(logActions.map(a => a.data.value))
      .to.deep.equal(actions.map(a => a.data.value))
  })
})
