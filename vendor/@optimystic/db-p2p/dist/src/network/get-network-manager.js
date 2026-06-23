import { createLogger } from '../logger.js';
const log = createLogger('network:get-manager');
export function getNetworkManager(node) {
    const svc = node.services?.networkManager;
    if (svc == null) {
        throw new Error('networkManager service is not registered on this libp2p node');
    }
    // Provide libp2p reference early to avoid MissingServiceError from components accessor
    try {
        svc.setLibp2p?.(node);
    }
    catch (err) {
        log('getNetworkManager setLibp2p failed - %o', err);
    }
    return svc;
}
//# sourceMappingURL=get-network-manager.js.map