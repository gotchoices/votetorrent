import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { first } from './it-utility.js';
import { createLogger } from './logger.js';
const log = createLogger('protocol-client');
/**
 * Thrown when the per-peer dial deadline expires before a stream is established.
 * Distinct from a libp2p dial failure (no route, refused, etc.) so the
 * batch-retry loop and diagnostic surfaces can identify a slow/unreachable peer
 * specifically. `.code === DIAL_TIMEOUT_ERROR_CODE`.
 */
export const DIAL_TIMEOUT_ERROR_CODE = 'DIAL_TIMEOUT';
export class DialTimeoutError extends Error {
    code = DIAL_TIMEOUT_ERROR_CODE;
    constructor(peer, protocol, ms) {
        super(`dial timeout: peer=${peer} protocol=${protocol} after ${ms}ms`);
        this.name = 'DialTimeoutError';
    }
}
/** Base class for clients that communicate via a libp2p protocol */
export class ProtocolClient {
    peerId;
    peerNetwork;
    constructor(peerId, peerNetwork) {
        this.peerId = peerId;
        this.peerNetwork = peerNetwork;
    }
    async processMessage(message, protocol, options) {
        const peer = this.peerId.toString();
        const cid = options?.correlationId;
        log('dial peer=%s protocol=%s%s', peer, protocol, cid ? ` cid=${cid}` : '');
        const t0 = Date.now();
        // Per-peer dial deadline. When set, an unreachable peer fails fast so the
        // caller can re-pick a different coordinator — independent of any overall
        // transaction budget the caller may also be enforcing.
        const dialTimeoutMs = options?.dialTimeoutMs;
        const dialController = dialTimeoutMs && dialTimeoutMs > 0 ? new AbortController() : undefined;
        let dialTimer;
        const onParentAbort = () => dialController?.abort(options?.signal?.reason);
        if (dialController) {
            dialTimer = setTimeout(() => {
                dialController.abort(new DialTimeoutError(peer, protocol, dialTimeoutMs));
            }, dialTimeoutMs);
            if (options?.signal) {
                if (options.signal.aborted)
                    dialController.abort(options.signal.reason);
                else
                    options.signal.addEventListener('abort', onParentAbort, { once: true });
            }
        }
        const dialSignal = dialController?.signal ?? options?.signal;
        let stream;
        try {
            stream = await this.peerNetwork.connect(this.peerId, protocol, { signal: dialSignal });
        }
        catch (err) {
            const elapsed = Date.now() - t0;
            // If the dial AbortController fired due to our own timer, surface the
            // dial-timeout error rather than the underlying AbortError so callers
            // can distinguish "peer was slow" from "user/parent cancelled".
            if (dialController?.signal.aborted && dialController.signal.reason instanceof DialTimeoutError) {
                log('dial:timeout peer=%s protocol=%s ms=%d%s', peer, protocol, elapsed, cid ? ` cid=${cid}` : '');
                throw dialController.signal.reason;
            }
            const errCode = err?.code;
            const errMessage = err instanceof Error ? err.message : String(err);
            const truncatedMsg = errMessage.length > 200 ? errMessage.slice(0, 200) + '…' : errMessage;
            log('dial:fail peer=%s protocol=%s ms=%d code=%s msg=%s%s', peer, protocol, elapsed, typeof errCode === 'string' && errCode.length > 0 ? errCode : 'none', truncatedMsg, cid ? ` cid=${cid}` : '');
            throw err;
        }
        finally {
            if (dialTimer)
                clearTimeout(dialTimer);
            if (options?.signal)
                options.signal.removeEventListener('abort', onParentAbort);
        }
        log('dial:ok peer=%s ms=%d%s', peer, Date.now() - t0, cid ? ` cid=${cid}` : '');
        try {
            // Send the request using length-prefixed encoding
            const encoded = pipe([new TextEncoder().encode(JSON.stringify(message))], lpEncode);
            for await (const chunk of encoded) {
                stream.send(chunk);
            }
            // Read the response from the stream (which is now directly AsyncIterable)
            let firstByte = true;
            const source = pipe(stream, lpDecode, async function* (source) {
                for await (const data of source) {
                    if (firstByte) {
                        log('first-byte peer=%s ms=%d%s', peer, Date.now() - t0, cid ? ` cid=${cid}` : '');
                        firstByte = false;
                    }
                    const decoded = new TextDecoder().decode(data.subarray());
                    const parsed = JSON.parse(decoded);
                    yield parsed;
                }
            });
            const result = await first(() => source, () => { throw new Error('No response received'); });
            log('response peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid ? ` cid=${cid}` : '');
            return result;
        }
        finally {
            await stream.close();
        }
    }
}
//# sourceMappingURL=protocol-client.js.map