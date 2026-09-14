/**
 * Optimystic — the certified-claim escape hatch, in arithmetic alone.
 *
 *   node --test repro/corroboration-floor.test.mjs
 *
 * Companion to `single-holder-block.test.mjs`, which exercises the same rules end-to-end.
 * This one removes every moving part — no mesh, no storage, no routing, no crypto — and calls
 * db-p2p's own `selectQuorumRev` / `selectQuorumBlock` directly with hand-built evidence.
 *
 * ── HISTORY ────────────────────────────────────────────────────────────────────────────────
 * This file was written to reproduce "a block with one holder can never gain a second": a sole
 * holder supplies one claim, `CORROBORATION_FLOOR` demands two, `selectQuorumRev` declines, and
 * the reader gets `unavailable: 'claimed-elsewhere'` for a block that is present and uncontested.
 * Because both repair routes that could mint a second holder are gated by that same floor, the
 * state was absorbing — and it is the state every deployment's founding write lands in.
 *
 * Its original arms asserted that an UNCERTIFIED sole claim must be adopted once the cohort view
 * reaches three. That was one hypothesis about the fix, and it was the wrong one: adopting an
 * unproven sole claim means restoring state on one peer's unbacked word, which is the safety
 * property the floor exists to hold. Upstream took the sound route instead — make the founding
 * write CARRY A PROOF, so the sole holder is not asking to be believed:
 *
 *   0.25.x  `cluster/certified-claims.ts` — a claim whose cohort commit proof the caller verified
 *           is marked `certified`, and a certified claim short-circuits the distinct-peer rule.
 *   0.27.0  `buildBlockCommitProof` gains a second call site on `CoordinatorRepo.commit`'s solo
 *           short-circuit, which self-signs a one-peer proof. The founding write — the one block
 *           guaranteed to be singly held — finally carries what the hatch needs.
 *
 * ── WHAT THIS FILE IS NOW ──────────────────────────────────────────────────────────────────
 * The regression gate for that mechanism, and it is GREEN on 0.27.0. It is deliberately built so
 * that neither direction of drift can pass:
 *
 *   - weaken the floor (adopt an uncertified sole claim) → `the floor still binds…` arms go RED
 *   - lose the hatch (stop honouring certified claims)   → `a certified sole claim…` arms go RED
 *   - lose the signer weighing (treat a self-signed solo receipt as cohort agreement)
 *                                                        → the single-signer arms go RED
 *
 * Every expectation below was read off 0.27.0's behaviour, not inferred from its docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `cluster/quorum-restore.js` is internal — not in the package's `exports` map — so it is
// loaded by path. Inside the Optimystic repo this is simply `../src/cluster/quorum-restore.js`.
const entry = import.meta.resolve('@optimystic/db-p2p');   // file://…/dist/src/index.js
const modUrl = entry.replace(/index\.js$/, 'cluster/quorum-restore.js');
const {
  selectQuorumRev, selectQuorumBlock, quorumSize, corroboratorCapacity,
  CORROBORATION_FLOOR, certifiedEquivocation, certifiedContentEquivocation,
} = await import(modUrl);

const SIMPLE_MAJORITY = 0.51;                 // db-p2p's shipped default
const REPAIR_CLUSTER_SIZE = 2;                // clusterPolicy.assumedClusterSize — the smallest real deployment

/** The sole holder's claim, in whatever certification state the arm is testing. */
const sole = (extra = {}) => [{ peerId: 'the-one-holder', rev: 1, actionId: 'a1', ...extra }];

/** A verified one-peer proof, as `certifyClaim` reports it: `{ certified: true, signerCount: 1 }`. */
const SOLO_RECEIPT = { certified: true, certifiedSignerCount: 1 };
/** A verified cohort proof — several distinct signers, the weight a real consensus commit carries. */
const COHORT_PROOF = { certified: true, certifiedSignerCount: 3 };

/** Two distinct peers agreeing on one (rev, actionId): ordinary corroboration. */
const corroborated = (rev, actionId) => [
  { peerId: 'x', rev, actionId },
  { peerId: 'y', rev, actionId },
];

test('CORROBORATION_FLOOR is 2 — two distinct non-self claims', () => {
  assert.equal(CORROBORATION_FLOOR, 2);
});

