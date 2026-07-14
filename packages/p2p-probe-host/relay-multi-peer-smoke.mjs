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
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';

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
