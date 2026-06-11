/**
 * packages/p2p-probe-host/drone.mjs — Phase 17 P2P-01 dial-proof host drone.
 *
 * Committed, repeatable dev tooling (Phase 22 reuse).  Ported from spike 009.
 *
 * A storage-profile CadreNode that listens on an ephemeral WebSocket address so
 * the Android emulator can dial it (emulator reaches the host at 10.0.2.2).
 * Boots, prints the control peerId + ws multiaddr, then stays alive.
 *
 * Prerequisites:
 *   This package is a normal yarn workspace — `yarn install` at the repo root installs its deps.
 *   The root `resolutions` pin uint8arrays only for ^5 ranges (Hermes/quereus compat), so
 *   @multiformats/multiaddr's ^6 requirement resolves to a real v6 and strict Node ESM works.
 *   The yarn-patched @serfab/cadre-core (connectionGater pass-through) is what resolves here.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   nvm use 22
 *   node drone.mjs
 *
 *   Copy the printed ws multiaddr + peerId into CONTROL_ADDR in dial-probe.ts,
 *   then run ./scripts/run-dial-probe.sh.
 *
 * Exit: Ctrl-C (SIGINT) — gracefully stops the node.
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';

const PARTY_ID = 'probe-party'; // must match CONTROL_ADDR in dial-probe.ts
const L = (...a) => console.log('[drone]', ...a);

const node = new CadreNode({
  controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
  profile: 'storage',
  strandFilter: { mode: 'all' },
  storage: { provider: () => new MemoryRawStorage() },
  network: {
    transports: [webSockets()],
    listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
    enableRelay: true,
  },
  hibernation: { enabled: false },
});

await node.start();
const addrs = node.getControlNode().getMultiaddrs().map(m => m.toString());
L('control peerId =', node.peerId?.toString());
L('control addrs  =', JSON.stringify(addrs));
L('READY — update CONTROL_ADDR in dial-probe.ts with the /ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID> addr above, then run ./scripts/run-dial-probe.sh');

process.on('SIGINT', async () => {
  L('SIGINT — stopping...');
  await node.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30); // stay alive
