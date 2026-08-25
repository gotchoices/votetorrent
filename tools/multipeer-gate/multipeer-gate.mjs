/**
 * multipeer-gate.mjs — a standalone Node gate for the n=4 Sereus/Optimystic
 * multi-peer topology.
 *
 * WHY THIS EXISTS
 * ---------------
 * The n=4 topology (two always-on relay/storage nodes plus two relay-only peers that
 * cannot be dialled directly) has repeatedly failed for reasons that are invisible in
 * an end-to-end pass/fail: a healthy control network sitting on top of a strand overlay
 * that never seeded, a clean dial surface that was clean only because nothing was ever
 * handed a peer to dial, and diagnostics living in a debug namespace nobody had armed.
 *
 * This gate replaces "it still fails" with "leg N fails, here is the number". It runs
 * five ORDERED legs and stops at the first failure, so the output names the earliest
 * broken link rather than its downstream symptoms.
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
 *
 * The peers get NO direct listen address. That is the whole point: a sibling cannot
 * reach them except through a relay, which is the constraint every multi-peer bug in
 * this topology has turned on.
 *
 * THE LEGS
 * --------
 *   L1  control-reachability  every node holds >= 1 control connection; founder sees all
 *   L2  relay-reservation both relay-only peers expose a /p2p-circuit multiaddr
 *   L3  cadre-authorization  the relay-only peers are AUTHORIZED members of the cadre
 *   L4  strand-cohort     each strand node assembles a cohort larger than itself
 *   L5  replication       peer-A writes a row; peer-B reads it back
 *
 * L1-L5 answer "is the multi-peer path unblocked?". They do NOT answer "is this actually
 * a distributed database?" — L5 passes with a replication factor of ONE, because the
 * writer is still up and still holds the row. Three further legs ask that question:
 *
 *   L6  replication-factor        how many nodes actually HOLD the row (want >= CLUSTER_SIZE)
 *   L7  late-joiner-convergence   a peer that arrives AFTER the write can read it
 *   L8  durability                the row survives losing the node that holds it
 *
 * All three are red on db-p2p 0.24.2. They are STANDING REPRODUCTIONS: recorded, never
 * short-circuiting each other, and deliberately excluded from the gate's verdict so it
 * stays usable as a green/red signal. If one flips to green that is reported loudly.
 *
 * L3 is the one people skip. Control-network membership is the v1 authorization for the
 * strand-address RPC (`strand-addr-protocol.js`: "only this party's cadre peers may ask
 * us for a strand address"). A peer that is merely CONNECTED is addressable but not
 * authorized: its strand-addr request is refused as `non-member`, it receives no cohort
 * addresses, and its strand node then sits at a cohort of one with zero dial attempts.
 * Every layer below looks healthy while replication silently never happens. L3 makes
 * that gate explicit instead of letting it masquerade as an L4 or L5 failure.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * ---------------------------------
 * DOES: that the topology's addressing, authorization, cohort-assembly and replication
 * path work when the peers are reachable ONLY through a relay. That is a real constraint
 * and it is where these bugs live.
 *
 * DOES NOT: prove device behaviour. Everything here is one process on loopback. A real
 * NAT adds address translation, mobile schedulers add main-thread starvation, and both
 * have produced device-only failures that a loopback gate passed straight through. A
 * PASS here is a necessary condition for the device proof, never a substitute for it.
 * Treat a PASS as "the blocker is not in this layer", not as "the topology works".
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
 *   TIMEOUT_SCALE=N   multiply every timeout by N on a slow machine (default 1).
 *   VERBOSE=1         print per-poll progress.
 *
 * To see the underlying diagnostics, arm BOTH namespace roots — the optimystic ones
 * alone have zero coverage of strand seeding, which is what made this class of bug so
 * hard to localize:
 *
 *   DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' node multipeer-gate.mjs
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';

// ── holder census ────────────────────────────────────────────────────────────────────
/**
 * L6-L8 need to know which nodes actually HOLD a block, not merely whether some read
 * succeeded — the distinction the first five legs cannot make. `MemoryRawStorage` has no
 * "list what I hold" surface, so wrap it and record every block id this node is asked to
 * persist. Storage-only: it changes nothing about how the node behaves.
 */
