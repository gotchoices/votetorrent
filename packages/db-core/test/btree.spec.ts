import { expect } from 'aegir/chai'
import { BTree } from '../src/btree/index.js'
import { type IBlock } from '../src/index.js'
import { createActor } from '../src/utility/actor.js'
import { TestBlockStore } from './test-block-store.js'

describe('BTree', () => {
  let store: TestBlockStore
  let btree: BTree<number, number>

  beforeEach(() => {
    store = new TestBlockStore()
    btree = BTree.create(store, (s, rootId) => {
			let storedRootId = rootId;
      return {
        get: async () => (await s.tryGet(storedRootId))!,
        set: async (node) => { storedRootId = node.header.id },
        getId: async () => storedRootId
      }
    })
  })

  it('should insert and retrieve values', async () => {
    // Insert some values
    await btree.insert(5)
    await btree.insert(3)
    await btree.insert(7)

    // Verify we can retrieve them
    expect(await btree.get(5)).to.equal(5)
    expect(await btree.get(3)).to.equal(3)
    expect(await btree.get(7)).to.equal(7)
    expect(await btree.get(4)).to.be.undefined
  })

  it('should handle sequential inserts', async () => {
    const count = 100
    for (let i = 0; i < count; i++) {
      await btree.insert(i)
    }

    // Verify all values are present
    for (let i = 0; i < count; i++) {
      expect(await btree.get(i)).to.equal(i)
    }
  })

  it('should support iteration', async () => {
    const values = [5, 3, 7, 1, 9]
    for (const value of values) {
      await btree.insert(value)
    }

    const path = await btree.first()
    const results: number[] = []

    while (path.on) {
      const value = btree.at(path)
      if (value !== undefined) {
        results.push(value)
      }
      await btree.moveNext(path)
    }

    expect(results).to.deep.equal([1, 3, 5, 7, 9])
  })

  it('should delete values', async () => {
    await btree.insert(5)
    await btree.insert(3)
    await btree.insert(7)

    const path = await btree.find(3)
    expect(path.on).to.be.true

    await btree.deleteAt(path)
    expect(path.on).to.be.false

    expect(await btree.get(3)).to.be.undefined
    expect(await btree.get(5)).to.equal(5)
    expect(await btree.get(7)).to.equal(7)
  })

  it('should handle empty tree operations', async () => {
    expect(await btree.get(1)).to.be.undefined
    const firstPath = await btree.first()
    expect(firstPath.on).to.be.false
    const lastPath = await btree.last()
    expect(lastPath.on).to.be.false
    const findPath = await btree.find(5)
    expect(findPath.on).to.be.false
  })

  it('should maintain sorted order after multiple insertions', async () => {
    await btree.insert(3)
    await btree.insert(1)
    await btree.insert(2)

    const values: number[] = []
    const path = await btree.first()
    while (path.on) {
      const value = btree.at(path)
      if (value !== undefined) {
        values.push(value)
      }
      await btree.moveNext(path)
    }

    expect(values).to.deep.equal([1, 2, 3])
  })

  it('should handle single-item ranges', async () => {
    await btree.insert(2)

    const path = await btree.find(2)
    expect(path.on).to.be.true
    expect(btree.at(path)).to.equal(2)

    await btree.moveNext(path)
    expect(path.on).to.be.false

    await btree.movePrior(path)
    expect(path.on).to.be.true
    expect(btree.at(path)).to.equal(2)
  })

  it('should handle updates correctly', async () => {
    await btree.insert(1)
    await btree.insert(2)
    await btree.insert(3)

    const path = await btree.find(2)
    expect(path.on).to.be.true

    // Update existing value
    await btree.updateAt(path, 4)
    expect(await btree.get(2)).to.be.undefined
    expect(await btree.get(4)).to.equal(4)

    // Try updating non-existent value
    const notFoundPath = await btree.find(2)
    expect(notFoundPath.on).to.be.false
  })

  it('should handle large sequential deletes', async () => {
    // Insert 100 items
    for (let i = 0; i < 100; i++) {
      await btree.insert(i)
      // Verify each insert worked correctly
      expect(await btree.get(i)).to.equal(i, `Failed to verify insert of ${i}`)
    }

    // Delete from end with better error tracking
    for (let i = 99; i >= 50; i--) {
      const path = await btree.find(i)
      expect(path.on).to.be.true
      try {
        await btree.deleteAt(path)
      } catch (e) {
        console.error(`Failed to delete ${i}:`, e)
        // Log the block store state
				store.logBlockIds();
        throw e
      }

      // Verify deletion worked
      expect(await btree.get(i)).to.be.undefined

      // Verify adjacent values still exist
      if (i > 0) {
        expect(await btree.get(i - 1)).to.equal(i - 1,
          `Adjacent value ${i - 1} missing after deleting ${i}`)
      }
    }

    // Verify remaining items with more granular checks
    for (let i = 0; i < 50; i++) {
      try {
        expect(await btree.get(i)).to.equal(i, `Missing value ${i}`)
      } catch (e) {
        console.error(`Failed to verify value ${i}:`, e)
        throw e
      }
    }
  })

  it('should handle interleaved inserts and deletes', async () => {
    // Insert initial items
    for (let i = 0; i < 10; i++) {
      await btree.insert(i * 2) // Insert evens: 0,2,4,6,8...
    }

    // Interleave inserts and deletes
    for (let i = 0; i < 5; i++) {
      // Delete even
      const delPath = await btree.find(i * 2)
      await btree.deleteAt(delPath)

      // Insert odd
      await btree.insert(i * 2 + 1)
    }

    // Verify final state
    for (let i = 0; i < 5; i++) {
      expect(await btree.get(i * 2)).to.be.undefined // Evens deleted
      expect(await btree.get(i * 2 + 1)).to.equal(i * 2 + 1) // Odds inserted
    }
  })

  it('should handle boundary conditions in node splits', async () => {
    // Insert ascending to force splits
    const count = 100
    for (let i = 0; i < count; i++) {
      await btree.insert(i)
    }

    // Insert between existing values to test split edge cases
    for (let i = 0; i < count - 1; i++) {
      await btree.insert(i + 0.5)
    }

    // Verify all values present
    for (let i = 0; i < count - 1; i++) {
      expect(await btree.get(i)).to.equal(i)
      expect(await btree.get(i + 0.5)).to.equal(i + 0.5)
    }
  })

  it('should maintain consistency during concurrent operations', async () => {
		// The following would fail without an actor proxy because the tree is not thread-safe by design.
		const safeBtree = createActor(btree);
    // Insert initial data
    for (let i = 0; i < 10; i++) {
      await safeBtree.insert(i)
    }

    // Perform concurrent operations
    await Promise.all([
      safeBtree.insert(20),
      safeBtree.insert(30),
      safeBtree.insert(40)
    ])

    // Verify tree is still consistent
    expect(await safeBtree.get(20)).to.equal(20)
    expect(await safeBtree.get(30)).to.equal(30)
    expect(await safeBtree.get(40)).to.equal(40)
  })
})
