/**
 * The repo's `@libp2p/websockets` yarn patch (`.yarn/patches/@libp2p-websockets-npm-10.1.25-votetorrent.patch`).
 *   node --test test/websockets-patch.test.mjs
 *
 * Two defects in 10.1.18 through 10.1.25 (debug officer-address-record-content-digest-mismatch):
 *  1. `_connect` threw on an aborted dial without closing the socket it had opened, so a socket
 *     whose handshake finished after the abort stayed open with no libp2p connection on it.
 *  2. `sendReset()` sent close code 1006, which is reserved and must never be sent; OkHttp and
 *     browsers refuse it, so on a phone the reset closed nothing.
 * Both tests run against the INSTALLED package, so they fail on stock bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webSockets } from '@libp2p/websockets';
import { defaultLogger } from '@libp2p/logger';
import { multiaddr } from '@multiformats/multiaddr';

const require = createRequire(import.meta.url);
// The package exports only its entry, so the internal module and its `ws` dependency are
// resolved from the installed package's own directory.
const wsPackageDir = dirname(dirname(dirname(require.resolve('@libp2p/websockets')))).replace(/\/dist$/, '');
const pkgRequire = createRequire(join(wsPackageDir, 'package.json'));
const { WebSocketServer } = pkgRequire('ws');
const { webSocketToMaConn } = await import(pathToFileURL(join(wsPackageDir, 'dist/src/websocket-to-conn.js')).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sendReset closes with an application code, never the reserved 1006', () => {
  const calls = [];
  const fake = {
    readyState: 1,
    bufferedAmount: 0,
    binaryType: 'arraybuffer',
    addEventListener() {},
    removeEventListener() {},
    close: (...args) => { calls.push(args); },
  };
  const conn = webSocketToMaConn({
    websocket: fake,
    remoteAddr: multiaddr('/ip4/127.0.0.1/tcp/1/ws'),
    direction: 'outbound',
    log: defaultLogger().forComponent('test:websockets-patch'),
  });
  conn.sendReset();
  assert.ok(calls.length >= 1, 'sendReset closed the socket');
  const [code, reason] = calls[0];
  assert.notEqual(code, 1006, 'close(1006) is reserved (RFC 6455 7.4.1) and must not be sent');
  assert.ok(code >= 4000 && code <= 4999, `an application close code, got ${code}`);
  assert.equal(reason, 'reset');
});

test('an aborted dial closes the socket it opened', { timeout: 30_000 }, async () => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  // Every TCP socket an upgrade request arrives on, and whether it has closed since.
  const sockets = [];
  // Hold every upgrade until the dial has already been aborted, then complete it.
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  server.on('upgrade', async (req, socket, head) => {
    const entry = { closed: false };
    socket.on('close', () => { entry.closed = true; });
    sockets.push(entry);
    await released;
    if (!socket.destroyed) wss.handleUpgrade(req, socket, head, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const transport = webSockets()({ logger: defaultLogger() });
    const controller = new AbortController();
    const dial = transport._connect(multiaddr(`/ip4/127.0.0.1/tcp/${port}/ws`), { signal: controller.signal });
    await sleep(200);
    controller.abort();
    await assert.rejects(dial, (err) => err?.name === 'ConnectionFailedError', 'the aborted dial rejects');
    release();
    assert.ok(sockets.length >= 1, 'precondition: the dial reached the server before it was aborted');
    // The server completes the handshake after the abort; the dialer must close that socket.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !sockets.every((e) => e.closed)) await sleep(100);
    assert.ok(sockets.every((e) => e.closed),
      `${sockets.filter((e) => !e.closed).length} socket(s) the aborted dial opened are still open after 10 s`);
  } finally {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
