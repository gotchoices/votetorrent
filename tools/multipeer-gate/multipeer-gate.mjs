/**
 * multipeer-gate.mjs — a standalone Node gate for the n=4 Sereus/Optimystic
 * multi-peer topology, with every node in THIS process.
 *
 * WHY THIS EXISTS
 * ---------------
 * The n=4 topology (two always-on relay/storage nodes plus two relay-only peers that
 * cannot be dialled directly) has repeatedly failed for reasons that are invisible in
 * an end-to-end pass/fail: a healthy control network sitting on top of a strand overlay
 * that never seeded, a clean dial surface that was clean only because nothing was ever
 * handed a peer to dial, and diagnostics living in a debug namespace nobody had armed.
 *
 * This gate replaces "it still fails" with "leg N fails, here is the number". The legs are
 * ORDERED and it stops at the first failure, so the output names the earliest broken link
 * rather than its downstream symptoms.
 *
 * It depends only on PUBLISHED packages — no VoteTorrent code, no app, no Android, no
 * emulator. Upstream maintainers can run it against a candidate build to check whether a
 * multi-peer fix actually unblocks the topology, and it doubles as a regression test.
 *
 * TOPOLOGY
 * --------
 *     drone-A   profile 'storage'      relay server ON, direct ws listen. Founder.
 *     drone-B   profile 'storage'      relay server ON, direct ws listen. Joins A.
 *     peer-A    profile 'transaction'  RELAY-ONLY: listens on <relay>/p2p-circuit only.
 *     peer-B    profile 'transaction'  RELAY-ONLY: listens on <relay>/p2p-circuit only.
 *     outsider  a one-node party of its own — the control arm for D5.
 *
 * The peers get NO direct listen address. That is the whole point: a sibling cannot
 * reach them except through a relay, which is the constraint every multi-peer bug in
 * this topology has turned on.
 *
 * THE LEGS
 * --------
 *   L0  dependency-provenance  the installed tree is the tree package.json declares
 *   L1  control-reachability   every node holds >= 1 control connection; founder sees all
 *   L2  relay-reservation      each relay-only peer holds a reservation (counted by distinct
 *                              relay IDENTITY, not address) and every cohort member holds a
 *                              circuit address for it
 *   DD  dial-through-relay     every drone actually DIALS every relay-only peer
 *   L3  cadre-authorization    the relay-only peers are AUTHORIZED members of the cadre
 *   L4  strand-cohort          each strand node assembles a cohort larger than itself
 *   L5  replication            peer-A writes a row; peer-B reads it back
 *   D1  replication-reverse    peer-B writes a row; peer-A reads it back
 *   D2  convergence-all        EVERY member reads EVERY row, not just the sibling sampled
 *   D3  concurrent-writes      both peers write at once and neither write is lost
 *   D4  mutation-propagation   an UPDATE and a DELETE converge, not only an INSERT
 *   D5  isolation-control      a non-member with a live database of its own sees NONE of it
 *   L6  replication-factor     standing reproduction — how many nodes actually hold the block
 *   L7  late-joiner            standing reproduction — a member that arrives after the write
 *   L8  durability             standing reproduction — the data survives losing a holder
 *
 * L3 is the one people skip. Control-network membership is the v1 authorization for the
 * strand-address RPC (`strand-addr-protocol.js`: "only this party's cadre peers may ask
 * us for a strand address"). A peer that is merely CONNECTED is addressable but not
 * authorized: its strand-addr request is refused as `non-member`, it receives no cohort
 * addresses, and its strand node then sits at a cohort of one with zero dial attempts.
 * Every layer below looks healthy while replication silently never happens.
 *
 * D1-D5 are the ones the gate itself used to skip. L5 is one direction, one row, one
 * reader, one shot — and it was the ONLY data assertion here. See `lib/db-legs.mjs` for
 * what each of them catches that L5 passes straight through; the short version is that the
 * n=4 device runs fail with both peers writing and reading cleanly while NEITHER sees the
 * other's row, and L5 samples exactly one of those two directions.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * ---------------------------------
 * DOES: that the topology's addressing, authorization, cohort-assembly and replication
 * path work when the peers are reachable ONLY through a relay. That is a real constraint
 * and it is where these bugs live.
 *
 * DOES NOT: prove device behaviour. Everything here is one process on loopback. Four nodes
 * in one process share a heap, a module registry and an event loop, so a data assertion
 * can be satisfied without a byte reaching a socket; D5 is the control that tests exactly
 * that, but the honest way to remove the doubt is to run the SAME legs with each node in
 * its own OS process:
 *
 *   node multiproc-gate.mjs
 *
 * and, for separate machines with a real NIC and a real NAT, to point that gate's agents
 * at other hosts. A real device adds address translation, a mobile scheduler and a
 * different JS engine on top of even that, and all three have produced device-only
 * failures a loopback gate passed straight through. A PASS here is a necessary condition
 * for the device proof, never a substitute for it.
 *
 * USAGE
 * -----
 *   cd tools/multipeer-gate
 *   npm install
 *   node multipeer-gate.mjs
 *
 * Requires Node >= 22 (Promise.withResolvers, used by the dependency graph).
 *
 * Exit 0 when every leg passes; exit 1 on the first failure, naming the leg.
 *
 * ENV KNOBS (all optional)
 *   DRONES=N          how many always-on storage nodes (default 2 — the topology under
 *                     test). ONLY storage-profile nodes serve blocks (`enableRingZulu` and
 *                     `storageRing` are gated on `profile === 'storage'`), so this is the
 *                     discriminator for a control-DB block read that fails with
 *                     `peers-unreachable`: if DRONES=3 passes a leg that DRONES=2 fails,
 *                     the cause is block-cluster breadth, not relay-only reachability.
 *   RELAYS=1|2        how many relays each peer reserves on (default 1). 2 exercises the
 *                     multi-relay posture, which has regressed before — see README.
 *   CLUSTER_SIZE=N    strandClusterSize, must be identical on every node (default 2).
 *   ENROLL=1|0        run the invite/enrolment ceremony before L3 (default 1). Set 0 to
 *                     observe the un-enrolled failure mode deliberately.
 *   DB_LEGS=1|0       run the distributed-database legs D1-D5 (default 1).
 *   TIMEOUT_SCALE=N   multiply every timeout by N on a slow machine (default 1).
 *   SKIP_PREFLIGHT=1  run against a tree that does not match package.json, deliberately.
 *   VERBOSE=1         print per-poll progress.
 *
 * To see the underlying diagnostics, arm BOTH namespace roots — the optimystic ones
 * alone have zero coverage of strand seeding, which is what made this class of bug so
 * hard to localize:
 *
 *   DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' node multipeer-gate.mjs
 */
