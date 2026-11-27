/**
 * Optimystic — the founding write is proven at commit, so a lone holder stays readable.
 *
 * Pure `@optimystic/db-p2p`. No cadre-core, no libp2p sockets, no timing: it drives db-p2p's OWN
 * mesh harness (`@optimystic/db-p2p/testing`) and its own CoordinatorRepo.
 *
 *   node --test repro/single-holder-block.test.mjs
 *
 * ── THE STATE UNDER TEST ────────────────────────────────────────────────────────────────────
 * A block committed while the cohort was smaller than it is now. Every deployment that grows
 * produces it, and every deployment starts by producing it: genesis runs while the founder is
 * alone, so the founding blocks have exactly one holder, and the cohort that later derives for
 * those keys has three members. They are also the blocks a joiner must read to participate at all.
 *
 * ── THE DEFECT THIS FILE WAS WRITTEN FOR (0.24.2) ───────────────────────────────────────────
 * Read-repair demanded `CORROBORATION_FLOOR` (2) distinct non-self claims. One holder supplies
 * one, `selectQuorumRev` declined, the absence was classified `claimed`, and `get` returned
 * `unavailable: 'claimed-elsewhere'` on a block that was present, healthy and uncontested. It
 * never healed: both routes that could mint the second holder — read-repair acquisition and
 * `createReconcileBlock` — were gated by the same floor.
 *
 * ── THE FIX, AND WHY THIS FILE CHANGED SHAPE ────────────────────────────────────────────────
 * The obvious fix — adopt the sole claim once the cohort is big enough — was rejected, correctly:
 * it restores state on one peer's unbacked word. Upstream made the founding write PROVE itself
 * instead. 0.25.x added `cluster/certified-claims.ts`, where a claim carrying a verified cohort
 * commit proof short-circuits the distinct-peer rule; 0.27.0 added the missing producer — a
 * `buildBlockCommitProof` call site on `CoordinatorRepo.commit`'s solo short-circuit, which
 * self-signs a one-peer proof where consensus never ran.
 *
 * So the variable was never really holder count. It was whether the block carries a proof, and
 * before 0.27.0 the one block guaranteed to be singly held was the one block that had none.
 *
 * ── WHAT THIS FILE IS NOW ───────────────────────────────────────────────────────────────────
 * The end-to-end regression gate for that mechanism, GREEN on 0.27.0, arranged so drift in either
 * direction is caught:
 *
 *   arm 1  the solo commit RETAINS a proof            <- the producer 0.27.0 added
 *   arm 2  control: a 3-member commit proofs everyone <- the machinery, unchanged since 0.25.x
 *   arm 3  the founding block reads back from a lone holder in a grown cohort  <- the symptom, closed
 *   arm 4  control: the same block with two holders reads back
 *   arm 5  NEGATIVE control: the same block WITHOUT its proof is still declined
 *
 * Arm 5 is what keeps the rest honest. Arms 1–4 would also go green if someone simply lowered the
 * corroboration floor, which would be a security regression wearing a passing test as a disguise.
 * Arm 5 fails in that world: it is the original 0.24.2 reproduction, and it must keep reproducing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import { Diary } from '@optimystic/db-core';

const COLLECTION = 'genesis';
const GROWN_COHORT = 3;

/** Commit one record through the REAL cluster path on a mesh of `nodeCount`. */
async function commitOn(nodeCount) {
  const mesh = await createMesh(nodeCount, {
    responsibilityK: nodeCount,
    clusterSize: nodeCount,
    clusterPolicy: { assumedClusterSize: nodeCount },
  });
  const diary = await Diary.createOrOpen(buildNetworkTransactor(mesh), COLLECTION);
  await diary.append({ hello: 'founding-record' });
  return mesh;
}

/**
 * The actionId a proof is only valid FOR. `certifyClaim` rejects `claim-not-in-message` when the
 * claim's actionId does not appear in the proof's signed message, so replicating a block under a
 * synthetic id makes a genuine proof read as an invalid one — a green fix would report as broken.
 * Derive it from the artifact under test rather than naming it.
 */
const UNPROVEN_ACTION_ID = 'genesis-action';

function commitActionId(proof, rev) {
  for (const op of proof?.message?.operations ?? []) {
    const commit = op?.commit;
    if (commit?.rev === rev && commit?.blockIds?.includes(COLLECTION)) return commit.actionId;
  }
  return UNPROVEN_ACTION_ID;
}

