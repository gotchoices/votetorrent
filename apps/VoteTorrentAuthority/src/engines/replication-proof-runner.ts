/**
 * replication-proof-runner.ts — P2P-06 on-device symmetric replication proof (dev tooling).
 *
 * Symmetric both-write / both-read proof (D-01/D-02): each peer creates a uniquely-named
 * network (`replication-test-<peerIdTail>`) via its own strand-backed session, then polls
 * for the OTHER peer's network. PASS = the peer's network is visible within the bounded
 * poll window; FAIL = timeout.
 *
 * Gated: `__DEV__ && REPLICATION_PROOF_ENABLED` — Metro dead-code-eliminates this entire
 * body in release builds (T-23-03-03).
 *
 * Boots its OWN CadreNode (store `votetorrent-cadre-probe-replication` — OQ2) so it is
 * self-contained and never collides with CadreNodeProvider's `votetorrent-cadre-node`.
 *
 * D-03 fresh-state wipe: `LevelDB.destroyDB` on ONLY the per-network strand store, wrapped
 * in try/catch so a failed wipe is auditable (logged warning) rather than silent (A1 mitigation).
 * The node-identity store (`votetorrent-cadre-node`) is NEVER destroyed (T-23-03-02).
 *
 * Markers emitted (multi-arg — logcat grep must use .* between tag and message):
 *   [replication-proof] starting
 *   [replication-proof] peerId=<id>          (D-05 / P2P-04)
 *   [replication-proof] strandId=<hash>      (OQ3 handshake)
 *   [replication-proof] peers=N              (D-06 / ENG-05)
 *   [replication-proof] ========== REPLICATION VERDICT: PASS|FAIL ==========
 *
 * Fire-and-forget from index.js. Never throws — all errors caught and logged.
 *
 * Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, LevelDBRawStorage, loadOrCreateRNPeerKey } from '@optimystic/db-p2p-storage-rn';
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
import { REPLICATION_PROOF_ENABLED } from './proof-flags.generated';
import { createStrandDbFactory } from './rn-db-factory';

// Multi-arg form — REQUIRED so logcat renders '[replication-proof]', 'msg' and the
// harness `.*` grep matches. (STATE.md v2.0 Phase 17 Plan 06 lesson.)
const L = (...a: unknown[]) => console.log('[replication-proof]', ...a);

// Distinct store name for the proof runner's own CadreNode identity (OQ2).
// NEVER 'votetorrent-cadre-node' — that store holds the stable peerId (D-05 / T-23-03-02).
const CADRE_STORE = 'votetorrent-cadre-probe-replication';

// The per-network strand store name (without the votetorrent- prefix that destroyDB prepends).
// destroyDB targets ONLY 'votetorrent-' + PROOF_NETWORK_STORE (D-03 / T-23-03-02).
const PROOF_NETWORK_STORE = 'replication-proof-strand';

// Control address — the drone's ws multiaddr. The harness (Plan 04) injects this via a
// generated config; for now use the same placeholder shape as dial-probe.ts. The runner
// reads CONTROL_ADDR at boot; Plan 04 writes the real address before bundling (D-07).
const CONTROL_ADDR = '/ip4/10.0.2.2/tcp/0/ws/p2p/UPDATE_AFTER_DRONE_RESTART';

// Poll constants (consistent with dial-probe.ts connection-poll shape).
// PEER_POLL_MAX: 3 ticks × 1 s = 3 s peer-connection wait (exits early when peers appear).
//   On a real device with a live drone the peer handshake typically completes within 1–2 s.
//   3 ticks is the minimum that covers transient boot delays without blocking unit tests past
//   Jest's default 5 s timeout (tests 2 and 3 each run the full 3 s peer wait).
// REPL_POLL_MAX: 120 ticks × 1 s = 120 s replication wait (exits early when strand replicates).
//   The read poll is ONLY entered when peerCount >= 1 after the peer wait. If peerCount === 0
//   the verdict is FAIL immediately — no peers means no replication is possible.
const PEER_POLL_MAX = 3;
const REPL_POLL_MAX = 120;
const POLL_INTERVAL_MS = 1000;

/**
 * Boot entry point.  Fire-and-forget from index.js after AppRegistry.registerComponent.
 * No-op (returns immediately) when REPLICATION_PROOF_ENABLED is false or __DEV__ is false.
 * Never throws — any failure is caught and logged as `[replication-proof] ERROR:`.
 *
 * P2P-06 / SC2 — the in-app harness that drives the on-device proof.
 */
