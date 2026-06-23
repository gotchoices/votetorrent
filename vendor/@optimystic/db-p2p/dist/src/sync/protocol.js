/** Sync protocol prefix - namespaced under db-p2p */
export const SYNC_PROTOCOL_PREFIX = '/db-p2p/sync/';
/** Sync protocol version */
export const SYNC_PROTOCOL_VERSION = '1.0.0';
/**
 * Builds the full protocol string for the sync protocol.
 *
 * @param protocolPrefix - Optional prefix (e.g., '/optimystic/testnet')
 * @returns Full protocol string
 */
export const buildSyncProtocol = (protocolPrefix = '') => `${protocolPrefix}${SYNC_PROTOCOL_PREFIX}${SYNC_PROTOCOL_VERSION}`;
//# sourceMappingURL=protocol.js.map