/** The block, the proof (if any) and the actionId that proof binds, as `node` retained them. */
async function retained(node) {
  const repo = node.storageRepo;
  const block = (await repo.get({ blockIds: [COLLECTION] }))[COLLECTION]?.block;
  for (const rev of [1, 2, 3]) {
    const proof = await repo.getBlockProof(COLLECTION, rev);
    if (proof) return { block, proof, rev, actionId: commitActionId(proof, rev) };
  }
  return { block, proof: undefined, rev: 1, actionId: UNPROVEN_ACTION_ID };
}

/**
 * Found the collection on a solo cohort, then replicate what the founder retained onto `holders`
 * members of a grown cohort and read it from a member that holds nothing. `saveReplicatedBlock` is
 * how db-p2p's own reconcile path lands a replica, so the stored state is the state a real commit
 * leaves behind — including whether a proof travelled with it.
 *
 * `carryProof: false` strips the proof on the way, reproducing the pre-0.27.0 artifact exactly:
 * same bytes, same rev, same holder count, no proof.
 */
async function foundSoloThenRead({ holders, carryProof = true }) {
  const solo = await commitOn(1);
  const { block, proof, rev, actionId } = await retained(solo.nodes[0]);
  assert.ok(block, 'the founder should hold the block it just committed');

  const grown = await createMesh(GROWN_COHORT, {
    responsibilityK: GROWN_COHORT,
    clusterSize: GROWN_COHORT,
    clusterPolicy: { assumedClusterSize: GROWN_COHORT },
  });
  for (let i = 0; i < holders; i++) {
    await grown.nodes[i].storageRepo.saveReplicatedBlock(
      COLLECTION,
      block,
      carryProof ? { actionId, rev } : { actionId: UNPROVEN_ACTION_ID, rev },
      carryProof ? proof : undefined,
    );
  }

  // A member that was not present at the founding write tries to read it.
  const reader = grown.nodes[GROWN_COHORT - 1];   // never a holder: holders < GROWN_COHORT throughout
  const result = await reader.coordinatorRepo.get({ blockIds: [COLLECTION] });
  return result[COLLECTION] ?? {};
}

test('a SOLO commit retains a commit proof', async () => {
  const mesh = await commitOn(1);
  const { block, proof } = await retained(mesh.nodes[0]);

  assert.ok(block, 'the founder should hold the block it just committed');
  assert.ok(
    proof,
    'the founder committed this block and holds it, but retained NO BlockCommitProof for it. ' +
    'A single-member cohort short-circuits consensus, so no ClusterRecord is formed; without the ' +
    'solo self-signing call site there is nothing to build a proof from. This block now has ' +
    'exactly one holder and no proof — the two conditions that together made it permanently ' +
    'unreadable to every later joiner.'
  );
});

test('control — a 3-member commit proofs every holder', async () => {
  const mesh = await commitOn(3);
  for (const [i, node] of mesh.nodes.entries()) {
    const { block, proof } = await retained(node);
    assert.ok(block, `node ${i} should hold the committed block`);
    assert.ok(proof, `node ${i} holds the block but retained no proof — the machinery should proof every holder`);
  }
});

test('a block founded by a SOLO cohort is readable once the deployment grows', async () => {
  const entry = await foundSoloThenRead({ holders: 1 });
  assert.equal(
    entry.unavailable, undefined,
    `the founding block was reported unavailable: '${entry.unavailable}'. It is present, healthy, ` +
    'uncontested and carrying the one-peer proof its commit self-signed — the certified-claim path ' +
    'should verify that proof and adopt the claim without a second voter.'
  );
  assert.ok(entry.block, 'the reader should have acquired the block from its sole certified holder');
});

test('control — the same block with TWO holders is readable', async () => {
  const entry = await foundSoloThenRead({ holders: 2 });
  assert.equal(entry.unavailable, undefined, `two holders should corroborate, got '${entry.unavailable}'`);
  assert.ok(entry.block, 'the reader should have acquired the block');
});

test('NEGATIVE control — the same block WITHOUT its proof is still declined', async () => {
  // The original 0.24.2 reproduction, kept alive on purpose. Identical bytes, identical rev,
  // identical holder count; the proof is the only thing removed. It must still be refused.
  const entry = await foundSoloThenRead({ holders: 1, carryProof: false });
  assert.equal(
    entry.unavailable, 'claimed-elsewhere',
    'an UNPROVEN singly-held block was adopted. Nothing certified this claim, so restoration just ' +
    'ran on one peer\'s unbacked word — the corroboration floor has been weakened rather than ' +
    'routed around, and the arms above are now passing for the wrong reason.'
  );
  assert.equal(entry.block, undefined, 'nothing should have been restored from an uncertified sole claim');
});
