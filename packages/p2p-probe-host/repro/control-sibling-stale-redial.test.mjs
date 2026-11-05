/**
 * `@serfab/cadre-core`: a control sibling whose address record went stale is never re-dialed
 * through the party relay.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/control-sibling-stale-redial.test.mjs
 *
 * The device bug (VoteTorrent debug `officer-address-record-content-digest-mismatch`, lock b):
 * on a party where every Authority is relay-circuit-only, the control link between two members
 * dropped and outlived the signed `CadrePeer` record's freshness window (15 min). In stock
 * 1.18.0 the reconcile pass then takes this path: `dialControlSibling` ->
 * `resolveControlDialAddrs` tries (1) the fresh signed record, (2) the libp2p address book and
 * (3) the sibling's retained out-of-band dial target. The inviter keeps no retained target for
 * the redeemer, the stale record is rejected, and the address book aged out. All three are
 * empty, so the pass logs "no dialable control address for sibling ...; skipping" and returns
 * `undialable`. `undialable` takes the sibling OFF the redial ladder, so nothing ever dials it
 * again until a cold boot, and the control collection stays forked.
 *
 * Scenario (an in-process relay, two relay-only Authority-shaped nodes): A (owner, the
 * inviter) and B (member, the redeemer) settle, then the A<->B link is cut and the cut is made
 * permanent from B's side (B never dials A; B refuses A's inbound until the release). A's view
 * of B is degraded the way the device's was: no address-book entry, no retained target, and
 *   - `stale-record`: B's record is rejected by the REAL freshness gate (A's `resolvePeerAddrs`
 *     forwards `maxAgeMs: 1` for B), or
 *   - `no-dialable-address`: B's record is present but resolves to no address (the device's
 *     0-address boot publish).
 * Assertions: A re-dials B through `<relayAddr>/p2p-circuit/p2p/<B>` (built from
 * `network.relayAddrs`) within 120 s of the release, never records `undialable` for B after the
 * release, and (stale-record) a failed circuit dial leaves the sibling on the ladder
 * (`reconcileRedialStreak >= 1`).
 * Stock 1.18.0 FAILS both tests. A fix that adds the party's configured relays as a fourth
 * dial source passes.
 *
 * Hygiene: loopback-only, in-memory storage, ephemeral identities, a random party id, every
 * node stopped in a `finally`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CadreNode,
  MemoryTrustedOwnerStore,
  ed25519KeyPairFromLibp2p,
  softwareOwnerSigner,
} from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';

const PARTY_ID = `repro-stale-redial-${randomUUID()}`;
const STEP_MS = 60_000;
const REDIAL_BOUND_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mode line: which bytes are under test (positive control that the repo's patched copy is used).
const cadreDir = dirname(fileURLToPath(import.meta.resolve('@serfab/cadre-core')));
const cadreNodeSrc = readFileSync(join(cadreDir, 'cadre-node.js'), 'utf8');
const cadreVersion = JSON.parse(readFileSync(join(cadreDir, '..', 'package.json'), 'utf8')).version;
const guardMarker = cadreNodeSrc.includes('VoteTorrent patch (control-fork guard');
const redialMarker = cadreNodeSrc.includes('VoteTorrent patch (stale-sibling relay redial)');
console.log(`[repro] cadreCore=${cadreVersion} guardMarker=${guardMarker} redialMarker=${redialMarker}`);
assert.equal(guardMarker, true, 'this repo\'s patched @serfab/cadre-core (control-fork guard) must be the bytes under test, never stock');

async function waitFor(label, predicate, timeoutMs = STEP_MS, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label} (last: ${last instanceof Error ? last.message : String(last)})`);
    }
    await sleep(everyMs);
  }
}

async function stopQuietly(node) {
  try { await node?.stop(); } catch { /* best effort */ }
}

