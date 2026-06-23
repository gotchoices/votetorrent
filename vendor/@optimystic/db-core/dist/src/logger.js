import debug from 'debug';
const BASE_NAMESPACE = 'optimystic:db-core';
export function createLogger(subNamespace) {
    return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}
export const verbose = typeof process !== 'undefined'
    && (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
//# sourceMappingURL=logger.js.map