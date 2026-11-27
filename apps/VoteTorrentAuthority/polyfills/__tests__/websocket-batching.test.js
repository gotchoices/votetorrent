/**
 * websocket-batching.test.js — guard for polyfills/websocket-batching.js (ported from
 * sereus-chat `packages/core/src/transport/websocket-batching.ts`, c9a02d3).
 *
 * Lives in the Authority suite only and checks the Voter's copy too, for the reason
 * polyfill-drift.test.js gives. Runs on Node (jest), never on a device: it proves the
 * coalescing and the byte order, not that fewer bridge sends make a phone faster. That needs a
 * device measurement with the bootstrap's WEBSOCKET_SEND_BATCHING constant on and off.
 *
 * Groups:
 *   A. both apps carry byte-identical copies, and both bootstraps install it behind the constant;
 *   B. sereus-chat's own four cases (one turn joined in order, copy at send time, a text send or
 *      close flushes first, sockets kept apart + idempotent install);
 *   C. libp2p-shaped traffic: Noise/yamux-sized frames written in one tick reach the socket as
 *      ONE message whose bytes are the frames in order; frames in different ticks stay apart;
 *   D. React Native's own WebSocket class, with the jest preset's mocked native module: one
 *      `sendBinary` per tick, carrying the base64 of the joined bytes.
 */

const fs = require('fs');
const path = require('path');

const AUTHORITY_MODULE = path.resolve(__dirname, '../websocket-batching.js');
const VOTER_MODULE = path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills/websocket-batching.js');
const BOOTSTRAPS = [
  ['Authority', path.resolve(__dirname, '../../polyfills.bootstrap.js')],
  ['Voter', path.resolve(__dirname, '../../../VoteTorrentVoter/polyfills.bootstrap.js')],
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

function load() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../websocket-batching');
  });
  return mod;
}

function fakeSocketClass() {
  class FakeSocket {
    constructor() {
      this.sent = [];
      this.closed = false;
    }
    send(data) {
      this.sent.push(data instanceof Uint8Array ? Array.from(data) : data);
    }
    close() {
      this.closed = true;
    }
  }
  return FakeSocket;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('A. both apps, both bootstraps', () => {
  it('both apps carry byte-identical copies', () => {
    const authority = fs.readFileSync(AUTHORITY_MODULE, 'utf8');
    expect(authority.length).toBeGreaterThan(1500);
    expect(fs.readFileSync(VOTER_MODULE, 'utf8')).toBe(authority);
  });

  it.each(BOOTSTRAPS)('%s installs it on WebSocket.prototype behind WEBSOCKET_SEND_BATCHING (on)', (_label, file) => {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    expect(src).toContain('const WEBSOCKET_SEND_BATCHING = true;');
    expect(src).toMatch(
      /if \(WEBSOCKET_SEND_BATCHING && typeof WebSocket !== 'undefined'\) \{\s*require\('\.\/polyfills\/websocket-batching'\)\.batchWebSocketSends\(WebSocket\.prototype\);\s*\}/,
    );
    // After the bufferedAmount arm (6c), which defines a property on the same prototype.
    expect(src.indexOf("'bufferedAmount'")).toBeGreaterThan(0);
    expect(src.indexOf('WEBSOCKET_SEND_BATCHING &&')).toBeGreaterThan(src.indexOf("'bufferedAmount'"));
  });
});

describe('B. sereus-chat cases', () => {
  it('joins the binary sends of one turn into one message, in order', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    const native = [];
    batchWebSocketSends(S.prototype, n => native.push(n));
    const ws = new S();
    ws.send(new Uint8Array([1, 2]));
    ws.send(new Uint8Array([9, 3, 4, 9]).subarray(1, 3)); // a view: only its own bytes
    ws.send(new Uint8Array([5]).buffer);
    expect(ws.sent).toEqual([]);
    await tick();
    expect(ws.sent).toEqual([[1, 2, 3, 4, 5]]);
    expect(native).toEqual([5]);
  });

  it('copies at send time, so a reused buffer does not change what goes out', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    batchWebSocketSends(S.prototype);
    const ws = new S();
    const buf = new Uint8Array([1, 2]);
    ws.send(buf);
    buf[0] = 7;
    await tick();
    expect(ws.sent).toEqual([[1, 2]]);
  });

  it('sends what is waiting before a text send or a close', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    batchWebSocketSends(S.prototype);
    const ws = new S();
    ws.send(new Uint8Array([1]));
    ws.send('text');
    ws.send(new Uint8Array([2]));
    ws.close();
    expect(ws.sent).toEqual([[1], 'text', [2]]);
    expect(ws.closed).toBe(true);
    await tick();
    expect(ws.sent).toEqual([[1], 'text', [2]]);
  });

  it('keeps sockets apart, and installs once', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    const native = [];
    batchWebSocketSends(S.prototype, n => native.push(n));
    batchWebSocketSends(S.prototype, n => native.push(n * 100));
    const a = new S();
    const b = new S();
    a.send(new Uint8Array([1]));
    b.send(new Uint8Array([2]));
    a.send(new Uint8Array([3]));
    await tick();
    expect(a.sent).toEqual([[1, 3]]);
    expect(b.sent).toEqual([[2]]);
    expect(native).toEqual([2, 1]);
  });
});

