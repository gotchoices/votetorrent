/**
 * probe-holders.mjs — which cohort members actually HOLD the block the
 * read path demands two corroborators for?
 *
 * Brings up the same n=4 topology as multipeer-gate.mjs, runs owner genesis
 * and one enrolment attempt, then reports, per node:
 *   - the block ids its local storage holds
 *   - its findCluster cohort for `default/CadrePeer/index/_uniq_5`
 *
 * RELAYS=1 (passing) vs RELAYS=2 (failing) is the A/B.
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';

const PARTY_ID = 'probe-holders';
const RELAYS = Number(process.env.RELAYS ?? 2);
const DRONES = Number(process.env.DRONES ?? 2);
const PEERS = Number(process.env.PEERS ?? 2);
const L = (...a) => console.log('[probe]', ...a);

/** Records every block id this node's storage is ever asked to persist. */
class TrackingStorage extends MemoryRawStorage {
  constructor() { super(); this.seen = new Set(); }
  async saveMetadata(id, m) { this.seen.add(id); return super.saveMetadata(id, m); }
  async saveRevision(id, r, a) { this.seen.add(id); return super.saveRevision(id, r, a); }
  async saveMaterializedBlock(id, a, b) { this.seen.add(id); return super.saveMaterializedBlock(id, a, b); }
}

const stores = new Map();   // name -> TrackingStorage
const nodes = [];

function base(bootstrapNodes, key, name) {
  return {
    privateKey: key,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: () => { const s = new TrackingStorage(); stores.set(name, s); return s; } },
    strandClusterSize: 2,
    hibernation: { enabled: false },
  };
}

const ctlAddrs = (n) => n.getControlNode().getMultiaddrs().map(m => m.toString());
const loopback = (a) => a.find(x => x.includes('/ip4/127.0.0.1/') && x.includes('/ws')) ?? a[0];

async function drone(name, boots) {
  const n = new CadreNode({
    ...base(boots, await generateKeyPair('Ed25519'), name),
    profile: 'storage',
    network: { transports: [webSockets()], listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'],
      relayServerInit: { reservations: { maxReservations: 32, defaultDurationLimit: 600000, defaultDataLimit: BigInt(1 << 20) }, maxInboundHopStreams: 64, maxOutboundStopStreams: 64 } },
  });
  await n.start(); nodes.push({ name, node: n, profile: 'storage' });
  L(`${name} up ${n.peerId} [storage]`); return n;
}

