/**
 * packages/p2p-probe-host/relay-smoke.mjs — Phase 38 Wave-0 Node-only smoke (38-02 Task 1).
 *
 * De-risks two of RESEARCH's MEDIUM-confidence P2P-08 claims BEFORE 38-03 spends any
 * emulator time on the relay wiring:
 *   1. A2 — the drone's relay SERVER (`circuitRelayServer()`) is actually live on a
 *      `profile:'storage'` node with zero drone-side config (cadre-core's
 *      `enableRelay = network.enableRelay ?? profile === 'storage'` fallback).
 *   2. OQ2/OQ3 — a relay-CLIENT node shaped exactly like the real app's
 *      `CadreNodeProvider.tsx:175-199` config (`transports:[webSockets(),
 *      circuitRelayTransport()]`, `listenAddrs:['/p2p-circuit']`) actually completes
 *      an end-to-end `/p2p-circuit` reservation against that relay-server peer on
 *      this exact libp2p/circuit-relay-v2 v4.2.5 pairing, and names which READY
 *      observable fires reliably (`node.getMultiaddrs()` vs `self:peer:update`).
 *
 * Two in-process CadreNodes:
 *   (A) relay-SERVER — drone-shaped (profile:'storage', webSockets only, ephemeral
 *       ws listen, MemoryRawStorage). No relay config — proves A2 by omission.
 *   (B) relay-CLIENT — CadreNodeProvider.tsx-shaped, bootstrapped to (A)'s printed
 *       control multiaddr.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   nvm use 22
 *   node relay-smoke.mjs
 *
 * Exit 0 + "RELAY SMOKE: PASS" on success (reservation observed + relay service
 * live); exit 1 + "RELAY SMOKE: FAIL <reason>" otherwise — a FAIL here is a P2P-08
 * blocker (relay path does not work on this libp2p/circuit-relay-v2 pairing), not a
 * transient error to retry past.
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';

const L = (...a) => console.log('[relay-smoke]', ...a);

const PARTY_ID = 'votetorrent-relay-smoke';
const RESERVATION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

let server;
let client;
let exitCode = 1;

async function main() {
  // (A) relay-SERVER node — drone-shaped: profile:'storage' computes
  // enableRelay=true by cadre-core's fallback (network.enableRelay ?? profile ===
  // 'storage'; cadre-node.js:179 / strand-instance-manager.js:87), so
  // circuitRelayServer() should already be wired with NO explicit relay config
  // (RESEARCH.md "P2P-08 — Relay Wiring" point 5 / Assumption A2).
  server = new CadreNode({
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
    profile: 'storage',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE (drone.mjs pattern)
    },
    hibernation: { enabled: false },
  });
  await server.start();

  const serverLibp2p = server.getControlNode();
  const relayServiceLive = serverLibp2p.services?.relay != null;
  L('drone relay service present:', relayServiceLive);

  const serverAddrs = serverLibp2p.getMultiaddrs().map((m) => m.toString());
  L('relay-server control addrs =', JSON.stringify(serverAddrs));
  const serverBootstrapAddr =
    serverAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? serverAddrs[0];

  if (!relayServiceLive) {
    L('RELAY SMOKE: FAIL relay service not live on the drone-shaped (profile:storage) node — A2 assumption broken');
    exitCode = 1;
    return;
  }
  if (!serverBootstrapAddr) {
    L('RELAY SMOKE: FAIL relay-server produced no usable bootstrap multiaddr');
    exitCode = 1;
    return;
  }

  // (B) relay-CLIENT node — mirrors apps/VoteTorrentAuthority/src/providers/
  // CadreNodeProvider.tsx:175-199 exactly (the real app's network config shape),
  // bootstrapped to the relay-server's control multiaddr.
  client = new CadreNode({
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [serverBootstrapAddr] },
    profile: 'transaction',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets(), circuitRelayTransport()],
      listenAddrs: ['/p2p-circuit'],
      connectionGater: { denyDialMultiaddr: async () => false },
    },
    hibernation: { enabled: false },
  });
  await client.start();

  const clientLibp2p = client.getControlNode();
  L('relay-client peerId =', clientLibp2p.peerId?.toString());

  // Race the two READY-observable candidates (Open Questions 2/3): poll
  // getMultiaddrs() for a /p2p-circuit entry (primary candidate per RESEARCH.md),
  // while separately tracking whether self:peer:update fires — log which one
  // proves reliable (and which fires first) so 38-03 can lock its D-09 marker.
  let selfPeerUpdateFiredAtMs = null;
  const pollStart = Date.now();
  const onSelfPeerUpdate = () => {
    if (selfPeerUpdateFiredAtMs == null) selfPeerUpdateFiredAtMs = Date.now() - pollStart;
  };
  clientLibp2p.addEventListener('self:peer:update', onSelfPeerUpdate);

  let circuitAddr = null;
  while (Date.now() - pollStart < RESERVATION_TIMEOUT_MS) {
    const addrs = clientLibp2p.getMultiaddrs().map((m) => m.toString());
    circuitAddr = addrs.find((a) => a.includes('/p2p-circuit')) ?? null;
    if (circuitAddr) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  clientLibp2p.removeEventListener('self:peer:update', onSelfPeerUpdate);

  if (!circuitAddr) {
    L(
      'RELAY SMOKE: FAIL relay reservation never completed within',
      RESERVATION_TIMEOUT_MS,
      'ms — self:peer:update fired:',
      selfPeerUpdateFiredAtMs != null,
    );
    exitCode = 1;
    return;
  }

  const elapsedMs = Date.now() - pollStart;
  L(`RELAY RESERVATION OBSERVED via getMultiaddrs()/p2p-circuit: ${circuitAddr} (after ${elapsedMs}ms)`);
  L(
    'self:peer:update fired:',
    selfPeerUpdateFiredAtMs != null,
    selfPeerUpdateFiredAtMs != null ? `(at +${selfPeerUpdateFiredAtMs}ms, vs getMultiaddrs() at +${elapsedMs}ms)` : '',
  );
  L(
    'READY observable for 38-03:',
    selfPeerUpdateFiredAtMs != null && selfPeerUpdateFiredAtMs <= elapsedMs
      ? 'self:peer:update (fired first or simultaneously)'
      : 'getMultiaddrs()/p2p-circuit poll (fired first, or self:peer:update never fired)',
  );

  L('RELAY SMOKE: PASS');
  exitCode = 0;
}

async function shutdown() {
  if (client) {
    try {
      await client.stop();
    } catch (e) {
      L('client stop error', e);
    }
  }
  if (server) {
    try {
      await server.stop();
    } catch (e) {
      L('server stop error', e);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping...`);
    await shutdown();
    process.exit(1);
  });
}

main()
  .catch((err) => {
    L('RELAY SMOKE: FAIL', err?.stack ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
