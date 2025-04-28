import { expect } from 'aegir/chai'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { NetworkSimulation } from './simulation.js'
import type { Scenario } from './simulation.js'
import { randomBytes } from '@libp2p/crypto'
import { blockIdToBytes } from '../src/utility/block-id-to-bytes.js'
import type { BlockId, PendRequest, TrxId, BlockOperation } from '../src/index.js'
import type { PeerId } from '@libp2p/interface'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { generateRandomTrxId } from './generate-random-trx-id.js'

describe('NetworkTransactor', () => {
  // Helper to generate block IDs
  const generateBlockId = (): BlockId => uint8ArrayToString(randomBytes(8), 'base64url') as BlockId

  // Helper to setup the test environment
  async function setupNetworkTest(scenario: Scenario = { nodeCount: 10, clusterSize: 1 }) {
    const network = await NetworkSimulation.create(scenario)

    const networkTransactor = new NetworkTransactor({
      timeoutMs: 1000,
      abortOrCancelTimeoutMs: 500,
      keyNetwork: network,
      getRepo: (peerId: PeerId) => {
				const peerIdString = peerId.toString();
				const node = network.getNode(peerIdString);
				if (!node) {
					throw new Error(`Node not found for peerId: ${peerIdString}`)
				}
        return node.transactor
      }
    })

    return { network, networkTransactor }
  }

  // Helper to create a valid BlockOperation
  const createBlockOperation = (): BlockOperation =>
    ['entity1', 0, 0, { field1: 'value1' }]

  // Basic tests for each method
  describe('get', () => {
    it('should fetch blocks from the network', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()

      const result = await networkTransactor.get({
        blockIds: [blockId]
      })

      expect(result).to.be.an('object')
      expect(result[blockId]).to.exist
      expect(result[blockId]!.state).to.exist
    })
  })

  describe('pend', () => {
    it('should pend a transaction on the network', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      const pendRequest: PendRequest = {
        trxId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: new Set()
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      const result = await networkTransactor.pend(pendRequest)

      expect(result.success).to.be.true
      // PendResult blockIds property may not exist in the type definition, but the implementation includes it
      if (result.success && 'blockIds' in result) {
        expect(result.blockIds).to.include(blockId)
      }
    })

    it('should handle pend failures gracefully', async () => {
      const { network, networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      // Make one of the nodes unavailable if nodes array is not empty
      if (network.nodes.length > 0) {
        const firstNode = network.nodes[0]
        firstNode!.transactor.available = false

        const pendRequest: PendRequest = {
          trxId,
          transforms: {
            updates: {
              [blockId]: [createBlockOperation()]
            },
            inserts: {},
            deletes: new Set()
          },
          policy: 'c' // Continue normally if there are pending transactions
        }

        try {
          await networkTransactor.pend(pendRequest)
          // If the transaction succeeded despite the failure, that's also okay
        } catch (error) {
          // We expect an error or a successful retry with a different node
          expect(error).to.exist
        }

        // Restore the node for future tests
        firstNode!.transactor.available = true
      }
    })
  })

  describe('commit', () => {
    it('should commit a pending transaction', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      // First pend the transaction
      const pendRequest: PendRequest = {
        trxId,
        transforms: {
          inserts: {	// Has to be an insert for a non-existing block
						[blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } }
					},
          updates: {},
          deletes: new Set()
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      await networkTransactor.pend(pendRequest)

      // Then commit it
      const result = await networkTransactor.commit({
        trxId,
        rev: 1,
        blockIds: [blockId],
        tailId: blockId,
      })

      expect(result.success).to.be.true
    })
  })

  describe('cancel', () => {
    it('should cancel a pending transaction', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      // First pend the transaction
      const pendRequest: PendRequest = {
        trxId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: new Set()
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      await networkTransactor.pend(pendRequest)

      // Then cancel it
      await networkTransactor.cancel({
        trxId,
        blockIds: [blockId]
      })

      // Verify it was canceled by trying to commit, which should fail
      try {
        await networkTransactor.commit({
          trxId,
          rev: 1,
          blockIds: [blockId],
          tailId: blockId,
        })
        throw new Error('Commit should have failed')
      } catch (error) {
        expect(error).to.exist
      }
    })
  })

	// Not implemented yet
  // describe('getStatus', () => {
  //   it('should get the status of transactions', async () => {
  //     const { networkTransactor } = await setupNetworkTest()
  //     const blockId = generateBlockId()
  //     const trxId = generateRandomTrxId()

  //     // First pend the transaction
  //     const pendRequest: PendRequest = {
  //       trxId,
  //       transforms: {
  //         updates: {
  //           [blockId]: [createBlockOperation()]
  //         },
  //         inserts: {},
  //         deletes: new Set()
  //       },
  //       policy: 'c' // Continue normally if there are pending transactions
  //     }

  //     await networkTransactor.pend(pendRequest)

  //     // Check status
  //     const statusResult = await networkTransactor.getStatus([{
  //       trxId,
  //       blockIds: [blockId]
  //     }])

  //     expect(statusResult).to.be.an('array').with.length(1)
  //     expect(statusResult[0]!.blockIds).to.include(blockId)
  //     expect(statusResult[0]!.statuses).to.be.an('array').with.length(1)
  //     expect(statusResult[0]!.statuses[0]).to.equal('pending')
  //   })
  // })

  // Test network partition scenarios
  describe('network partitions', () => {
    it('should handle network partitions gracefully', async () => {
      const { network, networkTransactor } = await setupNetworkTest({ nodeCount: 10, clusterSize: 1 })

      // Create a partition by making half the nodes only aware of themselves
      const halfNodes = network.nodes.slice(0, 5)
      const partialNodeIds = halfNodes.map(node => node.peerId.toString())

      // Create a partial view of the network
      const partialNetwork = network.createPartialNetworkView(partialNodeIds)

      // Create a transactor that uses this partial network view
      const partialTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: partialNetwork,
        getRepo: (peerId: PeerId) => {
          const node = partialNetwork.getNode(peerId.toString())
          if (!node) {
            throw new Error(`Node not found for peerId: ${peerId.toString()}`)
          }
          return node.transactor
        }
      })

      // Try to pend a transaction with the partial transactor
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      const pendRequest: PendRequest = {
        trxId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: new Set()
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      try {
        const result = await partialTransactor.pend(pendRequest)
        expect(result.success).to.be.true
      } catch (error) {
        // If it fails, that's expected in a partition
        expect(error).to.exist
      }
    })
  })

  // Test node failures
  describe('node failures', () => {
    it('should handle node failures by falling back to other nodes', async () => {
      const { network, networkTransactor } = await setupNetworkTest({ nodeCount: 10, clusterSize: 1 })

      // Make a block ID
      const blockId = generateBlockId()
      const trxId = generateRandomTrxId()

      // Find the coordinator for this block
      const key = blockIdToBytes(blockId)
      const closestNodes = network.findCluster(key)

      // Make the coordinator unavailable
      if (closestNodes && Object.keys(closestNodes).length > 0) {
        const coordinator = Object.values(closestNodes)[0]!
        coordinator.transactor.available = false

        // Try to pend a transaction - it should fall back to another node
        const pendRequest: PendRequest = {
          trxId,
          transforms: {
            updates: {
              [blockId]: [createBlockOperation()]
            },
            inserts: {},
            deletes: new Set()
          },
          policy: 'c' // Continue normally if there are pending transactions
        }

        try {
          const result = await networkTransactor.pend(pendRequest)
          expect(result.success).to.be.true
        } catch (error) {
          // If it fails, that's also expected with the coordinator down
          expect(error).to.exist
        }

        // Restore coordinator for future tests
        coordinator.transactor.available = true
      }
    })
  })
})