// ── the floor itself, unchanged and load-bearing ────────────────────────────────────────────
// These are the arms this file originally asserted the OPPOSITE of. An uncertified sole claim
// is one peer's unbacked word about a revision; a cohort that could supply a second voter must
// require one. If any of these ever selects, restoration can be steered by a single peer.

for (const nonSelfCohortMembers of [2, 3, 8]) {
  test(`the floor still binds — one UNCERTIFIED holder, cohort view of ${nonSelfCohortMembers + 1}, is declined`, () => {
    const capacity = corroboratorCapacity(nonSelfCohortMembers, REPAIR_CLUSTER_SIZE);
    assert.ok(capacity >= CORROBORATION_FLOOR, 'this cohort can supply the floor, so it must be required');
    assert.equal(
      selectQuorumRev(sole(), SIMPLE_MAJORITY, capacity), undefined,
      'an uncertified sole claim was SELECTED. One peer\'s unbacked word must never drive ' +
      'restoration in a cohort that can supply a second voter — that is what the floor is for. ' +
      'The lone-holder deadlock is fixed by proving the claim (see the certified arms below), ' +
      'never by lowering this bar.'
    );
  });
}

test('the floor is relaxed only for a cohort that genuinely cannot supply it', () => {
  // One other peer, measured against a deployment that declares itself two nodes: nobody else
  // exists to second the claim, so requiring a second makes divergence permanent, not safe.
  const capacity = corroboratorCapacity(1, REPAIR_CLUSTER_SIZE);
  assert.equal(capacity, 1, 'a genuinely two-node deployment has exactly one possible corroborator');
  assert.equal(quorumSize(1, SIMPLE_MAJORITY, capacity), 1);
  assert.ok(
    selectQuorumRev(sole(), SIMPLE_MAJORITY, capacity),
    'the relaxed branch for a genuinely tiny cohort has been lost'
  );
});

// ── the escape hatch: a proven sole claim IS adopted ────────────────────────────────────────
// This is the fix. `certified` is the caller's verdict after verifying the claim's cohort commit
// proof (`certifyClaim`), and it stands in for the second voter — the proof's signature set IS
// the corroboration. A block whose founding commit self-signed a one-peer proof therefore reads
// back from a lone holder at any cohort size.

for (const nonSelfCohortMembers of [1, 2, 3, 8]) {
  test(`a CERTIFIED sole claim is adopted — cohort view of ${nonSelfCohortMembers + 1}`, () => {
    const capacity = corroboratorCapacity(nonSelfCohortMembers, REPAIR_CLUSTER_SIZE);
    const selected = selectQuorumRev(sole(SOLO_RECEIPT), SIMPLE_MAJORITY, capacity);
    assert.ok(
      selected,
      'a sole holder carrying a VERIFIED one-peer commit proof was declined. This is the founding ' +
      'write of every deployment — committed while the cohort was one member, so singly held ' +
      'forever unless the proof rescues it. Without this branch the lone-holder deadlock returns.'
    );
    assert.equal(selected.certified, true, 'callers log which rule won; the certified path must say so');
    assert.deepEqual(selected.supporters, ['the-one-holder']);
  });
}

test('certification is the CALLER\'s verdict — an attached proof alone certifies nothing', () => {
  // Selection never reads `proof`: a peer chooses what to attach, so presence proves nothing.
  // Only `certified`, set after verification, counts. Inferring one from the other would let any
  // peer mint adoption by attaching bytes.
  const capacity = corroboratorCapacity(3, REPAIR_CLUSTER_SIZE);
  assert.equal(
    selectQuorumRev(sole({ proof: { v: 1, peerIds: ['the-one-holder'] } }), SIMPLE_MAJORITY, capacity),
    undefined,
    'an UNVERIFIED attached proof was treated as certification'
  );
});

// ── how a certified claim is weighed against ordinary corroboration ─────────────────────────
// The hatch is not a trump card. A self-signed solo receipt is one machine's honest word about
// its own commit; it must not outrank a cohort that stayed together.

const WIDE = corroboratorCapacity(8, 10);

