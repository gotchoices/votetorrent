/**
 * handles.mjs — the one shape every leg is written against.
 *
 * Two implementations:
 *
 *   inProcessHandle(node, storage)  the node lives in this process, as it always has
 *   agentHandle(client)             the node lives in its OWN process, reached over a pipe
 *
 * A leg cannot tell them apart. That is deliberate and it is the whole experiment: the
 * identical assertions run over a shared heap and over a socket, and where the two
 * disagree is precisely the coverage an in-process gate never had. A leg that passes
 * in-process and fails cross-process has not found a flaky test; it has found something
 * the shared heap was supplying for free.
 */
import { STRAND_ID } from './topology.mjs';

/** A node built and started inside THIS process. */
export function inProcessHandle(name, node, storage, { strandId = STRAND_ID } = {}) {
  const control = () => node.getControlNode();
  const strandDb = () => node.getStrand(strandId)?.database?.getDatabase() ?? null;

  return {
    name,
    kind: 'inproc',
    node,                              // escape hatch for legs that predate this interface
    peerId: () => node.peerId.toString(),

    addrs: async () => control().getMultiaddrs().map((m) => m.toString()),

    connections: async () => {
      const conns = control().getConnections();
      return { count: conns.length, peers: [...new Set(conns.map((c) => c.remotePeer.toString()))] };
    },

    circuitAddrsFor: async (peerId) => {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const peer = await control().peerStore.get(peerIdFromString(peerId));
        return (peer?.addresses ?? [])
          .map((a) => a.multiaddr?.toString())
          .filter((a) => a && a.includes('/p2p-circuit'));
      } catch {
        return [];
      }
    },

    dial: async (peerId) => {
      const started = Date.now();
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const target = peerIdFromString(peerId);
        // libp2p hands back an OPEN connection rather than opening a new one. A leg that
        // does not record which of the two it got would report a cache hit as a dial.
        const reused = control().getConnections(target).length > 0;
        const conn = await control().dial(target);
        return { ok: true, reused, ms: Date.now() - started, remoteAddr: conn.remoteAddr?.toString() ?? null };
      } catch (e) {
        return { ok: false, reused: false, ms: Date.now() - started, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
      }
    },

    genesis: async () => {
      const owner = node.getIdentityOwnerKey();
      await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
      const db = node.getControlDatabase();
      if (!db) throw new Error('no control database after start()');
      await db.ensureOwnerKey(owner.publicKeyB64);
      node.initializeSeedBootstrap(owner.privateKeyB64);
      return { publicKeyB64: owner.publicKeyB64 };
    },

    createInvite: async () => {
      const { encodedInvite } = await node.createInvite();
      return { encodedInvite };
    },
    dialInvite: async (encodedInvite) => { await node.dialInvite(node.decodeInvite(encodedInvite)); },
    acceptPhone: async (phonePeerId, encodedInvite) => {
      await node.acceptPhone({ phonePeerId }, encodedInvite ? node.decodeInvite(encodedInvite) : undefined);
    },

    isAuthorizedMember: async (peerId) => {
      try { return { value: await node.isAuthorizedMember(peerId) }; }
      catch (e) { return { value: 'unknown', error: `${e?.message ?? e}` }; }
    },
    listAuthorizedMembers: async () => {
      try { return { members: await node.listAuthorizedMembers() }; }
      catch (e) { return { members: [], error: `${e?.message ?? e}` }; }
    },

    addStrand: async (config) => { await node.addStrand(config); },

    cohort: async (key) => {
      const strandNode = node.getStrand(strandId)?.libp2pNode;
      if (!strandNode) return { count: 0, ids: [] };
      const peers = await strandNode.keyNetwork.findCluster(new TextEncoder().encode(key));
      const ids = Object.keys(peers ?? {});
      return { count: ids.length, ids };
    },

    exec: async (sql) => {
      const db = strandDb();
      if (!db) throw new Error('no active strand database');
      await db.exec(sql);
    },

    query: async (sql) => {
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

    heldBlocks: async () => [...(storage?.seen ?? [])],

    stop: async () => { await node.stop(); },

    /**
     * In-process there is no process to kill, so `kill` can only be `stop`. Say so rather
     * than pretending: the durability leg means something weaker here, and it reports that.
     */
    kill: async () => { await node.stop(); },
  };
}

/** A node running in its own process (local child, or remote over the spawn override). */
export function agentHandle(name, client) {
  let cachedPeerId = null;
  return {
    name,
    kind: 'process',
    client,
    get remote() { return Boolean(client.spec?.remote); },
    setPeerId: (id) => { cachedPeerId = id; },
    peerId: () => cachedPeerId,

    addrs: () => client.call('addrs'),
    connections: () => client.call('connections'),
    circuitAddrsFor: (peerId) => client.call('circuitAddrsFor', { peerId }),
    dial: (peerId) => client.call('dial', { peerId }),
    genesis: () => client.call('genesis'),
    createInvite: () => client.call('createInvite'),
    dialInvite: (encodedInvite) => client.call('dialInvite', { encodedInvite }),
    acceptPhone: (phonePeerId, encodedInvite) => client.call('acceptPhone', { phonePeerId, encodedInvite }),
    isAuthorizedMember: (peerId) => client.call('isAuthorizedMember', { peerId }),
    listAuthorizedMembers: () => client.call('listAuthorizedMembers'),
    addStrand: (config) => client.call('addStrand', { mode: config.mode }),
    cohort: (key) => client.call('cohort', { key }),
    exec: (sql) => client.call('exec', { sql }),
    query: (sql) => client.call('query', { sql }),
    heldBlocks: async () => (await client.call('heldBlocks')).ids,
    stop: () => client.call('stop'),
    kill: () => client.kill(),
  };
}
