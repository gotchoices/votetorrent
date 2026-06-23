import { createLibp2p, type Libp2p } from 'libp2p';
import { type CircuitRelayServerInit } from '@libp2p/circuit-relay-v2';
import type { ConnectionGater, PrivateKey } from '@libp2p/interface';
import type { IRawStorage } from './storage/i-raw-storage.js';
import { type NetworkStatePersistence } from './libp2p-key-network.js';
import type { ITransactionValidator } from '@optimystic/db-core';
import type { ITransactionStateStore } from './cluster/i-transaction-state-store.js';
import type { StorageMonitorConfig } from './storage/storage-monitor.js';
import type { DisputeConfig } from './dispute/types.js';
type Libp2pInit = NonNullable<Parameters<typeof createLibp2p>[0]>;
export type Libp2pTransports = NonNullable<Libp2pInit['transports']>;
/** Factory function or instance for creating raw storage */
export type RawStorageProvider = IRawStorage | (() => IRawStorage);
export type NodeOptions = {
    /**
     * Network port. Only used by the default `listenAddrs` fallback.
     * For non-TCP transports (e.g. WebSockets), set `listenAddrs` explicitly.
     */
    port?: number;
    /**
     * WebSocket listen port. When set, the Node `createLibp2pNode` defaulting
     * branch adds `webSockets()` to the transports and `/ip4/<wsHost>/tcp/<wsPort>/ws`
     * to the listen addrs. Browsers and other WS-only peers (RN, web) can dial here.
     * Ignored when `transports`/`listenAddrs` are explicitly provided.
     */
    wsPort?: number;
    /** Interface to bind the WS listener to. Defaults to `0.0.0.0`. */
    wsHost?: string;
    /**
     * Drop the default TCP transport and TCP listen addr. Useful for browser-only
     * bootstraps that listen on `/ws` (typically fronted as `/wss`) only.
     * Ignored when `transports`/`listenAddrs` are explicitly provided.
     */
    disableTcp?: boolean;
    bootstrapNodes: string[];
    networkName: string;
    fretProfile?: 'edge' | 'core';
    id?: string;
    relay?: boolean;
    /**
     * Init passed to `circuitRelayServer(...)` when `relay` is enabled.
     *
     * `@libp2p/circuit-relay-v2` defaults to `applyDefaultLimit: true`, which
     * stamps every reservation with `Limit { data: 128 KiB, duration: 2 min }`
     * and resets the relayed stream once either cap is hit — silently killing
     * long-lived service↔browser circuits. Trusted local clusters (e.g. the
     * reference-peer service nodes) should pass
     * `{ reservations: { applyDefaultLimit: false } }` to lift the cap.
     */
    relayServerInit?: CircuitRelayServerInit;
    /** Storage provider - either an IRawStorage instance or a factory function. Defaults to MemoryRawStorage if not provided. */
    storage?: RawStorageProvider;
    clusterSize?: number;
    clusterPolicy?: {
        allowDownsize?: boolean;
        sizeTolerance?: number;
        superMajorityThreshold?: number;
    };
    /** Override libp2p listen multiaddrs. */
    listenAddrs?: string[];
    /** Override libp2p transports. */
    transports?: Libp2pTransports;
    /**
     * Responsibility K - the replica set size for determining cluster membership.
     * This is distinct from kBucketSize (DHT routing) and clusterSize (consensus quorum).
     * When a node receives a request, it checks if it's in the top responsibilityK
     * peers (by XOR distance) for the key. If not, it redirects to closer peers.
     * Default: 1 (only the closest peer is responsible)
     */
    responsibilityK?: number;
    /** Arachnode storage configuration */
    arachnode?: {
        enableRingZulu?: boolean;
        storage?: StorageMonitorConfig;
    };
    /** Transaction validator for cluster consensus */
    validator?: ITransactionValidator;
    /** Optional persistence for network state (HWM, FRET table) across restarts */
    persistence?: NetworkStatePersistence;
    /** Dispute protocol configuration */
    dispute?: Partial<DisputeConfig>;
    /** Optional persistent store for 2PC transaction state (enables crash recovery) */
    transactionStateStore?: ITransactionStateStore;
    /**
     * Optional Ed25519 private key for this node. When provided, the libp2p
     * node uses this identity instead of generating a fresh keypair. Use this
     * to persist peer identity across process restarts.
     *
     * Accepts a libp2p `PrivateKey` (as returned by `generateKeyPair('Ed25519')`
     * or `privateKeyFromProtobuf(...)` from `@libp2p/crypto/keys`).
     */
    privateKey?: PrivateKey;
    /**
     * Optional libp2p connection gater. The libp2p browser default denies
     * dialing insecure WebSockets and private/loopback addresses; callers
     * that need to dial local or unsecured bootstraps (web reference dev,
     * Playwright e2e, RN simulators) supply a permissive gater here.
     */
    connectionGater?: ConnectionGater;
};
export declare function createLibp2pNodeBase(options: NodeOptions, defaults: {
    listenAddrs: string[];
    transports: Libp2pTransports;
}): Promise<Libp2p>;
export {};
//# sourceMappingURL=libp2p-node-base.d.ts.map