test('corroboration at a HIGHER rev beats a certified claim', () => {
  // Corroboration stays a legitimate weaker path, so an uncertified tail written after the last
  // proven rev remains readable rather than being shadowed by old proven state.
  const selected = selectQuorumRev(
    [...sole(SOLO_RECEIPT), ...corroborated(2, 'a2')], SIMPLE_MAJORITY, WIDE
  );
  assert.equal(selected?.rev, 2);
  assert.equal(selected?.certified, undefined, 'the corroborated pair won, so this is not a certified selection');
});

test('a MULTI-SIGNER certified claim outranks equal-rev corroboration', () => {
  const selected = selectQuorumRev(
    [...sole(COHORT_PROOF), ...corroborated(1, 'a2')], SIMPLE_MAJORITY, WIDE
  );
  assert.equal(selected?.actionId, 'a1', 'a whole cohort\'s signatures over the commit outweigh two peers\' votes');
  assert.equal(selected?.certified, true);
});

test('a SINGLE-SIGNER certified claim does NOT outrank equal-rev corroboration', () => {
  // The conservative half of the weighing, and the one most likely to be lost by a refactor that
  // treats every certified claim alike: one machine that was briefly alone must not overrule the
  // cohort that stayed together at the same revision.
  const selected = selectQuorumRev(
    [...sole(SOLO_RECEIPT), ...corroborated(1, 'a2')], SIMPLE_MAJORITY, WIDE
  );
  assert.equal(selected?.actionId, 'a2', 'a self-signed solo receipt overruled two distinct peers at the same rev');
  assert.equal(selected?.certified, undefined);
});

test('corroboration AGREEING with a solo receipt is convergence, not a contest', () => {
  const selected = selectQuorumRev(
    [...sole(SOLO_RECEIPT), ...corroborated(1, 'a1')], SIMPLE_MAJORITY, WIDE
  );
  assert.equal(selected?.actionId, 'a1');
  assert.equal(selected?.certified, true, 'the certified verdict should survive peers that agree with it');
});

test('certified equivocation declines, and is reported apart from a plain no-quorum', () => {
  // Two verified proofs for two different actions at one revision: the same keys provably signed
  // both sides. An operator has to be able to tell this from "not enough peers answered".
  const claims = [
    { peerId: 'h', rev: 1, actionId: 'a1', ...COHORT_PROOF },
    { peerId: 'g', rev: 1, actionId: 'a2', ...COHORT_PROOF },
  ];
  assert.equal(selectQuorumRev(claims, SIMPLE_MAJORITY, WIDE), undefined, 'equivocation must decline, not pick a side');
  assert.deepEqual(certifiedEquivocation(claims), { rev: 1, actionIds: ['a1', 'a2'] });
});

// ── the content side: the same rules decide WHICH BYTES are restored ────────────────────────
// A selected (rev, actionId) is useless if no block content clears its own quorum, so the hatch
// has to reach `selectQuorumBlock` too — otherwise the lone holder's revision is adopted and its
// bytes are still refused.

const candidate = (peerId, hash, extra = {}) => ({
  peerId, hash, block: { header: { id: 'b', type: 'T', collectionId: 'c' }, entries: [{ hash }] }, ...extra,
});

test('a sole UNCERTIFIED carrier\'s bytes are declined', () => {
  assert.equal(selectQuorumBlock([candidate('h', 'H1')], SIMPLE_MAJORITY, WIDE), undefined);
});

test('a sole CERTIFIED carrier\'s bytes are restored', () => {
  const selected = selectQuorumBlock([candidate('h', 'H1', SOLO_RECEIPT)], SIMPLE_MAJORITY, WIDE);
  assert.ok(selected, 'the proof\'s declared digest matched these bytes, so the cohort vouched for them');
  assert.equal(selected.hash, 'H1');
});

test('contending certified hashes decline, and are reported', () => {
  const candidates = [candidate('h', 'H1', SOLO_RECEIPT), candidate('g', 'H2', SOLO_RECEIPT)];
  assert.equal(selectQuorumBlock(candidates, SIMPLE_MAJORITY, WIDE), undefined);
  assert.deepEqual(certifiedContentEquivocation(candidates), { hashes: ['H1', 'H2'] });
});
