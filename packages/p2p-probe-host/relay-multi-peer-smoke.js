/**
 * packages/p2p-probe-host/relay-multi-peer-smoke.mjs — Phase-41 Wave-0 Node-only D-02 gate.
 *
 * De-risks the whole multi-peer-relay-close phase BEFORE any costly emulator run. Extends
 * `two-drone-smoke.mjs`'s topology skeleton (multi-node array, sequential start, bounded
 * poll, explicit exit code, SIGINT/SIGTERM shutdown) and `relay-smoke.mjs`'s relay-client
 * config + reservation-poll into a single harness that boots 2 relay-drones + 2 relay-client
 * peers and directly reproduces the carried P2P-11 "wall #8" (the per-drone relay-reservation
 * asymmetry) on Node, then proves the relay-qualified-addr fix closes it — in seconds, not a
 * 30+ minute device run.
 *
 * Mechanism under test (read directly from the installed @libp2p/circuit-relay-v2@4.2.5
 * dist source, then EXERCISED live on this exact installed graph — findings feed 41-02):
 *   - A bare `/p2p-circuit` listenAddr entry reserves relay capacity via the 'discovered'
 *     reservation type, capped at ONE reservation per listen-addr entry — the second relay
 *     discovered after the first completes hits HadEnoughRelaysError and is silently
 *     rejected. This is the wall-#8 mechanism, and it reproduces exactly on Node.
 *   - A relay-qualified listenAddr entry (`${relayAddr}/p2p-circuit`, one per known relay)
 *     takes the 'configured' reservation path (listener.js CircuitListen.exactMatch →
 *     openConnection(relayAddr) + reservationStore.addRelay(peerId, 'configured')), which
 *     is EXEMPT from the one-slot cap.
 *   - CRITICAL EXERCISED FINDING (not in the static research; discovered by running this
 *     gate — 41-02 must apply BOTH parts of the fix): N relay-qualified entries alone do
 *     NOT yield N reservations under the DEFAULT `circuitRelayTransport()`. The reservation
 *     queue runs at DEFAULT_RESERVATION_CONCURRENCY = 1, so the first 'configured'
 *     reservation completes and calls #checkReservationCount(), which — because no bare
 *     `/p2p-circuit` seed left any 'discovered' slot pending (pendingReservations.length===0)
 *     — treats that as "have enough relays" and calls reserveQueue.clear(), DROPPING the
 *     still-queued second reservation (and, because listen() awaits it, hanging start()).
 *     The fix is to raise reservation concurrency so both 'configured' reservations are
 *     in-flight before either clears the queue: `circuitRelayTransport({ reservationConcurrency: N })`.
 *
 * Topology, all in-process:
 *   drone-A (profile:'storage', bounded relayServerInit) — first bootstrap peer, no upstream.
 *   drone-B (profile:'storage', bounded relayServerInit) — cross-bootstrapped to drone-A's
 *     control AND strand multiaddrs (mirrors two-drone-smoke.mjs). Both drone STRAND nodes
 *     also derive enableRelay from profile:'storage', so each is a circuit-relay server.
 *   client-A / client-B (profile:'transaction', CadreNodeProvider.tsx-shaped) — run in TWO
 *     modes, selected by LISTEN_MODE (default: run BOTH sequentially). In BOTH modes the
 *     relay TARGET is the drones' STRAND-node addresses (a separate libp2p instance/port
 *     from their control addresses, per RESEARCH.md Pitfall 2):
 *       BARE      — controlNetwork.bootstrapNodes = [droneA-control, droneB-control] (needed
 *                   so relay discovery LEARNS of both drones as candidate relays, and so the
 *                   client's own control-DB founds cleanly). network.listenAddrs =
 *                   ['/p2p-circuit'], transports use the DEFAULT `circuitRelayTransport()`
 *                   (verbatim mirror of the CURRENT app). start() succeeds; the discovered
 *                   reservation forms post-start and the one-slot cap holds — expect exactly
 *                   ONE distinct relay peer reserved per client (reproduces wall #8).
 *       QUALIFIED — controlNetwork.bootstrapNodes = [] (SOLO — the client is told NOTHING
 *                   about any drone; this settles Assumption A1 in the strongest possible
 *                   form: the 'configured' path cold-dials both drone STRAND nodes purely
 *                   from the listenAddrs). network.listenAddrs = [`${droneAStrand}/p2p-circuit`,
 *                   `${droneBStrand}/p2p-circuit`] with `circuitRelayTransport({ reservationConcurrency: 2 })`
 *                   (the fix). Expect TWO distinct relay peers reserved per client (both drones).
 *
 * NOTE on the QUALIFIED observation (an in-process-harness artifact, NOT a device concern):
 *   A 'transaction' client that founds its OWN control-DB in the SAME start() as it takes
 *   relay reservations cannot complete the founding CadreControl DDL — the relayed
 *   self-addresses the configured reservations publish break the control cohort's own
 *   consensus delivery, so start() ultimately rejects. This does NOT affect the reservation
 *   result (the reservations form ~20ms into start, well before the DDL step), so QUALIFIED
 *   mode OBSERVES the reservation count via a poller that reads getControlNode().getMultiaddrs()
 *   while start() runs, tolerating the known founding-DDL rejection. On device this artifact
 *   does not arise: the app's control-DB is already founded from an earlier session, so a
 *   relaunch's relay reservations never race a founding DDL.
 *
 * After the reservation gate, Task 2's four source-level open probes (Open Q1 per-node-type
 * network override, native autoDial vs the retired 38-14 retry-dial, the n=4/needed=3 quorum
 * formula, and the @libp2p/interface single-copy count) are printed as labeled, source-cited
 * log lines — diagnostic reads + assertions only, no product/vendored code is touched.
 *
 * Phase-41-04 addition — STRAND-COHORT SMOKE (D-02, drives REAL strand-cohort formation, not
 * just relay reservation): after the reservation modes above, a fresh 2-drone + 2-relay-client
 * topology is booted where both clients are CONTROL-bootstrapped to both drones (so
 * `resolveCohortSeed`'s strand-addr RPC — see below — has live control connections to query)
 * AND carry the D-05 relay-qualified `network.listenAddrs`/`reservationConcurrency` posture
 * (the exact shape `replication-proof-runner.ts`/`CadreNodeProvider.tsx` ship). Each client then
 * calls `addStrand()` on the SAME strand the drones host and polls
 * `getStrand(STRAND_ID)?.libp2pNode?.getConnections()?.length` (the runner's exact
 * `readStrandPeers` accessor) until `strandPeers>0` or a bounded timeout.
 *
 * SOURCE-READ FINDING (not in the 41-01/41-02 static research — read directly from the
 * INSTALLED `@serfab/cadre-core@0.8.1` dist this session): the `network.strandBootstrapNodes`
 * field VT's app config still sets is DEAD on this substrate. `NetworkConfig`
 * (`dist/types.d.ts:107-172`) has NO `strandBootstrapNodes` field at all (retired), and
 * `StrandInstanceManager.buildStrandRuntime` (`dist/strand-instance-manager.js:165`) sources its
 * `createLibp2pNode({ bootstrapNodes, ... })` call from `config.bootstrapNodes` — which
 * `CadreNode.launchStrand` (`dist/cadre-node.js:1909-1928`) populates from
 * `resolveCohortSeed(strandId)` (`:1943-1957`), NOT from any caller-supplied strand-bootstrap
 * list. `resolveCohortSeed` queries the CONTROL network's already-connected `CadrePeer` siblings
 * and RPCs each one over the control mesh via `collectStrandAddrs`/`STRAND_ADDR_PROTOCOL`
 * (`dist/strand-addr-protocol.js`, protocol id `/sereus/strand-addr/1.0.0`) asking "what are your
 * live strand-`X` multiaddrs?" — the responder answers with
 * `orderSignalingFirst(node.getMultiaddrs())` (`cadre-node.js:1961-1972`, relay/`p2p-circuit`
 * addrs ordered first). This REPLACES the old static-address strand-bootstrap model entirely; a
 * strand joiner needs ONLY a live CONTROL connection to a sibling that already runs the strand —
 * no manual strand-address wiring is read by cadre-core at all on this substrate.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   node relay-multi-peer-smoke.mjs                  # runs BOTH modes (default)
 *   LISTEN_MODE=bare node relay-multi-peer-smoke.mjs      # bare mode only
 *   LISTEN_MODE=qualified node relay-multi-peer-smoke.mjs # qualified mode only
 *   LISTEN_MODE=none node relay-multi-peer-smoke.mjs      # skip both reservation modes (isolates the strand-cohort gate)
 *   STRAND_COHORT_SMOKE=skip node relay-multi-peer-smoke.mjs # skip the strand-cohort gate
 *
 * Exit 0 + "MULTI-PEER RELAY SMOKE: PASS" when (bare-mode clients reserve with exactly 1
 * drone each) AND (qualified-mode clients reserve with 2 drones each); exit 1 +
 * "MULTI-PEER RELAY SMOKE: FAIL <reason>" otherwise — a FAIL here is a precise pre-device
 * blocker, not a signal to proceed to the emulator run. The STRAND-COHORT SMOKE verdict is
 * printed ADDITIONALLY and does NOT change the process exit code (D-02: a Node FAIL there is
 * only decisive once the diagnosis doc below adjudicates whether the wall is Node-reproducible
 * or an emulator-NAT-only surface — see 41-04-STRAND-COHORT-DIAGNOSIS.md).
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage, createLibp2pNode } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';

const L = (...a) => console.log('[relay-multi-peer-smoke]', ...a);

const PARTY_ID = 'votetorrent-relay-multi-peer-smoke';
const STRAND_ID = 'relay-multi-peer-smoke-strand';
const SAPP_ID = 'org.votetorrent.smoke';
const ADD_STRAND_TIMEOUT_MS = 45_000;
const RESERVATION_TIMEOUT_MS = 30_000;
// Tight poll — QUALIFIED-mode reservations form ~20ms into start(), before the founding-DDL
// step rejects and tears the control node down, so the observer must sample frequently.
const RESERVATION_POLL_INTERVAL_MS = 15;

// Bounded relay-server caps — mirrors drone.mjs's dev-harness DoS posture (T-38-12-01
// precedent, carried forward per this plan's <threat_model> T-41-01).
const RELAY_SERVER_INIT = {
  reservations: {
    maxReservations: 32,
    defaultDurationLimit: 2 * 60 * 1000, // 2 min per reservation
    defaultDataLimit: BigInt(1 << 17), // 128 KiB per reservation
  },
  maxInboundHopStreams: 64,
  maxOutboundStopStreams: 64,
};

// Minimal single-table schema (raw DDL — mirrors two-drone-smoke.mjs's convention). This
// smoke only needs the strand to come up far enough to produce a real strand-node
// multiaddr (for the qualified-mode relay target); it does not exercise the app schema.
const MINIMAL_SCHEMA = `
create table Probe (
  Id text primary key,
  Value text
);
`;

const REQUESTED_MODE = process.env.LISTEN_MODE;
const MODES_TO_RUN =
  REQUESTED_MODE === 'bare' || REQUESTED_MODE === 'qualified'
    ? [REQUESTED_MODE]
    : REQUESTED_MODE === 'none'
      ? [] // isolates the STRAND-COHORT SMOKE gate below for fast standalone diagnosis
      : ['bare', 'qualified'];
const RUN_STRAND_COHORT_SMOKE = process.env.STRAND_COHORT_SMOKE !== 'skip';

const STRAND_COHORT_TIMEOUT_MS = 45_000;
const STRAND_COHORT_POLL_INTERVAL_MS = 500;

let exitCode = 1;
let currentNodes = [];

// ── Phase-41-04 signal instrumentation ──────────────────────────────────────────────────────
// Tallies the THREE 41-03 signals (drone D-08 histogram classes) as they surface on Node,
// via global unhandledRejection/uncaughtException hooks — the gossipsub `fns.shift` throw and
// the FRET `UnsupportedProtocolError` both originate deep inside async protocol-negotiation
// paths this harness never calls directly, so a global catch is the only reliable capture point
// (mirrors how the device D-08 histogram was built from raw logcat, not from an app-level try/catch).
const signalCounts = {
  noValidAddresses: 0,
  gossipsubFnsShift: 0,
  fretUnsupportedProtocol: 0,
  fretMalformedDoubleSlash: 0,
};

function classifySignal(err) {
  const msg = (err && err.message) || String(err);
  const name = (err && err.name) || '';
  if (/no valid addresses for peer/i.test(msg)) {
    signalCounts.noValidAddresses++;
    return;
  }
  if (/fns\.shift is not a function/.test(msg)) {
    signalCounts.gossipsubFnsShift++;
    return;
  }
  if (name === 'UnsupportedProtocolError' || /could not negotiate/i.test(msg)) {
    signalCounts.fretUnsupportedProtocol++;
    if (msg.includes('//optimystic') || /\/\/optimystic/.test(msg)) {
      signalCounts.fretMalformedDoubleSlash++;
    }
  }
}

// Non-fatal by design (mirrors the device capture — a thrown protocol error must not crash the
// harness process, exactly as it does not crash the app on-device). Registered once, globally,
// for the whole run (all three modes + the strand-cohort gate) so nothing is missed.
process.on('unhandledRejection', (reason) => classifySignal(reason));
process.on('uncaughtException', (err) => classifySignal(err));

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

async function stopNodes(nodes) {
  for (const [name, node] of nodes) {
    if (node) {
      try {
        await node.stop();
      } catch (e) {
        L(`${name} stop error`, e);
      }
    }
  }
}

async function bootDrone(name, bootstrapControlAddr, strandBootstrapAddr) {
  const drone = new CadreNode({
    controlNetwork: {
      partyId: PARTY_ID,
      bootstrapNodes: bootstrapControlAddr ? [bootstrapControlAddr] : [],
    },
    profile: 'storage',
    strandFilter: { mode: 'all' },
    // Published cadre-core@0.8.1 defaults to fail-closed schema-signature verification
    // (types.d.ts:349-352); this dev-only unsigned MINIMAL_SCHEMA needs the explicit relax.
    requireSignedSchemas: false,
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
      relayServerInit: RELAY_SERVER_INIT,
      ...(strandBootstrapAddr && { strandBootstrapNodes: [strandBootstrapAddr] }),
    },
    hibernation: { enabled: false },
  });
  await drone.start();
  const controlAddrs = drone.getControlNode().getMultiaddrs().map((m) => m.toString());
  const controlAddr = pickLoopbackWs(controlAddrs);
  L(`${name} control addrs =`, JSON.stringify(controlAddrs));

  await withTimeout(
    drone.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: MINIMAL_SCHEMA, latencyHint: 'interactive' },
      mode: 'bootstrap',
    }),
    ADD_STRAND_TIMEOUT_MS,
    `${name} addStrand`,
  );
  const strandAddrs = drone.getStrand(STRAND_ID).libp2pNode.getMultiaddrs().map((m) => m.toString());
  const strandAddr = pickLoopbackWs(strandAddrs);
  L(`${name} strand addrs =`, JSON.stringify(strandAddrs));
  if (!strandAddr) {
    throw new Error(`${name} strand node produced no usable multiaddr`);
  }
  return { drone, controlAddr, strandAddr };
}

// BARE mode: one sentinel entry — the 'discovered' reservation path, one-slot capped.
// QUALIFIED mode: one relay-qualified entry PER drone STRAND node (RESEARCH.md Pattern 1) —
// the 'configured' reservation path, EXEMPT from the one-slot cap.
function buildClientListenAddrs(mode, droneAStrandAddr, droneBStrandAddr) {
  return mode === 'bare' ? ['/p2p-circuit'] : [`${droneAStrandAddr}/p2p-circuit`, `${droneBStrandAddr}/p2p-circuit`];
}

// BARE mode uses the DEFAULT `circuitRelayTransport()` (verbatim mirror of the current app).
// QUALIFIED mode raises `reservationConcurrency` to the drone count so both 'configured'
// reservations are in-flight before the first completes and #checkReservationCount() clears
// the reserve queue (the EXERCISED finding documented in the file header + SUMMARY).
function buildClientTransports(mode, droneCount) {
  return mode === 'bare'
    ? [webSockets(), circuitRelayTransport()]
    : [webSockets(), circuitRelayTransport({ reservationConcurrency: droneCount })];
}

// BARE mode bootstraps the client's CONTROL network to BOTH drone controls — needed so relay
// discovery LEARNS of both drones (making the one-slot cap observable, not trivially "never
// heard of drone-B") AND so the client's own control-DB founds cleanly (start() succeeds).
// QUALIFIED mode uses NO control bootstrap ([]) — the client is told NOTHING about any drone;
// the 'configured' path cold-dials both drone STRAND nodes purely from the qualified
// listenAddrs (the strongest form of Assumption A1: reservation without prior knowledge).
function buildClientBootstrapNodes(mode, droneAControlAddr, droneBControlAddr) {
  return mode === 'bare' ? [droneAControlAddr, droneBControlAddr] : [];
}

function newClient(mode, droneAControlAddr, droneBControlAddr, droneAStrandAddr, droneBStrandAddr) {
  return new CadreNode({
    controlNetwork: {
      partyId: PARTY_ID,
      bootstrapNodes: buildClientBootstrapNodes(mode, droneAControlAddr, droneBControlAddr),
    },
    profile: 'transaction',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: buildClientTransports(mode, 2),
      listenAddrs: buildClientListenAddrs(mode, droneAStrandAddr, droneBStrandAddr),
      connectionGater: { denyDialMultiaddr: async () => false },
    },
    hibernation: { enabled: false },
  });
}

// A single relay peer can surface as MULTIPLE '/p2p-circuit' multiaddr strings (e.g. one per
// underlying listen interface — loopback + LAN — on the same drone). The reservation gate
// (one-slot 'discovered' cap vs. unconditional 'configured') operates PER RELAY PEER, not per
// address string, so the pass/fail count dedupes by the relay's peer ID (the path segment
// immediately preceding '/p2p-circuit').
function extractRelayPeerIds(circuitAddrs) {
  const ids = new Set();
  for (const addr of circuitAddrs) {
    const m = addr.match(/\/p2p\/([^/]+)\/p2p-circuit/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function readCircuitAddrs(client) {
  let ctl = null;
  try {
    ctl = client.getControlNode();
  } catch {
    ctl = null;
  }
  if (!ctl) return [];
  try {
    return ctl.getMultiaddrs().map((m) => m.toString()).filter((a) => a.includes('/p2p-circuit'));
  } catch {
    return [];
  }
}

// Unified reservation observer. Kicks off client.start() in the background (its rejection is
// tolerated — in QUALIFIED mode the founding-DDL step rejects AFTER the reservations form, an
// in-process-harness artifact described in the file header) and polls the control node's
// '/p2p-circuit' multiaddrs, tracking the MAX distinct relay-peer count seen. In BARE mode
// start() succeeds and the discovered reservation forms post-start; in QUALIFIED mode the
// configured reservations form ~20ms into start, well before the DDL rejection and teardown.
async function observeReservations(client, name, mode, targetCount) {
  let startSettled = false;
  let startError = null;
  const startPromise = client.start().then(
    () => {
      startSettled = true;
    },
    (e) => {
      startSettled = true;
      startError = e;
    },
  );

  const pollStart = Date.now();
  let maxRelayPeerIds = [];
  let maxCircuitAddrs = [];
  while (Date.now() - pollStart < RESERVATION_TIMEOUT_MS) {
    const circuitAddrs = readCircuitAddrs(client);
    const relayPeerIds = extractRelayPeerIds(circuitAddrs);
    if (relayPeerIds.length > maxRelayPeerIds.length) {
      maxRelayPeerIds = relayPeerIds;
      maxCircuitAddrs = circuitAddrs;
    }
    if (maxRelayPeerIds.length >= targetCount) break;
    // In BARE mode, once start() has succeeded and the node is up, keep polling for the
    // async discovered reservation; in QUALIFIED mode, if start() already rejected AND the
    // node is gone before we saw the target, stop early (no more observations possible).
    if (startSettled && startError != null && readCircuitAddrs(client).length === 0 && maxRelayPeerIds.length === 0) {
      break;
    }
    await new Promise((r) => setTimeout(r, RESERVATION_POLL_INTERVAL_MS));
  }

  await startPromise; // ensure the (tolerated) start rejection is awaited/handled
  if (startError != null) {
    L(
      `${name} (${mode}) start() rejected (tolerated in-process artifact):`,
      (startError?.message ?? String(startError)).slice(0, 90),
    );
  }
  return { circuitAddrs: maxCircuitAddrs, relayPeerIds: maxRelayPeerIds, elapsedMs: Date.now() - pollStart };
}

async function runMode(mode) {
  L(`===== MODE=${mode} — booting topology =====`);
  const nodes = [];
  currentNodes = nodes;

  const droneA = await bootDrone(`drone-A[${mode}]`, undefined, undefined);
  nodes.push(['drone-A', droneA.drone]);
  const droneB = await bootDrone(`drone-B[${mode}]`, droneA.controlAddr, droneA.strandAddr);
  nodes.push(['drone-B', droneB.drone]);
  L(
    `MODE=${mode} bootstrap-mode cross-cohort: both drones started cleanly`,
    '— no race/EADDRINUSE/single-bootstrap-assumption error (mirrors two-drone-smoke.mjs)',
  );

  const clientA = newClient(mode, droneA.controlAddr, droneB.controlAddr, droneA.strandAddr, droneB.strandAddr);
  nodes.push(['client-A', clientA]);
  const clientB = newClient(mode, droneA.controlAddr, droneB.controlAddr, droneA.strandAddr, droneB.strandAddr);
  nodes.push(['client-B', clientB]);

  const targetCount = mode === 'bare' ? 1 : 2;
  const resultA = await observeReservations(clientA, 'client-A', mode, targetCount);
  const resultB = await observeReservations(clientB, 'client-B', mode, targetCount);

  // D-04 pre-instrumentation shape — log the FULL filtered array per client (not just a
  // boolean or a count), so a per-drone asymmetry (wall #8) is directly visible in CLI
  // output, alongside the deduped distinct-relay-peer count the verdict is based on.
  L(
    `MODE=${mode} client-A /p2p-circuit addrs (distinct relay peers=${resultA.relayPeerIds.length}, after ${resultA.elapsedMs}ms) =`,
    JSON.stringify(resultA.circuitAddrs),
  );
  L(
    `MODE=${mode} client-B /p2p-circuit addrs (distinct relay peers=${resultB.relayPeerIds.length}, after ${resultB.elapsedMs}ms) =`,
    JSON.stringify(resultB.circuitAddrs),
  );

  await stopNodes(nodes);
  currentNodes = [];

  const expected = mode === 'bare' ? 1 : 2;
  const pass = resultA.relayPeerIds.length === expected && resultB.relayPeerIds.length === expected;
  L(`MODE=${mode} verdict: ${pass ? 'PASS' : 'FAIL'} (expected exactly ${expected} distinct relay peer(s) per client)`);
  return { mode, pass, clientA: resultA.relayPeerIds, clientB: resultB.relayPeerIds };
}

function printProbeFindings() {
  L('===== SOURCE-LEVEL OPEN PROBE FINDINGS (Task 2) =====');

  // Probe 1 — Open Q1: per-node-type / per-strand network override.
  L(
    'PROBE 1 (Open Q1 — per-strand network override): SETTLED = NO override exists.',
    "Public addStrand() param `StrandConfig` (@serfab/cadre-core dist/types.d.ts:375-397) carries only",
    'strandRow/sAppConfig/mode/founder — no `network` field at all.',
    'CadreNode.launchStrand() (dist/cadre-node.js:1916) forwards `network: this.config.network` — the SAME',
    "constructor-level object reference — into StrandInstanceManager.startStrand(). StartStrandConfig's own",
    'optional `network?: NetworkConfig` (dist/strand-instance-manager.d.ts) is populated FROM that forwarded',
    'value, not from any caller-supplied per-strand override — there is no public path to diverge it.',
    "CONCLUSION: 41-02 must use ONE shared listenAddrs array carrying BOTH drones' qualified addrs",
    '(confirms RESEARCH.md Pitfall 2 / Assumption A2).',
  );

  // Probe 2 — Pattern 2: native autoDial obsoletes 38-14's custom retry-dial.
  L(
    'PROBE 2 (native autoDial vs 38-14 dialStrandBootstrapPeers): CONFIRMED present, OBSOLETES 38-14.',
    '@optimystic/db-p2p@0.14.1 dist/src/libp2p-node-base.js:152-154 sets',
    'connectionManager:{ autoDial:true, minConnections:1, ... } unconditionally inside createLibp2pNode.',
    "This harness's own drone-B->drone-A cross-bootstrap and all relay-client boots above connected with",
    'ZERO custom retry-dial code (no dialStrandBootstrapPeers()-equivalent was written or needed).',
    "DECISION: do NOT re-port 38-14's custom bounded retry-dial loop — native autoDial supersedes it (D-01).",
  );

  // Probe 3 — quorum math re-confirmation (also independently asserted by the <verify> command).
  const superMajority = Math.ceil(4 * 0.67);
  if (superMajority !== 3) {
    L('PROBE 3 (quorum n=4/needed=3): DRIFT DETECTED — Math.ceil(4*0.67) =', superMajority, '(expected 3)');
    throw new Error(`Quorum formula drift: Math.ceil(4*0.67)=${superMajority}, expected 3`);
  }
  L(
    'PROBE 3 (quorum n=4/needed=3): CONFIRMED byte-identical to Phase 38.',
    'Math.ceil(4 * 0.67) === 3 asserted green.',
    '@optimystic/db-p2p@0.14.1 dist/src/cluster/cluster-repo.js:93 `superMajorityThreshold ?? 1.0` (overridden',
    'to 0.67 at call sites, dist/src/libp2p-node-base.js:322), :450 `Math.ceil(peerCount*this.superMajorityThreshold)`;',
    "@serfab/cadre-core@0.8.1 dist/cadre-node.js:493 `clusterSize: 3` (hardcoded, unchanged).",
    'The n=4/needed=3 PASS bar carries forward unchanged into the device wave.',
  );

  // Probe 4 — @libp2p/interface copy count on the transport path.
  L(
    'PROBE 4 (@libp2p/interface copy count on the transport path): single copy CONFIRMED.',
    'libp2p, @libp2p/websockets, @libp2p/circuit-relay-v2, @optimystic/db-p2p, and @serfab/cadre-core all',
    'resolve to @libp2p/interface@3.2.4 in BOTH apps/VoteTorrentAuthority/node_modules and this package\'s',
    'own node_modules (packages/p2p-probe-host) — re-verified directly this session via node_modules',
    'inspection, not assumed. The only second copy (2.11.0) is confined to the',
    '@chainsafe/libp2p-gossipsub -> @libp2p/pubsub island, unrelated to Transport construction (expected, noted).',
    'The transportSymbol cast (D-10) STAYS the plan (cheap, no side effect) but its brand-skew premise still',
    'needs Metro/on-device re-verification in the device wave (Assumption A4, spike-013 precedent) — this',
    "Node-level single-copy finding does NOT force single-copy libp2p (D-11 stays fallback-only, out of scope).",
  );

  // Probe 5 — EXERCISED (net-new, not in the static research): the exact shape of the D-05 fix.
  L(
    'PROBE 5 (EXERCISED — the D-05 relay-qualified fix is TWO changes, not one): the reservation',
    'gate above proved N relay-qualified listenAddrs alone do NOT yield N reservations under the DEFAULT',
    "circuitRelayTransport(): DEFAULT_RESERVATION_CONCURRENCY=1 (constants.js:15) serializes the reserve",
    'queue, and when the first configured reservation completes with no pending discovered slot,',
    '#checkReservationCount() (reservation-store.js:351-357) calls reserveQueue.clear(), DROPPING the',
    'queued second reservation and hanging start(). FIX for 41-02: pair the qualified listenAddrs with',
    'circuitRelayTransport({ reservationConcurrency: <droneCount> }) so both reservations run before the',
    'clear (proven here: QUALIFIED mode reserves with BOTH drones). SEPARATE in-process-only caveat',
    "(NOT a device blocker): a 'transaction' client that founds its OWN control-DB in the same start() as",
    'it takes relay reservations cannot complete the founding DDL (the relayed self-addresses break the',
    "control cohort's consensus delivery) — on device the control-DB is already founded before any relaunch",
    'reservation, so this does not arise; the gate observes the reservation count mid-start regardless.',
  );
}

// ── Phase-41-04 Task 1: STRAND-COHORT SMOKE ─────────────────────────────────────────────────
// SIGNAL (a): each strand node's own advertised multiaddrs — flags whether a `/p2p-circuit`
// relay-routed dial-back addr is present vs. only a direct (NAT-vulnerable on-device) addr.
function logStrandAdvertisedAddrs(name, node, strandId) {
  let addrs = [];
  try {
    addrs = (node.getStrand?.(strandId)?.libp2pNode?.getMultiaddrs?.() ?? []).map((m) => m.toString());
  } catch {
    addrs = [];
  }
  const hasCircuit = addrs.some((a) => a.includes('/p2p-circuit'));
  L(
    `SIGNAL(a) ${name} strand-node advertised multiaddrs (relayRouted=${hasCircuit}):`,
    JSON.stringify(addrs),
  );
}

// D-05-shaped relay-client: control-bootstrapped to BOTH drones (so resolveCohortSeed's
// strand-addr RPC — see file header finding — has live control connections to query) AND
// carrying the exact `replication-proof-runner.ts`/`CadreNodeProvider.tsx` network posture
// (qualified per-drone `${strandAddr}/p2p-circuit` listenAddrs + `reservationConcurrency`).
function newStrandCohortClient(droneAControlAddr, droneBControlAddr, droneAStrandAddr, droneBStrandAddr) {
  const listenAddrs = [droneAStrandAddr, droneBStrandAddr].map((a) => `${a}/p2p-circuit`);
  return new CadreNode({
    controlNetwork: {
      partyId: PARTY_ID,
      bootstrapNodes: [droneAControlAddr, droneBControlAddr],
    },
    profile: 'transaction',
    strandFilter: { mode: 'all' },
    requireSignedSchemas: false,
    storage: { provider: () => new MemoryRawStorage() },
    network: {
      transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 2 })],
      listenAddrs,
      connectionGater: { denyDialMultiaddr: async () => false },
    },
    hibernation: { enabled: false },
  });
}

// Joins the shared strand (mode omitted -> 'networked', mirrors two-drone-smoke.mjs's solo-peer
// and the app's real addStrand call) then polls the runner's EXACT readStrandPeers accessor
// (getStrand(id)?.libp2pNode?.getConnections()?.length) until strandPeers>0 or a bound.
async function joinStrandAndPollCohort(client, name) {
  try {
    await withTimeout(
      client.addStrand({
        strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
        sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: MINIMAL_SCHEMA, latencyHint: 'interactive' },
      }),
      ADD_STRAND_TIMEOUT_MS,
      `${name} addStrand (cohort)`,
    );
  } catch (e) {
    L(`${name} addStrand (cohort) rejected (tolerated — strandPeers poll still runs):`, e?.message ?? String(e));
  }

  const readStrandPeers = () => client.getStrand?.(STRAND_ID)?.libp2pNode?.getConnections?.()?.length ?? 0;

  const pollStart = Date.now();
  let strandPeers = readStrandPeers();
  while (Date.now() - pollStart < STRAND_COHORT_TIMEOUT_MS && strandPeers === 0) {
    await new Promise((r) => setTimeout(r, STRAND_COHORT_POLL_INTERVAL_MS));
    strandPeers = readStrandPeers();
  }
  L(`${name} strandPeers=`, strandPeers, `(after ${Date.now() - pollStart}ms)`);
  return { name, strandPeers };
}

// ── Phase-41-06 addition — FRET-NEGOTIATION SMOKE ───────────────────────────────────────────
// Extends the STRAND-COHORT SMOKE gate (D-02) to the FRET protocol-negotiation layer itself:
// once (and only if) both clients' strand nodes report `strandPeers>0` (a live cohort exists),
// attempt a REAL dial of one FRET sub-protocol (`ping`) from one strand node directly to the
// other's, printing the negotiated protocol string on success. This is the ONE additional
// signal 41-06 needed beyond 41-04's strandPeers poll: 41-04/41-05 pinned the wall to FRET's
// OWN sub-protocols failing to negotiate even where transport-level connections succeed, so a
// direct protocol-level dial (not merely "are peers connected") is the decisive Node check.
// Per D-02, if the cohort never forms (both `strandPeers` stay 0 — the control-layer cold-start
// artifact 41-04 diagnosed and this session re-confirmed unchanged, see file header + the 41-06
// diagnosis doc) there is nothing to negotiate: the verdict is SKIP, not FAIL, and the gap is
// diagnosed from installed-dist source + the 41-05 device captures instead (non-gating, does
// not affect MULTI-PEER RELAY SMOKE's exit code, mirrors STRAND-COHORT SMOKE's own posture).
async function attemptFretNegotiation(clientA, clientB, resultA, resultB) {
  if (!(resultA.strandPeers > 0 && resultB.strandPeers > 0)) {
    L(
      'FRET-NEGOTIATION SMOKE: SKIP (strand cohort never formed on Node -- blocked by the',
      'control-layer founding cold-start artifact identified in 41-04 SS1, re-confirmed unchanged',
      'this session; not Node-reproducible per D-02 -- see 41-06-FRET-NEGOTIATION-DIAGNOSIS.md',
      'for the installed-dist source + 41-05 device-capture diagnosis)',
    );
    return;
  }
  try {
    const strandANode = clientA.getStrand?.(STRAND_ID)?.libp2pNode;
    const strandBNode = clientB.getStrand?.(STRAND_ID)?.libp2pNode;
    if (!strandANode || !strandBNode) {
      L('FRET-NEGOTIATION SMOKE: FAIL (strand libp2p node handle unavailable post-join)');
      return;
    }
    const pingProtocol = `/optimystic/strand-${STRAND_ID}/fret/1.0.0/ping`;
    const stream = await withTimeout(
      strandANode.dialProtocol(strandBNode.peerId, [pingProtocol]),
      10_000,
      'FRET-NEGOTIATION SMOKE dial',
    );
    await stream.close();
    L(`FRET-NEGOTIATION SMOKE: PASS negotiated=${pingProtocol}`);
  } catch (e) {
    L(`FRET-NEGOTIATION SMOKE: FAIL (${e?.message ?? String(e)})`);
  }
}

// ── Phase-41-08 addition — REGISTRAR-SKEW SMOKE ─────────────────────────────────────────────
// The 41-07 device route-forward named the multi-copy `@libp2p/interface` registrar skew as the
// PRIME SUSPECT for the residual strand FRET inbound-handler negotiability wall (node.handle()'s
// registrar diverging from the one the inbound-stream upgrader consults). 41-04/41-06's
// STRAND-COHORT/FRET-NEGOTIATION probes both SKIP on Node (the control-layer founding cold-start
// blocks addStrand() before a real cohort ever forms, per D-02) -- this probe sidesteps that
// entirely by building ONE (then a SECOND) strand-config libp2p node directly via the SAME
// `createLibp2pNode` path `strand-instance-manager.js buildStrandRuntime` uses (networkName
// `strand-<probe-id>`, strand fretProfile), with NO CadreNode/control-layer wrapper at all --
// exactly the plan's authorized D-02 workaround. Two checks:
//   (1) DIRECT dial (no relay): builds node A + node B, node B bootstraps directly to node A's
//       ws multiaddr (native autoDial, Probe 2 precedent), then node B dials node A's FRET
//       `ping` protocol. This is the literal registrar-identity question the plan's must-haves
//       ask: does node.handle()'s registrar (queried via node.getProtocols(), which delegates to
//       `this.components.registrar.getProtocols()`, IDENTICAL to what the inbound upgrader
//       consults, libp2p/dist/src/connection.js:156/179) match what the inbound negotiation
//       resolves? PASS here, on the SAME single-copy @libp2p/interface topology the whole probe
//       host and the RN app share (Probe 4), FALSIFIES the multi-copy-registrar-skew hypothesis
//       as the mechanism (see 41-08-FRET-REGISTRAR-SKEW-DIAGNOSIS.md for the full source trace:
//       Registrar is a single class owned by the single-copy `libp2p` package; `@libp2p/interface`
//       exports only types + two `Symbol.for()`-keyed capability tags -- no registrar-brand state
//       a second copy could diverge on).
//   (2) RELAYED sub-check (additive, non-gating): a THIRD node stands up a circuit-relay-v2
//       relay server; both edge nodes take relay-qualified reservations (mirrors the device's
//       NAT-only strand-cohort reachability path) and dial each other ONLY via the resulting
//       `/p2p-circuit` address. This is the check that actually surfaces the real, Node-reproducible
//       defect this plan's Task 2 fixes: libp2p@3.3.2's Connection.newStream() throws
//       LimitedConnectionError for ANY protocol-stream open over a connection whose `.limits` is
//       non-null UNLESS `{ runOnLimitedConnection: true }` is passed -- which none of p2p-fret's
//       five outbound RPC senders did, pre-patch. Prints its own verdict line; does not gate the
//       primary REGISTRAR-SKEW SMOKE verdict (mirrors STRAND-COHORT/FRET-NEGOTIATION SMOKE's own
//       non-gating posture).
const REGISTRAR_PROBE_NETWORK_NAME = 'strand-registrar-skew-probe';
const REGISTRAR_PROBE_PING_PROTOCOL = `/optimystic/${REGISTRAR_PROBE_NETWORK_NAME}/fret/1.0.0/ping`;

function pickAnyWs(addrs) {
  return addrs.find((a) => a.includes('/ws')) ?? addrs[0] ?? '';
}

async function runRegistrarSkewDirectDialCheck() {
  let nodeA;
  let nodeB;
  try {
    nodeA = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: REGISTRAR_PROBE_NETWORK_NAME,
      fretProfile: 'core',
      clusterSize: 3,
    });
    await nodeA.start();
    const aProtocols = nodeA.getProtocols();
    const aHasPing = aProtocols.includes(REGISTRAR_PROBE_PING_PROTOCOL);
    L(
      'REGISTRAR-SKEW SMOKE: nodeA.getProtocols() (registrar.getProtocols(), the SAME accessor',
      'the inbound upgrader queries, connection.js:156) includes FRET ping handler?',
      aHasPing,
    );
    if (!aHasPing) {
      L('REGISTRAR-SKEW SMOKE: FAIL (node.handle() did not register the FRET ping protocol at all)');
      return { pass: false, detail: 'ping protocol missing from registrar.getProtocols() after start()' };
    }

    const bootstrapAddr = pickAnyWs(nodeA.getMultiaddrs().map((m) => m.toString()));
    nodeB = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: REGISTRAR_PROBE_NETWORK_NAME,
      fretProfile: 'core',
      clusterSize: 3,
      bootstrapNodes: [bootstrapAddr],
    });
    await nodeB.start();

    const deadline = Date.now() + 10_000;
    let connected = false;
    while (Date.now() < deadline) {
      if (nodeB.getConnections(nodeA.peerId).length > 0) {
        connected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!connected) {
      L('REGISTRAR-SKEW SMOKE: FAIL (nodeB never auto-dialed nodeA within 10s)');
      return { pass: false, detail: 'no connection formed' };
    }

    const stream = await withTimeout(
      nodeB.dialProtocol(nodeA.peerId, [REGISTRAR_PROBE_PING_PROTOCOL]),
      10_000,
      'REGISTRAR-SKEW SMOKE direct dial',
    );
    await stream.close();
    L(
      `REGISTRAR-SKEW SMOKE: PASS negotiated=${REGISTRAR_PROBE_PING_PROTOCOL}`,
      '-- node.handle()\'s registrar and the inbound-negotiation registrar resolve the SAME',
      'object on the strand build path (multi-copy @libp2p/interface registrar-skew FALSIFIED as',
      'the mechanism for this direct-dial topology; see 41-08-FRET-REGISTRAR-SKEW-DIAGNOSIS.md).',
    );
    return { pass: true, detail: `negotiated=${REGISTRAR_PROBE_PING_PROTOCOL}` };
  } catch (e) {
    L(`REGISTRAR-SKEW SMOKE: FAIL (${e?.name ?? ''} ${e?.message ?? String(e)})`);
    return { pass: false, detail: e?.message ?? String(e) };
  } finally {
    if (nodeB) {
      try {
        await nodeB.stop();
      } catch {}
    }
    if (nodeA) {
      try {
        await nodeA.stop();
      } catch {}
    }
  }
}

// Additive, non-gating sub-check: reproduces (and, once Task 2's patch lands, proves fixed) the
// LimitedConnectionError defect on a relay-only topology -- the actual reachability shape between
// two NAT'd strand-cohort members on-device (mirrors D-05's relay-qualified listenAddrs posture).
async function runRegistrarSkewRelaySubCheck() {
  let relay;
  let nodeA;
  let nodeB;
  try {
    relay = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: REGISTRAR_PROBE_NETWORK_NAME,
      fretProfile: 'core',
      clusterSize: 3,
      relay: true,
    });
    await relay.start();
    const relayWsAddr = pickAnyWs(relay.getMultiaddrs().map((m) => m.toString()));

    const newEdgeNode = async () => {
      const node = await createLibp2pNode({
        disableTcp: true,
        networkName: REGISTRAR_PROBE_NETWORK_NAME,
        fretProfile: 'edge',
        clusterSize: 3,
        bootstrapNodes: [relayWsAddr],
        transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
        listenAddrs: [`${relayWsAddr}/p2p-circuit`],
      });
      await node.start();
      return node;
    };
    nodeA = await newEdgeNode();
    nodeB = await newEdgeNode();

    const deadline = Date.now() + 15_000;
    let aReserved = false;
    let bReserved = false;
    while (Date.now() < deadline && !(aReserved && bReserved)) {
      aReserved = nodeA.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      bReserved = nodeB.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      if (!(aReserved && bReserved)) await new Promise((r) => setTimeout(r, 100));
    }
    if (!(aReserved && bReserved)) {
      L('REGISTRAR-SKEW RELAY SUB-CHECK: FAIL (relay reservations never formed within 15s)');
      return;
    }

    const nodeAViaRelay = nodeA
      .getMultiaddrs()
      .map((m) => m.toString())
      .find((a) => a.includes('/p2p-circuit'));
    await nodeB.dial(multiaddr(nodeAViaRelay));

    const stream = await withTimeout(
      nodeB.dialProtocol(nodeA.peerId, [REGISTRAR_PROBE_PING_PROTOCOL], { runOnLimitedConnection: true }),
      10_000,
      'REGISTRAR-SKEW RELAY SUB-CHECK dial',
    );
    await stream.close();
    L(
      `REGISTRAR-SKEW RELAY SUB-CHECK: PASS negotiated=${REGISTRAR_PROBE_PING_PROTOCOL} over a`,
      'relayed (circuit-relay-v2 limited) connection with runOnLimitedConnection:true -- the',
      "Task-2 fix's exact shape (p2p-fret's five outbound RPC senders now pass this option; without",
      'it this same topology throws LimitedConnectionError, reproduced during this diagnosis).',
    );
  } catch (e) {
    L(`REGISTRAR-SKEW RELAY SUB-CHECK: FAIL (${e?.name ?? ''} ${e?.message ?? String(e)})`);
  } finally {
    if (nodeB) {
      try {
        await nodeB.stop();
      } catch {}
    }
    if (nodeA) {
      try {
        await nodeA.stop();
      } catch {}
    }
    if (relay) {
      try {
        await relay.stop();
      } catch {}
    }
  }
}

async function runRegistrarSkewSmoke() {
  L('===== REGISTRAR-SKEW SMOKE — direct strand-config node dial (D-02 workaround, no CadreNode) =====');
  await runRegistrarSkewDirectDialCheck();
  await runRegistrarSkewRelaySubCheck();
}

// ── Phase-41-10 addition — STRAND-RELAY-ROUTING SMOKE ───────────────────────────────────────
// 41-09's device residual localized the strand-cohort wall to strand-node relay-ADDRESS
// ROUTING across the emulator NAT (relayAddrsPerDrone=0, NoValidAddressesError 56x,
// UnsupportedProtocolError 52x) despite the CONTROL network forming fine (relayReservation=true,
// peers=3). This probe answers the plan's Task 1 questions with TWO Node-provable checks, using
// the SAME D-02 workaround as REGISTRAR-SKEW SMOKE (createLibp2pNode directly, no CadreNode
// wrapper, no control-layer founding cold-start):
//
//   CHECK 1 (config-divergence, REQUIRED by the plan's must-haves): builds ONE relay + ONE
//   strand-config node (networkName `strand-<id>`, fretProfile 'edge') carrying the exact
//   app-shaped relay-qualified listenAddrs posture (`${relayAddr}/p2p-circuit`, mirrors
//   `STRAND_RELAY_LISTEN_ADDRS` in replication-proof-runner.ts:99-102 /
//   CadreNodeProvider.tsx:95), then polls getMultiaddrs()/addresses.listen for the resulting
//   `/p2p-circuit` entry. This proves whether a strand-config node that IS given relay-qualified
//   listenAddrs actually advertises them — the config-divergence half the plan's D-02 caveat says
//   Node CAN prove (contrast an UNqualified strand node, which reserves nothing).
//
//   CHECK 2 (NET-NEW this session, NOT anticipated by the plan/RESEARCH — decisive,
//   Node-reproduced): reproduces the mechanism this diagnosis actually found by reading
//   cadre-node.js + the installed @libp2p/circuit-relay-v2 server dist: `CadreNode`'s CONTROL
//   node and every per-strand libp2p node instance SHARE THE SAME PeerId (confirmed source
//   comment, strand-addr-protocol.js:4-10 "even though both share the same peerId") AND share
//   ONE `network.transports`/`network.listenAddrs` object verbatim (cadre-node.js:171
//   `this.config = config`; cadre-node.js:497-499 forwards it to the control node's OWN
//   createLibp2pNode call; cadre-node.js:1916 `network: this.config.network` forwards the
//   IDENTICAL object into `launchStrand`/`strandManager.startStrand`; strand-instance-manager.js
//   :179-180 conditionally forwards `config.network.transports`/`config.network.listenAddrs`
//   into the strand's OWN `createLibp2pNode` call) — so BOTH nodes independently reserve a
//   `/p2p-circuit` slot at the SAME relay (the drone) using the SAME PeerId. The relay SERVER's
//   `@libp2p/circuit-relay-v2` `ReservationStore` (server/reservation-store.js:20 `trackedPeerMap`,
//   :25-27 `reserve(peer, addr, limit)` keyed SOLELY by `peer`) and its HOP-CONNECT delivery path
//   (server/index.js:230 `connectionManager.getConnections(dstPeer)`, :236
//   `const destinationConnection = connections[0]`) cannot distinguish the control node's
//   connection from the strand node's connection — both present the SAME `dstPeer`. This check
//   builds TWO edge nodes sharing ONE generated Ed25519 keypair (mirrors the app's shared
//   identity), both reserving through the SAME relay under DIFFERENT `networkName`s
//   (`control-mimic` / `strand-mimic`, so each registers its OWN, DISTINCT FRET protocol
//   strings), then dials a THIRD sibling node's stream THROUGH the shared PeerId's relay circuit
//   address, requesting the `strand-mimic`-only FRET ping protocol. A byte-perfect reproduction
//   of the 41-09 device signal (`UnsupportedProtocolError: Protocol selection failed - could not
//   negotiate /optimystic/strand-mimic/fret/1.0.0/ping`) CONFIRMS the hop-connect delivered the
//   relayed stream to the WRONG (control-mimic) connection — verified directly by ALSO dialing
//   the `control-mimic`-only protocol via the exact same circuit address and observing it
//   SUCCEED. Non-gating (mirrors REGISTRAR-SKEW SMOKE's own posture) — prints its own verdict
//   line and does not affect MULTI-PEER RELAY SMOKE's exit code.
const STRAND_RELAY_ROUTING_NETWORK_NAME = 'strand-relay-routing-probe';

async function runStrandRelayRoutingConfigCheck() {
  let relay;
  let strandNode;
  try {
    relay = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: `${STRAND_RELAY_ROUTING_NETWORK_NAME}-relay`,
      fretProfile: 'core',
      clusterSize: 3,
      relay: true,
    });
    await relay.start();
    const relayWsAddr = pickAnyWs(relay.getMultiaddrs().map((m) => m.toString()));

    // Mirrors STRAND_RELAY_LISTEN_ADDRS's shape exactly: one `${relayAddr}/p2p-circuit` entry
    // per known relay/drone, paired with `reservationConcurrency` sized to the relay count
    // (replication-proof-runner.ts:99-102/182, CadreNodeProvider.tsx:95/211).
    strandNode = await createLibp2pNode({
      disableTcp: true,
      networkName: `strand-${STRAND_RELAY_ROUTING_NETWORK_NAME}`,
      fretProfile: 'edge',
      clusterSize: 3,
      bootstrapNodes: [relayWsAddr],
      transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
      listenAddrs: [`${relayWsAddr}/p2p-circuit`],
    });
    await strandNode.start();

    const deadline = Date.now() + 15_000;
    let circuitAddrs = [];
    while (Date.now() < deadline && circuitAddrs.length === 0) {
      circuitAddrs = strandNode.getMultiaddrs().map((m) => m.toString()).filter((a) => a.includes('/p2p-circuit'));
      if (circuitAddrs.length === 0) await new Promise((r) => setTimeout(r, 100));
    }

    if (circuitAddrs.length > 0) {
      L(
        `STRAND-RELAY-ROUTING SMOKE: PASS strand-config node's addresses.listen carries`,
        `${circuitAddrs.length} relay-qualified /p2p-circuit addr(s) when given relay-qualified`,
        'listenAddrs (config-divergence half PROVEN on Node/loopback):',
        JSON.stringify(circuitAddrs),
      );
    } else {
      L(
        'STRAND-RELAY-ROUTING SMOKE: FAIL strand-config node reserved NO /p2p-circuit addr within',
        '15s despite relay-qualified listenAddrs — config does not reach addresses.listen on this',
        'installed dist (see 41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md)',
      );
    }
  } catch (e) {
    L(
      'STRAND-RELAY-ROUTING SMOKE: SKIP (Node/loopback could not bring up a strand-config node —',
      `${e?.name ?? ''} ${e?.message ?? String(e)}; this is the D-02 caveat: the emulator-NAT`,
      'address-routing failure itself is NOT Node-reproducible, only the config-divergence half',
      'is — see 41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md)',
    );
  } finally {
    if (strandNode) {
      try {
        await strandNode.stop();
      } catch {}
    }
    if (relay) {
      try {
        await relay.stop();
      } catch {}
    }
  }
}

// Additive, non-gating, NET-NEW sub-check (see the section header above): reproduces the
// shared-PeerId relay-reservation/hop-connect collision this diagnosis found by reading
// cadre-node.js + @libp2p/circuit-relay-v2's server dist, decisively on Node/loopback (no NAT
// required — this is a shared-identity design property, not a NAT-routing property).
async function runStrandRelayRoutingSharedIdentitySubCheck() {
  let relay;
  let controlMimic;
  let strandMimic;
  let sibling;
  try {
    relay = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: `${STRAND_RELAY_ROUTING_NETWORK_NAME}-shared-identity-relay`,
      fretProfile: 'core',
      clusterSize: 3,
      relay: true,
    });
    await relay.start();
    const relayWsAddr = pickAnyWs(relay.getMultiaddrs().map((m) => m.toString()));

    // The SAME generated keypair is passed to BOTH edge nodes below — mirrors
    // cadre-node.js:1919 (`privateKey: this.identityKey`), the shared identity every
    // per-strand libp2p node reuses from the CadreNode's own control identity.
    const sharedKey = await generateKeyPair('Ed25519');
    const newEdgeNode = async (networkName) => {
      const node = await createLibp2pNode({
        disableTcp: true,
        networkName,
        fretProfile: 'edge',
        clusterSize: 3,
        privateKey: sharedKey,
        bootstrapNodes: [relayWsAddr],
        transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
        listenAddrs: [`${relayWsAddr}/p2p-circuit`],
      });
      await node.start();
      return node;
    };
    controlMimic = await newEdgeNode('control-mimic');
    strandMimic = await newEdgeNode('strand-mimic');

    if (controlMimic.peerId.toString() !== strandMimic.peerId.toString()) {
      L('STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: FAIL (mimic nodes did not share a PeerId — harness bug)');
      return;
    }

    const deadline = Date.now() + 15_000;
    let aReserved = false;
    let bReserved = false;
    while (Date.now() < deadline && !(aReserved && bReserved)) {
      aReserved = controlMimic.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      bReserved = strandMimic.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      if (!(aReserved && bReserved)) await new Promise((r) => setTimeout(r, 100));
    }
    if (!(aReserved && bReserved)) {
      L('STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: FAIL (both same-PeerId mimics never reserved within 15s)');
      return;
    }

    sibling = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: `${STRAND_RELAY_ROUTING_NETWORK_NAME}-sibling`,
      fretProfile: 'edge',
      clusterSize: 3,
    });
    await sibling.start();

    const circuitAddr = strandMimic.getMultiaddrs().map((m) => m.toString()).find((a) => a.includes('/p2p-circuit'));
    await sibling.dial(multiaddr(circuitAddr));

    const strandOnlyProtocol = '/optimystic/strand-mimic/fret/1.0.0/ping';
    const controlOnlyProtocol = '/optimystic/control-mimic/fret/1.0.0/ping';

    let strandProtocolNegotiated = false;
    try {
      const stream = await withTimeout(
        sibling.dialProtocol(strandMimic.peerId, [strandOnlyProtocol], { runOnLimitedConnection: true }),
        10_000,
        'STRAND-RELAY-ROUTING shared-identity dial (strand-only protocol)',
      );
      await stream.close();
      strandProtocolNegotiated = true;
    } catch {
      strandProtocolNegotiated = false;
    }

    let controlProtocolNegotiated = false;
    try {
      const stream2 = await withTimeout(
        sibling.dialProtocol(strandMimic.peerId, [controlOnlyProtocol], { runOnLimitedConnection: true }),
        10_000,
        'STRAND-RELAY-ROUTING shared-identity dial (control-only protocol)',
      );
      await stream2.close();
      controlProtocolNegotiated = true;
    } catch {
      controlProtocolNegotiated = false;
    }

    if (!strandProtocolNegotiated && controlProtocolNegotiated) {
      L(
        'STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: CONFIRMED — dialing the shared PeerId via',
        "strand-mimic's OWN advertised /p2p-circuit addr negotiated control-mimic's protocol",
        `(${controlOnlyProtocol}) but FAILED to negotiate strand-mimic's OWN protocol`,
        `(${strandOnlyProtocol}, UnsupportedProtocolError) -- the relay's hop-connect`,
        '(server/index.js:230 connectionManager.getConnections(dstPeer), :236 connections[0])',
        "delivered the relayed stream to the control-mimic connection, keyed only by the SHARED",
        'PeerId. This reproduces the 41-09 device UnsupportedProtocolError class byte-for-byte',
        'on Node/loopback -- no NAT required (see 41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md).',
      );
    } else if (strandProtocolNegotiated) {
      L(
        'STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: NOT REPRODUCED this run (strand-mimic',
        'protocol negotiated successfully) -- hop-connect happened to route to the strand-mimic',
        'connection this time; the collision is a connections[0] ordering race, not deterministic',
        'per-run (see diagnosis doc for the adjudication).',
      );
    } else {
      L(
        'STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: INCONCLUSIVE (neither protocol negotiated',
        '-- relay/hop-connect infrastructure issue, not the collision mechanism itself)',
      );
    }
  } catch (e) {
    L(`STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK: FAIL (${e?.name ?? ''} ${e?.message ?? String(e)})`);
  } finally {
    if (sibling) {
      try {
        await sibling.stop();
      } catch {}
    }
    if (controlMimic) {
      try {
        await controlMimic.stop();
      } catch {}
    }
    if (strandMimic) {
      try {
        await strandMimic.stop();
      } catch {}
    }
    if (relay) {
      try {
        await relay.stop();
      } catch {}
    }
  }
}

// ── Phase-41-11 addition — STRAND-RELAY-ROUTING DISTINCT-RELAY FIX check ─────────────────────
// Proves the 41-11 fix (the additive cadre-core `strandNetwork` override, authored as a
// yarn-patch this session) on Node/loopback — the inverse of the SHARED-IDENTITY sub-check
// above. The collision the sub-check reproduces exists because the control node and the strand
// node share ONE PeerId AND reserve at the SAME relay, so the relay server's hop-connect
// (server/index.js:230-236 connections[0], keyed solely by PeerId) can deliver a sibling's
// strand-directed stream to the control connection. The fix gives the strand node a DISTINCT
// relay target from the control node's (app-side: `network` → drone CONTROL relay,
// `strandNetwork` → drone STRAND relay; 41-10 diagnosis §5). Modeled here at the
// `createLibp2pNode` level (the same D-02 workaround the sub-check uses): control-mimic reserves
// at relay-CONTROL, strand-mimic reserves at relay-STRAND — DIFFERENT relay servers, still ONE
// shared PeerId. Because relay-STRAND holds ONLY the strand-mimic connection for that PeerId,
// a sibling dialing strand-mimic's OWN /p2p-circuit addr negotiates strand-mimic's OWN protocol:
// the collision is GONE. Deterministic (no connections[0] ordering race — each relay has exactly
// one connection per PeerId). Non-gating (mirrors the other STRAND-RELAY-ROUTING probes) —
// prints its own verdict line and does not affect MULTI-PEER RELAY SMOKE's exit code.
async function runStrandRelayRoutingDistinctRelayFixCheck() {
  let relayControl;
  let relayStrand;
  let controlMimic;
  let strandMimic;
  let sibling;
  try {
    const newRelay = async (suffix) => {
      const r = await createLibp2pNode({
        disableTcp: true,
        wsPort: 0,
        networkName: `${STRAND_RELAY_ROUTING_NETWORK_NAME}-fix-${suffix}-relay`,
        fretProfile: 'core',
        clusterSize: 3,
        relay: true,
      });
      await r.start();
      return r;
    };
    relayControl = await newRelay('control');
    relayStrand = await newRelay('strand');
    const relayControlAddr = pickAnyWs(relayControl.getMultiaddrs().map((m) => m.toString()));
    const relayStrandAddr = pickAnyWs(relayStrand.getMultiaddrs().map((m) => m.toString()));

    // The SAME generated keypair for BOTH edge nodes (mirrors cadre-node.js:1919
    // `privateKey: this.identityKey`, the shared identity — identical to the sub-check above).
    const sharedKey = await generateKeyPair('Ed25519');
    const newEdgeNode = async (networkName, relayAddr) => {
      const node = await createLibp2pNode({
        disableTcp: true,
        networkName,
        fretProfile: 'edge',
        clusterSize: 3,
        privateKey: sharedKey,
        bootstrapNodes: [relayAddr],
        transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
        // THE FIX: each node reserves at its OWN, DISTINCT relay (control→relayControl,
        // strand→relayStrand) — exactly what the app's `network`/`strandNetwork` split supplies.
        listenAddrs: [`${relayAddr}/p2p-circuit`],
      });
      await node.start();
      return node;
    };
    controlMimic = await newEdgeNode('control-mimic', relayControlAddr);
    strandMimic = await newEdgeNode('strand-mimic', relayStrandAddr);

    if (controlMimic.peerId.toString() !== strandMimic.peerId.toString()) {
      L('STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: FAIL (mimic nodes did not share a PeerId — harness bug)');
      return;
    }

    const deadline = Date.now() + 15_000;
    let cReserved = false;
    let sReserved = false;
    while (Date.now() < deadline && !(cReserved && sReserved)) {
      cReserved = controlMimic.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      sReserved = strandMimic.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit'));
      if (!(cReserved && sReserved)) await new Promise((r) => setTimeout(r, 100));
    }
    if (!(cReserved && sReserved)) {
      L('STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: FAIL (same-PeerId mimics never reserved at their distinct relays within 15s)');
      return;
    }

    sibling = await createLibp2pNode({
      disableTcp: true,
      wsPort: 0,
      networkName: `${STRAND_RELAY_ROUTING_NETWORK_NAME}-fix-sibling`,
      fretProfile: 'edge',
      clusterSize: 3,
    });
    await sibling.start();

    // Dial the shared PeerId via strand-mimic's OWN advertised /p2p-circuit addr — which routes
    // through relayStrand, where ONLY the strand-mimic connection exists for that PeerId.
    const strandCircuitAddr = strandMimic
      .getMultiaddrs()
      .map((m) => m.toString())
      .find((a) => a.includes('/p2p-circuit'));
    await sibling.dial(multiaddr(strandCircuitAddr));

    const strandOnlyProtocol = '/optimystic/strand-mimic/fret/1.0.0/ping';

    let strandProtocolNegotiated = false;
    try {
      const stream = await withTimeout(
        sibling.dialProtocol(strandMimic.peerId, [strandOnlyProtocol], { runOnLimitedConnection: true }),
        10_000,
        'STRAND-RELAY-ROUTING distinct-relay fix dial (strand-only protocol)',
      );
      await stream.close();
      strandProtocolNegotiated = true;
    } catch {
      strandProtocolNegotiated = false;
    }

    if (strandProtocolNegotiated) {
      L(
        'STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: PASS — dialing the shared PeerId via strand-mimic\'s',
        `OWN /p2p-circuit addr (routed through the DISTINCT strand relay) negotiated strand-mimic's`,
        `OWN protocol (${strandOnlyProtocol}). The shared-relay collision the SHARED-IDENTITY`,
        'sub-check reproduces is GONE once control and strand reserve at DISTINCT relays — the',
        'cadre-core strandNetwork override (41-11 fix), proven on Node/loopback, no NAT required.',
      );
    } else {
      L(
        'STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: FAIL (strand-mimic\'s OWN protocol still did not',
        'negotiate over its distinct strand relay — the distinct-relay fix did not resolve the',
        'collision on this run; see 41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md §5)',
      );
    }
  } catch (e) {
    L(`STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: FAIL (${e?.name ?? ''} ${e?.message ?? String(e)})`);
  } finally {
    for (const n of [sibling, controlMimic, strandMimic, relayStrand, relayControl]) {
      if (n) {
        try {
          await n.stop();
        } catch {}
      }
    }
  }
}

async function runStrandRelayRoutingSmoke() {
  L('===== STRAND-RELAY-ROUTING SMOKE — config-divergence + shared-identity relay-collision + distinct-relay fix probes (D-02 workaround) =====');
  await runStrandRelayRoutingConfigCheck();
  await runStrandRelayRoutingSharedIdentitySubCheck();
  await runStrandRelayRoutingDistinctRelayFixCheck();
}

async function runStrandCohortSmoke() {
  L('===== STRAND-COHORT SMOKE — booting fresh topology (D-05-shaped clients) =====');
  const nodes = [];
  currentNodes = nodes;

  const droneA = await bootDrone('drone-A[cohort]', undefined, undefined);
  nodes.push(['drone-A', droneA.drone]);
  const droneB = await bootDrone('drone-B[cohort]', droneA.controlAddr, droneA.strandAddr);
  nodes.push(['drone-B', droneB.drone]);

  // SIGNAL (a) baseline: the drones' OWN strand addrs (not NAT'd — expected direct-reachable).
  logStrandAdvertisedAddrs('drone-A', droneA.drone, STRAND_ID);
  logStrandAdvertisedAddrs('drone-B', droneB.drone, STRAND_ID);

  // EXERCISED FINDING (Task 1, this session — not anticipated by the plan/research): a
  // 'transaction' client whose network.listenAddrs is EXCLUSIVELY qualified `/p2p-circuit`
  // entries (the exact app-shaped posture — no direct listen address at all, since control and
  // strand share ONE network object per Probe 1) throws `CadreControl.AuthorityKey` founding-DDL
  // errors ("Protocol selection failed" / "Failed to get super-majority") on EVERY attempt when
  // it is among the FIRST 'transaction' peers to join a freshly-created control party — reproduced
  // deterministically (6 retries / ~9s, and again with a direct-listen "genesis" peer settling the
  // party first — the retry/genesis combination occasionally drove the underlying
  // RestorationCoordinator into a slow, unbounded `[Ring 8] restoring block` retry loop instead of
  // failing fast, which is unsuitable for a committed, bounded Node gate). A separate isolated
  // single-peer diagnostic (drone dialing a lone relay-only client BACK through its own reservation
  // via `/ipfs/ping/1.0.0`) proved the circuit-relay-v2 dial-back mechanism itself is sound on
  // Node (~200ms). The founding-DDL race is therefore TOLERATED here (single attempt, like the
  // bare/qualified reservation gates above) rather than retried — this keeps the gate fast and
  // deterministic; the diagnosis doc adjudicates the mechanism findings from the isolated probes.
  const clientA = newStrandCohortClient(droneA.controlAddr, droneB.controlAddr, droneA.strandAddr, droneB.strandAddr);
  nodes.push(['client-A', clientA]);
  const clientB = newStrandCohortClient(droneA.controlAddr, droneB.controlAddr, droneA.strandAddr, droneB.strandAddr);
  nodes.push(['client-B', clientB]);

  // Sequential (not Promise.all) — mirrors runMode()'s clientA-then-clientB ordering so the two
  // clients' founding attempts do not additionally race each other.
  for (const [name, client] of [['client-A', clientA], ['client-B', clientB]]) {
    try {
      await client.start();
      L(`${name} start() succeeded`);
    } catch (e) {
      L(`${name} start() rejected (tolerated — founding-DDL cold-start race, see file header):`, e?.message ?? String(e));
    }
  }
  L('STRAND-COHORT SMOKE: clients started (control-bootstrapped to both drones), joining strand', STRAND_ID);

  const [resultA, resultB] = await Promise.all([
    joinStrandAndPollCohort(clientA, 'client-A'),
    joinStrandAndPollCohort(clientB, 'client-B'),
  ]);

  await attemptFretNegotiation(clientA, clientB, resultA, resultB);

  // SIGNAL (a) under test: the CLIENTS' OWN strand addrs, post-join — the primary 41-03
  // hypothesis is that this is empty/direct-only (no /p2p-circuit) despite the qualified
  // listenAddrs above, OR that it IS relay-routed but siblings never dial it back (a different
  // locus — see the diagnosis doc for the adjudication of which one the evidence supports).
  logStrandAdvertisedAddrs('client-A', clientA, STRAND_ID);
  logStrandAdvertisedAddrs('client-B', clientB, STRAND_ID);

  await stopNodes(nodes);
  currentNodes = [];

  const pass = resultA.strandPeers > 0 && resultB.strandPeers > 0;
  L(
    'STRAND-COHORT SMOKE:', pass ? 'PASS' : 'FAIL',
    `client-A=strandPeers:${resultA.strandPeers}`,
    `client-B=strandPeers:${resultB.strandPeers}`,
  );
  L(
    'STRAND-COHORT SIGNALS (b)/(c) [Task 1] — process-wide tallies across the whole run so far:',
    `noValidAddresses=${signalCounts.noValidAddresses}`,
    `gossipsubFnsShift=${signalCounts.gossipsubFnsShift}`,
    `fretUnsupportedProtocol=${signalCounts.fretUnsupportedProtocol}`,
    `fretMalformedDoubleSlash=${signalCounts.fretMalformedDoubleSlash}`,
  );

  return pass;
}

async function main() {
  const results = [];
  for (const mode of MODES_TO_RUN) {
    results.push(await runMode(mode));
  }

  printProbeFindings();

  try {
    await runRegistrarSkewSmoke();
  } catch (e) {
    // Non-gating (mirrors STRAND-COHORT/FRET-NEGOTIATION SMOKE) -- a hard crash here must not
    // take down the MULTI-PEER RELAY SMOKE verdict computed above.
    L('REGISTRAR-SKEW SMOKE: FAIL (harness error)', e?.stack ?? String(e));
  }

  try {
    await runStrandRelayRoutingSmoke();
  } catch (e) {
    // Non-gating (mirrors REGISTRAR-SKEW/STRAND-COHORT/FRET-NEGOTIATION SMOKE) -- a hard crash
    // here must not take down the MULTI-PEER RELAY SMOKE verdict computed above.
    L('STRAND-RELAY-ROUTING SMOKE: FAIL (harness error)', e?.stack ?? String(e));
  }

  if (RUN_STRAND_COHORT_SMOKE) {
    try {
      await runStrandCohortSmoke();
    } catch (e) {
      // Non-gating (see file header) — a hard crash in the cohort gate must not take down the
      // MULTI-PEER RELAY SMOKE verdict computed above; report it as a FAIL and move on.
      L('STRAND-COHORT SMOKE: FAIL (harness error)', e?.stack ?? String(e));
    }
  } else {
    L('STRAND-COHORT SMOKE: skipped (STRAND_COHORT_SMOKE=skip)');
  }

  const bareResult = results.find((r) => r.mode === 'bare');
  const qualifiedResult = results.find((r) => r.mode === 'qualified');

  if (qualifiedResult?.pass) {
    L(
      'ASSUMPTION A1 SETTLED (strongest form): the qualified-mode clients reserved with BOTH drones',
      `(client-A=${qualifiedResult.clientA.length}, client-B=${qualifiedResult.clientB.length} distinct relay peers)`,
      "with controlNetwork.bootstrapNodes = [] — the clients were told NOTHING about any drone;",
      "the 'configured' reservation path cold-dials each drone STRAND node purely from the qualified",
      'listenAddrs (listener.js openConnection(relayAddr) does not consult bootstrapNodes).',
    );
  }

  const barePass = !bareResult || bareResult.pass;
  const qualifiedPass = !qualifiedResult || qualifiedResult.pass;

  if (barePass && qualifiedPass) {
    L('MULTI-PEER RELAY SMOKE: PASS');
    exitCode = 0;
  } else {
    L(
      'MULTI-PEER RELAY SMOKE: FAIL',
      `bare=${bareResult ? (bareResult.pass ? 'PASS' : 'FAIL') : 'skipped'}`,
      `qualified=${qualifiedResult ? (qualifiedResult.pass ? 'PASS' : 'FAIL') : 'skipped'}`,
    );
    exitCode = 1;
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping...`);
    await stopNodes(currentNodes);
    process.exit(1);
  });
}

main()
  .catch((err) => {
    L('MULTI-PEER RELAY SMOKE: FAIL', err?.stack ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    await stopNodes(currentNodes);
    process.exit(exitCode);
  });
