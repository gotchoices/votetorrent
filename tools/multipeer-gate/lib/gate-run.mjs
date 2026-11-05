/**
 * gate-run.mjs — the run sequence, shared by both gates.
 *
 * A gate supplies a `fabric` that knows how to make nodes; everything else — the order of
 * the legs, the ceremony, the short-circuiting, the summary — happens here, once. The two
 * gates differ ONLY in where their nodes live, which is the single variable the
 * cross-process experiment is trying to isolate.
 *
 * ORDERING
 * --------
 * L0-L5 are ordered and short-circuiting: a failure is the EARLIEST broken link rather
 * than a downstream symptom, which is the property that makes this gate diagnostic instead
 * of merely red.
 *
 * D1-D4 follow the same discipline, for a practical reason as well as a principled one:
 * each polls every member for every row, so continuing past a failure costs minutes of
 * timeout to re-learn what the first failure already said.
 *
 * D5 is the exception and always runs, even after a failure and even when everything above
 * it was skipped. It is the control arm, and a control arm that only runs on good days
 * tells you nothing on the days that matter.
 */
import { randomUUID } from 'node:crypto';
import { GATE_TABLE, strandConfig } from './topology.mjs';
import {
  DRONES, RELAYS, CLUSTER_SIZE, ENROLL, SCALE, DB_LEGS, PEER_DIRECT,
  ADD_STRAND_TIMEOUT_MS, withTimeout, createContext, summarize,
} from './runner.mjs';
import { legPreflight } from './preflight.mjs';
import { ownerGenesis, enrol, settleTopology } from './ceremony.mjs';
import {
  legControlMesh, legRelayReservation, legCadreAuthorization, legStrandCohort,
  legReplication, legReplicationFactor, legLateJoiner, legDurability,
} from './core-legs.mjs';
import {
  legRealDial, legReverseReplication, legConvergeAll, legConcurrentWrites,
  legMutationPropagation, legIsolationControl,
} from './db-legs.mjs';

/** Pick a loopback websocket address, which is what a same-host peer should dial. */
export function loopbackWs(addrs) {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
}

