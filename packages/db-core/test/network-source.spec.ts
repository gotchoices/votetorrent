import { expect } from 'aegir/chai'
import { NetworkSource } from '../src/network/network-source.js'
import { TestNetwork } from './test-network.js'
import { randomUUID } from 'crypto'
import type { IBlock, TrxId, TrxContext, Transforms, BlockOperation } from '../src/index.js'

describe('NetworkSource', () => {
  let network: TestNetwork
  let source: NetworkSource<IBlock>
  const collectionId = 'test-collection'

  // Helper to create a valid block operation
  const createBlockOperation = (entity = 'test'): BlockOperation => [entity, 0, 0, []]

  beforeEach(() => {
    network = new TestNetwork()
    source = new NetworkSource(collectionId, network, undefined)
  })

  it('should create block headers with correct properties', () => {
    const type = 'TEST'
    const header = source.createBlockHeader(type)

    expect(header.type).to.equal(type)
    expect(header.id).to.be.a('string')
    expect(header.collectionId).to.equal(collectionId)
  })

  it('should generate unique block IDs', () => {
    const id1 = source.generateId()
    const id2 = source.generateId()

    expect(id1).to.be.a('string')
    expect(id2).to.be.a('string')
    expect(id1).to.not.equal(id2)
  })

  it('should retrieve blocks from network', async () => {
    const blockId = 'test-block'
    const block: IBlock = {
      header: {
        id: blockId,
        type: 'TEST',
        collectionId
      }
    }

    // Add block to network
    await network.pend({
      trxId: randomUUID() as TrxId,
      transforms: {
        inserts: { [blockId]: block },
        updates: {},
        deletes: new Set()
      },
      pending: 'c'
    })

    const retrieved = await source.tryGet(blockId)
    expect(retrieved).to.deep.equal(block)
  })

  it('should handle missing blocks', async () => {
    const retrieved = await source.tryGet('non-existent')
    expect(retrieved).to.be.undefined
  })

  it('should handle transaction context in block retrieval', async () => {
    const blockId = 'test-block'
    const trxContext: TrxContext = {
      committed: [{ trxId: randomUUID() as TrxId, rev: 1 }],
      rev: 1
    }

    source = new NetworkSource(collectionId, network, trxContext)
    const retrieved = await source.tryGet(blockId)
    expect(retrieved).to.be.undefined
  })

  it('should handle successful transaction lifecycle', async () => {
    const blockId = 'test-block'
    const trxId = randomUUID() as TrxId
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId, 1, 'tail-id')
    expect(result).to.be.undefined

    const pendingTrx = network.getPendingTransactions()
    expect(pendingTrx.size).to.equal(0) // Should be committed

    const committedTrx = network.getCommittedTransactions()
    expect(committedTrx.size).to.equal(1)
    expect(committedTrx.has(trxId)).to.be.true
  })

  it('should handle failed pend operation', async () => {
    const blockId = 'test-block'
    const trxId1 = randomUUID() as TrxId
    const trxId2 = randomUUID() as TrxId

    // Create a pending transaction
    await network.pend({
      trxId: trxId1,
      transforms: {
        inserts: {},
        updates: { [blockId]: [createBlockOperation()] },
        deletes: new Set()
      },
      pending: 'c'
    })

    // Try to create another transaction on the same block
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId2, 1, 'tail-id')
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.reason).to.equal('Blocks have pending transactions')
  })

  it('should handle failed commit operation', async () => {
    const blockId = 'test-block'
    const trxId = randomUUID() as TrxId
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // First transaction succeeds
    await network.pend({
      trxId,
      transforms: transform,
      pending: 'c'
    })

    // Simulate a stale revision
    await network.commit('tail-id', {
      blockIds: [blockId],
      trxId,
      rev: 2
    })

    // Try to commit with an older revision
    const result = await source.transact(transform, randomUUID() as TrxId, 1, 'tail-id')
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.reason).to.equal('Blocks have been modified')
  })

  it('should handle concurrent transactions', async () => {
    const promises = Array(5).fill(0).map(async (_, i) => {
      const blockId = `test-block-${i}`
      const trxId = randomUUID() as TrxId
      const transform: Transforms = {
        inserts: {},
        updates: { [blockId]: [createBlockOperation()] },
        deletes: new Set()
      }

      return source.transact(transform, trxId, i + 1, 'tail-id')
    })

    const results = await Promise.all(promises)
    const successCount = results.filter(r => r === undefined).length
    expect(successCount).to.equal(5)

    const committedTrx = network.getCommittedTransactions()
    expect(committedTrx.size).to.equal(5)
  })
})
