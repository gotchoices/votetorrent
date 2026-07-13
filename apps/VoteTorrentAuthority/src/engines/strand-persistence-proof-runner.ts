/**
 * strand-persistence-proof-runner.ts — STR-02 on-device strand persistence proof (dev tooling).
 *
 * Boots a self-contained, bootstrap/solo CadreNode (own store, own identity — never the
 * shared `votetorrent-cadre-node` peerId store, never the solo `votetorrent-q2-*` scheme)
 * and hands it to the EXISTING `runPersistenceProof(node)` (persistence-proof-runner.ts),
 * which already threads an optional `StrandHost` through `makeProofEngine(node)` and branches
 * into `createStrandDbFactory(node)` (persistence-proof.ts, unchanged — D-05/D-06).
 *
 * This runner does NOT reimplement WRITE/READ/verdict logic — its entire proof body is a
 * single call to `runPersistenceProof(node)`. That call emits the SAME
 * `[proof] ========== FULL-CHAIN VERDICT: PASS|FAIL ==========` line `run-vtest02.sh` already
 * polls for, regardless of which DbFactory backs the engine.
 *
 * Bootstrap/SOLO ONLY (D-06) — `bootstrapNodes: []` and `strandBootstrapNodes: []` are
 * ALWAYS empty. No cross-peer wiring here; a genuine P2P-needing persistence gap degrades to
 * the boot/DDL/CHECK smoke and routes to Phase 38 (documented, not silently dropped).
 *
 * Gated: `__DEV__ && STRAND_PERSISTENCE_PROOF_ENABLED` — Metro dead-code-eliminates this
 * entire body in release builds (mirrors every other proof runner in this directory).
 *
 * Distinct store name: `votetorrent-cadre-probe-persistence` — NEVER `votetorrent-cadre-node`
 * (that store holds the stable peerId) and NEVER the solo `votetorrent-q2-*` naming scheme
 * (per project_strand_storage_per_network_isolation memory — a shared handle contaminates
 * count(*) across paths).
 *
 * Markers emitted (multi-arg — logcat grep must use .* between tag and message):
 *   [strand-persistence-proof] starting
 *   [strand-persistence-proof] peerId=<id>
 *   [strand-persistence-proof] ERROR: <...>            (on failure)
 *   (the FULL-CHAIN VERDICT line itself is emitted by runPersistenceProof under the [proof] tag)
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
import { STRAND_PERSISTENCE_PROOF_ENABLED } from './proof-flags.generated';
import { runPersistenceProof } from './persistence-proof-runner';
import type { StrandHost } from './rn-db-factory';

// Multi-arg form — REQUIRED so logcat renders '[strand-persistence-proof]', 'msg' and the
// harness `.*` grep matches. (STATE.md v2.0 Phase 17 Plan 06 lesson.)
const L = (...a: unknown[]) => console.info('[strand-persistence-proof]', ...a);

// Distinct store name for this proof runner's own CadreNode identity.
// NEVER 'votetorrent-cadre-node' — that store holds the stable peerId (T-23-03-02).
// NEVER the solo 'votetorrent-q2-*' naming scheme — that is the rnDbFactory solo store.
const CADRE_STORE = 'votetorrent-cadre-probe-persistence';

/**
 * Boot entry point. Fire-and-forget from index.js after AppRegistry.registerComponent.
 * No-op (returns immediately) when STRAND_PERSISTENCE_PROOF_ENABLED is false or __DEV__ is false.
 * Never throws — any failure is caught and logged as `[strand-persistence-proof] ERROR:`.
 *
 * D-05/D-06 — bootstrap/solo strand persistence proof (STR-02 on-device half).
 */
export async function runStrandPersistenceProof(): Promise<void> {
  if (!(__DEV__ && STRAND_PERSISTENCE_PROOF_ENABLED)) {
    return;
  }

  L('starting');

  let node: InstanceType<typeof CadreNode> | undefined;

  try {
    // ── 1. Boot this runner's own self-contained CadreNode (bootstrap/solo ONLY) ────────────
    const rnDb = openOptimysticRNDb({
      openFn: (n: string, c: boolean, e: boolean) => new LevelDB(n, c, e),
      WriteBatch: LevelDBWriteBatch,
      name: CADRE_STORE,
    });
    const privateKey = await loadOrCreateRNPeerKey(rnDb);

    node = new CadreNode({
      privateKey,
      // D-06: bootstrap/solo ONLY — never inject CONTROL_ADDR/STRAND_BOOTSTRAP_ADDR
      // placeholders here; cross-peer is explicitly out of scope for this proof.
      controlNetwork: { partyId: 'votetorrent', bootstrapNodes: [] },
      profile: 'transaction',
      // 40-03 (PUB-03): published @serfab/cadre-core@0.8.1 added a fail-closed sApp-schema
      // signature policy (requireSignedSchemas defaults true) — an unsigned sAppConfig is
      // rejected at strand bring-up with SchemaVerificationError('missing signature'). This
      // solo persistence-proof harness applies the unsigned votetorrent demo schema
      // (rn-db-factory sAppConfig has id:'org.votetorrent' + no signature), so relax the
      // policy for the proof node — the documented dev/test relaxation ("unsigned demo
      // schemas"). Production sApp-schema signing (id = author ed25519 pubkey + signSchema())
      // is a separate productionization task, out of this solo-boot/persistence proof's scope.
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => new LevelDBRawStorage(rnDb) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      network: {
        transports: [webSockets(), circuitRelayTransport()],
        listenAddrs: [],
        // Permissive gater — dev probe only (matches replication-proof-runner.ts / dial-probe.ts).
        connectionGater: { denyDialMultiaddr: async () => false },
        // D-06: bootstrap/solo ONLY — always empty, never a real/placeholder drone address.
        strandBootstrapNodes: [],
      } as any,
      hibernation: { enabled: false },
    });

    await node.start();

    const peerId = node.peerId?.toString() ?? 'unknown';
    L('peerId=', peerId);

    // ── 2. The entire proof body: hand the live node to the EXISTING runPersistenceProof. ───
    // makeProofEngine(node) (persistence-proof.ts, unchanged) branches into
    // createStrandDbFactory(node) when a node is passed, exercising the strand createContext
    // path end-to-end (WRITE → force-stop → relaunch → READ, D-05b) — or, on this same boot,
    // the CadreNode boot + strand DDL/CHECK smoke (D-05a) if the app has not yet reached the
    // read phase. No WRITE/READ/verdict logic is reimplemented here.
    await runPersistenceProof(node as StrandHost);

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