const stores = new Map();          // node name -> TrackingStorage
let currentNodeName = '?';
class TrackingStorage extends MemoryRawStorage {
  constructor() { super(); this.seen = new Set(); }
  async saveMetadata(id, m) { this.seen.add(id); return super.saveMetadata(id, m); }
  async saveRevision(id, r, a) { this.seen.add(id); return super.saveRevision(id, r, a); }
  async saveMaterializedBlock(id, a, b) { this.seen.add(id); return super.saveMaterializedBlock(id, a, b); }
}
const holdersOf = (blockId, all) =>
  all.filter(({ name }) => stores.get(name)?.seen.has(blockId)).map(({ name }) => name);
const allBlockIds = (all) => {
  const u = new Set();
  for (const { name } of all) for (const id of stores.get(name)?.seen ?? []) u.add(id);
  return u;
};

// ── configuration ────────────────────────────────────────────────────────────────────
const PARTY_ID = 'multipeer-gate';
const STRAND_ID = 'multipeer-gate-strand';
const SAPP_ID = 'org.sereus.multipeer-gate';

const DRONES = Number(process.env.DRONES ?? 2);
const RELAYS = Number(process.env.RELAYS ?? 1);
const CLUSTER_SIZE = Number(process.env.CLUSTER_SIZE ?? 2);
const ENROLL = (process.env.ENROLL ?? '1') !== '0';
const SCALE = Number(process.env.TIMEOUT_SCALE ?? 1);
const VERBOSE = process.env.VERBOSE === '1';

const T = (ms) => Math.round(ms * SCALE);
const START_TIMEOUT_MS = T(45_000);
const ADD_STRAND_TIMEOUT_MS = T(60_000);
const MESH_TIMEOUT_MS = T(30_000);
const RESERVATION_TIMEOUT_MS = T(20_000);
const ENROLL_TIMEOUT_MS = T(30_000);
const COHORT_TIMEOUT_MS = T(30_000);
const REPLICATION_TIMEOUT_MS = T(60_000);
const POLL_MS = T(500);
const ENROLL_ATTEMPTS = Number(process.env.ENROLL_ATTEMPTS ?? 5);
const SETTLE_MS = T(5_000);        // let replication quiesce before counting holders
const ISSUE_15 = 'Optimystic#15';  // singly-held blocks can never gain a second holder
/** L7's red is real but NOT yet attributed to a specific issue — see the leg's comment. */
const L7_NOTE = 'red on 0.24.2, cause not yet triaged — see the leg comment';

/**
 * StrandDatabase.executeSchema() wraps the DDL as `declare schema App { ... }`, so the
 * table lands in `App` while the default schema path is `main`.
 */
const GATE_TABLE = 'App.GateRow';
/** The block the table's rows live in — what L6/L8 count holders of. */
const GATE_ROW_BLOCK = 'default/GateRow';
let writtenRowId = null;           // set by L5, read by L7/L8
const ENROLL_RETRY_MS = T(2_000);

// A single-table schema. StrandDatabase.executeSchema() supplies the
// `declare schema App { ... } apply schema App;` wrapper itself, so this is raw DDL.
const SCHEMA = `
create table GateRow (
  Id text primary key,
  Value text
);
`;

// ── output ───────────────────────────────────────────────────────────────────────────
const L = (...a) => console.log('[multipeer-gate]', ...a);
const V = (...a) => { if (VERBOSE) console.log('[multipeer-gate]  ·', ...a); };

const nodes = [];          // { name, node } in shutdown order (reverse of creation)
const results = [];        // { id, title, status, detail }