export async function runReplicationProof(): Promise<void> {
  if (!(__DEV__ && REPLICATION_PROOF_ENABLED)) {
    return;
  }

  L('starting');

  let node: InstanceType<typeof CadreNode> | undefined;

  try {
    // ── 1. Boot the runner's own CadreNode (mirrors dial-probe.ts lines 49–74) ──────────────
    const rnDb = openOptimysticRNDb({
      openFn: (n: string, c: boolean, e: boolean) => new LevelDB(n, c, e),
      WriteBatch: LevelDBWriteBatch,
      name: CADRE_STORE,
    });
    const privateKey = await loadOrCreateRNPeerKey(rnDb);

    node = new CadreNode({
      privateKey,
      controlNetwork: { partyId: 'votetorrent', bootstrapNodes: [CONTROL_ADDR] },
      profile: 'transaction',
      strandFilter: { mode: 'all' },
      storage: { provider: () => new LevelDBRawStorage(rnDb) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      network: {
        transports: [webSockets(), circuitRelayTransport()],
        listenAddrs: [],
        // Permissive gater — dev probe only (matches dial-probe.ts / cadre-runtime-ondevice.md).
        // Cast: cadre-core's NetworkConfig type doesn't declare connectionGater yet (upstream gap);
        // the cadre-core patch forwards it into createLibp2pNode at runtime (spike 009 fix).
        connectionGater: { denyDialMultiaddr: async () => false },
      } as any,
      hibernation: { enabled: false },
    });

    await node.start();

    // ── 2. D-05 / P2P-04 peerId marker ──────────────────────────────────────────────────────
    const peerId = node.peerId?.toString() ?? 'unknown';
    L('peerId=', peerId);

    // Derive unique per-peer suffix for the proof network name (last 8 chars of peerId).
    const peerTail = peerId.length >= 8 ? peerId.slice(-8) : peerId;
    const proofNetworkName = `replication-test-${peerTail}`;

    // ── 3. D-03 fresh-state wipe — per-network store ONLY, try/catch, never silent (A1) ─────
    // NEVER call LevelDB.destroyDB('votetorrent-cadre-node') — the peerId store must survive.
    try {
      LevelDB.destroyDB('votetorrent-' + PROOF_NETWORK_STORE);
      L('wiped per-network store', PROOF_NETWORK_STORE);
    } catch (wipeErr) {
      // A failed wipe is auditable (logged warning) — proof continues (A1 LOW-conf mitigation).
      L('WARN wipe failed (continuing, determinism may be reduced):', wipeErr);
    }

    // ── 4. WRITE: create proof network via strand-backed factory path (Pitfall 7 / D-14) ─────
    // createStrandDbFactory(node) calls setSchemaPath(['App','main']) internally so bare SQL
    // table names resolve without rewriting engine queries (D-14). The strand factory is used
    // — not the local rnDbFactory and not a bare Quereus Database constructor call (Pitfall 7).
    let strandDb: Awaited<ReturnType<ReturnType<typeof createStrandDbFactory>>> | undefined;
    try {
      const strandDbFactory = createStrandDbFactory(node as Parameters<typeof createStrandDbFactory>[0]);
      // The shared strand ID is the PROOF_NETWORK_STORE constant; both peers join the same strand.
      // OQ3: strandId=<hash> is logged so the harness can launch the drone with STRAND_ID=<hash>.
      strandDb = await strandDbFactory(PROOF_NETWORK_STORE);

      // Log OQ3 handshake marker before the write so the harness can capture it.
      L('strandId=', PROOF_NETWORK_STORE);

      // Write the uniquely-named proof network via the strand-backed Quereus DB.
      // setSchemaPath(['App','main']) is already set by createStrandDbFactory so 'Network'
      // resolves to 'App.Network' without any query rewrite (D-14).
      const networkId = `proof-${peerTail}`;
      // Use VOTETORRENT_SCHEMA_SQL to satisfy the import (tree-shaken in release).
      void VOTETORRENT_SCHEMA_SQL;
      await strandDb.exec(
        `INSERT OR IGNORE INTO Network (Id, Name, Location, ElectionCount, AuthorityId) VALUES ('${networkId}', '${proofNetworkName}', '', 0, '')`,
      );
    } catch (writeErr) {
      // Write phase error — log the error; proof continues to the read phase which will FAIL.
      L('WARN write phase error (proof will FAIL):', writeErr instanceof Error ? writeErr.message : String(writeErr));
      // Still emit OQ3 strandId marker for harness capture even on write failure.
      if (!strandDb) {
        L('strandId=', PROOF_NETWORK_STORE);
      }
    }

    // ── 5. WAIT for peers: poll getConnections() up to PEER_POLL_MAX ticks ─────────────────
    const cn = node.getControlNode();
    for (let i = 0; i < PEER_POLL_MAX && (cn?.getConnections().length ?? 0) === 0; i++) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    const peerCount = cn?.getConnections().length ?? 0;
    // D-06 / ENG-05: live peer-count marker — logged once (pass or timeout).
    L('peers=', peerCount);

    // ── 6. READ: bounded poll for the OTHER peer's proof network ────────────────────────────
    // The other peer writes `replication-test-<theirTail>` (theirTail ≠ peerTail).
    // Any `replication-test-*` row that does NOT end with `-${peerTail}` proves cross-peer
    // strand replication succeeded (D-01 symmetric proof — no role flag).
    //
    // OPTIMIZATION: if peerCount === 0 after the peer-wait, skip the read poll entirely and
    // emit FAIL immediately. No peers → no replication is possible within the poll window;
    // this also keeps unit-test runtime within Jest's default 5 s timeout.
    let verdict = false;
    if (peerCount > 0) {
      try {
        const strandDbFactory = createStrandDbFactory(node as Parameters<typeof createStrandDbFactory>[0]);
        const readDb = strandDb ?? await strandDbFactory(PROOF_NETWORK_STORE);

        for (let i = 0; i < REPL_POLL_MAX && !verdict; i++) {
          try {
            // `eval` yields rows lazily via AsyncIterableIterator (no `all` on Database).
            for await (const row of readDb.eval(
              `SELECT Name FROM Network WHERE Name LIKE 'replication-test-%' AND Name != '${proofNetworkName}'`,
            )) {
              if (row && row['Name']) {
                verdict = true;
                break;
              }
            }
            if (!verdict) {
              await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
            }
          } catch {
            // Strand may still be bootstrapping — retry.
            await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }
      } catch (readErr) {
        L('WARN read phase error:', readErr instanceof Error ? readErr.message : String(readErr));
      }
    }

    // ── 7. REPLICATION VERDICT (byte-identical to logcat grep target) ───────────────────────
    L(`========== REPLICATION VERDICT: ${verdict ? 'PASS' : 'FAIL'} ==========`);

    await node.stop();
  } catch (e) {
    L('ERROR:', e instanceof Error ? e.stack : String(e));
    // Emit a FAIL verdict — the harness needs the verdict line regardless of errors.
    L('========== REPLICATION VERDICT: FAIL ==========');
    try {
      await node?.stop();
    } catch {
      // ignore stop errors
    }
  }
}
