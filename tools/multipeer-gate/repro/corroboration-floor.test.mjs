/**
 * Optimystic — the corroboration cliff, in arithmetic alone.
 *
 *   node --test repro/corroboration-floor.test.mjs
 *
 * Companion to `single-holder-block.test.mjs`, which shows the same cliff end-to-end.
 * This one removes every moving part — no mesh, no storage, no routing — and calls
 * db-p2p's own `selectQuorumRev` directly with a fixed body of evidence:
 *
 *   ONE honest claim from the block's sole holder, and every other cohort member has
 *   affirmatively answered "I hold nothing" (answered, so not silence; no competing
 *   claim, so nothing to outvote).
 *
 * That evidence never changes across the cases below. The only thing that changes is how
 * many members the cohort VIEW happens to contain — and the verdict flips at three.
 *
 * `corroboratorCapacity` exists to relax the floor of two for a cohort that cannot supply
 * two, and it is keyed on cohort size as the proxy for "how many peers could corroborate".
 * Cohort size is the wrong proxy: what bounds corroboration is how many peers HOLD the
 * block. A cohort of nine with one holder is as unable to supply a second claim as a
 * cohort of two, but only the cohort of two gets the relaxation.
 *
 * `resolveClusterPolicy`'s `assumed-cluster-size-unset` warning states the operator-facing
 * model: "a deployment that actually runs fewer than CORROBORATION_FLOOR + 1 machines can
 * never supply the floor ... Larger deployments can ignore this." The rows below are the
 * counter-example — at three machines the floor is satisfiable only if the block already
 * has two holders.
 *
 * Expected on @optimystic/db-p2p 0.24.2: the `nonSelfCohortMembers >= 2` rows FAIL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `cluster/quorum-restore.js` is internal — not in the package's `exports` map — so it is
// loaded by path. Inside the Optimystic repo this is simply `../src/cluster/quorum-restore.js`.
const entry = import.meta.resolve('@optimystic/db-p2p');   // file://…/dist/src/index.js
const modUrl = entry.replace(/index\.js$/, 'cluster/quorum-restore.js');
const { selectQuorumRev, quorumSize, corroboratorCapacity, CORROBORATION_FLOOR } = await import(modUrl);

const SIMPLE_MAJORITY = 0.51;                 // db-p2p's shipped default
const REPAIR_CLUSTER_SIZE = 2;                // clusterPolicy.assumedClusterSize — the smallest real deployment

/** The sole holder's claim. Uncontested: nobody else claims anything. */
const soleHolderClaim = [{ peerId: 'the-one-holder', rev: 1, actionId: 'a1' }];

test('CORROBORATION_FLOOR is 2 — two distinct non-self claims', () => {
  assert.equal(CORROBORATION_FLOOR, 2);
});

for (const nonSelfCohortMembers of [1, 2, 3, 8]) {
  test(`one holder, cohort view of ${nonSelfCohortMembers + 1} — the claim is accepted`, () => {
    const capacity = corroboratorCapacity(nonSelfCohortMembers, REPAIR_CLUSTER_SIZE);
    const required = quorumSize(soleHolderClaim.length, SIMPLE_MAJORITY, capacity);
    const selected = selectQuorumRev(soleHolderClaim, SIMPLE_MAJORITY, capacity);

    assert.ok(
      selected,
      `identical evidence, different verdict: with ${nonSelfCohortMembers} non-self cohort ` +
      `member(s) the capacity is ${capacity}, so ${required} corroborators are required and ` +
      'the sole holder supplies 1. The claim is declined, the absence is classified `claimed`, ' +
      "and the reader gets `unavailable: 'claimed-elsewhere'` for a block that is present and " +
      'uncontested. This same evidence IS accepted at 1 non-self member.'
    );
  });
}
