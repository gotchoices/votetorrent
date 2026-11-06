/**
 * packages/p2p-probe-host/commit-durability-probe.mjs -- does a real cadre-core node report a write
 * that no other member holds? (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort)
 *
 *   cd packages/p2p-probe-host && node commit-durability-probe.mjs
 *
 * One founder CadreNode, alone (no bootstrap peers), founds a strand with a one-table schema and
 * inserts a row. Expected: the insert SUCCEEDS (it always did -- that is the bug class), and the
 * CadreNode emits `strand:commit-durability` for it with `heldElsewhere: false`, which the app's
 * CommitDurabilityTracker (vote-engine) turns into "saved on this phone, not shared yet".
 *
 * Checks, all against the real node:
 *   1. the insert resolves;
 *   2. at least one `strand:commit-durability` arrives while the insert runs (the tracker's
 *      attribution window), reported synchronously before the statement returns;
 *   3. every one of those reports says `heldElsewhere: false`;
 *   4. vote-engine's CommitDurabilityTracker, attached to this node, reads the action 'waiting'
 *      and counts >= 1 unshared commit.
 *
 * Exit 0 on PASS, 1 on FAIL. Dev tooling, never shipped.
 */
import { CadreNode } from '@serfab/cadre-core';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { webSockets } from '@libp2p/websockets';
// Relative import of the built, import-free tracker: p2p-probe-host does not depend on vote-engine.
// Build first: yarn workspace @votetorrent/vote-engine build
import { CommitDurabilityTracker } from '../vote-engine/dist/durability/commit-durability-tracker.js';

const L = (...a) => console.log('[commit-durability-probe]', ...a);
const STRAND_ID = `durability-probe-${Date.now()}`;
const SCHEMA = 'table Probe (Id text primary key, V text);';
const WRITABLE_TIMEOUT_MS = 60_000;

let node;
let exitCode = 1;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); L(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`); };

try {
  node = new CadreNode({
    privateKey: await generateKeyPair('Ed25519'),
    controlNetwork: { partyId: 'durability-probe', bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    network: { transports: [webSockets()], listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'] },
    strandClusterSize: 2,
    hibernation: { enabled: false },
  });
  await node.start();

  const tracker = new CommitDurabilityTracker();
  tracker.attach(node);
  const reports = [];
  node.on('strand:commit-durability', (e) => { if (e.strandId === STRAND_ID) reports.push(e); });

  await node.addStrand({
    strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
    sAppConfig: { id: 'org.votetorrent.durability-probe', version: '1.0.0', schema: SCHEMA, latencyHint: 'interactive' },
    mode: 'bootstrap',
    founder: true,
  });

  const deadline = Date.now() + WRITABLE_TIMEOUT_MS;
  let strandDb;
  while (Date.now() < deadline) {
    strandDb = node.getStrand(STRAND_ID)?.database;
    if (strandDb) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!strandDb) throw new Error(`strand ${STRAND_ID} never became writable`);
  const db = strandDb.getDatabase();

  const before = reports.length;
  let inserted = false;
  let duringWindow = 0;
  await tracker.track('probe:insert', async () => {
    await db.exec("insert into App.Probe (Id, V) values ('r1', 'hello')");
    inserted = true;
    duringWindow = reports.length - before;
  });
  const mine = reports.slice(before);
  L('reports for the insert:', JSON.stringify(mine.map((e) => ({ tx: e.transactionId, heldElsewhere: e.heldElsewhere, followed: e.followed }))));

  check('1. the insert on a solo node resolves (the write "succeeds")', inserted);
  check('2. a strand:commit-durability report arrives before the insert returns', duringWindow >= 1, `reports in window=${duringWindow}`);
  check('3. every report for it says heldElsewhere=false', mine.length >= 1 && mine.every((e) => e.heldElsewhere === false));
  check("4. the tracker reads the action 'waiting' and counts it", tracker.actionState('probe:insert') === 'waiting' && tracker.unsharedCount >= 1,
    `state=${tracker.actionState('probe:insert')} unshared=${tracker.unsharedCount} unfollowed=${tracker.unfollowedCount}`);
  tracker.detach();

  exitCode = checks.every((c) => c.ok) ? 0 : 1;
  L(exitCode === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
} catch (err) {
  L('VERDICT: FAIL (threw)', err?.stack ?? err);
  exitCode = 1;
} finally {
  try { await node?.stop(); } catch { /* ignore */ }
  process.exit(exitCode);
}