async function startRelay() {
  const node = new CadreNode({
    privateKey: await generateKeyPair('Ed25519'),
    controlNetwork: { partyId: `${PARTY_ID}-relay`, bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: scopedMemoryProvider() },
    hibernation: { enabled: false },
    network: { transports: [webSockets(), circuitRelayTransport()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
  });
  await node.start();
  const relayAddr = node.getControlNode().getMultiaddrs().map(String)
    .find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws') && a.includes('/p2p/'));
  assert.ok(relayAddr, 'the relay node reports a loopback /ws/p2p/ address');
  return { node, relayAddr };
}

function scopedMemoryProvider() {
  const scopes = new Map();
  return (scope) => {
    let store = scopes.get(scope);
    if (!store) {
      store = new MemoryRawStorage();
      scopes.set(scope, store);
    }
    return store;
  };
}

/** Authority-shaped: relay-circuit-only, a gater whose peer-level denials read per-test flags. */
async function startAuthorityShaped({ privateKey, relayAddr, gater }) {
  const node = new CadreNode({
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [relayAddr] },
    profile: 'transaction',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: scopedMemoryProvider() },
    trustedOwners: { store: new MemoryTrustedOwnerStore(PARTY_ID) },
    hibernation: { enabled: false },
    network: {
      transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
      relayAddrs: [relayAddr],
      connectionGater: { denyDialMultiaddr: async () => false, ...gater },
    },
  });
  await node.start();
  await waitFor('a /p2p-circuit multiaddr', () => node.getControlNode().getMultiaddrs().map(String).some((a) => a.includes('/p2p-circuit')), 30_000, 500);
  return node;
}

const connectionsTo = (node, peerId) => node.getControlNode().getConnections().filter((c) => c.remotePeer.toString() === peerId);

async function scenario(name, installView) {
  const relay = await startRelay();
  const { relayAddr } = relay;
  const relayPeer = relayAddr.split('/p2p/').pop();
  const keyA = await generateKeyPair('Ed25519');
  const keyB = await generateKeyPair('Ed25519');
  const peerA = peerIdFromPrivateKey(keyA).toString();
  const peerB = peerIdFromPrivateKey(keyB).toString();
  const t0 = Date.now();
  const phase = (what) => console.log(`[repro ${name} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

  const flags = { aRefusesB: false, bRefusesA: false, bNeverDialsA: false };
  const gaterA = {
    denyDialPeer: async (p) => flags.aRefusesB && p?.toString() === peerB,
    denyInboundEncryptedConnection: async (p) => flags.aRefusesB && p?.toString() === peerB,
    denyOutboundEncryptedConnection: async (p) => flags.aRefusesB && p?.toString() === peerB,
  };
  const gaterB = {
    denyDialPeer: async (p) => flags.bNeverDialsA && p?.toString() === peerA,
    denyInboundEncryptedConnection: async (p) => flags.bRefusesA && p?.toString() === peerA,
    denyOutboundEncryptedConnection: async (p) => flags.bNeverDialsA && p?.toString() === peerA,
  };

  let nodeA;
  let nodeB;
  try {
    nodeA = await startAuthorityShaped({ privateKey: keyA, relayAddr, gater: gaterA });
    const owner = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
    await nodeA.useOwnerSigner(softwareOwnerSigner(owner.privateKeyB64));
    await nodeA.getControlDatabase().ensureOwnerKey(owner.publicKeyB64, 'repro');
    await nodeA.registerSelf();
    nodeB = await startAuthorityShaped({ privateKey: keyB, relayAddr, gater: gaterB });
    const { invitation } = await nodeA.createCadreInvitation({ peerId: peerB });
    await nodeB.redeemCadreInvitation(invitation);
    await waitFor('A to list B as a member', () => nodeA.isAuthorizedMember(peerB));
    await waitFor('A and B to be control siblings of each other', () => nodeA.hasReachableControlSibling() && nodeB.hasReachableControlSibling());
    await waitFor('B row on both replicas', async () => {
      const onA = await nodeA.getControlDatabase().queryPeerRecord(peerB);
      const onB = await nodeB.getControlDatabase().queryPeerRecord(peerB);
      return onA?.sig != null && onA.sig === onB?.sig;
    });
    await sleep(3_000);
    phase('party settled over the relay');

    // B never dials A from here on (the reverse direction cannot heal the link).
    flags.bNeverDialsA = true;

    // No retained dial target for B on A (the inviter keeps none for the redeemer; read it back).
    const retained = nodeA.retainedDialAddrs(peerB).length;
    if (retained > 0) await nodeA.bootstrapPeerStore.forget(peerB);
    assert.equal(nodeA.retainedDialAddrs(peerB).length, 0, 'precondition: A holds no retained dial target for B');
    phase(`retained dial target for B on A: ${retained} -> 0`);

    // A's degraded view of B.
    await installView(nodeA, peerB);

    // Cut the A<->B link, from both sides.
    flags.aRefusesB = true;
    flags.bRefusesA = true;
    await nodeA.getControlNode().hangUp(peerIdFromString(peerB)).catch(() => {});
    await nodeB.getControlNode().hangUp(peerIdFromString(peerA)).catch(() => {});
    await waitFor('no A<->B connection and no reachable sibling on A', () => connectionsTo(nodeA, peerB).length === 0 && connectionsTo(nodeB, peerA).length === 0 && !nodeA.hasReachableControlSibling());
    await nodeA.getControlNode().peerStore.delete(peerIdFromString(peerB)).catch(() => {});
    assert.deepEqual(await nodeA.peerStoreAddrs(peerB), [], 'precondition: A\'s address book holds nothing for B');
    phase('A<->B cut; A\'s address book empty for B');

    const outcomes = [];
    const dial = nodeA.dialControlSibling.bind(nodeA);
    nodeA.dialControlSibling = async (sibling, resolved) => {
      const outcome = await dial(sibling, resolved);
      outcomes.push({ peer: sibling.peerId, outcome, at: Date.now() });
      return outcome;
    };
    const outcomesFor = (since) => outcomes.filter((o) => o.peer === peerB && o.at >= since).map((o) => o.outcome);

    // Release.
    flags.bRefusesA = false;
    const tRelease = Date.now();
    if (name === 'stale-record') {
      // A's gater still refuses B: the first circuit dial must FAIL (and stay on the ladder), not be dropped.
      await nodeA.reconcileControlCohort();
      const mine = outcomesFor(tRelease);
      assert.equal(mine.at(-1), 'failed', `the first pass's outcome for B must be 'failed' (a circuit dial that was refused), got: ${mine.join(',') || '(none)'}`);
      assert.ok(nodeA.reconcileRedialStreak >= 1, `a failed dial keeps B on the redial ladder (streak >= 1), got ${nodeA.reconcileRedialStreak}`);
      flags.aRefusesB = false;
    } else {
      flags.aRefusesB = false;
      await nodeA.reconcileControlCohort();
    }
    phase('released');

    await waitFor('A to reach B through the relay circuit', () => connectionsTo(nodeA, peerB).some((c) => {
      const remote = c.remoteAddr.toString();
      return remote.includes('/p2p-circuit') && remote.includes(relayPeer);
    }) && nodeA.hasReachableControlSibling(), Math.max(1, REDIAL_BOUND_MS - (Date.now() - tRelease)), 500);
    const redialMs = Date.now() - tRelease;
    const seen = outcomesFor(tRelease);
    assert.ok(!seen.includes('undialable'), `B must never be dropped as 'undialable' after the release, got: ${seen.join(',')}`);
    assert.ok(redialMs <= REDIAL_BOUND_MS, `redial took ${redialMs} ms (bound ${REDIAL_BOUND_MS})`);
    console.log(`[repro] REDIAL test=${name} sibling=${peerB.slice(-8)} via=circuit redialMs=${redialMs} outcomes=${seen.join(',')}`);
  } finally {
    await stopQuietly(nodeB);
    await stopQuietly(nodeA);
    await stopQuietly(relay.node);
  }
}

