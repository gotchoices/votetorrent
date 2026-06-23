import type { Libp2p } from 'libp2p';
import { type Libp2pTransports, type NodeOptions, type RawStorageProvider } from './libp2p-node-base.js';
export type { Libp2pTransports, NodeOptions, RawStorageProvider };
/**
 * React Native-friendly libp2p node factory.
 *
 * This entrypoint intentionally does not import Node-only transports (like `@libp2p/tcp`).
 * Callers must provide `options.transports` (and typically `options.listenAddrs`).
 */
export declare function createLibp2pNode(options: NodeOptions): Promise<Libp2p>;
//# sourceMappingURL=libp2p-node-rn.d.ts.map