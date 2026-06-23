import debug from 'debug';
const BASE_NAMESPACE = 'optimystic:db-p2p-storage-rn';
export function createLogger(subNamespace) {
    return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}
//# sourceMappingURL=logger.js.map