test('stale-record: a sibling whose CadrePeer record is stale is re-dialed through the party relay circuit', { timeout: 300_000 }, async () => {
  await scenario('stale-record', async (nodeA, peerB) => {
    const resolve = nodeA.resolvePeerAddrs.bind(nodeA);
    nodeA.resolvePeerAddrs = (id, opts = {}) => resolve(id, id === peerB ? { ...opts, maxAgeMs: 1 } : opts);
    assert.deepEqual(await nodeA.resolvePeerAddrs(peerB), [], 'precondition: B\'s record is stale in A\'s view');
    assert.ok(await nodeA.getControlDatabase().queryPeerRecord(peerB), 'precondition: B\'s record is still present');
  });
});

test('no-dialable-address: a sibling whose record holds no address is re-dialed through the party relay circuit', { timeout: 300_000 }, async () => {
  await scenario('no-dialable-address', async (nodeA, peerB) => {
    const resolve = nodeA.resolvePeerAddrs.bind(nodeA);
    nodeA.resolvePeerAddrs = (id, opts = {}) => (id === peerB ? Promise.resolve([]) : resolve(id, opts));
    assert.deepEqual(await nodeA.resolvePeerAddrs(peerB), [], 'precondition: B\'s record resolves to no address');
    assert.ok(await nodeA.getControlDatabase().queryPeerRecord(peerB), 'precondition: B\'s record is present');
  });
});