function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  L(`${status.padEnd(9)}  ${id}  ${title}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A STANDING REPRODUCTION: a leg that is expected to be red on current upstream, kept so
 * a fix can be verified by watching it flip. It is recorded but never fails the gate —
 * the gate's verdict stays L1-L5, so it remains usable as a green/red signal — and if it
 * unexpectedly PASSES that is reported loudly, because it means the defect is fixed.
 */
function recordStanding(id, title, ok, detail, note) {
  record(id, title, ok ? 'FIXED' : 'KNOWN-RED',
    ok ? `${detail} — this leg is a standing reproduction (${note}); it just went GREEN, so check whether that is fixed`
       : `${detail} — expected red (${note})`);
  return ok;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Poll `probe` until it returns a truthy value or the deadline passes. */
async function poll(probe, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() >= deadline) return null;
    V(`${label}: not yet (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function loopbackWs(addrs) {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
}

function controlAddrs(node) {
  return node.getControlNode().getMultiaddrs().map((m) => m.toString());
}

/**
 * Shared CadreNode options. Every node on one strand MUST agree on strandClusterSize.
 *
 * `privateKey` is supplied explicitly rather than letting libp2p mint an ephemeral one:
 * `getIdentityOwnerKey()` — which owner genesis needs — throws on an ephemeral key,
 * because that key is internal to libp2p and never exposed.
 */
function baseConfig(bootstrapNodes, privateKey) {
  return {
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
    // The gate hosts an unsigned demo schema, so relax the fail-closed signature policy
    // exactly as the reference drone harness does. Not a production posture.
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: () => { const st = new TrackingStorage(); stores.set(currentNodeName, st); return st; } },
    strandClusterSize: CLUSTER_SIZE,
    hibernation: { enabled: false },
  };
}

async function startDrone(name, bootstrapNodes) {
  currentNodeName = name;
  const node = new CadreNode({
    ...baseConfig(bootstrapNodes, await generateKeyPair('Ed25519')),
    profile: 'storage', // turns the circuit-relay-v2 relay server ON
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
      relayServerInit: {
        reservations: {
          maxReservations: 32,             // n=4 plus headroom (library default is 15)
          defaultDurationLimit: 10 * 60 * 1000,
          defaultDataLimit: BigInt(1 << 20),
        },
        maxInboundHopStreams: 64,
        maxOutboundStopStreams: 64,
      },
    },
  });
  await withTimeout(node.start(), START_TIMEOUT_MS, `${name} start`);
  nodes.unshift({ name, node });
  L(`${name} up   peerId=${node.peerId?.toString()}`);
  return node;
}

/**
 * A relay-only peer: NO direct listen address, only `<relay>/p2p-circuit` entries. This
 * is the 'configured' reservation path, which is what makes the peer undialable except
 * through a relay — the constraint the whole gate exists to exercise.
 */
async function startRelayOnlyPeer(name, relayAddrs, bootstrapNodes) {
  currentNodeName = name;
  const node = new CadreNode({
    ...baseConfig(bootstrapNodes, await generateKeyPair('Ed25519')),
    profile: 'transaction',
    network: {
      transports: [
        webSockets(),
        // Required for a `/p2p-circuit` LISTEN address to be honoured at all — without
        // it libp2p rejects the address with UnsupportedListenAddressError and the peer
        // never starts.
        //
        // reservationConcurrency defaults to 1, which serialises and then DROPS the
        // surplus: N relay-qualified listen addresses alone do NOT yield N reservations.
        // Size it to the relay count or L2 silently caps at one reservation.
        circuitRelayTransport({ reservationConcurrency: Math.max(1, relayAddrs.length) }),
      ],
      listenAddrs: relayAddrs.map((a) => `${a}/p2p-circuit`),
    },
  });
  await withTimeout(node.start(), START_TIMEOUT_MS, `${name} start`);
  nodes.unshift({ name, node });
  L(`${name} up   peerId=${node.peerId?.toString()} (relay-only, ${relayAddrs.length} relay(s))`);
  return node;
}

async function addStrand(node, name, mode) {
  await withTimeout(
    node.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: SCHEMA, latencyHint: 'interactive' },
      mode,
    }),
    ADD_STRAND_TIMEOUT_MS,
    `${name} addStrand`,
  );
  V(`${name} strand up`);
}

/** The Quereus handle for a node's strand, or null if the strand is not active. */
function strandDb(node) {
  return node.getStrand(STRAND_ID)?.database?.getDatabase() ?? null;
}

/** Cohort size this node's strand assembles for `key`, via the same path the coordinator uses. */
async function cohortSize(node, key) {
  const strandNode = node.getStrand(STRAND_ID)?.libp2pNode;
  if (!strandNode) return { count: 0, ids: [] };
  const peers = await strandNode.keyNetwork.findCluster(new TextEncoder().encode(key));
  const ids = Object.keys(peers ?? {});
  return { count: ids.length, ids };
}

// ── the legs ─────────────────────────────────────────────────────────────────────────

/**
 * L1 — control-plane reachability.
 *
 * Deliberately NOT a full-mesh assertion. On bring-up the control network is a star:
 * every joiner dials the founder, and the mesh only widens once `reconcileControlCohort`
 * runs — which is itself gated on the membership L3 tests. Asserting a full mesh here
 * would fail for a reason that belongs to L3 and would mislabel the blocker.
 *
 * What must hold: every node has at least one control connection, and the founder can
 * see all of them. A relay-only peer that cannot reach the founder fails right here.
 */
