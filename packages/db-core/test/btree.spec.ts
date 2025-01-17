import { expect } from 'aegir/chai'
import { BTree } from '../src/btree/index.js'
import { applyOperation, type BlockOperation, type BlockStore, type IBlock } from '../src/index.js'
import type { ITreeNode } from '../src/btree/nodes.js'

// Simple in-memory block store for testing
class TestBlockStore implements BlockStore<ITreeNode> {
  private blocks = new Map<string, ITreeNode>()
  private nextId = 1

  createBlockHeader(type: string, newId?: string) {
    const id = newId ?? this.generateId()
    return { id, type, collectionId: 'test' }
  }

  insert(block: ITreeNode): void {
    this.blocks.set(block.header.id, block)
  }

  async tryGet(id: string): Promise<ITreeNode | undefined> {
    return this.blocks.get(id)
  }

  update(id: string, op: BlockOperation): void {
    const block = this.blocks.get(id)
    if (!block) throw new Error(`Block ${id} not found`)
    applyOperation(block, op)
  }

  delete(id: string): void {
    this.blocks.delete(id)
  }

  generateId(): string {
    return `block-${this.nextId++}`
  }
}

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
})
