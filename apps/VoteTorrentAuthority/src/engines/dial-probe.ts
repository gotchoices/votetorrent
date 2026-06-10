/**
 * dial-probe.ts — Phase 17 P2P-01 on-device dial proof (dev tooling, Phase 22 reuse).
 *
 * Ported from spike 009 device-probe.js.  Dev-only: gated by __DEV__ && DIAL_PROBE_ENABLED
 * (default false — Metro dead-code-eliminates in release, per D-13/D-17).
 *
 * Dials the host drone running at packages/p2p-probe-host/drone.mjs via the
 * Android emulator → host alias 10.0.2.2.  Injects a permissive connectionGater
 * (denyDialMultiaddr: async () => false) so the cadre-core patch forwards it into
 * libp2p — the fix being validated by this probe.
 *
 * IMPORTANT — update CONTROL_ADDR after each drone restart:
 *   1. Start the drone:  cd packages/p2p-probe-host && nvm use 22 && node drone.mjs
 *   2. Copy the printed ws multiaddr from the [drone] READY log line.
 *   3. Replace the /tcp/<PORT>/p2p/<PEER_ID> values below.
 *   4. Run: ./scripts/run-dial-probe.sh
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, LevelDBRawStorage, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
import { DIAL_PROBE_ENABLED } from './proof-flags.generated';

// Update port and peerId after each drone restart (drone prints this on startup).
// Example: '/ip4/10.0.2.2/tcp/52345/ws/p2p/12D3KooW...'
const CONTROL_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

const L = (...a: unknown[]) => console.log('[dial-probe]', ...a);

/**
 * Boot entry point. Fire-and-forget from index.js (or persistence-proof-runner.ts)
 * when DIAL_PROBE_ENABLED=true. Never throws — any failure is logged as
 * `[dial-probe] ERROR` so the app still boots.
 *
 * Proof: polls for conn>=1 for up to 20s, then emits:
 *   [dial-probe] ========== DIAL VERDICT: PASS|FAIL (conn=N) ==========
 */
export async function runDialProbe(): Promise<void> {
  if (!(__DEV__ && DIAL_PROBE_ENABLED)) {
    return;
  }

  L('starting — CONTROL_ADDR=', CONTROL_ADDR);
  let node: InstanceType<typeof CadreNode> | undefined;
  try {
    const db = openOptimysticRNDb({
      openFn: (n, c, e) => new LevelDB(n, c, e),
      WriteBatch: LevelDBWriteBatch,
      name: 'votetorrent-cadre-probe',
    });
    const privateKey = await loadOrCreateRNPeerKey(db);

    node = new CadreNode({
      privateKey,
      controlNetwork: { partyId: 'probe-party', bootstrapNodes: [CONTROL_ADDR] },
      profile: 'transaction',
      strandFilter: { mode: 'all' },
      storage: { provider: () => new LevelDBRawStorage(db) },
      network: {
        transports: [webSockets(), circuitRelayTransport()],
        listenAddrs: [],
        // Permissive gater — dev probe only (D-13). Allows private/loopback dials
        // (10.0.2.2) that libp2p would otherwise deny by default.
        // This is the gater that the cadre-core patch now forwards into createLibp2pNode.
        connectionGater: { denyDialMultiaddr: async () => false },
      },
      hibernation: { enabled: false },
    });

    await node.start();
    L('started, peerId=', node.peerId?.toString());

    const cn = node.getControlNode();
    // Explicit dial: cadre-core's bootstrap list alone does not guarantee an
    // eager dial, and internal bootstrap dial errors are swallowed. Dialing
    // here surfaces the real failure (e.g. "connection gater denied") in logcat.
    try {
      await cn.dial(multiaddr(CONTROL_ADDR));
      L('explicit dial OK');
    } catch (dialErr) {
      L('explicit dial error:', dialErr instanceof Error ? (dialErr.stack ?? dialErr.message) : String(dialErr));
    }
    for (let i = 0; i < 20 && cn.getConnections().length === 0; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    const connections = cn.getConnections().length;
    const ok = connections > 0;
    L(`========== DIAL VERDICT: ${ok ? 'PASS' : 'FAIL'} (conn=${connections}) ==========`);

    await node.stop();
  } catch (e) {
    L('ERROR:', e instanceof Error ? e.stack : String(e));
    try {
      await node?.stop();
    } catch {
      // ignore stop errors
    }
  }
}