async function legControlMesh(founder, all) {
  const wantFounder = all.length - 1;
  const got = await poll(async () => {
    const counts = all.map(({ name, node }) => ({
      name,
      n: node.getControlNode().getConnections().length,
    }));
    V(`control ${counts.map((c) => `${c.name}=${c.n}`).join(' ')}`);
    const founderCount = founder.getControlNode().getConnections().length;
    return counts.every((c) => c.n >= 1) && founderCount >= wantFounder ? counts : null;
  }, MESH_TIMEOUT_MS, 'control reachability');

  if (!got) {
    const counts = all.map(({ name, node }) => `${name}=${node.getControlNode().getConnections().length}`);
    record('L1', 'control-reachability', 'FAIL',
      `expected every node >= 1 control connection and the founder >= ${wantFounder}, ` +
      `got ${counts.join(' ')}`);
    return false;
  }
  record('L1', 'control-reachability', 'PASS',
    `${got.map((c) => `${c.name}=${c.n}`).join(' ')} (founder >= ${wantFounder}, each >= 1)`);
  return true;
}

/** L2 — the relay-only peers actually hold circuit reservations. */
async function legRelayReservation(peers) {
  const got = await poll(async () => {
    const seen = peers.map(({ name, node }) => {
      const circuits = controlAddrs(node).filter((a) => a.includes('/p2p-circuit'));
      return { name, circuits };
    });
    V(`reservations ${seen.map((s) => `${s.name}=${s.circuits.length}`).join(' ')}`);
    return seen.every((s) => s.circuits.length >= RELAYS) ? seen : null;
  }, RESERVATION_TIMEOUT_MS, 'relay reservation');

  if (!got) {
    const seen = peers.map(({ name, node }) =>
      `${name}=${controlAddrs(node).filter((a) => a.includes('/p2p-circuit')).length}`);
    record('L2', 'relay-reservation', 'FAIL',
      `expected >= ${RELAYS} /p2p-circuit multiaddr(s) per relay-only peer, got ${seen.join(' ')}`);
    return false;
  }

  // Distinct RELAY identities, not the same relay in several IP forms — a real trap:
  // three addresses that are all one relay reads as breadth in a naive count.
  const detail = got.map((s) => {
    const relayIds = new Set(s.circuits.map((c) => c.split('/p2p-circuit')[0].split('/p2p/').pop()));
    return `${s.name}=${s.circuits.length} addr/${relayIds.size} relay`;
  });
  record('L2', 'relay-reservation', 'PASS', detail.join(' '));
  return true;
}

/**
 * L3 — the relay-only peers are AUTHORIZED cadre members.
 *
 * `isAuthorizedMember` is the exact predicate the strand-address responder consults, so
 * this asserts the real gate rather than a proxy for it. Authorization needs a CadrePeer
 * row carrying an anchored voucher; merely being connected is not enough.
 */
async function legCadreAuthorization(owner, peers) {
  // The probe itself can THROW rather than answer — `isAuthorizedMember` reads the
  // control DB, and if that read cannot be served the query raises instead of returning
  // false. That is a distinct, and more interesting, failure than "not a member", so
  // capture it rather than letting it abort the run.
  let probeError = null;
  const check = async () => {
    try {
      const out = [];
      for (const { name, node } of peers) {
        out.push({ name, ok: await owner.isAuthorizedMember(node.peerId.toString()) });
      }
      probeError = null;
      V(`authorization ${out.map((o) => `${o.name}=${o.ok}`).join(' ')}`);
      return out.every((o) => o.ok) ? out : null;
    } catch (e) {
      probeError = e;
      V(`authorization probe threw: ${e?.message ?? e}`);
      return null;
    }
  };

  const got = await poll(check, ENROLL_TIMEOUT_MS, 'cadre authorization');
  if (got) {
    record('L3', 'cadre-authorization', 'PASS', `${got.map((o) => o.name).join(', ')} authorized`);
    return true;
  }

  if (probeError) {
    record('L3', 'cadre-authorization', 'FAIL',
      `the membership probe could not be answered: ${probeError?.message ?? probeError}. ` +
      'This is NOT "peer is not a member" — the control-database read itself failed, so ' +
      'the cadre cannot evaluate its own membership. Suspect control-DB cluster health ' +
      '(a `peers-unreachable` block read usually means the cluster cannot serve a quorum).');
    return false;
  }

  const finalState = [];
  for (const { name, node } of peers) {
    const ok = await owner.isAuthorizedMember(node.peerId.toString()).catch((e) => `error(${e?.message ?? e})`);
    finalState.push(`${name}=${ok}`);
  }
  const members = await owner.listAuthorizedMembers().catch(() => []);
  record('L3', 'cadre-authorization', 'FAIL',
    `${finalState.join(' ')}; owner lists ${members.length} authorized member(s). ` +
    (ENROLL
      ? 'The enrolment ceremony ran but did not produce authorized membership.'
      : 'ENROLL=0 — no ceremony was attempted.') +
    ' Un-authorized peers are refused the strand-address RPC as `non-member`, so their ' +
    'strand nodes never receive cohort addresses and L4/L5 cannot pass.');
  return false;
}