export async function runGate({ tag, kind, fabric }) {
  const runId = `gate-${randomUUID().slice(0, 8)}`;
  const ctx = createContext({ tag, kind, table: GATE_TABLE, runId });
  const { L } = ctx;

  L(`config DRONES=${DRONES} RELAYS=${RELAYS} CLUSTER_SIZE=${CLUSTER_SIZE} ` +
    `ENROLL=${ENROLL ? 1 : 0} DB_LEGS=${DB_LEGS ? 1 : 0} PEER_DIRECT=${PEER_DIRECT ? 1 : 0} ` +
    `TIMEOUT_SCALE=${SCALE} shape=${kind}`);
  if (PEER_DIRECT) {
    L('PEER_DIRECT=1 — the peers also listen directly. This is a DIAGNOSTIC run, not a gate');
    L('result: the relay-only constraint the gate exists to test has been lifted.');
  }

  if (!legPreflight(ctx)) return { ctx, passed: false };

  L(`bringing up the n=${DRONES + 2} topology (${kind === 'process' ? 'one OS process per node' : 'all nodes in this process'}) ...`);

  const droneA = await fabric.startDrone('drone-A', []);

  // Owner genesis runs while the founder is STILL SOLO, before anyone else joins. It writes
  // owner-signed control state, and once the control DB is spread across a cohort that write
  // needs a quorum the joiners cannot yet serve — attempting it after bring-up fails with
  // `Block default/Revocation is unavailable (peers-unreachable)`, which reads like a network
  // fault but is really a founding-order mistake.
  if (ENROLL) {
    L('running owner genesis on the founder (solo) ...');
    await ownerGenesis(ctx, droneA);
  } else {
    L('ENROLL=0 — skipping owner genesis and enrolment deliberately');
  }

  const droneAAddr = loopbackWs(await droneA.addrs());
  const drones = [droneA];
  for (let i = 1; i < DRONES; i++) {
    drones.push(await fabric.startDrone(`drone-${String.fromCharCode(65 + i)}`, [droneAAddr]));
  }
  const droneAddrs = [];
  for (const d of drones) droneAddrs.push(loopbackWs(await d.addrs()));

  const relayAddrs = droneAddrs.slice(0, Math.max(1, Math.min(RELAYS, droneAddrs.length)));
  const peerA = await fabric.startPeer('peer-A', relayAddrs, [droneAAddr], PEER_DIRECT);
  const peerB = await fabric.startPeer('peer-B', relayAddrs, [droneAAddr], PEER_DIRECT);
  const peers = [peerA, peerB];
  const all = [...drones, ...peers];

  const finish = (passed) => ({ ctx, passed });

  // L1 before any strand work: a broken mesh makes every later leg meaningless.
  if (!(await legControlMesh(ctx, droneA, all))) return finish(false);
  if (PEER_DIRECT) {
    ctx.record('L2', 'relay-reservation', 'SKIP',
      'PEER_DIRECT=1 lifted the relay-only constraint, so there is nothing for this leg to ' +
      'assert. Everything below is therefore a statement about the database, not about ' +
      'relay-only addressing — which is the only reason to run this way.');
  } else if (!(await legRelayReservation(ctx, peers))) {
    return finish(false);
  }

  if (ENROLL) {
    // Gate on the reservation actually landing — see settleTopology(). Without this the
    // ceremony races cadre-core 0.12.0's post-bring-up reservation drive and L3 fails
    // intermittently with `peers-unreachable`, which reads like a membership failure.
    await settleTopology(ctx, droneA, all, peers);
    L('running the invite/enrolment ceremony ...');
    await enrol(ctx, droneA, [...drones.slice(1), ...peers]);
  }
  if (!(await legCadreAuthorization(ctx, droneA, peers))) return finish(false);

  // Reachability is asserted HERE, not before enrolment: the control mesh is a star until
  // membership lets it widen, so an earlier check tests the sequence rather than the system.
  if (!(await legRealDial(ctx, drones, peers))) return finish(false);

  L('bringing up strands ...');
  // Exactly ONE founder, and it is the node that already founded the cadre (droneA ran owner
  // genesis). Every other node attaches as a genuine joiner, so the first-sync gate they pass
  // through is the real one -- which is what L4/L5 are measuring.
  for (const [i, d] of drones.entries()) {
    await withTimeout(d.addStrand(strandConfig({ mode: 'bootstrap', ...(i === 0 && { founder: true }) })),
      ADD_STRAND_TIMEOUT_MS, `${d.name} addStrand`);
  }
  for (const p of peers) {
    await withTimeout(p.addStrand(strandConfig({ mode: 'networked' })), ADD_STRAND_TIMEOUT_MS, `${p.name} addStrand`);
  }

  if (!(await legStrandCohort(ctx, all))) return finish(false);

  const forwardId = await legReplication(ctx, peerA, peerB);
  if (!forwardId) return finish(false);

  let ok = true;
  const writtenIds = [forwardId];

  if (DB_LEGS) {
    L('running the distributed-database legs ...');
    const skip = (id, title, why) => ctx.record(id, title, 'SKIP', why);

    const d1 = await legReverseReplication(ctx, peerA, peerB);
    if (d1) writtenIds.push(`${runId}-reverse`); else ok = false;

    if (d1) {
      if (!(await legConvergeAll(ctx, all, writtenIds))) ok = false;
    } else {
      skip('D2', 'convergence-all-members', 'D1 failed — replication is already broken in one direction');
    }

    if (ok) {
      if (!(await legConcurrentWrites(ctx, peerA, peerB, all))) ok = false;
    } else {
      skip('D3', 'concurrent-writes', 'an earlier data leg failed — a concurrency result would not be interpretable');
    }

    if (ok) {
      if (!(await legMutationPropagation(ctx, peerA, peerB))) ok = false;
    } else {
      skip('D4', 'mutation-propagation', 'an earlier data leg failed — a mutation result would not be interpretable');
    }

    // Always. It is the control arm.
    const outsider = await fabric.startOutsider?.('outsider');
    if (outsider) {
      // The control arm is a strand of one, deliberately cut off from the cohort, so it has to
      // found its own or it would sit un-writable and report "sees nothing" for that reason
      // rather than for the isolation it is there to demonstrate.
      await withTimeout(outsider.addStrand(strandConfig({ mode: 'bootstrap', founder: true })), ADD_STRAND_TIMEOUT_MS, 'outsider addStrand');
      if (!(await legIsolationControl(ctx, outsider, writtenIds))) ok = false;
    } else {
      skip('D5', 'isolation-control', 'this gate supplied no outsider — D1-D4 are unvouched');
      ok = false;
    }
  }

  // Standing reproductions. Recorded, never fatal — see `recordStanding`.
  await legReplicationFactor(ctx, all);
  await legLateJoiner(ctx, droneA, (name) => fabric.startPeer(name, relayAddrs, [droneAAddr], PEER_DIRECT), forwardId, all);
  await legDurability(ctx, all, forwardId);

  return finish(ok);
}

export { createContext, summarize };
