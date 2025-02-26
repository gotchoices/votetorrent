import { expect } from 'aegir/chai'
import { LocalStorageReact } from '../src/local-storage-react.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import sinon from 'sinon'

describe('LocalStorageReact', () => {
  let storage: LocalStorageReact
  let mockStorage: Record<string, string> = {}
  let getItemStub: sinon.SinonStub
  let setItemStub: sinon.SinonStub
  let removeItemStub: sinon.SinonStub
  let clearStub: sinon.SinonStub

  // Create stubs for AsyncStorage methods
  beforeEach(() => {
    // Reset mock storage
    mockStorage = {}

    // Create stubs
    getItemStub = sinon.stub()
    getItemStub.callsFake(async (key: string) => {
      return mockStorage[key] || null
    })

    setItemStub = sinon.stub()
    setItemStub.callsFake(async (key: string, value: string) => {
      mockStorage[key] = value
      return Promise.resolve()
    })

    removeItemStub = sinon.stub()
    removeItemStub.callsFake(async (key: string) => {
      delete mockStorage[key]
      return Promise.resolve()
    })

    clearStub = sinon.stub()
    clearStub.callsFake(async () => {
      mockStorage = {}
      return Promise.resolve()
    })

    // Replace AsyncStorage methods with stubs
    AsyncStorage.getItem = getItemStub
    AsyncStorage.setItem = setItemStub
    AsyncStorage.removeItem = removeItemStub
    AsyncStorage.clear = clearStub

    storage = new LocalStorageReact()
  })

  afterEach(() => {
    // Restore original methods
    sinon.restore()
  })

  it('should store and retrieve items', async () => {
    const testData = { test: 'value', number: 42 }
    await storage.setItem('test-key', testData)
    const retrieved = await storage.getItem<typeof testData>('test-key')
    expect(retrieved).to.deep.equal(testData)
  })

  it('should return undefined for non-existent items', async () => {
    const value = await storage.getItem('non-existent')
    expect(value).to.be.undefined
  })

  it('should remove items', async () => {
    const testData = { test: 'value' }
    await storage.setItem('test-key', testData)
    await storage.removeItem('test-key')
    const value = await storage.getItem('test-key')
    expect(value).to.be.undefined
  })

  it('should clear all items', async () => {
    await storage.setItem('key1', 'value1')
    await storage.setItem('key2', 'value2')
    await storage.clear()

    const value1 = await storage.getItem('key1')
    const value2 = await storage.getItem('key2')
    expect(value1).to.be.undefined
    expect(value2).to.be.undefined
  })

  it('should handle complex objects', async () => {
    const complexData = {
      nested: {
        array: [1, 2, 3],
        object: { a: 1, b: '2' }
      },
      date: new Date().toISOString()
    }
    await storage.setItem('complex', complexData)
    const retrieved = await storage.getItem<typeof complexData>('complex')
    expect(retrieved).to.deep.equal(complexData)
  })

  it('should handle concurrent operations', async () => {
    const operations = [
      storage.setItem('key1', 'value1'),
      storage.setItem('key2', 'value2'),
      storage.setItem('key3', 'value3')
    ]

    await Promise.all(operations)

    const results = await Promise.all([
      storage.getItem<string>('key1'),
      storage.getItem<string>('key2'),
      storage.getItem<string>('key3')
    ])

    expect(results).to.deep.equal(['value1', 'value2', 'value3'])
  })
})
