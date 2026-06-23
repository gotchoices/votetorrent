import { ProtocolClient } from "../protocol-client.js";
import { peerIdFromString } from "@libp2p/peer-id";
export class RepoClient extends ProtocolClient {
    protocolPrefix;
    constructor(peerId, peerNetwork, protocolPrefix) {
        super(peerId, peerNetwork);
        this.protocolPrefix = protocolPrefix;
    }
    /** Create a new client instance */
    static create(peerId, peerNetwork, protocolPrefix) {
        return new RepoClient(peerId, peerNetwork, protocolPrefix);
    }
    async get(blockGets, options) {
        return this.processRepoMessage([{ get: blockGets }], options);
    }
    async pend(request, options) {
        return this.processRepoMessage([{ pend: request }], options);
    }
    async cancel(actionRef, options) {
        return this.processRepoMessage([{ cancel: { actionRef } }], options);
    }
    async commit(request, options) {
        return this.processRepoMessage([{ commit: request }], options);
    }
    extractCorrelationId(operations) {
        const op = operations[0];
        if (!op)
            return undefined;
        if ('pend' in op)
            return op.pend.actionId;
        if ('commit' in op)
            return op.commit.actionId;
        if ('cancel' in op)
            return op.cancel.actionRef.actionId;
        return undefined;
    }
    async processRepoMessage(operations, options, hop = 0) {
        const message = {
            operations,
            expiration: options.expiration,
        };
        const correlationId = this.extractCorrelationId(operations);
        const deadline = options.expiration ?? (Date.now() + 30_000);
        const msLeft = Math.max(1, deadline - Date.now());
        const withTimeout = async (fn) => {
            return await Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('RepoClient timeout')), msLeft))
            ]);
        };
        let response;
        const preferred = (this.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0';
        response = await withTimeout(() => super.processMessage(message, preferred, {
            signal: options?.signal,
            correlationId,
            dialTimeoutMs: options?.dialTimeoutMs,
        }));
        if (response?.redirect?.peers?.length) {
            if (hop >= 2) {
                throw new Error('Redirect loop detected in RepoClient (max hops reached)');
            }
            const currentIdStr = this.peerId.toString();
            const next = response.redirect.peers.find((p) => p.id !== currentIdStr) ?? response.redirect.peers[0];
            const nextId = peerIdFromString(next.id);
            if (next.id === currentIdStr) {
                throw new Error('Redirect loop detected in RepoClient (same peer)');
            }
            // cache hint
            this.recordCoordinatorForOpsIfSupported(operations, nextId);
            // single-hop retry against target peer using repo protocol
            const nextClient = RepoClient.create(nextId, this.peerNetwork, this.protocolPrefix);
            return await nextClient.processRepoMessage(operations, options, hop + 1);
        }
        return response;
    }
    extractKeyFromOperations(ops) {
        const op = ops[0];
        if ('get' in op) {
            const id = op.get.blockIds[0];
            return id ? new TextEncoder().encode(id) : undefined;
        }
        if ('pend' in op) {
            const id = Object.keys(op.pend.transforms)[0];
            return id ? new TextEncoder().encode(id) : undefined;
        }
        if ('commit' in op) {
            return new TextEncoder().encode(op.commit.tailId);
        }
        if ('cancel' in op) {
            const id = op.cancel.actionRef.blockIds[0];
            return id ? new TextEncoder().encode(id) : undefined;
        }
        return undefined;
    }
    recordCoordinatorForOpsIfSupported(ops, peerId) {
        const keyBytes = this.extractKeyFromOperations(ops);
        const pn = this.peerNetwork;
        if (keyBytes != null && typeof pn?.recordCoordinator === 'function') {
            pn.recordCoordinator(keyBytes, peerId);
        }
    }
}
//# sourceMappingURL=client.js.map