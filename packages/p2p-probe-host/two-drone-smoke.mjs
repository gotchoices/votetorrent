/**
 * packages/p2p-probe-host/two-drone-smoke.mjs — Phase 38 Wave-0 Node-only smoke (38-02 Task 2).
 *
 * De-risks Open Question 1 (RESEARCH.md) / D-04's n=4 topology BEFORE 38-05 spends any
 * emulator time growing the cohort: does `strandBootstrapNodes` wiring support a cohort
 * of >2 non-drone-launching peers cleanly, and do TWO `mode:'bootstrap'` drones
 * cross-bootstrap into a single strand cohort without a race, EADDRINUSE, or an
 * "only one bootstrap peer supported"-class assumption break?
 *
 * Topology (RESEARCH-recommended "2-drone + 1 solo-CLI-peer"), all in-process:
 *   drone-A (mode:'bootstrap', profile:'storage') — first bootstrap peer, no upstream.
 *   drone-B (mode:'bootstrap', profile:'storage') — cross-bootstrapped to drone-A's
 *     control AND strand multiaddrs.
 *   solo-peer (mode:'networked' — the default, undefined) — bootstrapped to BOTH
 *     drones' strand multiaddrs; hosts the SAME strand+schema, so its `addStrand()`
 *     call exercises the REAL distributed create-table DDL path (StrandDatabase's
 *     'networked' mode uses the 'network' transactor, unlike the drones' 'local'
 *     bootstrap-mode transactor) — this is the actual cohort-assembly proof, not a
 *     synthetic one.
 *
 * A minimal single-table schema is used (not the full votetorrent.qsql) — this smoke
 * only needs to prove the cohort forms and the distributed DDL completes, not exercise
 * the app's real schema.
 *
 * After the solo peer's strand comes up, `node.keyNetwork.findCluster()` is called
 * directly (the same FRET-cohort-assembly path `cluster-coordinator.js`'s
 * `cluster-tx:start` peerCount log reads from) to print an explicit, CLI-visible
 * peerCount — no DEBUG env / log-scraping required.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   nvm use 22
 *   node two-drone-smoke.mjs
 *
 * Exit 0 + "TWO-DRONE SMOKE: PASS" if the cohort assembles with peerCount >= 3 and no
 * bootstrap-mode race/error occurs; exit 1 + "TWO-DRONE SMOKE: FAIL <reason>" otherwise
 * — per D-04, a FAIL here is a precise plan-time blocker for 38-05's n=4 topology, NOT
 * a signal to silently fall back to the n=3 threshold-tune.
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';

const L = (...a) => console.log('[two-drone-smoke]', ...a);

const STRAND_ID = 'two-drone-smoke-strand';
const SAPP_ID = 'org.votetorrent.smoke';
const ADD_STRAND_TIMEOUT_MS = 45_000;
const COHORT_TIMEOUT_MS = 20_000;
const COHORT_POLL_INTERVAL_MS = 500;

// Minimal single-table schema (raw DDL — StrandDatabase.executeSchema() supplies the
// `declare schema App { ... } apply schema App;` wrapper itself, matching drone.mjs's
// stripped-wrapper convention for votetorrent.qsql).
const MINIMAL_SCHEMA = `
create table Probe (
  Id text primary key,
  Value text
);
`;

let droneA;
let droneB;
let solo;
let exitCode = 1;

function pickLoopbackWs(addrs) {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  // --- drone-A: first bootstrap peer, no upstream ---
  droneA = new CadreNode({
    controlNetwork: { partyId: 'votetorrent-two-drone-smoke', bootstrapNodes: [] },
    profile: 'storage',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE (drone.mjs pattern)
    },
    hibernation: { enabled: false },
  });
  await droneA.start();
  const droneAControlAddrs = droneA.getControlNode().getMultiaddrs().map((m) => m.toString());
  L('drone-A control addrs =', JSON.stringify(droneAControlAddrs));

  await withTimeout(
    droneA.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: MINIMAL_SCHEMA, latencyHint: 'interactive' },
      mode: 'bootstrap',
    }),
    ADD_STRAND_TIMEOUT_MS,
    'drone-A addStrand',
  );
  const droneAStrandAddrs = droneA.getStrand(STRAND_ID).libp2pNode.getMultiaddrs().map((m) => m.toString());
  const droneAStrandAddr = pickLoopbackWs(droneAStrandAddrs);
  L('drone-A strand addrs =', JSON.stringify(droneAStrandAddrs));
  if (!droneAStrandAddr) {
    throw new Error('drone-A strand node produced no usable multiaddr');
  }

  // --- drone-B: SECOND mode:'bootstrap' peer — cross-bootstrapped to drone-A's
  // control AND strand multiaddrs (Open Question 1: does a 2nd bootstrap-mode drone
  // race or assume it's the only one?). ---
  const droneAControlAddr = pickLoopbackWs(droneAControlAddrs);
  droneB = new CadreNode({
    controlNetwork: { partyId: 'votetorrent-two-drone-smoke', bootstrapNodes: [droneAControlAddr] },
    profile: 'storage',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'],
      strandBootstrapNodes: [droneAStrandAddr],
    },
    hibernation: { enabled: false },
  });
  await droneB.start();
  L('drone-B control addrs =', JSON.stringify(droneB.getControlNode().getMultiaddrs().map((m) => m.toString())));

  await withTimeout(
    droneB.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: MINIMAL_SCHEMA, latencyHint: 'interactive' },
      mode: 'bootstrap',
    }),
    ADD_STRAND_TIMEOUT_MS,
    'drone-B addStrand',
  );
  const droneBStrandAddrs = droneB.getStrand(STRAND_ID).libp2pNode.getMultiaddrs().map((m) => m.toString());
  const droneBStrandAddr = pickLoopbackWs(droneBStrandAddrs);
  L('drone-B strand addrs =', JSON.stringify(droneBStrandAddrs));
  if (!droneBStrandAddr) {
    throw new Error('drone-B strand node produced no usable multiaddr');
  }
  L('TWO-DRONE bootstrap-mode cross-cohort: both drones started cleanly — no race/EADDRINUSE/single-bootstrap-assumption error');

  // --- solo-peer: 'networked' mode (default) — bootstrapped to BOTH drones' strand
  // addrs. Its addStrand() exercises the REAL distributed create-table DDL path
  // (StrandDatabase 'networked' mode -> 'network' transactor -> coordinatedRepo ->
  // cluster-coordinator's real super-majority-gated executeClusterTransaction). ---
  solo = new CadreNode({
    controlNetwork: {
      partyId: 'votetorrent-two-drone-smoke',
      bootstrapNodes: [droneAControlAddr, pickLoopbackWs(droneB.getControlNode().getMultiaddrs().map((m) => m.toString()))],
    },
    profile: 'transaction',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'],
      strandBootstrapNodes: [droneAStrandAddr, droneBStrandAddr],
    },
    hibernation: { enabled: false },
  });
  await solo.start();
  L('solo-peer peerId =', solo.peerId?.toString());

  await withTimeout(
    solo.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: MINIMAL_SCHEMA, latencyHint: 'interactive' },
      // mode omitted -> defaults to 'networked' (StrandDatabase: transactor='network')
    }),
    ADD_STRAND_TIMEOUT_MS,
    'solo-peer addStrand',
  );
  L('solo-peer strand initialized — distributed create-table DDL completed via the network transactor');

  const soloStrandNode = solo.getStrand(STRAND_ID).libp2pNode;

  // Directly probe FRET cohort assembly (the same peerCount source cluster-coordinator's
  // 'cluster-tx:start' log reads from) — poll in case gossip/discovery is still settling.
  const cohortStart = Date.now();
  let peerCount = 0;
  let peerIds = [];
  while (Date.now() - cohortStart < COHORT_TIMEOUT_MS) {
    const peers = await soloStrandNode.keyNetwork.findCluster(new TextEncoder().encode('smoke-probe-block'));
    peerIds = Object.keys(peers ?? {});
    peerCount = peerIds.length;
    if (peerCount >= 3) break;
    await new Promise((r) => setTimeout(r, COHORT_POLL_INTERVAL_MS));
  }

  L(`assembleCohort peerCount=${peerCount} (peerIds=${JSON.stringify(peerIds)}) after ${Date.now() - cohortStart}ms`);

  if (peerCount < 3) {
    L(`TWO-DRONE SMOKE: FAIL cohort assembled only ${peerCount} peer(s), expected >= 3 — D-04 n=4 topology blocker`);
    exitCode = 1;
    return;
  }

  L('TWO-DRONE SMOKE: PASS');
  exitCode = 0;
}

async function shutdown() {
  for (const [name, node] of [
    ['solo', solo],
    ['drone-B', droneB],
    ['drone-A', droneA],
  ]) {
    if (node) {
      try {
        await node.stop();
      } catch (e) {
        L(`${name} stop error`, e);
      }
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
    L('TWO-DRONE SMOKE: FAIL', err?.stack ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
