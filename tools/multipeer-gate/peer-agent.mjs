/**
 * peer-agent.mjs — ONE cadre node, in its own OS process.
 *
 * WHY THIS EXISTS
 * ---------------
 * `multipeer-gate.mjs` builds all four nodes inside a single Node process. That gate is
 * worth having, but there is a whole class of defect it cannot see, because in one
 * process the four "peers" share a heap, a module registry, a timer wheel and a single
 * libp2p event loop. Concretely:
 *
 *   - A row can appear on the reader without ever having been serialized, framed, or put
 *     on a socket. Nothing in an in-process run distinguishes "replicated" from "the
 *     reader happened to be looking at an object the writer also had a reference to".
 *   - A stream that is never opened cannot fail to open. The n=4 device runs die on
 *     `UnexpectedEOFError` and `NoValidAddressesError` during block transfer — failures
 *     of a real dial between real processes, which an in-process cohort never attempts.
 *   - One event loop hides scheduling. Four nodes taking turns cooperatively is not four
 *     nodes competing for a CPU, and starvation bugs only exist in the second case.
 *
 * So each node here is a separate process, addressed over stdin/stdout. Every byte
 * between two nodes then crosses a real socket, because there is no other way for it to
 * get there.
 *
 * THIS IS NOT A DEVICE PROOF, AND THE DISTINCTION MATTERS
 * -------------------------------------------------------
 * Separate processes on one host remove the shared heap. They do NOT add address
 * translation, a mobile scheduler, a radio, or a JS engine that is not V8. Run this agent
 * on a second machine (`SPAWN_peer_A='ssh box2 node /opt/gate/peer-agent.mjs'`) and you
 * add a real NIC and a real NAT; that is host-to-host, and it is a strictly stronger
 * claim than loopback. It is still not the Android app. Say which one you ran.
 *
 * PROTOCOL
 * --------
 * Newline-delimited JSON frames prefixed `#MPG#`, request/response by `id`. Everything
 * else printed on stdout is log noise and is forwarded verbatim by the gate. See
 * `lib/wire.mjs` for why the channel is a byte pipe rather than `fork()` IPC.
 *
 * Run it by hand to see the surface:
 *   echo '#MPG# {"id":1,"op":"ping"}' | node peer-agent.mjs
 */
import { createFrameReader, encodeFrame } from './lib/wire.mjs';
import {
  buildNode, generateKeyPair, strandConfig,
  PARTY_ID, STRAND_ID, GATE_TABLE,
} from './lib/topology.mjs';

let state = {
  node: null,
  storage: null,
  strandId: STRAND_ID,
  name: process.env.AGENT_NAME ?? 'agent',
};

const send = (obj) => process.stdout.write(encodeFrame(obj));
const log = (...a) => console.error(`[agent:${state.name}]`, ...a);

/** The node, or a throw naming what the caller forgot. */
function requireNode() {
  if (!state.node) throw new Error('agent has no node — call `start` first');
  return state.node;
}

function strandDb() {
  return requireNode().getStrand(state.strandId)?.database?.getDatabase() ?? null;
}

