/**
 * `@serfab/cadre-core`: a restarted party member commits its own `CadrePeer` row ALONE.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/control-self-publish-alone.test.mjs
 *
 * The device bug (VoteTorrent debug `officer-address-record-content-digest-mismatch`,
 * 2026-10-23/26): the party control collection `CadreControl.CadrePeer` forked between two
 * Authorities. One of them restarted. Its 1 s boot timer (`scheduleSelfRegistration` ->
 * `publishSelfRecordUnlessCurrent` -> `registerSelf` -> `publishSelfRecord`, UPDATE path) and
 * then its heartbeat committed the self-record while its only connection was a relay, on a
 * base the sibling had already moved past. Both sides then sat at the SAME revision with
 * different content, and db-p2p's promise-round digest check rejected every later write of
 * either side (`content-digest-mismatch`) for good.
 *
 * cadre-core 1.18.0's identify-based `hasReachableControlSibling()` (sereus ticket 7.31) gates
 * `publishFirstSelfRecord`, `committedAlone()` and the reap gate. It does NOT gate
 * `publishSelfRecord` itself, so the boot timer, the heartbeat and `self:peer:update` still
 * commit an UPDATE of the own row on a cohort of one; `noteSelfPeerWritten` only queues a
 * re-touch for the growth edge, and at an equal revision that re-touch is the rejected write.
 *
 * Scenario: A (owner) and B (member, enrolled by invitation) form a party. B stops. While B is
 * down, A commits two owner writes to `CadrePeer` (two `authorizePeer` rows). B restarts on the
 * same identity and storage, with A unreachable (B's own connection gater refuses A; nothing
 * else is reachable). Assertions:
 *   1. While `hasReachableControlSibling()` is false, B commits NO update of its own row: not
 *      from the boot timer, and not from an explicit `registerSelf()` (the heartbeat's call).
 *   2. Once B reaches A, B's row converges: both replicas hold the same record for B, and B's
 *      replica holds A's two rows (B adopted A's lineage instead of forking it).
 * Stock 1.18.0 FAILS (1); a fix that skips the solo update and lets the growth-edge drain
 * publish it passes both.
 *
 * Hygiene: loopback-only listen addresses, in-memory storage, ephemeral identities, no
 * bootstrap beyond the two nodes, every node stopped in a `finally`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CadreNode,
  MemoryTrustedOwnerStore,
  ed25519KeyPairFromLibp2p,
  softwareOwnerSigner,
} from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

const PARTY_ID = `repro-self-publish-alone-${randomUUID()}`;
const STEP_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Per-scope memory stores that outlive one CadreNode instance, so a restart reopens them. */
function persistentMemoryProvider() {
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

function buildNode({ privateKey, provider, trustedOwnerStore, bootstrapNodes, connectionGater }) {
  return new CadreNode({
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider },
    trustedOwners: { store: trustedOwnerStore },
    hibernation: { enabled: false },
    profile: 'transaction',
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
      ...(connectionGater ? { connectionGater } : {}),
    },
  });
}

const loopbackWs = (node) => node.getControlNode().getMultiaddrs().map(String)
  .find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws'));

async function stopQuietly(node) {
  try { await node?.stop(); } catch { /* best effort */ }
}

