import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ProtocolClient, DialTimeoutError, DIAL_TIMEOUT_ERROR_CODE } from '../src/protocol-client.js';
class TestProtocolClient extends ProtocolClient {
    async dial(message, protocol, options) {
        return this.processMessage(message, protocol, options);
    }
}
async function makePeerId() {
    const pk = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(pk);
}
describe('ProtocolClient dial timeout', () => {
    it('throws DialTimeoutError when dial hangs past dialTimeoutMs', async () => {
        const peerId = await makePeerId();
        const hangingNetwork = {
            async connect(_p, _proto, options) {
                return new Promise((_, reject) => {
                    if (options?.signal?.aborted) {
                        reject(options.signal.reason);
                        return;
                    }
                    options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
            }
        };
        const client = new TestProtocolClient(peerId, hangingNetwork);
        const t0 = Date.now();
        let caught;
        try {
            await client.dial({ ping: true }, '/test/1.0.0', { dialTimeoutMs: 100 });
        }
        catch (e) {
            caught = e;
        }
        const elapsed = Date.now() - t0;
        expect(caught).to.be.instanceOf(DialTimeoutError);
        expect(caught.code).to.equal(DIAL_TIMEOUT_ERROR_CODE);
        expect(elapsed).to.be.lessThan(500); // generous epsilon for CI jitter
    });
    it('does not impose a dial cap when dialTimeoutMs is omitted', async () => {
        const peerId = await makePeerId();
        let observedSignal;
        const network = {
            async connect(_p, _proto, options) {
                observedSignal = options?.signal;
                // resolve "successfully" with a stream-shaped stub that the
                // response-wait path will then exercise (and fail on, which is fine
                // for this assertion — we only care that the dial wasn't aborted)
                return { send: () => { }, close: async () => { }, [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; } };
            }
        };
        const client = new TestProtocolClient(peerId, network);
        try {
            await client.dial({}, '/test/1.0.0', {});
        }
        catch { /* response-wait path will fail; not under test */ }
        expect(observedSignal).to.equal(undefined);
    });
    it('forwards parent signal abort to the dial', async () => {
        const peerId = await makePeerId();
        const network = {
            async connect(_p, _proto, options) {
                return new Promise((_, reject) => {
                    options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
            }
        };
        const client = new TestProtocolClient(peerId, network);
        const parent = new AbortController();
        const sentinel = new Error('parent aborted');
        setTimeout(() => parent.abort(sentinel), 30);
        let caught;
        try {
            await client.dial({}, '/test/1.0.0', { signal: parent.signal, dialTimeoutMs: 5_000 });
        }
        catch (e) {
            caught = e;
        }
        // Parent abort surfaces (not a dial-timeout) because the timer didn't fire.
        expect(caught).to.equal(sentinel);
    });
});
//# sourceMappingURL=protocol-client-dial-timeout.spec.js.map