/** L4 — each strand node assembles a cohort bigger than itself. */
async function legStrandCohort(all) {
  const key = 'multipeer-gate-probe-block';
  const got = await poll(async () => {
    const sizes = [];
    for (const { name, node } of all) {
      sizes.push({ name, ...(await cohortSize(node, key)) });
    }
    V(`cohort ${sizes.map((s) => `${s.name}=${s.count}`).join(' ')}`);
    return sizes.every((s) => s.count >= 2) ? sizes : null;
  }, COHORT_TIMEOUT_MS, 'strand cohort');

  if (!got) {
    const sizes = [];
    for (const { name, node } of all) sizes.push(`${name}=${(await cohortSize(node, key)).count}`);
    record('L4', 'strand-cohort', 'FAIL',
      `expected every strand node to assemble >= 2 cohort members, got ${sizes.join(' ')}. ` +
      'A node stuck at 1 has only itself: it was never given a peer to dial, which points ' +
      'upstream at strand-address seeding (L3), not at the dial layer.');
    return false;
  }
  record('L4', 'strand-cohort', 'PASS', got.map((s) => `${s.name}=${s.count}`).join(' '));
  return true;
}

/** L5 — the actual point: a row written by one relay-only peer is readable by the other. */
async function legReplication(peerA, peerB) {
  const dbA = strandDb(peerA.node);
  const dbB = strandDb(peerB.node);
  if (!dbA || !dbB) {
    record('L5', 'replication', 'FAIL', 'a relay-only peer has no active strand database');
    return false;
  }

  const TABLE = GATE_TABLE;
  const id = `gate-row-${peerA.node.peerId.toString().slice(-8)}`;
  writtenRowId = id;
  try {
    await dbA.exec(`insert into ${TABLE} (Id, Value) values ('${id}', 'written-by-peer-A');`);
  } catch (e) {
    record('L5', 'replication', 'FAIL', `peer-A write failed: ${e?.message ?? e}`);
    return false;
  }
  V(`peer-A wrote ${id}`);

  const seen = await poll(() => rowVisible(dbB, id, 'peer-B'), REPLICATION_TIMEOUT_MS, 'replication');

  if (!seen) {
    record('L5', 'replication', 'FAIL',
      `peer-B never observed row '${id}' within ${REPLICATION_TIMEOUT_MS}ms`);
    return false;
  }
  record('L5', 'replication', 'PASS', `peer-B observed '${id}'`);
  return true;
}


/** Is `id` visible in this node's strand db? Never throws — a failed read is just false. */
async function rowVisible(db, id, who) {
  try {
    for await (const row of db.eval(`select Id from ${GATE_TABLE} where Id = '${id}';`)) {
      if (row?.Id === id) return true;
    }
  } catch (e) {
    V(`${who} read retry: ${e?.message ?? e}`);
  }
  return false;
}

// ── standing reproductions (L6-L8) ───────────────────────────────────────────────────
// L1-L5 answer "is the multi-peer path unblocked?". They do NOT answer "is this actually
// a distributed database?", and the difference is not academic: L5 passes with a
// replication factor of ONE, because the writer is still up and still holds the row.
// These three legs ask the questions L5 cannot. All three are red on current upstream
// for the same reason (Optimystic#15), so none of them short-circuits the others.

/**
 * L6 — replication factor. L5 proves the row PROPAGATED to a live peer. It never asks
 * how many nodes hold it. Measured on 0.24.2 in the default config the answer is one,
 * and 24-27 of the ~33 blocks in the run are singly held — so today's green gate is
 * green over unreplicated data.
 */
async function legReplicationFactor(all) {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const holders = holdersOf(GATE_ROW_BLOCK, all);
  const ids = allBlockIds(all);
  const singly = [...ids].filter((id) => holdersOf(id, all).length === 1);
  for (const id of [...ids].sort()) {
    const h = holdersOf(id, all);
    V(`${String(h.length)}/${all.length}  ${id}  [${h.join(', ')}]`);
  }
  return recordStanding('L6', 'replication-factor',
    holders.length >= CLUSTER_SIZE,
    `'${GATE_ROW_BLOCK}' held by ${holders.length}/${all.length} [${holders.join(', ') || 'nobody'}], ` +
    `want >= CLUSTER_SIZE (${CLUSTER_SIZE}); ${singly.length}/${ids.size} blocks in this run are singly held`,
    ISSUE_15);
}