test('a restarted member does not commit its own CadrePeer row while no control sibling is reachable', { timeout: 300_000 }, async () => {
  const keyA = await generateKeyPair('Ed25519');
  const keyB = await generateKeyPair('Ed25519');
  const peerA = peerIdFromPrivateKey(keyA).toString();
  const peerB = peerIdFromPrivateKey(keyB).toString();
  const providerB = persistentMemoryProvider();
  const trustedB = new MemoryTrustedOwnerStore(PARTY_ID);
  const t0 = Date.now();
  const phase = (what) => console.log(`[repro +${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

  // B's own connection gater: while `isolated`, A can neither be dialed nor dial in.
  let isolated = false;
  const isA = (peerId) => peerId?.toString() === peerA;
  const gaterB = {
    denyDialPeer: async (peerId) => isolated && isA(peerId),
    denyInboundEncryptedConnection: async (peerId) => isolated && isA(peerId),
    denyOutboundEncryptedConnection: async (peerId) => isolated && isA(peerId),
  };

  let nodeA;
  let nodeB;
  try {
    // ── Party: A owns, B joins by a targeted invitation ─────────────────────────────────────
    nodeA = buildNode({ privateKey: keyA, provider: persistentMemoryProvider(), trustedOwnerStore: new MemoryTrustedOwnerStore(PARTY_ID), bootstrapNodes: [] });
    await nodeA.start();
    const owner = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
    await nodeA.useOwnerSigner(softwareOwnerSigner(owner.privateKeyB64));
    await nodeA.getControlDatabase().ensureOwnerKey(owner.publicKeyB64, 'repro');
    await nodeA.registerSelf();
    phase('A started and owns the party');

    nodeB = buildNode({ privateKey: keyB, provider: providerB, trustedOwnerStore: trustedB, bootstrapNodes: [loopbackWs(nodeA)], connectionGater: gaterB });
    await nodeB.start();
    const { invitation } = await nodeA.createCadreInvitation({ peerId: peerB });
    await nodeB.redeemCadreInvitation(invitation);
    phase('B redeemed its invitation');
    await waitFor('A to list B as a member', () => nodeA.isAuthorizedMember(peerB));
    await waitFor('B to reach A as a control sibling', () => nodeB.hasReachableControlSibling());
    // Settle: B's own row is in place in both replicas.
    await waitFor('B row on both replicas', async () => {
      const onA = await nodeA.getControlDatabase().queryPeerRecord(peerB);
      const onB = await nodeB.getControlDatabase().queryPeerRecord(peerB);
      return onA?.sig != null && onA.sig === onB?.sig;
    });
    await sleep(3_000);
    phase('party settled: B row on both replicas');
    const before = await nodeB.getControlDatabase().queryPeerRecord(peerB);
    assert.ok(before, 'B holds its own row before the restart');

    // ── B down; A commits twice to CadrePeer ─────────────────────────────────────────────────
    await nodeB.stop();
    nodeB = null;
    await waitFor('A to see B gone', () => !nodeA.hasReachableControlSibling());
    phase('B stopped; A sees no sibling');
    const extraA = [];
    for (let i = 0; i < 2; i++) {
      const extra = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
      await nodeA.authorizePeer(extra);
      extraA.push(extra);
    }
    phase('A committed two CadrePeer writes while B was down');

    // ── B restarts isolated from A ───────────────────────────────────────────────────────────
    isolated = true;
    nodeB = buildNode({ privateKey: keyB, provider: providerB, trustedOwnerStore: trustedB, bootstrapNodes: [loopbackWs(nodeA)], connectionGater: gaterB });
    await nodeB.start();
    // Count every commit of B's own row while no sibling is reachable. Wrapped right after start()
    // returns; the boot publish is a 1 s timer, so it runs through the wrapper.
    const db = nodeB.getControlDatabase();
    const update = db.updateSelfPeerRecord.bind(db);
    const soloCommits = [];
    db.updateSelfPeerRecord = async (...args) => {
      const reachable = nodeB.hasReachableControlSibling();
      const record = await update(...args);
      if (record !== null && !reachable) soloCommits.push(record.updatedAt);
      return record;
    };
    phase('B restarted, isolated from A');
    await sleep(5_000); // the 1 s boot timer, plus its reconcile trigger
    assert.equal(nodeB.hasReachableControlSibling(), false, 'precondition: B is isolated from A');
    const heartbeat = await nodeB.registerSelf(); // what the 7.5 min heartbeat calls
    const after = await nodeB.getControlDatabase().queryPeerRecord(peerB);
    phase(`isolated: solo own-row commits=${soloCommits.length}, registerSelf()=${heartbeat}, row updatedAt ${before.updatedAt} -> ${after?.updatedAt}`);

    assert.deepEqual(soloCommits, [], `B committed its own CadrePeer row ${soloCommits.length} time(s) while no control sibling was reachable (a fork on a stale base)`);
    assert.notEqual(heartbeat, 'refreshed', 'registerSelf() (the heartbeat path) refreshed the own row while alone');
    assert.equal(after?.updatedAt, before.updatedAt, 'B\'s own row changed locally while alone');

    // ── B reaches A: the row is published once, on A's lineage ──────────────────────────────
    isolated = false;
    await nodeB.getControlNode().dial(multiaddr(loopbackWs(nodeA)));
    await waitFor('B to reach A again', () => nodeB.hasReachableControlSibling());
    phase('B reaches A again');
    await waitFor('B row converged on both replicas, newer than before the restart, with A\'s writes adopted', async () => {
      const onA = await nodeA.getControlDatabase().queryPeerRecord(peerB);
      const onB = await nodeB.getControlDatabase().queryPeerRecord(peerB);
      if (!onA || !onB || onA.sig !== onB.sig || onA.updatedAt !== onB.updatedAt) return false;
      if (onB.updatedAt <= before.updatedAt) return false;
      const rowsOnB = new Set((await nodeB.getControlDatabase().queryCadrePeers()).map((r) => r.peerId));
      return extraA.every((p) => rowsOnB.has(p));
    }, 120_000, 1_000);
    phase('converged: B row identical on both replicas, A\'s writes adopted on B');
  } finally {
    await stopQuietly(nodeB);
    await stopQuietly(nodeA);
  }
});
