import { expect } from 'aegir/chai'
import { TransactorSource } from '../src/transactor/transactor-source.js'
import { TestTransactor } from './test-transactor.js'
import { randomBytes } from '@libp2p/crypto'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { IBlock, TrxId, TrxContext, Transforms, BlockOperation, CommitRequest } from '../src/index.js'

describe('TransactorSource', () => {
	type TestBlock = IBlock & { test: string[] }

  let network: TestTransactor
  let source: TransactorSource<TestBlock>
  const collectionId = 'test-collection'

  // Helper to create a valid block operation
  const createBlockOperation = (inserted = 'new-test-value'): BlockOperation => ['test', 0, 0, [inserted]]

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

    const pendingTrxId = generateTrxId()
    // Add block to network
    await network.pend({
      trxId: pendingTrxId,
      transforms: {
        inserts: { [blockId]: block },
        updates: {},
        deletes: new Set()
      },
      policy: 'c'
    })
    await network.commit({
      trxId: pendingTrxId,
      blockIds: [blockId],
      rev: 1,
      tailId: blockId
    } as CommitRequest)

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
    // First operation has to be an insert for a non-existing block
    const transform: Transforms = {
      inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
      updates: {},
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId, 1, blockId, blockId)
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

    // Create a pending transaction with an insert
    await network.pend({
      trxId: trxId1,
      transforms: {
        inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
        updates: {},
        deletes: new Set()
      },
      policy: 'c'
    })

    // Try to create another transaction with an update
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    const result = await source.transact(transform, trxId2, 1, blockId, blockId)
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.pending && result.pending.length === 1).to.be.true
  })

  it('should handle failed commit operation', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()

    // First create the block with an insert
    await network.pend({
      trxId,
      transforms: {
        inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
        updates: {},
        deletes: new Set()
      },
      policy: 'c'
    })

    // Commit under later revision
    await network.commit({
      headerId: 'header-id',
      tailId: 'tail-id',
      blockIds: [blockId],
      trxId,
      rev: 2
    })

    // Then update it
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // Try to commit with a stale revision
    const result = await source.transact(transform, generateTrxId(), 1, blockId, blockId)
    expect(result).to.not.be.undefined
    expect(result?.success).to.be.false
    expect(result?.missing && result.missing.length === 1).to.be.true
  })

  it('should handle transaction rollback', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()

    // First create the block with an insert
    await network.pend({
      trxId,
      transforms: {
        inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
        updates: {},
        deletes: new Set()
      },
      policy: 'c'
    })

    // Then update it
    const transform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // Start update transaction
    await network.pend({
      trxId: generateTrxId(),
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
    expect(result).to.be.undefined
  })

  it('should handle concurrent transactions on different blocks', async () => {
    const blockId1 = 'test-block-1'
    const blockId2 = 'test-block-2'
    const trxId1 = generateTrxId()
    const trxId2 = generateTrxId()

    // First create both blocks with inserts
    await Promise.all([
      network.pend({
        trxId: trxId1,
        transforms: {
          inserts: { [blockId1]: { header: { id: blockId1, type: 'block', collectionId: 'test' }, test: [] } as TestBlock },
          updates: {},
          deletes: new Set()
        },
        policy: 'c'
      }),
      network.pend({
        trxId: trxId2,
        transforms: {
          inserts: { [blockId2]: { header: { id: blockId2, type: 'block', collectionId: 'test' }, test: [] } as TestBlock },
          updates: {},
          deletes: new Set()
        },
        policy: 'c'
      })
    ])

    // Commit both blocks
    await Promise.all([
      network.commit({
        trxId: trxId1,
        blockIds: [blockId1],
        rev: 1,
        tailId: blockId1
      }),
      network.commit({
        trxId: trxId2,
        blockIds: [blockId2],
        rev: 1,
        tailId: blockId2
      })
    ])

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

    // Execute update transactions concurrently
    const [result1, result2] = await Promise.all([
      source.transact(transform1, generateTrxId(), 2, 'header-id', 'tail-id'),
      source.transact(transform2, generateTrxId(), 2, 'header-id', 'tail-id')
    ])

    expect(result1).to.be.undefined
    expect(result2).to.be.undefined

    const block1 = await source.tryGet(blockId1)
    const block2 = await source.tryGet(blockId2)

    expect(block1?.test).to.deep.equal(['new-test-value'])
    expect(block2?.test).to.deep.equal(['new-test-value'])
  })

  it('should prioritize headerId and tailId in transaction processing', async () => {
    const headerId = 'header-block'
    const tailId = 'tail-block'
    const contentId = 'content-block'

    // Create initial blocks
    const initialTransform: Transforms = {
      inserts: {
        [headerId]: { header: { id: headerId, type: 'header', collectionId: 'test' }, test: [] } as TestBlock,
        [tailId]: { header: { id: tailId, type: 'tail', collectionId: 'test' }, test: [] } as TestBlock,
        [contentId]: { header: { id: contentId, type: 'content', collectionId: 'test' }, test: [] } as TestBlock
      },
      updates: {},
      deletes: new Set()
    }

    // Insert initial blocks
    const initialTrxId = generateTrxId()
    await source.transact(initialTransform, initialTrxId, 1, headerId, tailId)

    // First transaction updates header and tail
    const trxId1 = generateTrxId()
    const transform1: Transforms = {
      inserts: {},
      updates: {
        [headerId]: [createBlockOperation('header-update-1')],
        [tailId]: [createBlockOperation('tail-update-1')]
      },
      deletes: new Set()
    }

    // Start first transaction
    const result1 = await source.transact(transform1, trxId1, 2, headerId, tailId)
    expect(result1).to.be.undefined

    // Second transaction tries to update header and tail (should fail due to conflict)
    const trxId2 = generateTrxId()
    const transform2: Transforms = {
      inserts: {},
      updates: {
        [headerId]: [createBlockOperation('header-update-2')],
        [tailId]: [createBlockOperation('tail-update-2')]
      },
      deletes: new Set()
    }

    // Start second transaction (using same rev=2)
    const result2 = await source.transact(transform2, trxId2, 2, headerId, tailId)
    expect(result2).to.not.be.undefined
    expect(result2?.success).to.be.false

    // Check that first transaction's changes are still applied
    const headerBlock = await source.tryGet(headerId)
    const tailBlock = await source.tryGet(tailId)
    expect(headerBlock?.test).to.deep.equal(['header-update-1'])
    expect(tailBlock?.test).to.deep.equal(['tail-update-1'])

		// Verify that the second transaction is no longer pending
		const pending = network.getPendingTransactions()
		expect(pending.size).to.equal(0)
  })

  it('should handle update operations only on existing blocks', async () => {
    const blockId = 'test-block'
    const trxId = generateTrxId()

    // Try to update a non-existent block
    const updateTransform: Transforms = {
      inserts: {},
      updates: { [blockId]: [createBlockOperation()] },
      deletes: new Set()
    }

    // This should fail because the block doesn't exist
		// Error should look like: Error: Commit Error: Transaction dPWSdMgzCagwbE2ERPUi7A has no insert for new block test-block
		await expect(source.transact(updateTransform, trxId, 1, 'header-id', 'tail-id')).to.be.rejected

    // Now create the block with an insert
    const insertTransform: Transforms = {
      inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
      updates: {},
      deletes: new Set()
    }

    const insertResult = await source.transact(insertTransform, generateTrxId(), 1, 'header-id', 'tail-id')
    expect(insertResult).to.be.undefined

    // Now update the block
    const updateResult = await source.transact(updateTransform, generateTrxId(), 2, 'header-id', 'tail-id')
    expect(updateResult).to.be.undefined
  })
})