import {
  buildNode, generateKeyPair, PARTY_ID,
} from './lib/topology.mjs';
import { inProcessHandle } from './lib/handles.mjs';
import { START_TIMEOUT_MS, withTimeout, summarize, CLUSTER_SIZE } from './lib/runner.mjs';
import { runGate } from './lib/gate-run.mjs';

const started = [];   // reverse creation order, which is the order to shut down in

async function boot(name, role, opts) {
  const { node, storage } = buildNode(role, {
    ...opts,
    clusterSize: CLUSTER_SIZE,
    privateKey: await generateKeyPair('Ed25519'),
  });
  await withTimeout(node.start(), START_TIMEOUT_MS, `${name} start`);
  const handle = inProcessHandle(name, node, storage);
  started.unshift(handle);
  console.log(`[multipeer-gate] ${name} up   peerId=${handle.peerId()}` +
    (role === 'peer' ? ` (relay-only, ${opts.relayAddrs.length} relay(s))` : ''));
  return handle;
}

const fabric = {
  startDrone: (name, bootstrapNodes) => boot(name, 'drone', { bootstrapNodes, relayAddrs: [] }),
  startPeer: (name, relayAddrs, bootstrapNodes, direct) => boot(name, 'peer', { relayAddrs, bootstrapNodes, direct }),

  /**
   * The D5 control arm: a node in its OWN party, founded on its own, sharing this process
   * with the cohort and sharing no membership with it. Same heap, same event loop, same
   * schema, same strand id — everything except the party. It must see nothing.
   */
  startOutsider: async (name) => {
    const handle = await boot(name, 'drone', {
      bootstrapNodes: [], relayAddrs: [], partyId: `${PARTY_ID}-outsider`,
    });
    await handle.genesis();
    return handle;
  },
};

async function shutdown() {
  for (const h of started) {
    try { await h.stop(); } catch { /* already gone, or never fully up */ }
  }
}

let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[multipeer-gate] ${sig} — stopping ...`);
    await shutdown();
    process.exit(1);
  });
}

const SHAPE_NOTE = [
  'Shape: ONE process, all nodes sharing a heap. A green data leg here does not prove a',
  'byte reached a socket — D5 is the control for that, and `node multiproc-gate.mjs` runs',
  'these same legs with one OS process per node. Neither stands in for a device run.',
];

runGate({ tag: 'multipeer-gate', kind: 'inproc', fabric })
  .then(({ ctx, passed }) => { exitCode = summarize(ctx, { shapeNote: SHAPE_NOTE }); return passed; })
  .catch((err) => {
    console.log('[multipeer-gate] MULTIPEER GATE: FAIL (harness error)', err?.stack ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
