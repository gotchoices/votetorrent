import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { clusterService } from './cluster/service.js';
import { repoService } from './repo/service.js';
import { StorageRepo } from './storage/storage-repo.js';
import { BlockStorage } from './storage/block-storage.js';
import { MemoryRawStorage } from './storage/memory-storage.js';
import { clusterMember } from './cluster/cluster-repo.js';
import { coordinatorRepo } from './repo/coordinator-repo.js';
import { Libp2pKeyPeerNetwork } from './libp2p-key-network.js';
import { ClusterClient } from './cluster/client.js';
import { networkManagerService } from './network/network-manager-service.js';
import { fretService } from 'p2p-fret';
import { syncService } from './sync/service.js';
import { SyncClient } from './sync/client.js';
import { RestorationCoordinator } from './storage/restoration-coordinator-v2.js';
import { RingSelector } from './storage/ring-selector.js';
import { StorageMonitor } from './storage/storage-monitor.js';
import { ArachnodeFretAdapter } from './storage/arachnode-fret-adapter.js';
import { PartitionDetector } from './cluster/partition-detector.js';
import { PeerReputationService } from './reputation/peer-reputation.js';
import { DisputeService } from './dispute/dispute-service.js';
import { DisputeClient } from './dispute/client.js';
function resolveStorage(provider) {
    if (!provider) {
        return new MemoryRawStorage();
    }
    return typeof provider === 'function' ? provider() : provider;
}
export async function createLibp2pNodeBase(options, defaults) {
    const rawStorage = resolveStorage(options.storage);
    // Create placeholder restore callback (will be replaced after node starts)
    let restoreCallback = async (_blockId, _rev) => {
        return undefined;
    };
    // Create shared storage layers with restoration callback
    const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage, restoreCallback));
    let clusterImpl;
    let coordinatedRepo;
    const clusterProxy = {
        async update(record) {
            if (!clusterImpl) {
                throw new Error('ClusterMember not initialized');
            }
            return await clusterImpl.update(record);
        }
    };
    const repoProxy = {
        async get(blockGets, options) {
            const target = coordinatedRepo ?? storageRepo;
            return await target.get(blockGets, options);
        },
        async pend(request, options) {
            const target = coordinatedRepo ?? storageRepo;
            return await target.pend(request, options);
        },
        async cancel(trxRef, options) {
            const target = coordinatedRepo ?? storageRepo;
            return await target.cancel(trxRef, options);
        },
        async commit(request, options) {
            const target = coordinatedRepo ?? storageRepo;
            return await target.commit(request, options);
        }
    };
    const nodePrivateKey = options.privateKey ?? await generateKeyPair('Ed25519');
    const listenAddrs = options.listenAddrs ?? defaults.listenAddrs;
    const transports = options.transports ?? defaults.transports;
    const libp2pOptions = {
        start: false,
        privateKey: nodePrivateKey,
        addresses: {
            listen: listenAddrs
        },
        connectionManager: {
            autoDial: true,
            minConnections: 1,
            maxConnections: 16,
            inboundConnectionUpgradeTimeout: 10_000,
            dialQueue: { concurrency: 2, attempts: 2 }
        },
        ...(options.connectionGater ? { connectionGater: options.connectionGater } : {}),
        transports,
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify({
                protocolPrefix: `/optimystic/${options.networkName}`
            }),
            ping: ping(),
            pubsub: gossipsub({
                allowPublishToZeroTopicPeers: true,
                heartbeatInterval: 7000
            }),
            // Circuit relay server - enables this node to relay connections for other peers
            ...(options.relay ? { relay: circuitRelayServer(options.relayServerInit) } : {}),
            // Custom services - create wrapper factories that inject dependencies
            cluster: (components) => {
                const serviceFactory = clusterService({
                    protocolPrefix: `/optimystic/${options.networkName}`,
                    configuredClusterSize: options.clusterSize ?? 10,
                    allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
                    clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
                    responsibilityK: options.responsibilityK ?? 1
                });
                return serviceFactory({
                    logger: components.logger,
                    registrar: components.registrar,
                    cluster: clusterProxy
                });
            },
            repo: (components) => {
                const serviceFactory = repoService({
                    protocolPrefix: `/optimystic/${options.networkName}`,
                    responsibilityK: options.responsibilityK ?? 1
                });
                return serviceFactory({
                    logger: components.logger,
                    registrar: components.registrar,
                    repo: repoProxy
                });
            },
            sync: (components) => {
                const serviceFactory = syncService({
                    protocolPrefix: `/optimystic/${options.networkName}`
                });
                return serviceFactory({
                    logger: components.logger,
                    registrar: components.registrar,
                    repo: repoProxy
                });
            },
            networkManager: (components) => {
                const svcFactory = networkManagerService({
                    clusterSize: options.clusterSize ?? 10,
                    expectedRemotes: (options.bootstrapNodes?.length ?? 0) > 0,
                    allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
                    clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5
                });
                const svc = svcFactory(components);
                try {
                    svc.setLibp2p?.(components.libp2p);
                }
                catch { }
                return svc;
            },
            fret: (components) => {
                const svcFactory = fretService({
                    k: 15,
                    m: 8,
                    capacity: 2048,
                    profile: options.fretProfile ?? ((options.bootstrapNodes?.length ?? 0) > 0 ? 'core' : 'edge'),
                    networkName: options.networkName,
                    bootstraps: options.bootstrapNodes ?? []
                });
                const svc = svcFactory(components);
                try {
                    svc.setLibp2p(components.libp2p);
                }
                catch { }
                return svc;
            }
        },
        // Add bootstrap nodes as needed
        peerDiscovery: [
            ...(options.bootstrapNodes?.length ? [bootstrap({ list: options.bootstrapNodes })] : [])
        ],
    };
    const node = await createLibp2p(libp2pOptions);
    // Inject libp2p reference into services that need it before start
    try {
        node.services?.fret?.setLibp2p?.(node);
    }
    catch { }
    try {
        node.services?.networkManager?.setLibp2p?.(node);
    }
    catch { }
    await node.start();
    // Initialize peer reputation service
    const reputation = new PeerReputationService();
    // Initialize cluster coordination components
    const networkMode = (options.bootstrapNodes?.length ?? 0) > 0 ? 'joining' : 'forming';
    const keyNetwork = new Libp2pKeyPeerNetwork(node, options.clusterSize, undefined, networkMode, options.persistence, reputation);
    await keyNetwork.initFromPersistedState();
    const protocolPrefix = `/optimystic/${options.networkName}`;
    const createClusterClient = (peerId) => ClusterClient.create(peerId, keyNetwork, protocolPrefix);
    // Inject reputation into NetworkManagerService
    try {
        node.services?.networkManager?.setReputation?.(reputation);
    }
    catch { }
    // Create partition detector and get FRET service
    const partitionDetector = new PartitionDetector();
    const fretSvc = node.services?.fret;
    const consensusConfig = {
        superMajorityThreshold: options.clusterPolicy?.superMajorityThreshold ?? 0.67,
        simpleMajorityThreshold: 0.51,
        minAbsoluteClusterSize: 2,
        allowClusterDownsize: options.clusterPolicy?.allowDownsize ?? true,
        clusterSizeTolerance: options.clusterPolicy?.sizeTolerance ?? 0.5,
        partitionDetectionWindow: 60000
    };
    clusterImpl = clusterMember({
        storageRepo,
        peerNetwork: keyNetwork,
        peerId: node.peerId,
        privateKey: nodePrivateKey,
        protocolPrefix,
        partitionDetector,
        fretService: fretSvc,
        validator: options.validator,
        reputation,
        consensusConfig,
        stateStore: options.transactionStateStore
    });
    const coordinatorRepoFactory = coordinatorRepo(keyNetwork, createClusterClient, {
        clusterSize: options.clusterSize ?? 10,
        ...consensusConfig
    }, fretSvc, reputation, options.transactionStateStore);
    // Create callback for querying cluster peers for their latest block revision
    const clusterLatestCallback = async (peerId, blockId, context) => {
        // Self-read short-circuit: dialling self via SyncClient is a round trip
        // with no remote on the other end, and on nodes without listen addresses
        // (solo WebSocket-only, bare-RN, etc.) the self-dial can hang the dial
        // queue. Read directly from the local storage repo instead.
        if (peerId.equals(node.peerId)) {
            try {
                const result = await storageRepo.get({ blockIds: [blockId], context });
                return result[blockId]?.state?.latest;
            }
            catch {
                return undefined;
            }
        }
        const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix);
        try {
            const response = await syncClient.requestBlock({ blockId, rev: undefined });
            if (response.success && response.archive) {
                const revisions = Object.keys(response.archive.revisions).map(Number);
                if (revisions.length > 0) {
                    const maxRev = Math.max(...revisions);
                    const revisionData = response.archive.revisions[maxRev];
                    if (revisionData?.action) {
                        return { actionId: revisionData.action.actionId, rev: maxRev };
                    }
                }
            }
        }
        catch {
            // Peer may be unreachable - return undefined to skip this peer
        }
        return undefined;
    };
    coordinatedRepo = coordinatorRepoFactory({
        storageRepo,
        localCluster: clusterImpl,
        localPeerId: node.peerId,
        clusterLatestCallback
    });
    // Recover persisted transaction state before accepting new requests
    if (options.transactionStateStore) {
        await clusterImpl.recoverTransactions();
        await coordinatedRepo.recoverTransactions();
    }
    // Initialize Arachnode ring membership and restoration
    const enableArachnode = options.arachnode?.enableRingZulu ?? true;
    if (enableArachnode) {
        const log = node.logger?.forComponent?.('db-p2p:arachnode');
        const fret = node.services?.fret;
        if (fret) {
            const fretAdapter = new ArachnodeFretAdapter(fret);
            const storageMonitor = new StorageMonitor(rawStorage, options.arachnode?.storage ?? {});
            const ringSelector = new RingSelector(fretAdapter, storageMonitor, {
                minCapacity: 100 * 1024 * 1024,
                thresholds: {
                    moveOut: 0.85,
                    moveIn: 0.40
                }
            });
            // Determine and announce ring membership
            const peerId = node.peerId.toString();
            const arachnodeInfo = await ringSelector.createArachnodeInfo(peerId);
            fretAdapter.setArachnodeInfo(arachnodeInfo);
            log?.('Announced Arachnode membership: Ring %d', arachnodeInfo.ringDepth);
            // Setup restoration coordinator with FRET adapter
            const restorationCoordinatorV2 = new RestorationCoordinator(fretAdapter, { connect: (pid, protocol) => node.dialProtocol(pid, [protocol]) }, `/optimystic/${options.networkName}`, node.peerId.toString());
            // Update restore callback to use new coordinator
            const newRestoreCallback = async (blockId, rev) => {
                return await restorationCoordinatorV2.restore(blockId, rev);
            };
            // Replace the restore callback (this is a bit hacky, but works for now)
            storageRepo.createBlockStorage = (blockId) => new BlockStorage(blockId, rawStorage, newRestoreCallback);
            // Monitor capacity and adjust ring periodically
            const monitorInterval = setInterval(async () => {
                const transition = await ringSelector.shouldTransition();
                if (transition.shouldMove) {
                    log?.('Ring transition needed: moving %s to Ring %d', transition.direction, transition.newRingDepth);
                    // Update Arachnode info with new ring
                    const updatedInfo = await ringSelector.createArachnodeInfo(peerId);
                    fretAdapter.setArachnodeInfo(updatedInfo);
                }
            }, 60_000);
            // Cleanup on node stop
            const originalStop = node.stop.bind(node);
            node.stop = async () => {
                clearInterval(monitorInterval);
                await originalStop();
            };
        }
        else {
            log?.('FRET service not available, Arachnode disabled');
        }
    }
    // Initialize dispute service if enabled
    let disputeServiceInstance;
    if (options.dispute?.disputeEnabled) {
        const createDisputeClient = (peerId) => DisputeClient.create(peerId, keyNetwork, protocolPrefix);
        disputeServiceInstance = new DisputeService({
            peerId: node.peerId,
            privateKey: nodePrivateKey,
            peerNetwork: keyNetwork,
            createDisputeClient,
            reputation,
            validator: options.validator,
            config: options.dispute,
            selectArbitrators: async (blockId, excludePeers, count) => {
                const { hashKey: fretHashKey } = await import('p2p-fret');
                const blockIdBytes = new TextEncoder().encode(blockId);
                const fret = node.services?.fret;
                if (!fret)
                    return [];
                // Get a larger cohort and exclude the original cluster peers
                const cohortSize = count + excludePeers.length + 1;
                const hashedCoord = await fretHashKey(blockIdBytes);
                const allPeerIdStrs = fret.assembleCohort(hashedCoord, cohortSize);
                // Filter out original cluster peers and self, convert to PeerId
                const excludeSet = new Set(excludePeers);
                excludeSet.add(node.peerId.toString());
                const arbitratorPeerIds = allPeerIdStrs
                    .filter(pid => !excludeSet.has(pid))
                    .slice(0, count)
                    .map(pid => peerIdFromString(pid));
                return arbitratorPeerIds;
            },
        });
    }
    // Cleanup cluster member intervals on node stop
    {
        const previousStop = node.stop.bind(node);
        node.stop = async () => {
            clusterImpl.dispose();
            await previousStop();
        };
    }
    // Expose coordinated repo and storage for external use
    node.coordinatedRepo = coordinatedRepo;
    node.storageRepo = storageRepo;
    node.keyNetwork = keyNetwork;
    node.reputation = reputation;
    node.disputeService = disputeServiceInstance;
    return node;
}
//# sourceMappingURL=libp2p-node-base.js.map