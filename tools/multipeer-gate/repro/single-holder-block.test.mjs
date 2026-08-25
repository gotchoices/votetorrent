/**
 * Optimystic — a singly-held block is permanently unreadable once the cohort reaches 3.
 *
 * Pure `@optimystic/db-p2p`. No cadre-core, no libp2p sockets, no timing: it drives
 * db-p2p's OWN mesh harness (`@optimystic/db-p2p/testing`) and its own CoordinatorRepo.
 *
 *   node --test repro/single-holder-block.test.mjs
 *
 * THE STATE UNDER TEST — a block committed while the cohort was smaller than it is now.
 * Every deployment that grows produces it: whatever was written at cohort size 1 has one
 * holder, and the cohort that later derives for that key has three members.
 *
 * WHAT SHOULD HAPPEN: a cohort member that does not hold the block asks the cohort, one
 * peer answers "rev 1, here it is", the others answer "I hold nothing", and the reader
 * acquires it — one holder becomes two, and the block is now repairable by everyone.
 *
 * WHAT DOES HAPPEN: the read-repair quorum requires CORROBORATION_FLOOR (2) distinct
 * non-self claims. One holder can supply one. `selectQuorumRev` declines, the absence is
 * classified `claimed`, and `get` returns `unavailable: 'claimed-elsewhere'` — on a block
 * that is present, healthy, uncontested and singly held.
 *
 * WHY IT NEVER HEALS: the two paths that could create the second holder — read-repair
 * acquisition here and `createReconcileBlock` — are gated by that same floor. The floor
 * assumes two holders; only those paths can produce the second one.
 *
 * ARM 2 is the control. Identical code, identical cohort, TWO holders instead of one: it
 * passes. So the variable is holder count, not the harness, the mock or the routing.
 *
 * Expected on @optimystic/db-p2p 0.24.2:
 *   arm 1  FAIL   unavailable: 'claimed-elsewhere'   <- the defect
 *   arm 2  pass                                       <- control
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMesh } from '@optimystic/db-p2p/testing';

const BLOCK_ID = 'singly-held-block';
const COHORT = 3;

const block = () => ({
  header: { id: BLOCK_ID, type: 'TestBlock', collectionId: 'test-collection' },
  entries: [{ k: 'written-before-the-cohort-grew' }],
});

/**
 * A cohort of `COHORT` nodes in which exactly `holders` of them hold BLOCK_ID, and a
 * reader that holds nothing. `saveReplicatedBlock` is how db-p2p's own reconcile path
 * lands a replica, so the stored state is the state a real commit leaves behind.
 */
async function readFromNonHolder(holders) {
  const mesh = await createMesh(COHORT, { responsibilityK: COHORT, clusterSize: COHORT });
  for (let i = 0; i < holders; i++) {
    await mesh.nodes[i].storageRepo.saveReplicatedBlock(BLOCK_ID, block(), { actionId: 'a1', rev: 1 });
  }
  const reader = mesh.nodes[COHORT - 1];   // never a holder: holders < COHORT in both arms
  const result = await reader.coordinatorRepo.get({ blockIds: [BLOCK_ID] });
  return result[BLOCK_ID] ?? {};
}

test('a block with ONE holder is readable by another cohort member', async () => {
  const entry = await readFromNonHolder(1);
  assert.equal(
    entry.unavailable, undefined,
    `a present, uncontested, singly-held block was reported unavailable: '${entry.unavailable}'. ` +
    'One holder cannot supply the two corroborators read-repair demands, and no other path ' +
    'can create the second holder — so this block is unreadable by this node permanently.'
  );
  assert.ok(entry.block, 'the reader should have acquired the block from its sole holder');
});

test('control — the SAME block with TWO holders is readable', async () => {
  const entry = await readFromNonHolder(2);
  assert.equal(entry.unavailable, undefined, `two holders should corroborate, got '${entry.unavailable}'`);
  assert.ok(entry.block, 'the reader should have acquired the block');
});
