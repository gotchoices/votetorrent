import { expect } from 'aegir/chai'
import { TransactorSource } from '../src/transactor/transactor-source.js'
import { TestTransactor } from './test-transactor.js'
import { randomBytes } from '@libp2p/crypto'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, TrxId, TrxContext, Transforms, BlockOperation } from '../src/index.js'

describe('NetworkSource', () => {
  let network: TestTransactor
  let source: TransactorSource<IBlock>
  const collectionId = 'test-collection'

  // Helper to create a valid block operation
  const createBlockOperation = (entity = 'test'): BlockOperation => [entity, 0, 0, []]

  // Helper to generate a random transaction ID
  const generateTrxId = (): TrxId => uint8ArrayToString(randomBytes(16), 'base64url') as TrxId

  beforeEach(() => {
    network = new TestTransactor()
    source = new TransactorSource(collectionId, network, undefined)
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
      trxId: generateTrxId(),
      transforms: {
        inserts: { [blockId]: block },
        updates: {},
        deletes: new Set()
      },
      policy: 'c'
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
      committed: [{ trxId: generateTrxId(), rev: 1 }],
      rev: 1
    }

    source = new TransactorSource(collectionId, network, trxContext)
    const retrieved = await source.tryGet(blockId)
    expect(retrieved).to.be.undefined
  })

  it('should handle successful transaction lifecycle', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId, 1, 'header-id', 'tail-id')
    expect(result).to.be.undefined

    const pendingTrx = network.getPendingTransactions()
    expect(pendingTrx.size).to.equal(0) // Should be committed

    const committedTrx = network.getCommittedTransactions()
    expect(committedTrx.size).to.equal(1)
    expect(committedTrx.has(trxId)).to.be.true
  })

  it('should handle failed pend operation', async () => {
    const blockId = 'test-block'
    const trxId1 = generateTrxId()
    const trxId2 = generateTrxId()

    // Create a pending transaction
    await network.pend({
      trxId: trxId1,
      transforms: {
        inserts: {},
        updates: { [blockId]: [createBlockOperation()] },
        deletes: new Set()
      },
      policy: 'c'
    })

    // Try to create another transaction on the same block
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId2, 1, 'header-id', 'tail-id')
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.reason).to.equal('Blocks have pending transactions')
  })

  it('should handle failed commit operation', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // First transaction succeeds
    await network.pend({
      trxId,
      transforms: transform,
      policy: 'c'
    })

    // Simulate a stale revision
    await network.commit({
      headerId: 'header-id',
      tailId: 'tail-id',
      blockIds: [blockId],
      trxId,
      rev: 2
    })

    // Try to commit with an older revision
    const result = await source.transact(transform, generateTrxId(), 1, 'header-id', 'tail-id')
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.reason).to.equal('Blocks have been modified')
  })

  it('should handle concurrent transactions', async () => {
    const promises = Array(5).fill(0).map(async (_, i) => {
      const blockId = `test-block-${i}`
      const trxId = generateTrxId()
      const transform: Transforms = {
        inserts: {},
        updates: { [blockId]: [createBlockOperation()] },
        deletes: new Set()
      }

      return source.transact(transform, trxId, i + 1, 'header-id', 'tail-id')
    })

    const results = await Promise.all(promises)
    const successCount = results.filter(r => r === undefined).length
    expect(successCount).to.equal(5)

    const committedTrx = network.getCommittedTransactions()
    expect(committedTrx.size).to.equal(5)
  })

  it('should handle transaction rollback', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // Start transaction
    await network.pend({
      trxId,
      transforms: transform,
      policy: 'c'
    })

    // Rollback the transaction
    await network.cancel({
      trxId,
      blockIds: [blockId]
    })

    // Verify block is available for new transactions
    const newTrxId = generateTrxId()
    const result = await source.transact(transform, newTrxId, 1, 'header-id', 'tail-id')
    expect(result?.success).to.be.true
  })

  it('should handle concurrent transactions on different blocks', async () => {
    const blockId1 = 'test-block-1'
    const blockId2 = 'test-block-2'
    const trxId1 = generateTrxId()
    const trxId2 = generateTrxId()

    const transform1: Transforms = {
      inserts: {},
      updates: { [blockId1]: [createBlockOperation()] },
      deletes: new Set()
    }

    const transform2: Transforms = {
      inserts: {},
      updates: { [blockId2]: [createBlockOperation()] },
      deletes: new Set()
    }

    // Execute transactions concurrently
    const [result1, result2] = await Promise.all([
      source.transact(transform1, trxId1, 1, 'header-id', 'tail-id'),
      source.transact(transform2, trxId2, 1, 'header-id', 'tail-id')
    ])

    expect(result1?.success).to.be.true
    expect(result2?.success).to.be.true
  })

  it('should handle block deletion with pending transactions', async () => {
    const blockId = 'test-block'
    const trxId1 = generateTrxId()

    // Create a pending transaction
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set([blockId])
    }

    await network.pend({
      trxId: trxId1,
      transforms: transform,
      policy: 'c'
    })

    // Try to delete the block with another transaction
    const trxId2 = generateTrxId()
    const deleteTransform: Transforms = {
      inserts: {},
      updates: {},
      deletes: new Set([blockId])
    }

    const result = await source.transact(deleteTransform, trxId2, 1, 'header-id', 'tail-id')
    expect(result?.success).to.be.false
    expect(result?.reason).to.equal('Blocks have pending transactions')
  })
})
