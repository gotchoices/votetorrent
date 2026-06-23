import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNodeBase, } from './libp2p-node-base.js';
export async function createLibp2pNode(options) {
    const port = options.port ?? 0;
    const wsHost = options.wsHost ?? '0.0.0.0';
    const defaultTransports = [];
    const defaultListenAddrs = [];
    if (!options.disableTcp) {
        defaultTransports.push(tcp());
        defaultListenAddrs.push(`/ip4/0.0.0.0/tcp/${port}`);
    }
    if (options.wsPort !== undefined) {
        defaultTransports.push(webSockets());
        defaultListenAddrs.push(`/ip4/${wsHost}/tcp/${options.wsPort}/ws`);
    }
    // Always include the relay transport so this node can dial through relays
    defaultTransports.push(circuitRelayTransport());
    return await createLibp2pNodeBase(options, {
        listenAddrs: defaultListenAddrs,
        transports: defaultTransports,
    });
}
//# sourceMappingURL=libp2p-node.js.map