import { expect } from 'aegir/chai'
import type { BlockId, BlockOperation, IBlock, BlockType, Transforms } from '../src/index.js'
import { Tracker } from '../src/transform/tracker.js'
import { applyOperation, withOperation, blockIdsForTransforms, emptyTransforms, mergeTransforms, concatTransforms, transformForBlockId } from '../src/index.js'

interface TestBlock extends IBlock {
  data: string
  items: string[]
}

describe('Transform functionality', () => {
  let mockSource: any
  let testBlock: TestBlock

  beforeEach(() => {
    mockSource = {
      tryGet: async (id: BlockId) => testBlock,
      generateId: () => 'test-id' as BlockId,
      createBlockHeader: (type: BlockType) => ({ id: 'test-id', type })
    }

    testBlock = {
      header: {
        id: 'test-id' as BlockId,
        type: 'test' as BlockType
      },
      data: 'initial',
      items: ['item1', 'item2']
    } as TestBlock
  })

  describe('Tracker', () => {
    it('should track inserts correctly', async () => {
      const tracker = new Tracker(mockSource)
      const newBlock = { ...testBlock, header: { ...testBlock.header, id: 'new-id' as BlockId } }

      tracker.insert(newBlock)
      expect(tracker.transforms.inserts['new-id']).to.deep.equal(newBlock)
      expect(tracker.transforms.deletes.has('new-id')).to.be.false
    })

    it('should track updates correctly', async () => {
      const tracker = new Tracker(mockSource)
      const operation: BlockOperation = ['data', 0, 0, 'updated']

      tracker.update('test-id' as BlockId, operation)
      expect(tracker.transforms.updates['test-id']).to.deep.equal([operation])
    })

    it('should track deletes correctly', async () => {
      const tracker = new Tracker(mockSource)

      tracker.delete('test-id' as BlockId)
      expect(tracker.transforms.deletes.has('test-id')).to.be.true
      expect(tracker.transforms.inserts['test-id']).to.be.undefined
      expect(tracker.transforms.updates['test-id']).to.be.undefined
    })

    it('should reset transform correctly', async () => {
      const tracker = new Tracker(mockSource)
      tracker.insert(testBlock)

      const oldTransforms = tracker.reset()
      expect(oldTransforms.inserts['test-id']).to.deep.equal(testBlock)
      expect(tracker.transforms).to.deep.equal(emptyTransforms())
    })
  })

  describe('Transform Helpers', () => {
    it('should apply attribute operations correctly', () => {
      const block = { ...testBlock }
      const operation: BlockOperation = ['data', 0, 0, 'updated']

      applyOperation(block, operation)
      expect(block.data).to.equal('updated')
    })

		it('should apply array operations correctly', () => {
			const block = { ...testBlock }
			const operation: BlockOperation = ['items', 0, 1, ['updated']]

			applyOperation(block, operation)
			expect(block.items).to.deep.equal(['updated', 'item2'])
		})

    it('should create new block with operation applied', () => {
      const operation: BlockOperation = ['data', 0, 0, 'updated']
      const newBlock = withOperation(testBlock, operation) as TestBlock

      expect(newBlock.data).to.equal('updated')
      expect(testBlock.data).to.equal('initial') // Original unchanged
    })

    it('should get block ids for transform', () => {
      const transform: Transforms = {
        inserts: { 'id1': testBlock },
        updates: { 'id2': [] },
        deletes: new Set(['id3'])
      }

      const ids = blockIdsForTransforms(transform)
      expect(ids).to.have.members(['id1', 'id2', 'id3'])
    })

    it('should merge transforms correctly', () => {
      const transform1: Transforms = {
        inserts: { 'id1': testBlock },
        updates: {},
        deletes: new Set()
      }

      const transform2: Transforms = {
        inserts: { 'id2': testBlock },
        updates: {},
        deletes: new Set(['id3'])
      }

      const merged = mergeTransforms(transform1, transform2)
      expect(merged.inserts).to.have.keys(['id1', 'id2'])
      expect(merged.deletes.has('id3')).to.be.true
    })

    it('should concatenate multiple transforms', () => {
      const transforms: Transforms[] = [
        {
          inserts: { 'id1': testBlock },
          updates: {},
          deletes: new Set()
        },
        {
          inserts: { 'id2': testBlock },
          updates: {},
          deletes: new Set(['id3'])
        }
      ]

      const concatenated = concatTransforms(...transforms)
      expect(concatenated.inserts).to.have.keys(['id1', 'id2'])
      expect(concatenated.deletes.has('id3')).to.be.true
    })

    it('should create transform for specific block id', () => {
      const transform: Transforms = {
        inserts: { 'id1': testBlock, 'id2': testBlock },
        updates: { 'id1': [], 'id3': [] },
        deletes: new Set(['id1', 'id4'])
      }

      const blockTransform = transformForBlockId(transform, 'id1' as BlockId)
      expect(blockTransform.insert).to.exist
			expect(blockTransform.insert).to.deep.equal(testBlock)
      expect(blockTransform.updates).to.exist
      expect(blockTransform.delete).to.be.true
    })
  })
})