async function peer(name, relays, boots) {
  const n = new CadreNode({
    ...base(boots, await generateKeyPair('Ed25519'), name),
    profile: 'transaction',
    // cadre-core 0.12.0: relays live in `network.relayAddrs`, not `listenAddrs` — the old
    // shape is rejected on a control node (it dials the relay during the bring-up quiet
    // period). `listenAddrs` stays unset so this peer keeps no direct listener.
    network: { transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: Math.max(1, relays.length) })],
      relayAddrs: relays },
  });
  await n.start(); nodes.push({ name, node: n, profile: 'transaction' });
  L(`${name} up ${n.peerId} [transaction, ${relays.length} relay(s)]`); return n;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  L(`DRONES=${DRONES} PEERS=${PEERS} RELAYS=${RELAYS}`);
  const a = await drone('drone-A', []);
  const genesis = async (when) => {
    const owner = a.getIdentityOwnerKey();
    await a.trustOwnerKeys([owner.publicKeyB64], 'operator');
    await a.getControlDatabase().ensureOwnerKey(owner.publicKeyB64);
    a.initializeSeedBootstrap(owner.privateKeyB64);
    L(`owner genesis done (${when})`);
  };
  const GENESIS_AT = Number(process.env.GENESIS_AT ?? 1);
  if (GENESIS_AT <= 1) await genesis('founder solo, cohort=1');

  const aAddr = loopback(ctlAddrs(a));
  const droneAddrs = [aAddr];
  for (let i = 1; i < DRONES; i++) {
    const boots = process.env.MESH === '1' ? [...droneAddrs] : [aAddr];
    const d = await drone(`drone-${String.fromCharCode(65 + i)}`, boots);
    droneAddrs.push(loopback(ctlAddrs(d)));
    if (GENESIS_AT === i + 1) { await sleep(5000); await genesis(`cohort=${i + 1}`); }
  }
  const relays = droneAddrs.slice(0, Math.max(1, Math.min(RELAYS, droneAddrs.length)));
  for (let i = 0; i < PEERS; i++) await peer(`peer-${String.fromCharCode(65 + i)}`, relays, [aAddr]);

  await sleep(8000);


  L('--- enrolment: one attempt per joiner ---');
  for (const { name, node } of nodes.slice(1)) {
    try {
      const { invite } = await a.createInvite();
      await node.dialInvite(invite);
      const ok = await a.isAuthorizedMember(node.peerId.toString());
      L(`${name}: dialInvite ok, authorized=${ok}`);
    } catch (e) { L(`${name}: enrolment threw: ${e?.message ?? e}`); }
  }

  const HOLD = Number(process.env.HOLD_MS ?? 3000);
  if (HOLD > 3000) {
    L(`--- holding ${HOLD}ms, re-reading CadrePeer every 10s to test for self-repair ---`);
    const t0 = Date.now();
    while (Date.now() - t0 < HOLD) {
      await sleep(10000);
      for (const { name, node } of nodes.slice(1)) {
        let verdict;
        try { verdict = await a.isAuthorizedMember(node.peerId.toString()) ? 'read-ok' : 'read-ok'; } catch {}
        try {
          const db = node.getControlDatabase();
          let n = 0;
          for await (const _ of db.getDatabase().eval('select 1 from CadreControl.CadrePeer limit 1;')) n++;
          verdict = `read-ok(rows>=${n})`;
        } catch (e) { verdict = `FAIL: ${(e?.message ?? e).toString().slice(0, 80)}`; }
        L(`  t+${Math.round((Date.now() - t0) / 1000)}s ${name}: ${verdict}`);
      }
    }
  } else await sleep(3000);

  const KEY = 'default/CadrePeer/index/_uniq_5';
  L('');
  L(`--- who HOLDS ${KEY}? ---`);
  const idByName = Object.fromEntries(nodes.map(n => [n.node.peerId.toString().slice(0, 12), n.name]));
  for (const { name, node, profile } of nodes) {
    const s = stores.get(name);
    const held = s ? [...s.seen] : [];
    const has = held.includes(KEY);
    const meta = s ? await s.getMetadata(KEY).catch(() => undefined) : undefined;
    L(`${name.padEnd(8)} profile=${profile.padEnd(11)} holds=${String(has).padEnd(5)} rev=${meta?.latest?.rev ?? '-'} blocksHeld=${held.length}`);
  }

  L('');
  L(`--- cohort each node derives for ${KEY} ---`);
  for (const { name, node } of nodes) {
    try {
      const kn = node.getControlNode().keyNetwork;
      const peers = await kn.findCluster(new TextEncoder().encode(KEY));
      const ids = Object.keys(peers).map(i => idByName[i.slice(0, 12)] ?? i.slice(0, 8));
      L(`${name.padEnd(8)} cohort(${ids.length}) = ${ids.sort().join(', ')}`);
    } catch (e) { L(`${name}: findCluster threw ${e?.message ?? e}`); }
  }
} catch (e) {
  L('probe error:', e?.message ?? e);
  let c = e?.cause, d = 0;
  while (c && d++ < 6) { L(`  cause[${d}]: ${c?.code ?? ''} ${c?.message ?? c}`); c = c.cause; }
} finally {
  for (const { node } of nodes.reverse()) { try { await node.stop(); } catch {} }
  process.exit(0);
}