/**
 * L7 — late-joiner convergence. Every reader in L5 was present when the row was written.
 * A distributed database has to serve a member that arrives afterwards, and that is
 * exactly the case Optimystic#15 makes impossible: a block whose cohort has grown since
 * commit is unreadable by everyone who was not there.
 *
 * Joining also widens every node's cohort view, which is #15's trigger — so this leg
 * meets the defect from the direction a real deployment does: by growing.
 *
 * CAVEAT, because getting this wrong is how the RELAYS=2 section was wrong for weeks:
 * on 0.24.2 this leg currently fails EARLIER than the read, while peer-C is still
 * bringing its strand up, with `Block optimystic/schema is unavailable
 * (cohort-unreachable)` — a different AbsenceVerdict branch from #15's
 * `claimed-elsewhere`. That may be #15 reached by another route, or an addressing
 * problem in the #13/#14 family. It has NOT been triaged. The leg reports the error it
 * actually gets; do not read the red as evidence for any particular issue until someone
 * does that work.
 */
async function legLateJoiner(founder, relayAddrs, bootstrapAddr, all) {
  const name = 'peer-C';
  let node;
  try {
    node = await startRelayOnlyPeer(name, relayAddrs, [bootstrapAddr]);
    if (ENROLL) await enrol(founder, [{ name, node }]);
    await addStrand(node, name, 'networked');
  } catch (e) {
    return recordStanding('L7', 'late-joiner-convergence', false,
      `${name} could not join after the write: ${e?.message ?? e}`, L7_NOTE);
  }
  all.push({ name, node });

  const db = strandDb(node);
  if (!db) {
    return recordStanding('L7', 'late-joiner-convergence', false,
      `${name} joined but has no active strand database`, L7_NOTE);
  }
  const seen = await poll(() => rowVisible(db, writtenRowId, name), REPLICATION_TIMEOUT_MS, 'late-joiner');
  return recordStanding('L7', 'late-joiner-convergence', Boolean(seen),
    seen ? `${name} read '${writtenRowId}' after joining`
         : `${name} joined, enrolled and never saw '${writtenRowId}' in ${REPLICATION_TIMEOUT_MS}ms`,
    L7_NOTE);
}

/**
 * L8 — durability. The promise that separates a distributed database from a cache:
 * losing a node must not lose data.
 *
 * The assertion is on the CENSUS, not on a read, and that distinction is the leg's whole
 * point. Storage here is in-memory, so a block held by one node ceases to exist the
 * moment that node stops. A read can still succeed afterwards — the surviving nodes
 * materialized the row when it propagated and will answer from their own state — which
 * means a naive write-then-read-back check (L5, and most integration tests) reports
 * PASS over data that is no longer stored anywhere. We stop the holder, then report both
 * numbers so the difference is visible.
 *
 * Destructive, so it runs last.
 */
