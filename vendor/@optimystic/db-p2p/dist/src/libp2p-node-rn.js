import { createLibp2pNodeBase, } from './libp2p-node-base.js';
/**
 * React Native-friendly libp2p node factory.
 *
 * This entrypoint intentionally does not import Node-only transports (like `@libp2p/tcp`).
 * Callers must provide `options.transports` (and typically `options.listenAddrs`).
 */
export async function createLibp2pNode(options) {
    const transports = options.transports;
    if (!transports || transports.length === 0) {
        throw new Error('createLibp2pNode (RN) requires options.transports. ' +
            'Provide an RN-compatible transport (e.g. WebSockets) and any required listenAddrs.');
    }
    return await createLibp2pNodeBase(options, {
        listenAddrs: [],
        transports,
    });
}
//# sourceMappingURL=libp2p-node-rn.js.map