const ops = {
  ping: async () => ({ pong: true, pid: process.pid, node: process.version }),

  /**
   * Build and start the node. `role` is 'drone' or 'peer'; the difference is entirely in
   * `lib/topology.mjs`, shared with the in-process gate so the two cannot drift.
   */
  start: async ({ role, bootstrapNodes = [], relayAddrs = [], clusterSize = 2, partyId = PARTY_ID, strandId = STRAND_ID, name, direct = false }) => {
    if (state.node) throw new Error('already started');
    if (name) state.name = name;
    state.strandId = strandId;
    const privateKey = await generateKeyPair('Ed25519');
    const built = buildNode(role, { bootstrapNodes, relayAddrs, clusterSize, partyId, privateKey, direct });
    state.node = built.node;
    state.storage = built.storage;
    await state.node.start();
    log(`up pid=${process.pid} peerId=${state.node.peerId?.toString()}`);
    return { peerId: state.node.peerId.toString(), addrs: await ops.addrs() };
  },

  addrs: async () => requireNode().getControlNode().getMultiaddrs().map((m) => m.toString()),

  /** Control-plane connection count, and who they are — L1's raw material. */
  connections: async () => {
    const cn = requireNode().getControlNode();
    const conns = cn.getConnections();
    return { count: conns.length, peers: [...new Set(conns.map((c) => c.remotePeer.toString()))] };
  },

  /**
   * Every `/p2p-circuit` address this node holds FOR `peerId`, from its own peer store —
   * the same source `connect()` consults. Empty is not an error: it means this node
   * cannot dial that peer at all.
   */
  circuitAddrsFor: async ({ peerId }) => {
    const cn = requireNode().getControlNode();
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peer = await cn.peerStore.get(peerIdFromString(peerId));
      return (peer?.addresses ?? [])
        .map((a) => a.multiaddr?.toString())
        .filter((a) => a && a.includes('/p2p-circuit'));
    } catch {
      return [];
    }
  },

  /**
   * A REAL dial, not a peer-store lookup. This is the step the device runs actually die
   * on, and no amount of address bookkeeping can stand in for it: an address can be
   * present, well-formed and undialable.
   */
  dial: async ({ peerId }) => {
    const cn = requireNode().getControlNode();
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const started = Date.now();
    try {
      const target = peerIdFromString(peerId);
      // An OPEN connection is returned as-is. Record which of the two this was, or a cache
      // hit reads as a successful dial.
      const reused = cn.getConnections(target).length > 0;
      const conn = await cn.dial(target);
      return { ok: true, reused, ms: Date.now() - started, remoteAddr: conn.remoteAddr?.toString() ?? null };
    } catch (e) {
      return { ok: false, reused: false, ms: Date.now() - started, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
    }
  },

  genesis: async () => {
    const node = requireNode();
    const owner = node.getIdentityOwnerKey();
    await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
    const db = node.getControlDatabase();
    if (!db) throw new Error('no control database after start()');
    await db.ensureOwnerKey(owner.publicKeyB64);
    node.initializeSeedBootstrap(owner.privateKeyB64);
    return { publicKeyB64: owner.publicKeyB64 };
  },

  /**
   * The invite crosses the wire as `encodedInvite`, the same base64url string a real
   * deployment puts in a QR code — not as a decoded object. That is deliberate: it is the
   * out-of-band channel the ceremony is designed around, so the cross-process run
   * exercises the encode/decode path a device run depends on instead of quietly skipping
   * it by passing a live object between two nodes that share a heap.
   */
  createInvite: async () => {
    const { invite, encodedInvite } = await requireNode().createInvite();
    return { encodedInvite, partyId: invite?.partyId ?? null };
  },

  dialInvite: async ({ encodedInvite }) => {
    const node = requireNode();
    await node.dialInvite(node.decodeInvite(encodedInvite));
    return {};
  },

  acceptPhone: async ({ phonePeerId, encodedInvite }) => {
    const node = requireNode();
    await node.acceptPhone({ phonePeerId }, encodedInvite ? node.decodeInvite(encodedInvite) : undefined);
    return {};
  },

  /**
   * `true` / `false` / `'unknown'`. A control-database read can fail outright rather than
   * answer, and that is NOT a membership verdict — conflating the two is what made the
   * enrolment ceremony look broken when it was merely unreadable.
   */
  isAuthorizedMember: async ({ peerId }) => {
    try {
      return { value: await requireNode().isAuthorizedMember(peerId) };
    } catch (e) {
      return { value: 'unknown', error: `${e?.message ?? e}` };
    }
  },

  listAuthorizedMembers: async () => {
    try {
      return { members: await requireNode().listAuthorizedMembers() };
    } catch (e) {
      return { members: [], error: `${e?.message ?? e}` };
    }
  },

  addStrand: async ({ mode }) => {
    await requireNode().addStrand(strandConfig({ strandId: state.strandId, mode }));
    return {};
  },

  /** Cohort this node's strand assembles for `key`, via the path the coordinator uses. */
  cohort: async ({ key }) => {
    const strandNode = requireNode().getStrand(state.strandId)?.libp2pNode;
    if (!strandNode) return { count: 0, ids: [] };
    const peers = await strandNode.keyNetwork.findCluster(new TextEncoder().encode(key));
    const ids = Object.keys(peers ?? {});
    return { count: ids.length, ids };
  },

  exec: async ({ sql }) => {
    const db = strandDb();
    if (!db) throw new Error('no active strand database');
    await db.exec(sql);
    return {};
  },

  /** Rows as plain JSON. A failed read is reported, never thrown — callers poll on it. */
  query: async ({ sql }) => {
    const db = strandDb();
    if (!db) return { rows: null, error: 'no active strand database' };
    try {
      const rows = [];
      for await (const row of db.eval(sql)) rows.push(row);
      return { rows: JSON.parse(JSON.stringify(rows)) };
    } catch (e) {
      return { rows: null, error: `${e?.message ?? e}` };
    }
  },

  /** Which block ids this process's storage layer has actually been asked to persist. */
  heldBlocks: async () => ({ ids: [...(state.storage?.seen ?? [])] }),

  table: async () => ({ table: GATE_TABLE }),

  stop: async () => {
    if (state.node) {
      try { await state.node.stop(); } catch (e) { log(`stop error: ${e?.message ?? e}`); }
      state.node = null;
    }
    return {};
  },

  /** Leave the process, so the gate can assert on an ACTUALLY dead node. */
  exit: async () => {
    await ops.stop();
    setTimeout(() => process.exit(0), 50);
    return {};
  },
};

const feed = createFrameReader({
  onFrame: async ({ id, op, args }) => {
    const handler = ops[op];
    if (!handler) return send({ id, error: `unknown op '${op}'` });
    try {
      send({ id, result: await handler(args ?? {}) });
    } catch (e) {
      send({ id, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`, stack: e?.stack ?? null });
    }
  },
  onNoise: (line) => { if (line.trim()) log(`unparsed input: ${line}`); },
});

process.stdin.on('data', feed);
process.stdin.on('end', async () => { await ops.stop(); process.exit(0); });

// Announce readiness so the gate does not have to guess when stdin is being read.
send({ event: 'ready', pid: process.pid, node: process.version });
