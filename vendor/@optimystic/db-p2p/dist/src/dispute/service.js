import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
export function disputeProtocolService(init = {}) {
    return (components) => new DisputeProtocolService(components, init);
}
/**
 * Libp2p service that handles dispute protocol messages.
 * Follows the same pattern as ClusterService.
 */
export class DisputeProtocolService {
    protocol;
    maxInboundStreams;
    maxOutboundStreams;
    log;
    disputeService;
    components;
    running;
    constructor(components, init = {}) {
        this.components = components;
        this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/dispute/1.0.0';
        this.maxInboundStreams = init.maxInboundStreams ?? 16;
        this.maxOutboundStreams = init.maxOutboundStreams ?? 32;
        this.log = components.logger.forComponent('db-p2p:dispute');
        this.disputeService = components.disputeService;
        this.running = false;
    }
    [Symbol.toStringTag] = '@libp2p/dispute';
    async start() {
        if (this.running)
            return;
        await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
            maxInboundStreams: this.maxInboundStreams,
            maxOutboundStreams: this.maxOutboundStreams,
        });
        this.running = true;
    }
    async stop() {
        if (!this.running)
            return;
        await this.components.registrar.unhandle(this.protocol);
        this.running = false;
    }
    handleIncomingStream(stream, connection) {
        const peerId = connection.remotePeer;
        const processStream = async function* (source) {
            for await (const msg of source) {
                const decoded = new TextDecoder().decode(msg.subarray());
                const message = JSON.parse(decoded);
                let response;
                switch (message.type) {
                    case 'challenge': {
                        const vote = await this.disputeService.handleChallenge(message.challenge);
                        response = { type: 'vote', vote };
                        break;
                    }
                    case 'resolution': {
                        this.disputeService.handleResolution(message.resolution);
                        response = { type: 'ack' };
                        break;
                    }
                    default:
                        throw new Error(`Unknown dispute message type: ${message.type}`);
                }
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
                this.log.error('error handling dispute protocol message from %p - %e', peerId, err);
                stream.abort(err instanceof Error ? err : new Error(String(err)));
            }
        })();
    }
}
//# sourceMappingURL=service.js.map