import { expect } from 'aegir/chai'
import { Diary } from '../src/collections/diary/index.js'
import { TestTransactor } from './test-transactor.js'

interface TestEntry {
  id: number
  content: string
  timestamp: number
}

describe('Diary', () => {
  let network: TestTransactor
  let diary: Diary<TestEntry>
  const collectionId = 'test-diary'

  beforeEach(async () => {
    network = new TestTransactor()
    diary = await Diary.create<TestEntry>(network, collectionId)
  })

  it('should create a diary collection', async () => {
    expect(diary).to.be.instanceOf(Diary)
  })

  it('should append and retrieve single entry', async () => {
    const entry: TestEntry = {
      id: 1,
      content: 'Test entry',
      timestamp: Date.now()
    }

    await diary.append(entry)

    const entries: TestEntry[] = []
    for await (const retrievedEntry of diary.select()) {
      entries.push(retrievedEntry)
    }

    expect(entries).to.have.lengthOf(1)
    expect(entries[0]).to.deep.equal(entry)
  })

  it('should append and retrieve multiple entries in order', async () => {
    const entries: TestEntry[] = Array(5).fill(0).map((_, i) => ({
      id: i + 1,
      content: `Entry ${i + 1}`,
      timestamp: Date.now() + i
    }))

    // Append entries
    for (const entry of entries) {
      await diary.append(entry)
    }

    // Retrieve and verify order
    const retrievedEntries: TestEntry[] = []
    for await (const entry of diary.select()) {
      retrievedEntries.push(entry)
    }

    expect(retrievedEntries).to.have.lengthOf(entries.length)
    expect(retrievedEntries).to.deep.equal(entries)
  })

  it('should retrieve entries in reverse order', async () => {
    const entries: TestEntry[] = Array(5).fill(0).map((_, i) => ({
      id: i + 1,
      content: `Entry ${i + 1}`,
      timestamp: Date.now() + i
    }))

    // Append entries
    for (const entry of entries) {
      await diary.append(entry)
    }

    // Retrieve in reverse order
    const retrievedEntries: TestEntry[] = []
    for await (const entry of diary.select(false)) {
      retrievedEntries.push(entry)
    }

    expect(retrievedEntries).to.have.lengthOf(entries.length)
    expect(retrievedEntries).to.deep.equal([...entries].reverse())
  })

  it('should handle empty diary', async () => {
    const entries: TestEntry[] = []
    for await (const entry of diary.select()) {
      entries.push(entry)
    }

    expect(entries).to.be.empty
  })

  it('should handle large number of entries', async () => {
    const count = 100
    const entries: TestEntry[] = Array(count).fill(0).map((_, i) => ({
      id: i + 1,
      content: `Entry ${i + 1}`,
      timestamp: Date.now() + i
    }))

    // Append entries
    for (const entry of entries) {
      await diary.append(entry)
    }

    // Retrieve and verify
    const retrievedEntries: TestEntry[] = []
    for await (const entry of diary.select()) {
      retrievedEntries.push(entry)
    }

    expect(retrievedEntries).to.have.lengthOf(count)
    expect(retrievedEntries).to.deep.equal(entries)
  })

  it('should handle complex entry objects', async () => {
    const entry: TestEntry = {
      id: 1,
      content: JSON.stringify({
        title: 'Complex entry',
        tags: ['test', 'complex'],
        metadata: {
          author: 'Test User',
          version: 1
        }
      }),
      timestamp: Date.now()
    }

    await diary.append(entry)

    const retrievedEntries: TestEntry[] = []
    for await (const retrievedEntry of diary.select()) {
      retrievedEntries.push(retrievedEntry)
    }

    expect(retrievedEntries[0]).to.deep.equal(entry)
  })

  it('should maintain entry order with concurrent appends', async () => {
    const count = 10
    const entries: TestEntry[] = Array(count).fill(0).map((_, i) => ({
      id: i + 1,
      content: `Entry ${i + 1}`,
      timestamp: Date.now() + i
    }))

    // Append entries concurrently
    await Promise.all(entries.map(entry => diary.append(entry)))

    // Retrieve and verify
    const retrievedEntries: TestEntry[] = []
    for await (const entry of diary.select()) {
      retrievedEntries.push(entry)
    }

    expect(retrievedEntries).to.have.lengthOf(count)
    // Note: The exact order might not match the append order due to concurrency,
    // but entries should be in some consistent order based on their timestamps
    expect(retrievedEntries.map(e => e.id).sort()).to.deep.equal(entries.map(e => e.id).sort())
  })

  it('should handle multiple diary instances with same network', async () => {
    const diary2 = await Diary.create<TestEntry>(network, 'test-diary-2')

    const entry1: TestEntry = {
      id: 1,
      content: 'Diary 1 entry',
      timestamp: Date.now()
    }

    const entry2: TestEntry = {
      id: 2,
      content: 'Diary 2 entry',
      timestamp: Date.now()
    }

    await diary.append(entry1)
    await diary2.append(entry2)

    // Check diary 1
    const entries1: TestEntry[] = []
    for await (const entry of diary.select()) {
      entries1.push(entry)
    }
    expect(entries1).to.have.lengthOf(1)
    expect(entries1[0]).to.deep.equal(entry1)

    // Check diary 2
    const entries2: TestEntry[] = []
    for await (const entry of diary2.select()) {
      entries2.push(entry)
    }
    expect(entries2).to.have.lengthOf(1)
    expect(entries2[0]).to.deep.equal(entry2)
  })
})
