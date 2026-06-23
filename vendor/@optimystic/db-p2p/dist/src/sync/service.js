import { buildSyncProtocol } from './protocol.js';
import { pipe } from 'it-pipe';
import { toString as u8ToString } from 'uint8arrays/to-string';
import * as lp from 'it-length-prefixed';
/**
 * Service for handling incoming sync requests from other cluster peers.
 *
 * Listens on the sync protocol and responds to block requests by:
 * 1. Extracting the block from local storage
 * 2. Building a BlockArchive with requested revisions
 * 3. Sending the response back to the requester
 *
 * This is the server-side of the block restoration mechanism.
 */
export class SyncService {
    running = false;
    log;
    protocol;
    repo;
    registrar;
    constructor(components, init = {}) {
        this.log = components.logger.forComponent('db-p2p:sync-service');
        this.protocol = buildSyncProtocol(init.protocolPrefix ?? '');
        this.repo = components.repo;
        this.registrar = components.registrar;
    }
    async start() {
        if (this.running)
            return;
        await this.registrar.handle(this.protocol, this.handleSyncRequest.bind(this));
        this.running = true;
        this.log('Sync service started on protocol %s', this.protocol);
    }
    async stop() {
        if (!this.running)
            return;
        await this.registrar.unhandle(this.protocol);
        this.running = false;
        this.log('Sync service stopped');
    }
    /**
     * Handle an incoming sync request stream.
     * Uses a streaming pipeline (like the repo service) to process the
     * first request and yield a response without waiting for the client
     * to close its write side — avoids a read/write deadlock.
     */
    /**
     * Handle an incoming sync request stream.
     * Uses a streaming pipeline (like the repo service) to process the
     * request and yield a response immediately — avoids a read/write deadlock.
     */
    handleSyncRequest(stream) {
        const self = this;
        void (async () => {
            try {
                const processStream = async function* (source) {
                    for await (const msg of source) {
                        const json = u8ToString(msg.subarray(), 'utf8');
                        const request = JSON.parse(json);
                        self.log('[Ring Zulu] Received sync request for block %s revision %s', request.blockId, request.rev ?? 'latest');
                        const archive = await self.buildArchive(request.blockId, request.rev, request.includePending, request.maxRevisions);
                        const response = archive
                            ? { success: true, archive, responderId: stream.id ?? stream.stream?.id }
                            : { success: false, error: 'Block not found in local storage' };
                        self.log('[Ring Zulu] %s sync request for block %s', response.success ? 'Fulfilled' : 'Failed', request.blockId);
                        yield new TextEncoder().encode(JSON.stringify(response));
                        return;
                    }
                };
                // Use the same streaming pipeline pattern as the repo service.
                // The registrar handler receives the stream (or data object) directly.
                const actualStream = stream.stream ?? stream;
                const responses = pipe(actualStream, (source) => lp.decode(source), processStream, (source) => lp.encode(source));
                for await (const chunk of responses) {
                    actualStream.send(chunk);
                }
                await actualStream.close();
            }
            catch (error) {
                self.log.error('Error handling sync request:', error);
                const actualStream = stream.stream ?? stream;
                try {
                    actualStream.abort(error instanceof Error ? error : new Error(String(error)));
                }
                catch { /* ignore */ }
            }
        })();
    }
    /**
     * Build a block archive from local storage.
     *
     * @param blockId - Block to retrieve
     * @param rev - Optional specific revision
     * @param includePending - Whether to include pending transactions
     * @param maxRevisions - Maximum number of revisions to include
     * @returns BlockArchive if found, undefined otherwise
     */
    async buildArchive(blockId, rev, _includePending, _maxRevisions) {
        try {
            // Get the block from local storage
            const context = rev !== undefined
                ? { rev, committed: [], pending: [] }
                : undefined;
            const result = await this.repo.get({
                blockIds: [blockId],
                context
            }, { skipClusterFetch: true });
            const blockResult = result[blockId];
            if (!blockResult || !blockResult.state.latest) {
                return undefined;
            }
            const latest = blockResult.state.latest;
            // Return minimal archive with just the requested block
            const archive = {
                blockId,
                revisions: {
                    [latest.rev]: {
                        action: {
                            actionId: latest.actionId,
                            transform: { insert: blockResult.block }
                        },
                        block: blockResult.block
                    }
                },
                range: [latest.rev, latest.rev + 1]
            };
            return archive;
        }
        catch (error) {
            this.log.error('Error building archive for block %s:', blockId, error);
            return undefined;
        }
    }
}
/**
 * Factory function for creating a SyncService.
 * Follows the libp2p service pattern.
 */
export const syncService = (init = {}) => (components) => new SyncService(components, init);
//# sourceMappingURL=service.js.map