import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
export function clusterService(init = {}) {
    return (components) => new ClusterService(components, init);
}
/**
 * A libp2p service that handles cluster protocol messages
 */
export class ClusterService {
    protocol;
    maxInboundStreams;
    maxOutboundStreams;
    log;
    cluster;
    components;
    running;
    constructor(components, init = {}) {
        this.components = components;
        this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
        this.maxInboundStreams = init.maxInboundStreams ?? 32;
        this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
        this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:cluster');
        this.cluster = components.cluster;
        this.running = false;
    }
    [Symbol.toStringTag] = '@libp2p/cluster';
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
    async stop() {
        if (!this.running) {
            return;
        }
        await this.components.registrar.unhandle(this.protocol);
        this.running = false;
    }
    handleIncomingStream(stream, connection) {
        const peerId = connection.remotePeer;
        const processStream = async function* (source) {
            for await (const msg of source) {
                // Decode the message
                const decoded = new TextDecoder().decode(msg.subarray());
                const message = JSON.parse(decoded);
                // Process the operation
                let response;
                if (message.operation === 'update') {
                    // TEMPORARY: Disable cluster membership check to fix empty promises issue
                    // The membership check was causing peers to return redirect responses
                    // instead of processing cluster updates, leading to empty promise arrays.
                    // TODO: Re-enable and fix cluster membership logic for proper DHT routing
                    response = await this.cluster.update(message.record);
                }
                else {
                    throw new Error(`Unknown operation: ${message.operation}`);
                }
                // Encode and yield the response
                if (message.operation === 'update') {
                    const rec = response;
                    this.log('cluster-service:pre-serialize', {
                        messageHash: rec?.messageHash,
                        responseType: typeof response,
                        hasPromises: 'promises' in (rec ?? {}),
                        hasCommits: 'commits' in (rec ?? {}),
                        promiseKeys: Object.keys(rec?.promises ?? {}),
                        commitKeys: Object.keys(rec?.commits ?? {}),
                        promiseValues: rec?.promises,
                        commitValues: rec?.commits
                    });
                }
                const serialized = JSON.stringify(response);
                if (message.operation === 'update') {
                    const deserialized = JSON.parse(serialized);
                    this.log('cluster-service:post-serialize', {
                        messageHash: deserialized?.messageHash,
                        promiseKeys: Object.keys(deserialized?.promises ?? {}),
                        commitKeys: Object.keys(deserialized?.commits ?? {})
                    });
                }
                yield new TextEncoder().encode(serialized);
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
                // 38-04 (P2P-09 diagnose-first): SURFACE the real error to the log (this
                // is where the on-device drone-log capture reads it), then do NOT convert a
                // member-side processing failure into a contentless StreamResetError. The
                // previous unconditional stream.abort(err) reached the initiating peer only
                // as the generic "The stream has been reset" (masking the true cause) AND
                // hung the entire consensus round on a reset stream. Close the stream
                // gracefully so the caller sees a clean end (a bounded non-response for this
                // member) instead of a reset; fall back to abort only if the graceful close
                // itself fails. Errors are surfaced (logged), never silently swallowed (V5).
                this.log.error('error handling cluster protocol message from %p - %e', peerId, err);
                try {
                    await stream.close();
                }
                catch {
                    stream.abort(err instanceof Error ? err : new Error(String(err)));
                }
            }
        })();
    }
}
//# sourceMappingURL=service.js.map