/**
 * selftest.mjs — prove the data legs before trusting their verdict.
 *
 * WHY
 * ---
 * A leg that has only ever been observed RED is not evidence about the system; it is an
 * untested assertion. `D4` is the case that forced this file: on the stack it was written
 * against it failed every time it ran, so nothing distinguished "update and delete do not
 * converge" from "this leg's SQL is wrong". The difference matters enormously and no
 * amount of re-running the gate settles it.
 *
 * So: run the data legs against a SINGLE node, where the writer and the reader are the
 * same database and convergence cannot be the variable. Everything here must be green. A
 * red line is a defect in the harness, and any gate result relying on that leg should be
 * discarded until it is fixed.
 *
 * What this does NOT do is test replication — it deliberately removes it. Passing here
 * says the legs ask their question correctly, not that the system answers it.
 *
 *   node selftest.mjs     # or: npm run selftest
 *
 * Exit 0 when every leg is green.
 */
import { buildNode, generateKeyPair, strandConfig, GATE_TABLE } from './lib/topology.mjs';
import { inProcessHandle } from './lib/handles.mjs';
import { createContext, START_TIMEOUT_MS, withTimeout } from './lib/runner.mjs';
import {
  legReverseReplication, legConvergeAll, legMutationPropagation, legIsolationControl,
} from './lib/db-legs.mjs';

const { node, storage } = buildNode('drone', {
  bootstrapNodes: [],
  relayAddrs: [],
  clusterSize: 2,
  partyId: 'multipeer-gate-selftest',
  privateKey: await generateKeyPair('Ed25519'),
});

let failed = false;
try {
  await withTimeout(node.start(), START_TIMEOUT_MS, 'selftest node start');
  const solo = inProcessHandle('solo', node, storage);
  await solo.genesis();
  await solo.addStrand(strandConfig({ mode: 'bootstrap' }));

  const ctx = createContext({
    tag: 'selftest', kind: 'inproc', table: GATE_TABLE, runId: `selftest-${Date.now().toString(36)}`,
  });
  ctx.L('running the data legs against ONE node — every line below must be green');

  // Writer and reader are the same database, so each leg reduces to "does this leg's own
  // SQL and polling do what it claims?".
  const d1 = await legReverseReplication(ctx, solo, solo);
  const d2 = d1 && await legConvergeAll(ctx, [solo], [`${ctx.runId}-reverse`]);
  const d4 = await legMutationPropagation(ctx, solo, solo);
  // Nothing was written under this id, so a correct control arm reports no leak — and it
  // still has to read back its OWN row first, which is the half that can actually break.
  const d5 = await legIsolationControl(ctx, solo, ['never-written-by-anyone']);

  failed = !(d1 && d2 && d4 && d5);
  ctx.L('');
  ctx.L(failed
    ? 'SELFTEST: FAIL — a data leg is broken as an INSTRUMENT. Gate results that depend on it are void.'
    : 'SELFTEST: PASS — the data legs ask their question correctly. This says nothing about replication.');
} catch (e) {
  console.log('[selftest] FAIL (harness error)', e?.stack ?? e);
  failed = true;
} finally {
  try { await node.stop(); } catch { /* already down */ }
  process.exit(failed ? 1 : 0);
}
