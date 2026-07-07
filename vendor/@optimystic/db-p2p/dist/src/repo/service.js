import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import { peersEqual, toBrandedPeerId } from '../peer-utils.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { encodePeers } from './redirect.js';
import { createLogger } from '../logger.js';
const debugLog = createLogger('repo-service');
export function repoService(init = {}) {
    return (components) => new RepoService(components, init);
}
/**
 * A libp2p service that handles repo protocol messages
 */
export class RepoService {
    protocol;
    maxInboundStreams;
    maxOutboundStreams;
    log;
    repo;
    components;
    running;
    /** Responsibility K - how many peers are responsible for a key (for redirect decisions) */
    responsibilityK;
    constructor(components, init = {}) {
        this.components = components;
        const computed = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0';
        this.protocol = computed;
        this.maxInboundStreams = init.maxInboundStreams ?? 32;
        this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
        this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service');
        this.repo = components.repo;
        this.running = false;
        this.responsibilityK = init.responsibilityK ?? 1;
    }
    [Symbol.toStringTag] = '@libp2p/repo-service';
    /**
     * Start the service
     */
    async start() {
        if (this.running) {
            return;
        }
        await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
            maxInboundStreams: this.maxInboundStreams,
            maxOutboundStreams: this.maxOutboundStreams
        });
        this.running = true;
    }
    /**
     * Stop the service
     */
    async stop() {
        if (!this.running) {
            return;
        }
        await this.components.registrar.unhandle(this.protocol);
        this.running = false;
    }
    getNetworkManager() {
        if (this.components.networkManager)
            return this.components.networkManager;
        return this.components.libp2p?.services?.networkManager;
    }
    getSelfId() {
        if (this.components.peerId)
            return this.components.peerId;
        return this.components.libp2p?.peerId;
    }
    getPeerAddrs(peerId) {
        if (this.components.getConnectionAddrs)
            return this.components.getConnectionAddrs(peerId);
        const libp2p = this.components.libp2p;
        if (!libp2p?.getConnections)
            return [];
        const conns = libp2p.getConnections(toBrandedPeerId(peerId)) ?? [];
        const addrs = [];
        for (const c of conns) {
            const addr = c.remoteAddr?.toString?.();
            if (addr)
                addrs.push(addr);
        }
        return addrs;
    }
    /**
     * Check if this node should redirect the request for a given key.
     * Returns a RedirectPayload if not responsible, null if should handle locally.
     * Also attaches cluster info to the message for downstream use.
     */
    async checkRedirect(blockKey, opName, message) {
        const nm = this.getNetworkManager();
        if (!nm)
            return null;
        const mh = await sha256.digest(new TextEncoder().encode(blockKey));
        const key = mh.digest;
        const cluster = await nm.getCluster(key);
        message.cluster = cluster.map((p) => p.toString?.() ?? String(p));
        const selfId = this.getSelfId();
        if (!selfId)
            return null;
        const isMember = cluster.some((p) => peersEqual(p, selfId));
        const smallMesh = cluster.length < this.responsibilityK;
        if (!smallMesh && !isMember) {
            const peers = cluster.filter((p) => !peersEqual(p, selfId));
            debugLog('redirect op=%s blockKey=%s cluster=%d', opName, blockKey, cluster.length);
            return encodePeers(peers.map((pid) => ({
                id: pid.toString(),
                addrs: this.getPeerAddrs(pid)
            })));
        }
        return null;
    }
    /**
     * Handle incoming streams on the repo protocol
     */
    handleIncomingStream(stream, connection) {
        const peerId = connection.remotePeer;
        const processStream = async function* (source) {
            for await (const msg of source) {
                // Decode the message
                const decoded = new TextDecoder().decode(msg.subarray());
                const message = JSON.parse(decoded);
                // Process each operation
                const operation = message.operations[0];
                let response;
                if ('get' in operation) {
                    const blockKey = operation.get.blockIds[0];
                    const redirect = await this.checkRedirect(blockKey, 'get', message);
                    if (redirect) {
                        response = redirect;
                    }
                    else {
                        response = await this.repo.get(operation.get, { expiration: message.expiration, skipClusterFetch: true });
                    }
                }
                else if ('pend' in operation) {
                    const blockKey = Object.keys(operation.pend.transforms)[0];
                    const redirect = await this.checkRedirect(blockKey, 'pend', message);
                    if (redirect) {
                        response = redirect;
                    }
                    else {
                        response = await this.repo.pend(operation.pend, { expiration: message.expiration });
                    }
                }
                else if ('cancel' in operation) {
                    const blockKey = operation.cancel.actionRef.blockIds[0];
                    if (blockKey) {
                        const redirect = await this.checkRedirect(blockKey, 'cancel', message);
                        if (redirect) {
                            response = redirect;
                        }
                        else {
                            response = await this.repo.cancel(operation.cancel.actionRef, { expiration: message.expiration });
                        }
                    }
                    else {
                        response = await this.repo.cancel(operation.cancel.actionRef, { expiration: message.expiration });
                    }
                }
                else if ('commit' in operation) {
                    const blockKey = operation.commit.tailId;
                    const redirect = await this.checkRedirect(blockKey, 'commit', message);
                    if (redirect) {
                        response = redirect;
                    }
                    else {
                        response = await this.repo.commit(operation.commit, { expiration: message.expiration });
                    }
                }
                // Encode and yield the response
                yield new TextEncoder().encode(JSON.stringify(response));
            }
        };
        void (async () => {
            try {
                const responses = pipe(stream, (source) => lpDecode(source), processStream.bind(this), (source) => lpEncode(source));
                for await (const chunk of responses) {
                    stream.send(chunk);
                }
                await stream.close();
            }
            catch (err) {
                this.log.error('error handling repo protocol message from %p - %e', peerId, err);
                stream.abort(err instanceof Error ? err : new Error(String(err)));
            }
        })();
    }
}
//# sourceMappingURL=service.js.map