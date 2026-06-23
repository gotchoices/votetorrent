import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { ProtocolClient } from '../protocol-client.js';
import { createLogger } from '../logger.js';
const log = createLogger('block-transfer-service');
/** Protocol path */
const BLOCK_TRANSFER_PREFIX = '/db-p2p/block-transfer/';
const BLOCK_TRANSFER_VERSION = '1.0.0';
export const buildBlockTransferProtocol = (protocolPrefix = '') => `${protocolPrefix}${BLOCK_TRANSFER_PREFIX}${BLOCK_TRANSFER_VERSION}`;
/**
 * Libp2p service that handles incoming block transfer requests.
 *
 * Responds to pull requests by reading blocks from local storage.
 * Handles push requests by accepting block data and storing it locally.
 */
export class BlockTransferService {
    running = false;
    protocol;
    repo;
    registrar;
    constructor(components, init = {}) {
        this.protocol = buildBlockTransferProtocol(init.protocolPrefix ?? '');
        this.repo = components.repo;
        this.registrar = components.registrar;
    }
    async start() {
        if (this.running)
            return;
        await this.registrar.handle(this.protocol, async (data) => {
            await this.handleRequest(data.stream);
        });
        this.running = true;
        log('started on %s', this.protocol);
    }
    async stop() {
        if (!this.running)
            return;
        await this.registrar.unhandle(this.protocol);
        this.running = false;
        log('stopped');
    }
    async handleRequest(stream) {
        try {
            const request = await this.readRequest(stream);
            log('request type=%s blocks=%d reason=%s', request.type, request.blockIds.length, request.reason);
            let response;
            if (request.type === 'pull') {
                response = await this.handlePull(request);
            }
            else {
                response = await this.handlePush(request);
            }
            await this.sendResponse(stream, response);
            log('response blocks=%d missing=%d', Object.keys(response.blocks).length, response.missing.length);
        }
        catch (error) {
            log('error: %s', error.message);
            try {
                await this.sendResponse(stream, { blocks: {}, missing: [] });
            }
            catch {
                // ignore send errors
            }
        }
        finally {
            try {
                await stream.close();
            }
            catch { /* ignore */ }
        }
    }
    async handlePull(request) {
        const blocks = {};
        const missing = [];
        const result = await this.repo.get({ blockIds: request.blockIds });
        for (const blockId of request.blockIds) {
            const blockResult = result[blockId];
            if (blockResult?.block) {
                blocks[blockId] = Buffer.from(JSON.stringify(blockResult.block)).toString('base64');
            }
            else {
                missing.push(blockId);
            }
        }
        return { blocks, missing };
    }
    // TODO: handlePush validates incoming block data but does not persist it.
    // The pushed data is a serialized IBlock, not a full BlockArchive with revisions.
    // Persistence should be wired when RebalanceMonitor integrates with BlockStorage.saveRestored().
    async handlePush(request) {
        const blocks = {};
        const missing = [];
        if (!request.blockData) {
            return { blocks: {}, missing: request.blockIds };
        }
        // Accept pushed blocks — for each block, validate we received parseable data
        for (const blockId of request.blockIds) {
            const data = request.blockData[blockId];
            if (data) {
                // Verify we received valid data
                try {
                    JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
                    blocks[blockId] = data;
                }
                catch {
                    missing.push(blockId);
                }
            }
            else {
                missing.push(blockId);
            }
        }
        return { blocks, missing };
    }
    async readRequest(stream) {
        const messages = [];
        await pipe(stream, lp.decode, async (source) => {
            for await (const msg of source) {
                messages.push(msg.subarray());
            }
        });
        if (messages.length === 0) {
            throw new Error('No request received');
        }
        return JSON.parse(u8ToString(messages[0], 'utf8'));
    }
    async sendResponse(stream, response) {
        const bytes = u8FromString(JSON.stringify(response), 'utf8');
        const encoded = pipe([bytes], lp.encode);
        for await (const chunk of encoded) {
            stream.send(chunk);
        }
    }
}
/** Factory for creating BlockTransferService following the libp2p service pattern. */
export const blockTransferService = (init = {}) => (components) => new BlockTransferService(components, init);
// --- Client ---
/**
 * Client for sending block transfer requests to remote peers.
 */
export class BlockTransferClient extends ProtocolClient {
    protocol;
    constructor(peerId, peerNetwork, protocolPrefix = '') {
        super(peerId, peerNetwork);
        this.protocol = buildBlockTransferProtocol(protocolPrefix);
    }
    /** Pull blocks from the remote peer. */
    async pullBlocks(blockIds, reason = 'rebalance') {
        const request = { type: 'pull', blockIds, reason };
        return await this.processMessage(request, this.protocol);
    }
    /** Push blocks to the remote peer. */
    async pushBlocks(blockIds, blockDataBuffers, reason = 'rebalance') {
        const blockData = {};
        for (let i = 0; i < blockIds.length; i++) {
            blockData[blockIds[i]] = Buffer.from(blockDataBuffers[i]).toString('base64');
        }
        const request = { type: 'push', blockIds, reason, blockData };
        return await this.processMessage(request, this.protocol);
    }
}
//# sourceMappingURL=block-transfer-service.js.map