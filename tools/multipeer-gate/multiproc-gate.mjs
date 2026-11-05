/**
 * multiproc-gate.mjs — the same gate, with every node in its OWN OS process.
 *
 * WHY A SECOND GATE
 * -----------------
 * `multipeer-gate.mjs` builds its four nodes inside one Node process. That gate is worth
 * having and it localizes real blockers, but there is a class of claim it cannot support,
 * because in one process the nodes share a heap, a module registry, a timer wheel and a
 * single libp2p event loop:
 *
 *   - "peer-B read the row peer-A wrote" does not establish that anything was serialized,
 *     framed or put on a socket. Two nodes in one heap can satisfy every data assertion in
 *     the gate with no network involvement whatsoever, and nothing in a green run
 *     distinguishes that from replication.
 *   - A stream that is never opened cannot fail to open. The n=4 device runs die during
 *     block transfer on `UnexpectedEOFError` and then `NoValidAddressesError` — failures of
 *     a real dial between real processes, which an in-process cohort never performs.
 *   - One event loop hides scheduling. Four nodes taking cooperative turns is not four
 *     nodes competing for a CPU, and starvation only exists in the second case.
 *
 * Here each node is a `peer-agent.mjs` process addressed over a pipe, so every byte between
 * two nodes crosses a real socket because there is no other route. The legs are the same
 * source file in both gates (`lib/core-legs.mjs`, `lib/db-legs.mjs`) and the nodes are built
 * from the same options (`lib/topology.mjs`), so a difference in result is a difference in
 * SHAPE — which is the measurement.
 *
 * GOING HOST-TO-HOST
 * ------------------
 * The control channel is a byte pipe, so "another process" and "another machine" are one
 * code path. Point any node's agent somewhere else:
 *
 *   SPAWN_PEER_A='ssh bench-2 node /opt/multipeer-gate/peer-agent.mjs' \
 *   SPAWN_PEER_B='ssh bench-3 node /opt/multipeer-gate/peer-agent.mjs' \
 *     node multiproc-gate.mjs
 *
 * `SPAWN_<NAME>` upper-cases the node name and replaces `-` with `_`. The far end needs
 * this package installed and a route back for the libp2p sockets; the gate tunnels control,
 * never traffic. That adds a real NIC and a real NAT, and the summary says which shape
 * produced the result so the two cannot be quoted interchangeably.
 *
 * WHAT IT STILL DOES NOT PROVE
 * ----------------------------
 * Not a device run. Separate processes remove the shared heap; separate hosts add real
 * routing. Neither adds a mobile scheduler, a radio, or Hermes instead of V8, and all three
 * have produced device-only failures that a host-level gate passed straight through. Say
 * which shape you ran — the summary prints it for exactly that reason.
 *
 * USAGE
 * -----
 *   cd tools/multipeer-gate
 *   npm install
 *   node multiproc-gate.mjs
 *
 * Every knob from `multipeer-gate.mjs` applies unchanged, plus:
 *   RPC_TIMEOUT_MS=N  how long an agent may take to answer one control request (default
 *                     180000). A remote agent over a slow link may need more.
 */
import { PARTY_ID, STRAND_ID } from './lib/topology.mjs';
import { agentHandle } from './lib/handles.mjs';
import { startAgent, spawnSpecFor } from './lib/agent-client.mjs';
import { RPC_TIMEOUT_MS, CLUSTER_SIZE, VERBOSE, summarize } from './lib/runner.mjs';
import { runGate } from './lib/gate-run.mjs';

const started = [];   // reverse creation order, which is the order to shut down in

/**
 * Agent logs are forwarded, not swallowed. A cross-process run's most useful diagnostics
 * live in the child's own stderr — an inbound-stream denial, a dial error, a libp2p
 * warning — and a harness that hides them reproduces the original complaint that the
 * decisive diagnostics were in a namespace nobody had armed.
 */
const onLog = (name, line) => {
  if (VERBOSE || /error|denied|refused|unreachable|WARN/i.test(line)) {
    console.log(`[multiproc-gate] (${name}) ${line}`);
  }
};

async function boot(name, role, args) {
  const spec = spawnSpecFor(name);
  const client = await startAgent(name, { onLog, timeoutMs: RPC_TIMEOUT_MS });
  const handle = agentHandle(name, client);
  started.unshift(handle);
  const { peerId } = await client.call('start', {
    role, clusterSize: CLUSTER_SIZE, strandId: STRAND_ID, name, ...args,
  });
  handle.setPeerId(peerId);
  const where = spec.remote ? `REMOTE via ${spec.source}` : `local pid ${client.child.pid}`;
  console.log(`[multiproc-gate] ${name} up   peerId=${peerId}  [${where}]` +
    (role === 'peer' ? ` (relay-only, ${args.relayAddrs?.length ?? 0} relay(s))` : ''));
  return handle;
}

const fabric = {
  startDrone: (name, bootstrapNodes) => boot(name, 'drone', { bootstrapNodes }),
  startPeer: (name, relayAddrs, bootstrapNodes, direct) => boot(name, 'peer', { relayAddrs, bootstrapNodes, direct }),

  /**
   * The D5 control arm: its own party, its own genesis, its own process — sharing the host
   * with the cohort and sharing no membership with it. Cross-process it can no longer be
   * accused of reading someone else's heap, which is precisely the accusation the
   * in-process control exists to answer.
   */
  startOutsider: async (name) => {
    const handle = await boot(name, 'drone', { bootstrapNodes: [], partyId: `${PARTY_ID}-outsider` });
    await handle.genesis();
    return handle;
  },
};

async function shutdown() {
  for (const h of started) {
    try { await h.kill(); } catch { /* already gone */ }
  }
}

let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[multiproc-gate] ${sig} — stopping ...`);
    await shutdown();
    process.exit(1);
  });
}

const remotes = ['drone-A', 'drone-B', 'peer-A', 'peer-B', 'peer-C', 'outsider']
  .filter((n) => spawnSpecFor(n).remote);

const SHAPE_NOTE = [
  remotes.length
    ? `Shape: one OS process per node, ${remotes.length} of them REMOTE (${remotes.join(', ')}).`
    : 'Shape: one OS process per node, all on this host.',
  'No two nodes share a heap, so a green data leg required a real socket. That is a',
  'strictly stronger claim than the in-process gate makes — and still not a device run:',
  'no mobile scheduler, no radio, no Hermes. Quote the shape with the result.',
];

runGate({ tag: 'multiproc-gate', kind: 'process', fabric })
  .then(({ ctx, passed }) => { exitCode = summarize(ctx, { shapeNote: SHAPE_NOTE }); return passed; })
  .catch((err) => {
    console.log('[multiproc-gate] MULTIPROC GATE: FAIL (harness error)', err?.stack ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