describe('C. libp2p-shaped traffic', () => {
  /** A Noise transport message as libp2p writes it: a 2-byte length prefix, then the payload. */
  function noiseFrame(payload) {
    const prefix = new Uint8Array([payload.length >> 8, payload.length & 0xff]);
    return [prefix, payload];
  }

  function bytes(n, seed) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (seed + i * 31) & 0xff;
    return out;
  }

  it('coalesces every frame written in one tick into ONE send, bytes in write order', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    const native = [];
    batchWebSocketSends(S.prototype, n => native.push(n));
    const ws = new S();

    // Three yamux writes, each a 12-byte header + payload, each wrapped in a Noise frame: the
    // shape behind "about half the sends are 16 bytes or fewer".
    const writes = [];
    for (const [i, size] of [[0, 3], [1, 700], [2, 40]]) {
      const yamuxHeader = bytes(12, 100 + i);
      const body = bytes(size, i);
      const [lenA, payloadA] = noiseFrame(yamuxHeader);
      const [lenB, payloadB] = noiseFrame(body);
      writes.push(lenA, payloadA, lenB, payloadB);
    }
    // Some arrive as views into a larger buffer, as libp2p's Uint8ArrayList subarrays do.
    const pool = new Uint8Array(4096);
    pool.set(writes[5], 1000);
    writes[5] = pool.subarray(1000, 1000 + writes[5].length);

    const expected = [];
    for (const w of writes) {
      expected.push(...w);
      ws.send(w);
    }
    expect(ws.sent).toEqual([]);
    await tick();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual(expected);
    expect(native).toEqual([expected.length]);
    expect(writes).toHaveLength(12); // 12 sends in, 1 out
  });

  it('frames written in different ticks are separate messages, each in order', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    batchWebSocketSends(S.prototype);
    const ws = new S();
    ws.send(new Uint8Array([0, 2]));
    ws.send(new Uint8Array([0xaa, 0xbb]));
    await tick();
    ws.send(new Uint8Array([0, 1]));
    ws.send(new Uint8Array([0xcc]));
    await tick();
    expect(ws.sent).toEqual([[0, 2, 0xaa, 0xbb], [0, 1, 0xcc]]);
  });

  it('a send made from inside the flush microtask is not lost or reordered', async () => {
    const { batchWebSocketSends } = load();
    const S = fakeSocketClass();
    batchWebSocketSends(S.prototype);
    const ws = new S();
    ws.send(new Uint8Array([1]));
    void Promise.resolve().then(() => ws.send(new Uint8Array([2])));
    await tick();
    expect(ws.sent.flat()).toEqual([1, 2]);
  });
});

describe("D. React Native's WebSocket", () => {
  it('reaches the native module as one sendBinary per tick, base64 of the joined bytes', async () => {
    let NativeModules;
    let RNWebSocket;
    jest.isolateModules(() => {
      NativeModules = require('react-native/Libraries/BatchedBridge/NativeModules').default
        ?? require('react-native/Libraries/BatchedBridge/NativeModules');
      RNWebSocket = require('react-native/Libraries/WebSocket/WebSocket').default;
      require('../websocket-batching').batchWebSocketSends(RNWebSocket.prototype);
    });
    const sendBinary = NativeModules.WebSocketModule.sendBinary;
    sendBinary.mockClear();
    const ws = new RNWebSocket('ws://203.0.113.9:4801');
    ws.readyState = ws.OPEN;
    ws.send(new Uint8Array([0, 3]));
    ws.send(new Uint8Array([104, 105, 33]));
    expect(sendBinary).not.toHaveBeenCalled();
    await tick();
    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect(sendBinary.mock.calls[0][0]).toBe(Buffer.from([0, 3, 104, 105, 33]).toString('base64'));
  });
});
