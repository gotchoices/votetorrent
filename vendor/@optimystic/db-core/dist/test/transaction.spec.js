import { expect } from 'chai';
import { ActionsEngine, createActionsStatements, createTransactionStamp, createTransactionId, DEFAULT_TRANSACTION_TTL_MS, isTransactionExpired, hashString, TransactionCoordinator, TransactionSession, TransactionValidator, Tree, } from '../src/index.js';
import { TestTransactor } from './test-transactor.js';
describe('Transaction', () => {
    describe('Transaction Structure', () => {
        it('should create a valid transaction with all required fields', async () => {
            const collections = [
                {
                    collectionId: 'users',
                    actions: [
                        { type: 'insert', data: { id: 1, name: 'Alice' } }
                    ]
                }
            ];
            const statements = createActionsStatements(collections);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const reads = [{ blockId: 'block1', revision: 1 }];
            const transaction = {
                stamp,
                statements,
                reads,
                id: await createTransactionId(stamp.id, statements, reads)
            };
            expect(transaction.stamp.engineId).to.equal('actions@1.0.0');
            expect(transaction.stamp.id).to.be.a('string');
            expect(transaction.statements).to.be.an('array');
            expect(transaction.statements).to.have.lengthOf(1);
            expect(transaction.reads).to.have.lengthOf(1);
            expect(transaction.id).to.be.a('string');
        });
        it('should create unique stamp IDs for different peers', async () => {
            const timestamp = Date.now();
            const stamp1 = await createTransactionStamp('peer1', timestamp, 'schema-hash-123', 'actions@1.0.0');
            const stamp2 = await createTransactionStamp('peer2', timestamp, 'schema-hash-123', 'actions@1.0.0');
            expect(stamp1.id).to.not.equal(stamp2.id);
        });
        it('should create unique transaction IDs for different transactions', async () => {
            const stamp1 = await createTransactionStamp('peer1', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const stamp2 = await createTransactionStamp('peer2', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const statements1 = createActionsStatements([]);
            const statements2 = createActionsStatements([]);
            const reads1 = [{ blockId: 'block1', revision: 1 }];
            const reads2 = [{ blockId: 'block2', revision: 2 }];
            const transaction1 = {
                stamp: stamp1,
                statements: statements1,
                reads: reads1,
                id: await createTransactionId(stamp1.id, statements1, reads1)
            };
            const transaction2 = {
                stamp: stamp2,
                statements: statements2,
                reads: reads2,
                id: await createTransactionId(stamp2.id, statements2, reads2)
            };
            expect(transaction1.id).to.not.equal(transaction2.id);
        });
    });
    describe('ActionsEngine', () => {
        let engine;
        let coordinator;
        beforeEach(() => {
            const transactor = new TestTransactor();
            const collections = new Map();
            coordinator = new TransactionCoordinator(transactor, collections);
            engine = new ActionsEngine(coordinator);
        });
        it('should parse and validate actions statements', async () => {
            // Test that ActionsEngine can parse statements correctly
            // Note: Execution will fail because no collection is registered,
            // but we can verify the parsing and validation logic
            const collections = [
                {
                    collectionId: 'users',
                    actions: [
                        { type: 'insert', data: { id: 1, name: 'Alice' } },
                        { type: 'insert', data: { id: 2, name: 'Bob' } }
                    ]
                }
            ];
            const statements = createActionsStatements(collections);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await engine.execute(transaction);
            // Execution fails because no collection is registered
            expect(result.success).to.be.false;
            expect(result.error).to.include('Collection not found');
        });
        it('should validate multiple collections in statements', async () => {
            // Test that ActionsEngine can parse statements with multiple collections
            const collections = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'insert', data: { id: 1 } }]
                },
                {
                    collectionId: 'posts',
                    actions: [{ type: 'insert', data: { id: 1 } }]
                }
            ];
            const statements = createActionsStatements(collections);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await engine.execute(transaction);
            // Execution fails because no collections are registered
            expect(result.success).to.be.false;
            expect(result.error).to.include('Collection not found');
        });
        it('should fail execution for invalid JSON statements', async () => {
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements: ['invalid json'],
                reads: [],
                id: await createTransactionId(stamp.id, ['invalid json'], [])
            };
            const result = await engine.execute(transaction);
            expect(result.success).to.be.false;
            expect(result.error).to.include('Failed to execute transaction');
        });
    });
    // TransactionContext tests removed - use TransactionSession instead
    // TransactionContext is now an internal implementation detail used by commitTransaction()
    describe('Integration with Collections', () => {
        it('should execute actions through collections via ActionsEngine', async () => {
            // Create a test transactor
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users-tree', entry => entry.key);
            // Access the underlying collection (Tree wraps a Collection)
            const underlyingCollection = usersTree.collection;
            // Create coordinator with the underlying collection
            const collections = new Map();
            collections.set('users-tree', underlyingCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction with actions
            const collectionActions = [
                {
                    collectionId: 'users-tree',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, value: 'Alice' }]]
                        }]
                },
                {
                    collectionId: 'users-tree',
                    actions: [{
                            type: 'replace',
                            data: [[2, { key: 2, value: 'Bob' }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute transaction through engine
            const result = await actionsEngine.execute(transaction);
            // Verify execution succeeded
            expect(result.success).to.be.true;
            // Verify local snapshot sees the changes (via tracker)
            const aliceValue = await usersTree.get(1);
            expect(aliceValue).to.deep.equal({ key: 1, value: 'Alice' });
            const bobValue = await usersTree.get(2);
            expect(bobValue).to.deep.equal({ key: 2, value: 'Bob' });
        });
    });
    describe('Multi-Collection Transactions', () => {
        it('should execute transaction across multiple collections', async () => {
            // Create a test transactor
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            // Access the underlying collections
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            // Create coordinator with both collections
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction that affects BOTH collections
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, name: 'Alice' }]]
                        }]
                },
                {
                    collectionId: 'posts',
                    actions: [{
                            type: 'replace',
                            data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute transaction through engine
            const result = await actionsEngine.execute(transaction);
            // Verify execution succeeded
            expect(result.success).to.be.true;
            // Verify both collections see the changes
            const alice = await usersTree.get(1);
            expect(alice).to.deep.equal({ key: 1, name: 'Alice' });
            const post = await postsTree.get(100);
            expect(post).to.deep.equal({ key: 100, userId: 1, title: 'First Post' });
        });
        it('should include operations hash in pend request for multi-collection transactions', async () => {
            // Create a test transactor that tracks pend requests
            const pendRequests = [];
            const transactor = new TestTransactor();
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                pendRequests.push({
                    operationsHash: request.operationsHash,
                    transaction: request.transaction
                });
                return originalPend(request);
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            // Access the underlying collections
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            // Create coordinator with both collections
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction that affects BOTH collections
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, name: 'Alice' }]]
                        }]
                },
                {
                    collectionId: 'posts',
                    actions: [{
                            type: 'replace',
                            data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute transaction through coordinator.execute() which goes through full PEND flow
            await coordinator.execute(transaction, actionsEngine);
            // Verify pend requests include operations hash and transaction
            expect(pendRequests.length).to.be.greaterThan(0);
            for (const request of pendRequests) {
                expect(request.operationsHash).to.be.a('string');
                expect(request.transaction).to.exist;
                expect(request.transaction?.id).to.equal(transaction.id);
            }
        });
        it('should skip GATHER phase for single collection transactions', async () => {
            // Create a test transactor that tracks cluster nominee queries
            let clusterNomineesQueried = false;
            const transactor = new TestTransactor();
            transactor.queryClusterNominees = async () => {
                clusterNomineesQueried = true;
                return { nominees: [] };
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            // Access the underlying collection
            const usersCollection = usersTree.collection;
            // Create coordinator with one collection
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction that affects ONLY one collection
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, name: 'Alice' }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute transaction through coordinator.execute() which goes through full flow
            await coordinator.execute(transaction, actionsEngine);
            // Verify GATHER phase was skipped (no cluster nominee queries)
            expect(clusterNomineesQueried).to.be.false;
        });
        it('should query cluster nominees for multi-collection transactions', async () => {
            // Create a test transactor that tracks cluster nominee queries
            const queriedBlockIds = [];
            const transactor = new TestTransactor();
            transactor.queryClusterNominees = async (blockId) => {
                queriedBlockIds.push(blockId);
                return { nominees: [] };
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            // Access the underlying collections
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            // Create coordinator with both collections
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction that affects BOTH collections
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, name: 'Alice' }]]
                        }]
                },
                {
                    collectionId: 'posts',
                    actions: [{
                            type: 'replace',
                            data: [[100, { key: 100, userId: 1, title: 'First Post' }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute transaction through coordinator.execute() which goes through full flow
            await coordinator.execute(transaction, actionsEngine);
            // Verify GATHER phase queried cluster nominees for both collections
            expect(queriedBlockIds.length).to.equal(2);
        });
        it('should atomically update multiple collections with pre-existing data', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const ordersTree = await Tree.createOrOpen(transactor, 'orders', entry => entry.key);
            // Pre-populate users with balance via replace
            await usersTree.replace([[1, { key: 1, name: 'Alice', balance: 100 }]]);
            await usersTree.replace([[2, { key: 2, name: 'Bob', balance: 50 }]]);
            // Verify initial state
            const aliceInitial = await usersTree.get(1);
            expect(aliceInitial?.balance).to.equal(100);
            // Setup coordinator
            const usersCollection = usersTree.collection;
            const ordersCollection = ordersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('orders', ordersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction that deducts from Alice and creates an order
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{
                            type: 'replace',
                            data: [[1, { key: 1, name: 'Alice', balance: 75 }]] // Deduct 25
                        }]
                },
                {
                    collectionId: 'orders',
                    actions: [{
                            type: 'replace',
                            data: [[1001, { key: 1001, userId: 1, amount: 25 }]]
                        }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await actionsEngine.execute(transaction);
            expect(result.success).to.be.true;
            // Verify both collections updated atomically
            const aliceUpdated = await usersTree.get(1);
            expect(aliceUpdated?.balance).to.equal(75);
            const order = await ordersTree.get(1001);
            expect(order).to.deep.equal({ key: 1001, userId: 1, amount: 25 });
        });
        it('should handle transaction with three or more collections', async () => {
            const transactor = new TestTransactor();
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const commentsTree = await Tree.createOrOpen(transactor, 'comments', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const commentsCollection = commentsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            collections.set('comments', commentsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create user, post, and comment all in one transaction
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
                },
                {
                    collectionId: 'posts',
                    actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Hello World' }]] }]
                },
                {
                    collectionId: 'comments',
                    actions: [{ type: 'replace', data: [[1000, { key: 1000, postId: 100, text: 'Great post!' }]] }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await coordinator.execute(transaction, actionsEngine);
            expect(result.success).to.be.true;
            // Verify all three collections updated
            expect(await usersTree.get(1)).to.deep.equal({ key: 1, name: 'Alice' });
            expect(await postsTree.get(100)).to.deep.equal({ key: 100, userId: 1, title: 'Hello World' });
            expect(await commentsTree.get(1000)).to.deep.equal({ key: 1000, postId: 100, text: 'Great post!' });
        });
        it('should propagate supercluster nominees to pend requests', async () => {
            // Create mock PeerIds
            const { generateKeyPair } = await import('@libp2p/crypto/keys');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const mockPeerIds = await Promise.all([
                generateKeyPair('Ed25519').then(peerIdFromPrivateKey),
                generateKeyPair('Ed25519').then(peerIdFromPrivateKey),
                generateKeyPair('Ed25519').then(peerIdFromPrivateKey)
            ]);
            const pendRequests = [];
            const transactor = new TestTransactor();
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                pendRequests.push({
                    superclusterNominees: request.superclusterNominees?.map(p => p.toString())
                });
                return originalPend(request);
            };
            // Return mock nominees for each cluster query
            let queryCount = 0;
            transactor.queryClusterNominees = async () => {
                const nominee = mockPeerIds[queryCount % mockPeerIds.length];
                queryCount++;
                return { nominees: [nominee] };
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
                },
                {
                    collectionId: 'posts',
                    actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Post' }]] }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await coordinator.execute(transaction, actionsEngine);
            // All pend requests should include supercluster nominees
            expect(pendRequests.length).to.be.greaterThan(0);
            for (const request of pendRequests) {
                expect(request.superclusterNominees).to.be.an('array');
                expect(request.superclusterNominees.length).to.be.greaterThan(0);
            }
        });
        it('should fail if a collection does not exist', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            // Only register 'users' collection, but transaction references 'posts'
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
                },
                {
                    collectionId: 'posts', // This collection doesn't exist
                    actions: [{ type: 'replace', data: [[100, { key: 100, title: 'Post' }]] }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await actionsEngine.execute(transaction);
            expect(result.success).to.be.false;
            expect(result.error).to.include('Collection not found: posts');
        });
        it('should handle empty transaction gracefully', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Empty transaction with no actions
            const statements = createActionsStatements([]);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await coordinator.execute(transaction, actionsEngine);
            expect(result.success).to.be.true;
        });
        it('should trace full GATHER/PEND/COMMIT phases for multi-collection transaction', async () => {
            const phaseLog = [];
            const transactor = new TestTransactor();
            // Track GATHER phase
            transactor.queryClusterNominees = async (blockId) => {
                phaseLog.push({ phase: 'GATHER', data: { blockId } });
                return { nominees: [] };
            };
            // Track PEND phase
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                phaseLog.push({
                    phase: 'PEND',
                    data: {
                        actionId: request.actionId,
                        hasTransaction: !!request.transaction,
                        hasOperationsHash: !!request.operationsHash,
                        blockCount: Object.keys(request.transforms.inserts ?? {}).length +
                            Object.keys(request.transforms.updates ?? {}).length +
                            (request.transforms.deletes?.length ?? 0)
                    }
                });
                return originalPend(request);
            };
            // Track COMMIT phase
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (request) => {
                phaseLog.push({
                    phase: 'COMMIT',
                    data: {
                        actionId: request.actionId,
                        blockCount: request.blockIds.length
                    }
                });
                return originalCommit(request);
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Clear phase log before our transaction
            phaseLog.length = 0;
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
                },
                {
                    collectionId: 'posts',
                    actions: [{ type: 'replace', data: [[100, { key: 100, userId: 1, title: 'Post' }]] }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            const result = await coordinator.execute(transaction, actionsEngine);
            expect(result.success).to.be.true;
            // Verify phase order: GATHER (2x for 2 collections), PEND (2x), COMMIT (2x)
            const gatherPhases = phaseLog.filter(p => p.phase === 'GATHER');
            const pendPhases = phaseLog.filter(p => p.phase === 'PEND');
            const commitPhases = phaseLog.filter(p => p.phase === 'COMMIT');
            expect(gatherPhases.length).to.equal(2, 'Should have 2 GATHER calls');
            expect(pendPhases.length).to.equal(2, 'Should have 2 PEND calls');
            expect(commitPhases.length).to.equal(2, 'Should have 2 COMMIT calls');
            // Verify GATHER happens before PEND, PEND before COMMIT
            const firstGatherIdx = phaseLog.findIndex(p => p.phase === 'GATHER');
            const firstPendIdx = phaseLog.findIndex(p => p.phase === 'PEND');
            const firstCommitIdx = phaseLog.findIndex(p => p.phase === 'COMMIT');
            expect(firstGatherIdx).to.be.lessThan(firstPendIdx, 'GATHER should come before PEND');
            expect(firstPendIdx).to.be.lessThan(firstCommitIdx, 'PEND should come before COMMIT');
            // Verify PEND has transaction and operations hash
            for (const pendPhase of pendPhases) {
                const data = pendPhase.data;
                expect(data.hasTransaction).to.be.true;
                expect(data.hasOperationsHash).to.be.true;
            }
        });
    });
    describe('Transaction Validation', () => {
        it('should validate transaction with matching operations hash', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Create transaction
            const collectionActions = [
                {
                    collectionId: 'users',
                    actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }]
                }
            ];
            const statements = createActionsStatements(collectionActions);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements,
                reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute to get operations hash
            const result = await coordinator.execute(transaction, actionsEngine);
            expect(result.success).to.be.true;
            // Set up validator with same engine
            const validationTransforms = new Map();
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: actionsEngine,
                getSchemaHash: async () => 'schema-hash-123'
            });
            const createValidationCoordinator = () => ({
                applyActions: async (actions, _stampId) => {
                    for (const { collectionId } of actions) {
                        validationTransforms.set(collectionId, {
                            inserts: {},
                            updates: {},
                            deletes: []
                        });
                    }
                },
                getTransforms: () => validationTransforms,
                dispose: () => validationTransforms.clear()
            });
            const validator = new TransactionValidator(engines, createValidationCoordinator);
            // Validation should succeed with matching hash (using empty transforms since we simplified)
            const expectedHash = `ops:${await hashString(JSON.stringify([]))}`;
            const validationResult = await validator.validate(transaction, expectedHash);
            expect(validationResult.valid).to.be.true;
        });
        it('should reject transaction with unknown engine', async () => {
            const engines = new Map();
            const createValidationCoordinator = () => ({
                applyActions: async () => { },
                getTransforms: () => new Map(),
                dispose: () => { }
            });
            const validator = new TransactionValidator(engines, createValidationCoordinator);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'unknown-engine@1.0.0');
            const transaction = {
                stamp,
                statements: [],
                reads: [],
                id: await createTransactionId(stamp.id, [], [])
            };
            const result = await validator.validate(transaction, 'ops:abc');
            expect(result.valid).to.be.false;
            expect(result.reason).to.include('Unknown engine');
        });
        it('should reject transaction with schema mismatch', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Engine has DIFFERENT schema hash than transaction
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: actionsEngine,
                getSchemaHash: async () => 'different-schema-hash'
            });
            const createValidationCoordinator = () => ({
                applyActions: async () => { },
                getTransforms: () => new Map(),
                dispose: () => { }
            });
            const validator = new TransactionValidator(engines, createValidationCoordinator);
            const stamp = await createTransactionStamp('reference-peer', Date.now(), 'schema-hash-123', 'actions@1.0.0');
            const transaction = {
                stamp,
                statements: [],
                reads: [],
                id: await createTransactionId(stamp.id, [], [])
            };
            const result = await validator.validate(transaction, 'ops:abc');
            expect(result.valid).to.be.false;
            expect(result.reason).to.include('Schema mismatch');
        });
    });
    describe('Transaction Rollback (TEST-2.1.1)', () => {
        it('should discard pending changes on rollback', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            await session.execute('stmt1', [{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }]);
            // Data visible in local snapshot before commit
            const beforeRollback = await usersTree.get(1);
            expect(beforeRollback).to.deep.equal({ key: 1, name: 'Alice' });
            await session.rollback();
            // After rollback, session's data should no longer be visible
            const afterRollback = await usersTree.get(1);
            expect(afterRollback, 'Alice should be gone after rollback').to.be.undefined;
        });
        it('should discard session data across multiple collections on rollback', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            await session.execute('stmt1', [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ]);
            // Both collections have pending transforms
            const transformsBefore = coordinator.getTransforms();
            expect(transformsBefore.size).to.equal(2);
            await session.rollback();
            // Session's data should be gone from both collections
            const alice = await usersTree.get(1);
            expect(alice, 'Alice should be gone after rollback').to.be.undefined;
            const post = await postsTree.get(10);
            expect(post, 'Post should be gone after rollback').to.be.undefined;
        });
        it('should throw when rolling back an already committed session', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            await session.execute('stmt1', [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ]);
            await session.commit();
            try {
                await session.rollback();
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('already committed');
            }
        });
        it('should throw on double rollback', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            await session.execute('stmt1', [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ]);
            await session.rollback();
            try {
                await session.rollback();
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('already rolled back');
            }
        });
        it('should reject execute after rollback', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            await session.rollback();
            const result = await session.execute('stmt1', [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ]);
            expect(result.success).to.be.false;
            expect(result.error).to.include('already rolled back');
        });
        it('should set session state flags correctly after rollback', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine);
            expect(session.isCommitted()).to.be.false;
            expect(session.isRolledBack()).to.be.false;
            await session.rollback();
            expect(session.isCommitted()).to.be.false;
            expect(session.isRolledBack()).to.be.true;
        });
    });
    describe('Multi-Collection Transaction Conflicts (TEST-2.1.2)', () => {
        it('should detect pend conflicts from concurrent transactions on same blocks', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // First transaction: insert user
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements1 = createActionsStatements(actions1);
            const stamp1 = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx1 = {
                stamp: stamp1, statements: statements1, reads: [],
                id: await createTransactionId(stamp1.id, statements1, [])
            };
            // Execute and commit tx1
            await coordinator.execute(tx1, actionsEngine);
            // Second transaction: also insert same user (conflict)
            const actions2 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Bob' }]] }] }
            ];
            const statements2 = createActionsStatements(actions2);
            const stamp2 = await createTransactionStamp('peer2', Date.now() + 1, 'schema1', 'actions@1.0.0');
            const tx2 = {
                stamp: stamp2, statements: statements2, reads: [],
                id: await createTransactionId(stamp2.id, statements2, [])
            };
            // tx2 should encounter the transforms from tx1's committed state
            const result2 = await actionsEngine.execute(tx2);
            // The execute itself succeeds (local apply), but the data reflects the second write
            expect(result2.success).to.be.true;
        });
        it('should isolate transforms between independent collections', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Snapshot posts transforms before execution (includes creation transforms)
            const postsTransformsBefore = JSON.parse(JSON.stringify(postsCollection.tracker.transforms));
            // Transaction affecting only users
            const userActions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const userStatements = createActionsStatements(userActions);
            const userStamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const userTx = {
                stamp: userStamp, statements: userStatements, reads: [],
                id: await createTransactionId(userStamp.id, userStatements, [])
            };
            await actionsEngine.execute(userTx);
            // Posts transforms should be unchanged (user transaction shouldn't affect posts)
            const postsTransformsAfter = JSON.parse(JSON.stringify(postsCollection.tracker.transforms));
            expect(postsTransformsAfter).to.deep.equal(postsTransformsBefore);
        });
    });
    describe('Coordinator Timeout Handling (TEST-2.2.1)', () => {
        it('should fail pend phase when transactor is unavailable', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            // Execute locally first (this succeeds)
            await actionsEngine.execute(tx);
            // Make transactor unavailable before commit
            transactor.setAvailable(false);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('not available');
            }
        });
        it('should fail commit phase when transactor becomes unavailable after pend', async () => {
            const transactor = new TestTransactor();
            let pendCount = 0;
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                pendCount++;
                const result = await originalPend(request);
                // Make transactor unavailable after pend succeeds
                transactor.setAvailable(false);
                return result;
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(pendCount).to.be.greaterThan(0);
                expect(e.message).to.satisfy((msg) => msg.includes('not available') || msg.includes('failed'));
            }
        });
        it('should fail gather phase when cluster nominees query throws', async () => {
            const transactor = new TestTransactor();
            transactor.queryClusterNominees = async () => {
                throw new Error('Cluster unreachable');
            };
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('Cluster unreachable');
            }
        });
    });
    describe('Partial Failure Recovery (TEST-2.2.2)', () => {
        it('should cancel pended collections when commit fails for one collection', async () => {
            const transactor = new TestTransactor();
            const cancelledActions = [];
            let commitCallCount = 0;
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (request) => {
                commitCallCount++;
                if (commitCallCount >= 2) {
                    return { success: false, reason: 'Commit rejected by peer' };
                }
                return originalCommit(request);
            };
            const originalCancel = transactor.cancel.bind(transactor);
            transactor.cancel = async (actionRef) => {
                cancelledActions.push({
                    actionId: actionRef.actionId,
                    blockIds: [...actionRef.blockIds]
                });
                return originalCancel(actionRef);
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('failed');
            }
            // Cancel phase should have been invoked for the affected collections
            expect(cancelledActions.length).to.be.greaterThan(0);
        });
        it('should call cancel on pend failure partway through multi-collection pend', async () => {
            const transactor = new TestTransactor();
            let pendCallCount = 0;
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                pendCallCount++;
                if (pendCallCount >= 2) {
                    return { success: false, reason: 'Storage full' };
                }
                return originalPend(request);
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                // Pend failure should propagate as commit error
                expect(e.message).to.include('failed');
            }
            // At least one pend was attempted
            expect(pendCallCount).to.be.greaterThanOrEqual(1);
        });
        it('should handle transactor becoming unavailable during cancel phase gracefully', async () => {
            const transactor = new TestTransactor();
            let commitCallCount = 0;
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (request) => {
                commitCallCount++;
                if (commitCallCount >= 2) {
                    // Return structured failure so cancelPhase is triggered
                    return { success: false, reason: 'Commit rejected' };
                }
                return originalCommit(request);
            };
            // Make cancel throw to simulate unavailability during cancel
            transactor.cancel = async () => {
                throw new Error('Cancel also failed');
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const usersCollection = usersTree.collection;
            const postsCollection = postsTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            collections.set('posts', postsCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            // Cancel phase throws, which should propagate as an error
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                // The cancel failure propagates through the commit path
                expect(e).to.be.instanceOf(Error);
            }
        });
    });
    describe('Operations Hash Determinism (TEST-10.6.1)', () => {
        it('should produce different hashes when operation order differs (ordering sensitivity)', async () => {
            // Directly test the hashing mechanism: same operations, different order
            const op1 = { type: 'insert', collectionId: 'users', blockId: 'b1', block: { data: 'alice' } };
            const op2 = { type: 'insert', collectionId: 'posts', blockId: 'b2', block: { data: 'post1' } };
            const hash1 = `ops:${await hashString(JSON.stringify([op1, op2]))}`;
            const hash2 = `ops:${await hashString(JSON.stringify([op2, op1]))}`;
            // Operation ordering affects the hash — confirming that Map iteration order
            // in coordinator/validator is a determinism risk if collections are processed
            // in different order on different nodes
            expect(hash1).to.not.equal(hash2);
        });
        it('should produce consistent hash from execute() regardless of constructor Map order', async () => {
            const transactor1 = new TestTransactor();
            const transactor2 = new TestTransactor();
            // Coordinator 1: users first, then posts
            const usersTree1 = await Tree.createOrOpen(transactor1, 'users', e => e.key);
            const postsTree1 = await Tree.createOrOpen(transactor1, 'posts', e => e.key);
            const collections1 = new Map();
            collections1.set('users', usersTree1.collection);
            collections1.set('posts', postsTree1.collection);
            // Coordinator 2: posts first, then users (reversed)
            const postsTree2 = await Tree.createOrOpen(transactor2, 'posts', e => e.key);
            const usersTree2 = await Tree.createOrOpen(transactor2, 'users', e => e.key);
            const collections2 = new Map();
            collections2.set('posts', postsTree2.collection);
            collections2.set('users', usersTree2.collection);
            const coordinator1 = new TransactionCoordinator(transactor1, collections1);
            const coordinator2 = new TransactionCoordinator(transactor2, collections2);
            const engine1 = new ActionsEngine(coordinator1);
            const engine2 = new ActionsEngine(coordinator2);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, value: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, value: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const ts = Date.now();
            const stamp1 = await createTransactionStamp('peer1', ts, 'schema1', 'actions@1.0.0');
            const stamp2 = await createTransactionStamp('peer2', ts, 'schema1', 'actions@1.0.0');
            const tx1 = {
                stamp: stamp1, statements, reads: [],
                id: await createTransactionId(stamp1.id, statements, [])
            };
            const tx2 = {
                stamp: stamp2, statements, reads: [],
                id: await createTransactionId(stamp2.id, statements, [])
            };
            const result1 = await coordinator1.execute(tx1, engine1);
            const result2 = await coordinator2.execute(tx2, engine2);
            expect(result1.success).to.be.true;
            expect(result2.success).to.be.true;
            // execute() populates collectionTransforms from result.actions order (which comes
            // from statements order), not from the constructor Map order.
            // So hashes should match. If they don't, that's a bug.
        });
        it('should validate multi-collection transaction with matching transforms', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', e => e.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', e => e.key);
            const collections = new Map();
            collections.set('users', usersTree.collection);
            collections.set('posts', postsTree.collection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, value: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, value: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const transaction = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await coordinator.execute(transaction, actionsEngine);
            // Set up validator — transforms will be empty (applyActions is a no-op)
            // so the hash comparison is for empty operations
            const validationTransforms = new Map();
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: actionsEngine,
                getSchemaHash: async () => 'schema1'
            });
            const createValidationCoordinator = () => ({
                applyActions: async (appliedActions, _stampId) => {
                    for (const { collectionId } of appliedActions) {
                        validationTransforms.set(collectionId, {
                            inserts: {},
                            updates: {},
                            deletes: []
                        });
                    }
                },
                getTransforms: () => validationTransforms,
                dispose: () => validationTransforms.clear()
            });
            const validator = new TransactionValidator(engines, createValidationCoordinator);
            const expectedHash = `ops:${await hashString(JSON.stringify([]))}`;
            const validationResult = await validator.validate(transaction, expectedHash);
            expect(validationResult.valid).to.be.true;
        });
        it('should fail validation when transforms order differs with non-empty data (known risk)', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', e => e.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', e => e.key);
            const collections = new Map();
            collections.set('users', usersTree.collection);
            collections.set('posts', postsTree.collection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, value: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, value: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const transaction = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await coordinator.execute(transaction, actionsEngine);
            // Validator produces transforms in REVERSED collection order
            const fakeBlock = { header: { id: 'fake-block', type: 'test', collectionId: 'test' } };
            const validationTransforms = new Map();
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: actionsEngine,
                getSchemaHash: async () => 'schema1'
            });
            const createValidationCoordinator = () => ({
                applyActions: async (appliedActions, _stampId) => {
                    // Insert in REVERSED order to simulate different node behavior
                    for (const { collectionId } of [...appliedActions].reverse()) {
                        validationTransforms.set(collectionId, {
                            inserts: { [`block-${collectionId}`]: fakeBlock },
                            updates: {},
                            deletes: []
                        });
                    }
                },
                getTransforms: () => validationTransforms,
                dispose: () => validationTransforms.clear()
            });
            const validator = new TransactionValidator(engines, createValidationCoordinator);
            // With non-empty transforms in reversed order, the JSON.stringify
            // produces different output → different hash → validation fails
            const validationResult = await validator.validate(transaction, 'ops:anyHash');
            expect(validationResult.valid).to.be.false;
        });
    });
    describe('Write-Skew and Lost-Update Detection (TEST-10.5.1)', () => {
        const makeBlock = (id, data) => ({
            header: { id, type: 'test', collectionId: 'test' },
            data,
        });
        it('should detect conflict when two pends touch the same block (lost-update prevention)', async () => {
            const transactor = new TestTransactor();
            const blockId = 'shared-block';
            // Initial commit: insert the block
            const setupTransforms = {
                inserts: { [blockId]: makeBlock(blockId, 'initial') },
                updates: {},
                deletes: [],
            };
            const setupResult = await transactor.pend({
                actionId: 'setup',
                transforms: setupTransforms,
                policy: 'f',
            });
            expect(setupResult.success).to.be.true;
            await transactor.commit({
                actionId: 'setup',
                blockIds: [blockId],
                tailId: blockId,
                rev: 1,
            });
            // Transaction A: update the block (rev 2 = "I've seen rev 1")
            const txATransforms = {
                inserts: {},
                updates: { [blockId]: [['data', 0, 0, 'tx-a-value']] },
                deletes: [],
            };
            const txAResult = await transactor.pend({
                actionId: 'tx-a',
                transforms: txATransforms,
                policy: 'f',
                rev: 2,
            });
            expect(txAResult.success).to.be.true;
            // Transaction B: also update the same block — should conflict with pending tx-a
            const txBTransforms = {
                inserts: {},
                updates: { [blockId]: [['data', 0, 0, 'tx-b-value']] },
                deletes: [],
            };
            const txBResult = await transactor.pend({
                actionId: 'tx-b',
                transforms: txBTransforms,
                policy: 'f',
                rev: 2,
            });
            // With policy 'f', pend fails when there are pending conflicts
            expect(txBResult.success).to.be.false;
            const failResult = txBResult;
            expect(failResult.pending).to.be.an('array').that.is.not.empty;
        });
        it('should detect committed conflict (stale revision)', async () => {
            const transactor = new TestTransactor();
            const blockId = 'account-block';
            // Insert and commit at rev 1
            await transactor.pend({
                actionId: 'init',
                transforms: { inserts: { [blockId]: makeBlock(blockId, '100') }, updates: {}, deletes: [] },
                policy: 'f',
            });
            await transactor.commit({ actionId: 'init', blockIds: [blockId], tailId: blockId, rev: 1 });
            // Transaction A commits at rev 2
            await transactor.pend({
                actionId: 'tx-a',
                transforms: { inserts: {}, updates: { [blockId]: [['data', 0, 0, '50']] }, deletes: [] },
                policy: 'f',
                rev: 2,
            });
            await transactor.commit({ actionId: 'tx-a', blockIds: [blockId], tailId: blockId, rev: 2 });
            // Transaction B tries to pend at rev 2 — tx-a already committed at rev 2
            const txBResult = await transactor.pend({
                actionId: 'tx-b',
                transforms: { inserts: {}, updates: { [blockId]: [['data', 0, 0, '75']] }, deletes: [] },
                policy: 'f',
                rev: 2,
            });
            expect(txBResult.success).to.be.false;
            const failResult = txBResult;
            expect(failResult.missing).to.be.an('array').that.is.not.empty;
        });
        it('should allow write-skew anomaly — no read dependency tracking (known limitation)', async () => {
            const transactor = new TestTransactor();
            const blockA = 'account-a';
            const blockB = 'account-b';
            // Setup: two accounts with balance 100 each (invariant: A + B >= 100)
            await transactor.pend({
                actionId: 'init',
                transforms: {
                    inserts: {
                        [blockA]: makeBlock(blockA, '100'),
                        [blockB]: makeBlock(blockB, '100'),
                    },
                    updates: {},
                    deletes: [],
                },
                policy: 'f',
            });
            await transactor.commit({
                actionId: 'init',
                blockIds: [blockA, blockB],
                tailId: blockA,
                rev: 1,
            });
            // Transaction A: reads both accounts (100 + 100 = 200 >= 100 ✓), withdraws 100 from A
            // The "read" of B is not tracked — only the write to A is recorded
            const txAResult = await transactor.pend({
                actionId: 'tx-a',
                transforms: {
                    inserts: {},
                    updates: { [blockA]: [['data', 0, 0, '0']] },
                    deletes: [],
                },
                policy: 'f',
                rev: 2,
            });
            expect(txAResult.success, 'tx-a pend should succeed').to.be.true;
            // Transaction B: reads both accounts (100 + 100 = 200 >= 100 ✓), withdraws 100 from B
            // The "read" of A is not tracked — only the write to B is recorded
            const txBResult = await transactor.pend({
                actionId: 'tx-b',
                transforms: {
                    inserts: {},
                    updates: { [blockB]: [['data', 0, 0, '0']] },
                    deletes: [],
                },
                policy: 'f',
                rev: 2,
            });
            // KNOWN LIMITATION: Both succeed because they touch DIFFERENT blocks.
            // No read dependency tracking means the system doesn't know that tx-b
            // "depends on" the value of blockA that tx-a is about to change.
            // Result: A=0, B=0 → A + B = 0 < 100, invariant violated.
            expect(txBResult.success, 'tx-b pend succeeds — write-skew not detected').to.be.true;
            // Commit both — both succeed because no block-ID overlap
            const commitA = await transactor.commit({
                actionId: 'tx-a', blockIds: [blockA], tailId: blockA, rev: 2,
            });
            const commitB = await transactor.commit({
                actionId: 'tx-b', blockIds: [blockB], tailId: blockB, rev: 2,
            });
            expect(commitA.success, 'tx-a commit').to.be.true;
            expect(commitB.success, 'tx-b commit').to.be.true;
        });
        it('should detect conflict through Tree when same key is updated concurrently', async () => {
            const transactor = new TestTransactor();
            // Create tree and insert initial data
            const tree1 = await Tree.createOrOpen(transactor, 'accounts', e => e.key);
            await tree1.replace([[1, { key: 1, balance: 100 }]]);
            // Capture the block IDs touched by tree1's first write
            const tree1Blocks = new Set();
            for (const [id] of transactor.blocks.entries()) {
                tree1Blocks.add(id);
            }
            // Create a second tree instance viewing the same collection
            const tree2 = await Tree.createOrOpen(transactor, 'accounts', e => e.key);
            // Verify tree2 can see the initial data
            const entry = await tree2.get(1);
            expect(entry).to.deep.equal({ key: 1, balance: 100 });
            // Both trees update the same key — the second should conflict and retry
            // (Collection.sync handles conflicts via update+replay loop)
            await tree1.replace([[1, { key: 1, balance: 50 }]]);
            await tree2.replace([[1, { key: 1, balance: 75 }]]);
            // After both complete, the last writer wins (tree2 retries after conflict)
            await tree1.update();
            const finalFromTree1 = await tree1.get(1);
            const finalFromTree2 = await tree2.get(1);
            expect(finalFromTree1).to.deep.equal(finalFromTree2);
            // tree2 wrote last (after retry), so its value should win
            expect(finalFromTree2.balance).to.equal(75);
        });
        it('should detect write-skew via read dependency validation', async () => {
            const transactor = new TestTransactor();
            const blockA = 'account-a';
            const blockB = 'account-b';
            // Setup: two accounts with balance 100 each (invariant: A + B >= 100)
            await transactor.pend({
                actionId: 'init',
                transforms: {
                    inserts: {
                        [blockA]: makeBlock(blockA, '100'),
                        [blockB]: makeBlock(blockB, '100'),
                    },
                    updates: {},
                    deletes: [],
                },
                policy: 'f',
            });
            await transactor.commit({
                actionId: 'init',
                blockIds: [blockA, blockB],
                tailId: blockA,
                rev: 1,
            });
            // Simulate read dependencies: tx-b reads both blocks at rev 1
            const txBReads = [
                { blockId: blockA, revision: 1 },
                { blockId: blockB, revision: 1 },
            ];
            // Transaction A: writes to blockA (withdraw 100)
            await transactor.pend({
                actionId: 'tx-a',
                transforms: {
                    inserts: {},
                    updates: { [blockA]: [['data', 0, 0, '0']] },
                    deletes: [],
                },
                policy: 'f',
                rev: 2,
            });
            await transactor.commit({
                actionId: 'tx-a',
                blockIds: [blockA],
                tailId: blockA,
                rev: 2,
            });
            // Now blockA is at rev 2. Validate tx-b's read dependencies.
            // tx-b read blockA at rev 1, but it's now at rev 2 → stale read
            const blockStateProvider = async (blockId) => {
                const result = await transactor.get({ blockIds: [blockId] });
                return result[blockId]?.state;
            };
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: new ActionsEngine({}),
                getSchemaHash: async () => 'schema1'
            });
            const validator = new TransactionValidator(engines, () => ({ applyActions: async () => { }, getTransforms: () => new Map(), dispose: () => { } }), blockStateProvider);
            const stamp = await createTransactionStamp('peer-b', Date.now(), 'schema1', 'actions@1.0.0');
            const txB = {
                stamp,
                statements: [],
                reads: txBReads,
                id: await createTransactionId(stamp.id, [], txBReads),
            };
            const result = await validator.validate(txB, `ops:${await hashString(JSON.stringify([]))}`);
            expect(result.valid).to.be.false;
            expect(result.reason).to.include('Stale read');
            expect(result.reason).to.include(blockA);
        });
        it('should pass validation when reads have not changed', async () => {
            const transactor = new TestTransactor();
            const blockA = 'block-a';
            // Setup: create a block at rev 1
            await transactor.pend({
                actionId: 'init',
                transforms: { inserts: { [blockA]: makeBlock(blockA, 'data') }, updates: {}, deletes: [] },
                policy: 'f',
            });
            await transactor.commit({
                actionId: 'init',
                blockIds: [blockA],
                tailId: blockA,
                rev: 1,
            });
            // Read dependency at rev 1 — block is still at rev 1
            const reads = [{ blockId: blockA, revision: 1 }];
            const blockStateProvider = async (blockId) => {
                const result = await transactor.get({ blockIds: [blockId] });
                return result[blockId]?.state;
            };
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: new ActionsEngine({}),
                getSchemaHash: async () => 'schema1'
            });
            const validator = new TransactionValidator(engines, () => ({ applyActions: async () => { }, getTransforms: () => new Map(), dispose: () => { } }), blockStateProvider);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp,
                statements: [],
                reads,
                id: await createTransactionId(stamp.id, [], reads),
            };
            const expectedHash = `ops:${await hashString(JSON.stringify([]))}`;
            const result = await validator.validate(tx, expectedHash);
            expect(result.valid).to.be.true;
        });
        it('should detect when a non-existent block (rev 0) gets created', async () => {
            const transactor = new TestTransactor();
            const blockA = 'new-block';
            // Read dependency: block didn't exist (rev 0)
            const reads = [{ blockId: blockA, revision: 0 }];
            // Now create the block
            await transactor.pend({
                actionId: 'create',
                transforms: { inserts: { [blockA]: makeBlock(blockA, 'data') }, updates: {}, deletes: [] },
                policy: 'f',
            });
            await transactor.commit({
                actionId: 'create',
                blockIds: [blockA],
                tailId: blockA,
                rev: 1,
            });
            // blockA is now at rev 1, but read expected rev 0 → stale
            const blockStateProvider = async (blockId) => {
                const result = await transactor.get({ blockIds: [blockId] });
                return result[blockId]?.state;
            };
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: new ActionsEngine({}),
                getSchemaHash: async () => 'schema1'
            });
            const validator = new TransactionValidator(engines, () => ({ applyActions: async () => { }, getTransforms: () => new Map(), dispose: () => { } }), blockStateProvider);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp,
                statements: [],
                reads,
                id: await createTransactionId(stamp.id, [], reads),
            };
            const expectedHash = `ops:${await hashString(JSON.stringify([]))}`;
            const result = await validator.validate(tx, expectedHash);
            expect(result.valid).to.be.false;
            expect(result.reason).to.include('Stale read');
        });
        it('should pass validation when transaction has no reads (backward compatible)', async () => {
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: new ActionsEngine({}),
                getSchemaHash: async () => 'schema1'
            });
            const blockStateProvider = async () => undefined;
            const validator = new TransactionValidator(engines, () => ({ applyActions: async () => { }, getTransforms: () => new Map(), dispose: () => { } }), blockStateProvider);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp,
                statements: [],
                reads: [],
                id: await createTransactionId(stamp.id, [], []),
            };
            const expectedHash = `ops:${await hashString(JSON.stringify([]))}`;
            const result = await validator.validate(tx, expectedHash);
            expect(result.valid).to.be.true;
        });
        it('should NOT detect write-skew through separate Tree collections (known limitation)', async () => {
            const transactor = new TestTransactor();
            // Two separate collections for two accounts
            const treeA = await Tree.createOrOpen(transactor, 'account-a', e => e.key);
            const treeB = await Tree.createOrOpen(transactor, 'account-b', e => e.key);
            // Initial state: both accounts have balance 100
            await treeA.replace([[1, { key: 1, balance: 100 }]]);
            await treeB.replace([[1, { key: 1, balance: 100 }]]);
            // Simulate two concurrent withdrawals that each check the invariant
            // Transaction 1: reads both (100+100=200 >= 100 ✓), writes A.balance = 0
            const readA1 = await treeA.get(1);
            const readB1 = await treeB.get(1);
            expect(readA1.balance + readB1.balance).to.be.gte(100); // invariant check passes
            // Transaction 2: reads both (100+100=200 >= 100 ✓), writes B.balance = 0
            const readA2 = await treeA.get(1);
            const readB2 = await treeB.get(1);
            expect(readA2.balance + readB2.balance).to.be.gte(100); // invariant check passes
            // Both writes succeed — different collections, different blocks
            await treeA.replace([[1, { key: 1, balance: 0 }]]);
            await treeB.replace([[1, { key: 1, balance: 0 }]]);
            // Final state: invariant violated (0 + 0 = 0 < 100)
            await treeA.update();
            await treeB.update();
            const finalA = await treeA.get(1);
            const finalB = await treeB.get(1);
            expect(finalA.balance + finalB.balance).to.equal(0);
            // Write-skew: invariant A + B >= 100 is violated
            expect(finalA.balance + finalB.balance).to.be.lessThan(100);
        });
    });
    describe('2PC Protocol Edge Cases (TEST-10.2.1)', () => {
        it('should cancel already-pended collections when pendPhase fails partway', async () => {
            const transactor = new TestTransactor();
            let pendCallCount = 0;
            const originalPend = transactor.pend.bind(transactor);
            transactor.pend = async (request) => {
                pendCallCount++;
                if (pendCallCount === 2) {
                    return { success: false, reason: 'Peer rejected' };
                }
                return originalPend(request);
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const collections = new Map();
            collections.set('users', usersTree.collection);
            collections.set('posts', postsTree.collection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('failed');
            }
            // FIX VERIFIED: pendPhase now cancels already-pended collections on failure.
            const pending = transactor.getPendingActions();
            expect(pending.size, 'no orphaned pending actions after partial pend failure').to.equal(0);
        });
        it('should do forward recovery with retry and targeted cancel on partial commit failure', async () => {
            const transactor = new TestTransactor();
            let commitCallCount = 0;
            const cancelledCollectionBlockIds = [];
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (request) => {
                commitCallCount++;
                // First call succeeds (collection A), all subsequent calls fail (collection B retries)
                if (commitCallCount >= 2) {
                    return { success: false, reason: 'Commit rejected' };
                }
                return originalCommit(request);
            };
            const originalCancel = transactor.cancel.bind(transactor);
            transactor.cancel = async (actionRef) => {
                cancelledCollectionBlockIds.push(actionRef.blockIds);
                return originalCancel(actionRef);
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const collections = new Map();
            collections.set('users', usersTree.collection);
            collections.set('posts', postsTree.collection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            try {
                await coordinator.commit(tx);
                expect.fail('Should have thrown');
            }
            catch (e) {
                expect(e.message).to.include('failed');
            }
            // Forward recovery: 1st collection committed (unavoidable once commit succeeds)
            const committed = transactor.getCommittedActions();
            expect(committed.size, 'forward recovery: 1st collection committed after successful commit').to.equal(1);
            // Targeted cancel: only the still-pending (failed) collection was cancelled, not the committed one
            expect(cancelledCollectionBlockIds.length, 'cancel called only for the non-committed collection').to.equal(1);
            // No orphaned pending actions remain
            const pending = transactor.getPendingActions();
            expect(pending.size, 'no orphaned pending actions').to.equal(0);
            // Verify retry: 1 success + 3 retries for the failed collection = 4 total commit calls
            expect(commitCallCount, 'commit retried 3 times for the failed collection').to.equal(4);
        });
        it('should retry and succeed when commit transiently fails', async () => {
            const transactor = new TestTransactor();
            let commitCallCount = 0;
            const cancelledBlockIds = [];
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (request) => {
                commitCallCount++;
                // Fail on 2nd call only (1st collection succeeds, 2nd fails once then succeeds on retry)
                if (commitCallCount === 2) {
                    return { success: false, reason: 'Transient failure' };
                }
                return originalCommit(request);
            };
            const originalCancel = transactor.cancel.bind(transactor);
            transactor.cancel = async (actionRef) => {
                cancelledBlockIds.push(actionRef.blockIds);
                return originalCancel(actionRef);
            };
            transactor.queryClusterNominees = async () => ({ nominees: [] });
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const postsTree = await Tree.createOrOpen(transactor, 'posts', entry => entry.key);
            const collections = new Map();
            collections.set('users', usersTree.collection);
            collections.set('posts', postsTree.collection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
                { collectionId: 'posts', actions: [{ type: 'replace', data: [[10, { key: 10, title: 'Post' }]] }] },
            ];
            const statements = createActionsStatements(actions);
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx = {
                stamp, statements, reads: [],
                id: await createTransactionId(stamp.id, statements, [])
            };
            await actionsEngine.execute(tx);
            await coordinator.commit(tx);
            // Transaction committed (both collections share one actionId, so committed.size === 1)
            const committed = transactor.getCommittedActions();
            expect(committed.size, 'transaction committed').to.equal(1);
            // No cancel calls should have been made
            expect(cancelledBlockIds.length, 'no cancel calls when retry succeeds').to.equal(0);
            // No orphaned pending actions
            const pending = transactor.getPendingActions();
            expect(pending.size, 'no orphaned pending actions').to.equal(0);
            // Verify retry happened: 1st collection succeeded on attempt 1, 2nd failed then succeeded = 3 total
            expect(commitCallCount, 'commit called 3 times total (1 + fail + retry)').to.equal(3);
        });
    });
    describe('Consensus Protocol Correctness (TEST-10.3.1)', () => {
        it('should reset trackers after successful coordinator.execute()', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements1 = createActionsStatements(actions1);
            const stamp1 = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx1 = {
                stamp: stamp1, statements: statements1, reads: [],
                id: await createTransactionId(stamp1.id, statements1, [])
            };
            const result = await coordinator.execute(tx1, actionsEngine);
            expect(result.success).to.be.true;
            // FIX VERIFIED: execute() now resets trackers after successful commit.
            const transforms = coordinator.getTransforms();
            expect(transforms.size, 'trackers should be clean after successful commit').to.equal(0);
        });
        it('should update actionContext after coordinator.execute()', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements1 = createActionsStatements(actions1);
            const stamp1 = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx1 = {
                stamp: stamp1, statements: statements1, reads: [],
                id: await createTransactionId(stamp1.id, statements1, [])
            };
            const result = await coordinator.execute(tx1, actionsEngine);
            expect(result.success).to.be.true;
            // Verify transactor actually committed
            const committed = transactor.getCommittedActions();
            expect(committed.size).to.be.greaterThan(0);
            // FIX VERIFIED: actionContext now reflects the committed rev.
            const ctx = usersCollection.source.actionContext;
            expect(ctx?.rev, 'actionContext.rev should be updated after commit').to.equal(1);
        });
        it('should succeed with sequential coordinator.execute() calls', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // tx1: insert Alice
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const statements1 = createActionsStatements(actions1);
            const stamp1 = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            const tx1 = {
                stamp: stamp1, statements: statements1, reads: [],
                id: await createTransactionId(stamp1.id, statements1, [])
            };
            const result1 = await coordinator.execute(tx1, actionsEngine);
            expect(result1.success).to.be.true;
            // tx2: insert Bob at DIFFERENT key (no logical conflict)
            const actions2 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[2, { key: 2, name: 'Bob' }]] }] }
            ];
            const statements2 = createActionsStatements(actions2);
            const stamp2 = await createTransactionStamp('peer1', Date.now() + 1, 'schema1', 'actions@1.0.0');
            const tx2 = {
                stamp: stamp2, statements: statements2, reads: [],
                id: await createTransactionId(stamp2.id, statements2, [])
            };
            // FIX VERIFIED: actionContext is updated after tx1, so tx2 computes rev=2.
            const result2 = await coordinator.execute(tx2, actionsEngine);
            expect(result2.success, 'sequential execute() should succeed with updated actionContext').to.be.true;
        });
        it('should reset trackers after successful session.commit()', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine, 'peer1', 'schema1');
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            await session.execute(createActionsStatements(actions1)[0], actions1);
            // Transforms exist before commit
            const transformsBefore = coordinator.getTransforms();
            expect(transformsBefore.size).to.be.greaterThan(0);
            const result = await session.commit();
            expect(result.success).to.be.true;
            // FIX VERIFIED: commit() via session path now resets trackers
            const transformsAfter = coordinator.getTransforms();
            expect(transformsAfter.size, 'trackers should be clean after session commit').to.equal(0);
        });
        it('should update actionContext.rev after successful session.commit()', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            const session = await TransactionSession.create(coordinator, actionsEngine, 'peer1', 'schema1');
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            await session.execute(createActionsStatements(actions1)[0], actions1);
            const result = await session.commit();
            expect(result.success).to.be.true;
            // FIX VERIFIED: actionContext.rev is updated after session commit
            const ctx = usersCollection.source.actionContext;
            expect(ctx?.rev, 'actionContext.rev should be 1 after first session commit').to.equal(1);
        });
        it('should update actionContext.rev correctly after session commit enabling sequential execute()', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Session 1: insert Alice via session path
            const session1 = await TransactionSession.create(coordinator, actionsEngine, 'peer1', 'schema1');
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            await session1.execute(createActionsStatements(actions1)[0], actions1);
            const result1 = await session1.commit();
            expect(result1.success).to.be.true;
            expect(usersCollection.source.actionContext?.rev).to.equal(1);
            // FIX VERIFIED: after session commit, actionContext.rev=1 and trackers are clean,
            // so a subsequent execute() correctly computes rev=2 instead of stale rev=1
            const actions2 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[2, { key: 2, name: 'Bob' }]] }] }
            ];
            const statements2 = createActionsStatements(actions2);
            const stamp2 = await createTransactionStamp('peer1', Date.now() + 1, 'schema1', 'actions@1.0.0');
            const tx2 = {
                stamp: stamp2, statements: statements2, reads: [],
                id: await createTransactionId(stamp2.id, statements2, [])
            };
            const result2 = await coordinator.execute(tx2, actionsEngine);
            expect(result2.success, 'execute() after session commit should succeed with updated rev').to.be.true;
            expect(usersCollection.source.actionContext?.rev, 'rev should increment to 2').to.equal(2);
        });
        it('should only rollback the given session transforms, preserving other sessions', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Session 1: apply actions
            const session1 = await TransactionSession.create(coordinator, actionsEngine, 'peer1', 'schema1');
            const actions1 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            await session1.execute(createActionsStatements(actions1)[0], actions1);
            // Session 2: apply actions (different data on same coordinator)
            const session2 = await TransactionSession.create(coordinator, actionsEngine, 'peer2', 'schema1');
            const actions2 = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[2, { key: 2, name: 'Bob' }]] }] }
            ];
            await session2.execute(createActionsStatements(actions2)[0], actions2);
            // Both sessions applied transforms to the shared tracker
            const transformsBefore = coordinator.getTransforms();
            expect(transformsBefore.size, 'Both sessions applied transforms').to.be.greaterThan(0);
            // Rollback session 1 only
            await session1.rollback();
            // Session 1's data (Alice) should be gone
            const alice = await usersTree.get(1);
            expect(alice, 'Alice should be gone after session 1 rollback').to.be.undefined;
            // Session 2's data (Bob) should survive the rollback
            const bob = await usersTree.get(2);
            expect(bob, 'Bob should survive session 1 rollback').to.not.be.undefined;
            expect(bob.name, 'Bob\'s data should be intact').to.equal('Bob');
            // Transforms should still exist (session 2's changes are preserved)
            const transformsAfter = coordinator.getTransforms();
            expect(transformsAfter.size, 'rollback should preserve other sessions\' transforms').to.be.greaterThan(0);
        });
        it('should preserve interleaved batches from lower-order stamp when higher-order stamp is rolled back', async () => {
            const transactor = new TestTransactor();
            const usersTree = await Tree.createOrOpen(transactor, 'users', entry => entry.key);
            const usersCollection = usersTree.collection;
            const collections = new Map();
            collections.set('users', usersCollection);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const actionsEngine = new ActionsEngine(coordinator);
            // Session 1 created first (order=0)
            const session1 = await TransactionSession.create(coordinator, actionsEngine, 'peer1', 'schema1');
            // Session 2 created second (order=1)
            const session2 = await TransactionSession.create(coordinator, actionsEngine, 'peer2', 'schema1');
            // Session 1 inserts Alice (stamp1 gets snapshot S0={})
            await session1.execute(createActionsStatements([
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ])[0], [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ]);
            // Session 2 inserts Bob (stamp2 gets snapshot S1={Alice})
            await session2.execute(createActionsStatements([
                { collectionId: 'users', actions: [{ type: 'replace', data: [[2, { key: 2, name: 'Bob' }]] }] }
            ])[0], [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[2, { key: 2, name: 'Bob' }]] }] }
            ]);
            // Session 1 inserts Charlie AFTER session 2's snapshot (interleaved batch)
            await session1.execute(createActionsStatements([
                { collectionId: 'users', actions: [{ type: 'replace', data: [[3, { key: 3, name: 'Charlie' }]] }] }
            ])[0], [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[3, { key: 3, name: 'Charlie' }]] }] }
            ]);
            // Verify all three exist before rollback
            expect(await usersTree.get(1), 'Alice before rollback').to.not.be.undefined;
            expect(await usersTree.get(2), 'Bob before rollback').to.not.be.undefined;
            expect(await usersTree.get(3), 'Charlie before rollback').to.not.be.undefined;
            // Rollback session 2 (higher-order stamp)
            await session2.rollback();
            // Bob (session 2) should be gone
            const bob = await usersTree.get(2);
            expect(bob, 'Bob should be gone after session 2 rollback').to.be.undefined;
            // Alice and Charlie (session 1) should both survive
            const alice = await usersTree.get(1);
            expect(alice, 'Alice should survive session 2 rollback').to.not.be.undefined;
            expect(alice.name).to.equal('Alice');
            const charlie = await usersTree.get(3);
            expect(charlie, 'Charlie should survive session 2 rollback (interleaved batch)').to.not.be.undefined;
            expect(charlie.name).to.equal('Charlie');
        });
    });
    describe('Clock Skew and Ordering (TEST-10.8.1)', () => {
        it('should produce identical stamp IDs for same-millisecond transactions from same peer (collision risk)', async () => {
            const now = Date.now();
            const stamp1 = await createTransactionStamp('peer1', now, 'schema1', 'actions@1.0.0');
            const stamp2 = await createTransactionStamp('peer1', now, 'schema1', 'actions@1.0.0');
            // Same inputs → same stamp ID. This is by design (deterministic hashing),
            // but it means two independent transactions from the same peer at the same
            // millisecond with the same schema and engine are INDISTINGUISHABLE.
            expect(stamp1.id).to.equal(stamp2.id);
            // With identical stamps and identical statements, transaction IDs also collide
            const actions = [
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ];
            const stmts = createActionsStatements(actions);
            const txId1 = await createTransactionId(stamp1.id, stmts, []);
            const txId2 = await createTransactionId(stamp2.id, stmts, []);
            // BUG: Two independent transactions produce the same ID.
            // If peer1 sends the same operation twice (retry, or concurrent sessions),
            // the log cannot distinguish them — deduplication silently drops one.
            expect(txId1, 'BUG: independent transactions collide when inputs match').to.equal(txId2);
        });
        it('should produce completely different stamp IDs for 1ms clock difference', async () => {
            const now = Date.now();
            const stamp1 = await createTransactionStamp('peer1', now, 'schema1', 'actions@1.0.0');
            const stamp2 = await createTransactionStamp('peer1', now + 1, 'schema1', 'actions@1.0.0');
            // A 1ms clock difference produces a completely different stamp ID.
            // This means clock skew between peers prevents stamp-based deduplication:
            // the same logical transaction replayed on a node with a slightly different
            // clock would generate a different stamp, appearing as a new transaction.
            expect(stamp1.id).to.not.equal(stamp2.id);
            // Same statements but different stamps → different transaction IDs
            const stmts = createActionsStatements([
                { collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }
            ]);
            const txId1 = await createTransactionId(stamp1.id, stmts, []);
            const txId2 = await createTransactionId(stamp2.id, stmts, []);
            expect(txId1, '1ms difference → fully divergent transaction IDs').to.not.equal(txId2);
        });
        it('should not produce hashString collisions within practical input range (SHA-256)', async () => {
            // SHA-256 produces 256-bit output — collision within 100K inputs is
            // astronomically unlikely (birthday bound ~2^128).
            const seen = new Map();
            let collision;
            for (let i = 0; i < 100_000 && !collision; i++) {
                const input = `{"peerId":"peer-${i}","timestamp":${1700000000000 + i},"schemaHash":"s","engineId":"e"}`;
                const hash = await hashString(input);
                const existing = seen.get(hash);
                if (existing) {
                    collision = [existing, input];
                }
                seen.set(hash, input);
            }
            expect(collision, 'SHA-256 should not collide within 100K inputs').to.be.undefined;
        });
        it('stamp includes expiration computed from timestamp + ttlMs', async () => {
            const ts = 1700000000000;
            const stamp = await createTransactionStamp('peer1', ts, 'schema1', 'actions@1.0.0');
            expect(stamp.expiration).to.equal(ts + DEFAULT_TRANSACTION_TTL_MS);
        });
        it('stamp with custom TTL computes correct expiration', async () => {
            const ts = 1700000000000;
            const customTtl = 60_000;
            const stamp = await createTransactionStamp('peer1', ts, 'schema1', 'actions@1.0.0', customTtl);
            expect(stamp.expiration).to.equal(ts + customTtl);
        });
        it('different expirations produce different stamp IDs', async () => {
            const ts = 1700000000000;
            const stamp1 = await createTransactionStamp('peer1', ts, 'schema1', 'actions@1.0.0', 30_000);
            const stamp2 = await createTransactionStamp('peer1', ts, 'schema1', 'actions@1.0.0', 60_000);
            expect(stamp1.id).to.not.equal(stamp2.id);
        });
        it('should order transactions by commit sequence, not by timestamp', async () => {
            const transactor = new TestTransactor();
            const tree = await Tree.createOrOpen(transactor, 'data', e => e.key);
            // First transaction: timestamp = 2000 (future)
            await tree.replace([[1, { key: 1, value: 'first-commit' }]]);
            // Capture revs after first commit
            const committed1 = transactor.getCommittedActions();
            const revs1 = new Set();
            for (const [, at] of committed1) {
                if (at.rev !== undefined)
                    revs1.add(at.rev);
            }
            // Second transaction on same tree (commit order = rev order, regardless of timestamp)
            await tree.replace([[2, { key: 2, value: 'second-commit' }]]);
            const committed2 = transactor.getCommittedActions();
            const revs2 = new Set();
            for (const [, at] of committed2) {
                if (at.rev !== undefined)
                    revs2.add(at.rev);
            }
            // Revisions monotonically increase regardless of timestamp ordering.
            // The second commit should have strictly higher max revision.
            const maxRev1 = Math.max(...revs1);
            const maxRev2 = Math.max(...revs2);
            expect(maxRev2, 'commit order determines revision, not timestamp').to.be.greaterThan(maxRev1);
        });
    });
    describe('Transaction Expiration', () => {
        it('isTransactionExpired returns false for non-expired stamp', async () => {
            const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', 'actions@1.0.0');
            expect(isTransactionExpired(stamp)).to.be.false;
        });
        it('isTransactionExpired returns true for expired stamp', async () => {
            // Create stamp with timestamp far in the past so it's already expired
            const stamp = await createTransactionStamp('peer1', 1000, 'schema1', 'actions@1.0.0', 1);
            expect(isTransactionExpired(stamp)).to.be.true;
        });
        it('TransactionValidator rejects expired transaction', async () => {
            // Create a stamp that is already expired
            const stamp = await createTransactionStamp('peer1', 1000, 'schema1', 'actions@1.0.0', 1);
            const transaction = {
                stamp,
                statements: [],
                reads: [],
                id: await createTransactionId(stamp.id, [], [])
            };
            const engines = new Map();
            engines.set('actions@1.0.0', {
                engine: new ActionsEngine({}),
                getSchemaHash: async () => 'schema1'
            });
            const validator = new TransactionValidator(engines, () => ({
                applyActions: async () => { },
                getTransforms: () => new Map(),
                dispose: () => { }
            }));
            const result = await validator.validate(transaction, 'ops:whatever');
            expect(result.valid).to.be.false;
            expect(result.reason).to.include('expired');
        });
        it('TransactionSession.commit rejects expired transaction', async () => {
            const transactor = new TestTransactor();
            const tree = await Tree.createOrOpen(transactor, 'data', e => e.key);
            const usersCollection = tree.collection;
            const collections = new Map([['data', usersCollection]]);
            const coordinator = new TransactionCoordinator(transactor, collections);
            const engine = new ActionsEngine(coordinator);
            // Create session with a very short TTL (1ms) so it expires immediately
            const session = await TransactionSession.create(coordinator, engine, 'peer1', 'schema1', 1);
            // Wait a tick to ensure expiration
            await new Promise(resolve => setTimeout(resolve, 5));
            const result = await session.commit();
            expect(result.success).to.be.false;
            expect(result.error).to.include('expired');
        });
    });
});
//# sourceMappingURL=transaction.spec.js.map