async function legDurability(all) {
  const before = holdersOf(GATE_ROW_BLOCK, all);
  if (before.length === 0) {
    return recordStanding('L8', 'durability', false,
      `nobody holds '${GATE_ROW_BLOCK}', so there is nothing to lose`, ISSUE_15);
  }
  const victim = all.find((n) => n.name === before[0]);
  const survivors = all.filter((n) => n.name !== victim.name);

  L(`stopping ${victim.name} — holder 1 of ${before.length} [${before.join(', ')}] ...`);
  try {
    await victim.node.stop();
  } catch (e) {
    V(`${victim.name} stop error: ${e?.message ?? e}`);
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Does any SURVIVING node still hold the block? That is the durability question.
  const after = holdersOf(GATE_ROW_BLOCK, survivors);

  // And, separately, can anyone still read it? If yes while `after` is empty, the read is
  // being served from memory, not from a stored replica.
  let readableBy = null;
  for (const sv of survivors) {
    const db = strandDb(sv.node);
    if (!db) continue;
    if (await poll(() => rowVisible(db, writtenRowId, sv.name), REPLICATION_TIMEOUT_MS, `durability:${sv.name}`)) {
      readableBy = sv.name;
      break;
    }
  }

  const gloss = after.length === 0 && readableBy
    ? `; ${readableBy} still READS '${writtenRowId}', but from its own materialized state — ` +
      'no surviving node holds the block, so a read-back check would call this durable when it is not'
    : after.length === 0
      ? `; and no survivor can read '${writtenRowId}' either`
      : `; ${readableBy ?? 'nobody'} reads it back`;

  return recordStanding('L8', 'durability', after.length > 0,
    `'${GATE_ROW_BLOCK}' was held by [${before.join(', ')}]; after stopping ${victim.name} ` +
    `it is held by ${after.length}/${survivors.length} survivors [${after.join(', ') || 'none'}]${gloss}`,
    ISSUE_15);
}

/**
 * Owner genesis on the founder. cadre-core deliberately never runs this implicitly —
 * the hosting app owns it — so a harness must do it explicitly or every owner-signed
 * control write (including `createInvite`) fails.
 *
 *   trustOwnerKeys   anchor the owner pubkey in this node's node-local trusted set
 *   ensureOwnerKey   enroll it in the replicated OwnerKey table
 *   initializeSeedBootstrap  hand the private half to the seed/invite signer
 */
async function ownerGenesis(founder) {
  const owner = founder.getIdentityOwnerKey();
  await founder.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const db = founder.getControlDatabase();
  if (!db) throw new Error('founder has no control database after start()');
  await db.ensureOwnerKey(owner.publicKeyB64);
  founder.initializeSeedBootstrap(owner.privateKeyB64);
  V(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);
  return owner;
}

// ── enrolment ────────────────────────────────────────────────────────────────────────
/**
 * Run the public invite ceremony so the joiners become authorized members:
 * `createInvite` on the owner (which also opens the inbound enrolment window),
 * then `dialInvite` on the joiner. `acceptPhone` is tried as a fallback for builds
 * where the owner must accept explicitly.
 */
async function enrol(owner, joiners) {
  for (const { name, node } of joiners) {
    const peerId = node.peerId.toString();
    let lastErr = null;

    // Bounded retry, because the ceremony genuinely races. Each step writes and then
    // reads owner-signed control state, and a read issued before that state has settled
    // fails with `Block default/Revocation is unavailable (peers-unreachable)`. The same
    // code path succeeds or fails run-to-run purely on timing, so a one-shot attempt
    // makes the whole gate flaky. Retrying is not masking a defect: a peer that is truly
    // un-enrollable still exhausts every attempt and L3 still fails.
    for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt++) {
      try {
        if (await owner.isAuthorizedMember(peerId)) { lastErr = null; break; }

        const { invite } = await owner.createInvite();
        await withTimeout(node.dialInvite(invite), ENROLL_TIMEOUT_MS, `${name} dialInvite`);
        V(`${name} dialInvite ok (attempt ${attempt})`);

        if (!(await owner.isAuthorizedMember(peerId))) {
          try {
            await owner.acceptPhone({ phonePeerId: peerId }, invite);
            V(`${name} acceptPhone ok (attempt ${attempt})`);
          } catch (e) {
            V(`${name} acceptPhone unavailable: ${e?.message ?? e}`);
          }
        }

        if (await owner.isAuthorizedMember(peerId)) { lastErr = null; break; }
        lastErr = new Error('ceremony completed but membership did not take');
      } catch (e) {
        lastErr = e;
        V(`${name} enrolment attempt ${attempt}/${ENROLL_ATTEMPTS} failed: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, ENROLL_RETRY_MS * attempt)); // linear backoff
    }

    if (lastErr) L(`WARN enrolment for ${name} did not settle after ${ENROLL_ATTEMPTS} attempt(s): ${lastErr?.message ?? lastErr}`);
    else V(`${name} enrolled`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────
async function main() {
  L(`config DRONES=${DRONES} RELAYS=${RELAYS} CLUSTER_SIZE=${CLUSTER_SIZE} ` +
    `ENROLL=${ENROLL ? 1 : 0} TIMEOUT_SCALE=${SCALE}`);
  L('bringing up the n=4 topology ...');

  const droneA = await startDrone('drone-A', []);

  // Owner genesis runs while the founder is STILL SOLO, before anyone else joins.
  // It writes owner-signed control state, and once the control DB is spread across a
  // cohort that write needs a quorum the joiners cannot yet serve — attempting it after
  // bring-up fails with `Block default/Revocation is unavailable (peers-unreachable)`,
  // which reads like a network fault but is really a founding-order mistake.
  if (ENROLL) {
    L('running owner genesis on the founder (solo) ...');
    await ownerGenesis(droneA);
  } else {
    L('ENROLL=0 — skipping owner genesis and enrolment deliberately');
  }

  const droneAAddr = loopbackWs(controlAddrs(droneA));
  const drones = [{ name: 'drone-A', node: droneA }];
  for (let i = 1; i < DRONES; i++) {
    const name = `drone-${String.fromCharCode(65 + i)}`;
    drones.push({ name, node: await startDrone(name, [droneAAddr]) });
  }
  const droneAddrs = drones.map((d) => loopbackWs(controlAddrs(d.node)));

  const relayAddrs = droneAddrs.slice(0, Math.max(1, Math.min(RELAYS, droneAddrs.length)));
  const peerA = await startRelayOnlyPeer('peer-A', relayAddrs, [droneAAddr]);
  const peerB = await startRelayOnlyPeer('peer-B', relayAddrs, [droneAAddr]);

  const peers = [{ name: 'peer-A', node: peerA }, { name: 'peer-B', node: peerB }];
  const all = [...drones, ...peers];

  // L1 before any strand work: a broken mesh makes every later leg meaningless.
  if (!(await legControlMesh(droneA, all))) return false;
  if (!(await legRelayReservation(peers))) return false;

  if (ENROLL) {
    L('running the invite/enrolment ceremony ...');
    await enrol(droneA, [...drones.slice(1), ...peers]);
  }
  if (!(await legCadreAuthorization(droneA, peers))) return false;

  L('bringing up strands ...');
  for (const { name, node } of drones) await addStrand(node, name, 'bootstrap');
  await addStrand(peerA, 'peer-A', 'networked');
  await addStrand(peerB, 'peer-B', 'networked');

  if (!(await legStrandCohort(all))) return false;
  if (!(await legReplication(peers[0], peers[1]))) return false;

  // L6-L8 are STANDING REPRODUCTIONS. They deliberately do not short-circuit each other
  // and do not affect the gate's verdict — see recordStanding().
  L('');
  L('running the distributed-database legs (standing reproductions, expected red) ...');
  await legReplicationFactor(all);
  await legLateJoiner(droneA, relayAddrs, droneAAddr, all);
  await legDurability(all);

  return true;
}

async function shutdown() {
  for (const { name, node } of nodes) {
    try {
      await node.stop();
    } catch (e) {
      V(`${name} stop error: ${e?.message ?? e}`);
    }
  }
}

function summarize(passed) {
  const gate = results.filter((r) => r.status === 'PASS' || r.status === 'FAIL' || r.status === 'SKIP');
  const standing = results.filter((r) => r.status === 'KNOWN-RED' || r.status === 'FIXED');

  L('');
  L('──────────────────────────── SUMMARY ────────────────────────────');
  for (const r of gate) L(` ${r.status.padEnd(9)}  ${r.id}  ${r.title}`);
  const ran = gate.length;
  L('─────────────────────────────────────────────────────────────────');
  if (passed) {
    L(`MULTIPEER GATE: PASS — all ${ran} gate legs green.`);
    L('Necessary, not sufficient: this is loopback, so it says the blocker is not in');
    L('this layer. It does not stand in for a device run.');
  } else {
    const failed = results.find((r) => r.status === 'FAIL');
    L(`MULTIPEER GATE: FAIL at ${failed?.id ?? '?'} (${failed?.title ?? 'startup'}) — ${ran} leg(s) ran.`);
    L('Legs are ordered, so this is the EARLIEST broken link, not a downstream symptom.');
    L("Re-run with DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' for the underlying trace.");
  }

  if (standing.length) {
    L('');
    L('──────────── DISTRIBUTED-DATABASE LEGS (standing) ───────────────');
    for (const r of standing) L(` ${r.status.padEnd(9)}  ${r.id}  ${r.title}`);
    L('─────────────────────────────────────────────────────────────────');
    const fixed = standing.filter((r) => r.status === 'FIXED');
    if (fixed.length) {
      L(`${fixed.length} standing reproduction(s) went GREEN: ${fixed.map((r) => r.id).join(', ')}.`);
      L('Verify against the leg\'s own note, then promote it from standing to a real leg.');
    } else {
      L(`All red, as expected. A green gate above does NOT mean the data is replicated:`);
      L(`L6 measures the replication factor and on 0.24.2 it is 1 (${ISSUE_15}).`);
    }
  }
  return passed ? 0 : 1;
}

let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping ...`);
    await shutdown();
    process.exit(1);
  });
}

main()
  .then((passed) => { exitCode = summarize(passed); })
  .catch((err) => {
    L('MULTIPEER GATE: FAIL (harness error)', err?.stack ?? err);
    exitCode = summarize(false);
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
