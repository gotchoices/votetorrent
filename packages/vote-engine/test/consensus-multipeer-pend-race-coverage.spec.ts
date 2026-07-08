/**
 * consensus-multipeer-pend-race-coverage.spec.ts
 *
 * P2P-11/38-16 regression lock — `ClusterMember.handleConsensus`'s `'pend' in
 * operation` branch recognizes an idempotent-self-MISSING shape (this exact
 * action's OWN already-committed revision landing in `result.missing`, under
 * a LIVE multi-peer cohort redelivering the identical pend-phase message —
 * see `38-16-CONSENSUS-RACE-DIAGNOSIS.md` §2/§3) instead of unconditionally
 * throwing the mislabeled "Consensus pend failed ...: stale revision" that
 * hung the drone-side consensus round at revision 50 in the 38-15 n=4
 * device capture (305 occurrences on ONE action ID).
 *
 * The 38-10 fix (`isIdempotentSelfPend`) only relaxed the throw when
 * `result.missing` was EMPTY — any non-empty `result.missing` fell straight
 * through to the throw regardless of whose action populated it. This spec
 * locks the 38-16 extension: a `result.missing` populated ENTIRELY by this
 * action's own actionId is now ALSO recognized as idempotent-self, while a
 * `result.missing` entry for a DIFFERENT actionId (a genuine multi-writer
 * conflict) still throws, unchanged.
 *
 * Five invariants, parsed from the vendored dist source (the source of truth
 * for what actually ships), all anchored to `handleConsensus()`'s own method
 * body so a comment elsewhere in the file (or in this spec) cannot
 * self-satisfy the assertion (the 38-07/38-09/38-10 spec-authoring lesson):
 *
 *   1. The 38-16 missing-side idempotent-self recognition
 *      (`isIdempotentSelfMissing`) is present INSIDE `handleConsensus`,
 *      requiring EVERY `result.missing` entry's actionId to match the
 *      operation's own actionId — not merely referenced in a comment.
 *   2. The relaxation condition combines BOTH the 38-10 pending-side check
 *      and the 38-16 missing-side check (additive — neither replaces the
 *      other).
 *   3. The 38-10 `isIdempotentSelfPend` recognition and its `result.pending`
 *      self-match condition are both still present, unmodified.
 *   4. The 38-04 `validatePendOperations` staleness try/catch defer
 *      (defer-on-"Failed to find materialized block") is still present,
 *      unchanged.
 *   5. The genuine-conflict `Consensus pend failed for action` throw remains
 *      present (a foreign-action missing/pending entry still rejects,
 *      T-38-16-01) and `superMajorityThreshold`/`clusterSize` occurrence
 *      counts are unchanged (D-07 single-file transplant scope discipline).
 *
 * Mirrors consensus-pend-race-coverage.spec.ts's "read a file with fs,
 * regex/index-assert on its text, anchored to the method body" shape.
 * Static source-text assertions only — this is a lockfile/source-tree
 * guard, not a runtime-behaviour guard (on-device confirmation of an actual
 * REPLICATION VERDICT: PASS is 38-17's scope, per this plan's <verification>).
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('consensus-multipeer-pend-race-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const CLUSTER_REPO_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'cluster', 'cluster-repo.js'
)

// Build markers via concatenation so this spec's own explanatory text above
// cannot accidentally satisfy its own assertions (mirrors the
// consensus-pend-race-coverage.spec.ts / 38-10 static-lock-authoring lesson).
const HANDLE_CONSENSUS_SIGNATURE = 'async handleConsensus' + '(record) {'
const NEXT_METHOD_SIGNATURE = 'async handleRejection' + '(_record) {'
const IDEMPOTENT_SELF_PEND_MARKER = 'isIdempotentSelfPend'
const IDEMPOTENT_SELF_MISSING_MARKER = 'isIdempotentSelfMissing'
const MISSING_ACTION_ID_MATCH_MARKER = 'm.actionId === operation.pend.actionId'
const PENDING_ACTION_ID_MATCH_MARKER = 'p.actionId === operation.pend.actionId'
const COMBINED_CONDITION_MARKER = 'isIdempotentSelfPend' + ' || ' + 'isIdempotentSelfMissing'
const RESULT_MISSING_MARKER = 'result.missing'
const RESULT_PENDING_MARKER = 'result.pending'
const CONSENSUS_PEND_FAILED_THROW = 'Consensus pend failed for action'
const VALIDATE_PEND_SIGNATURE = 'async validatePendOperations' + '(record) {'
const STALENESS_DEFER_MARKER = 'staleness-check-unavailable'
const MATERIALIZE_MSG_MARKER = 'Failed to find materialized block'
const EXECUTED_TX_CHECK_MARKER = 'this.executedTransactions.has(record.messageHash)'
const SUPER_MAJORITY_MARKER = 'superMajorityThreshold'
const CLUSTER_SIZE_MARKER = 'clusterSize'

/** Extract the exact body of `handleConsensus()` — from its signature up to
 * (not including) the next method's signature — so all assertions are
 * scoped to this one method, not the whole file. */
function extractHandleConsensusBody (src: string): string {
  const start = src.indexOf(HANDLE_CONSENSUS_SIGNATURE)
  expect(start, `Expected to find the handleConsensus() method signature in ${CLUSTER_REPO_PATH}`).to.be.greaterThan(-1)
  const end = src.indexOf(NEXT_METHOD_SIGNATURE, start)
  expect(end, 'Expected to find the next method signature (handleRejection) after handleConsensus()').to.be.greaterThan(start)
  return src.slice(start, end)
}

describe('P2P-11/38-16: idempotent-self-MISSING recognition in handleConsensus (multi-peer concurrent-pend race fix)', () => {
  it('cluster-repo.js exists at the expected vendored-dist path', () => {
    expect(existsSync(CLUSTER_REPO_PATH), `Expected ${CLUSTER_REPO_PATH} to exist`).to.equal(true)
  })

  it('handleConsensus recognizes a result.missing set populated ENTIRELY by this action\'s own actionId as idempotent-self, anchored inside the method body', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)

    expect(
      body.includes(IDEMPOTENT_SELF_MISSING_MARKER),
      'Expected handleConsensus() to contain the 38-16 idempotent-self-missing recognition ' +
      '(isIdempotentSelfMissing) — the fix must be anchored inside the method body, not merely ' +
      'referenced in a comment elsewhere in the file'
    ).to.equal(true)
    expect(
      body.includes(MISSING_ACTION_ID_MATCH_MARKER),
      'Expected handleConsensus() to require EVERY result.missing entry\'s actionId to match ' +
      'the operation\'s own actionId before treating a missing-side pend failure as an ' +
      'idempotent self-retry — a missing entry belonging to a DIFFERENT action must still be ' +
      'treated as a real conflict (T-38-16-01)'
    ).to.equal(true)
  })

  it('the relaxation condition combines the 38-10 pending-side check and the 38-16 missing-side check (additive)', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)

    expect(
      body.includes(COMBINED_CONDITION_MARKER),
      'Expected handleConsensus() to relax the pend-fail throw when EITHER the 38-10 ' +
      'pending-side idempotent-self shape OR the 38-16 missing-side idempotent-self shape is ' +
      'present (isIdempotentSelfPend || isIdempotentSelfMissing) — additive, not a replacement ' +
      'of the 38-10 fix'
    ).to.equal(true)
  })

  it('the 38-10 isIdempotentSelfPend recognition (pending-side) is still present, unmodified', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)

    expect(
      body.includes(IDEMPOTENT_SELF_PEND_MARKER),
      'Expected the 38-10 isIdempotentSelfPend recognition to remain present inside ' +
      'handleConsensus() — the 38-16 fix is additive, not a replacement'
    ).to.equal(true)
    expect(
      body.includes(PENDING_ACTION_ID_MATCH_MARKER),
      'Expected the 38-10 result.pending self-match condition (p.actionId === ' +
      'operation.pend.actionId) to remain present, unmodified'
    ).to.equal(true)
    expect(
      body.includes(RESULT_MISSING_MARKER),
      'Expected handleConsensus() to still reference result.missing'
    ).to.equal(true)
    expect(
      body.includes(RESULT_PENDING_MARKER),
      'Expected handleConsensus() to still reference result.pending'
    ).to.equal(true)
    expect(
      body.includes(CONSENSUS_PEND_FAILED_THROW),
      'Expected the original "Consensus pend failed for action ..." throw to remain present ' +
      'for the genuine-conflict case (safety preserved, T-38-16-01)'
    ).to.equal(true)
  })

  it('the 38-04 validatePendOperations staleness try/catch defer is still present, unchanged', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const validateStart = src.indexOf(VALIDATE_PEND_SIGNATURE)
    expect(validateStart, 'Expected to find the validatePendOperations() method signature').to.be.greaterThan(-1)

    const staleDeferIdx = src.indexOf(STALENESS_DEFER_MARKER, validateStart)
    const materializeMsgIdx = src.indexOf(MATERIALIZE_MSG_MARKER, validateStart)
    expect(
      staleDeferIdx,
      'Expected the 38-04 staleness-check-unavailable defer log to still be present inside ' +
      'validatePendOperations() — this 38-16 plan must NOT disturb the 38-04 defer'
    ).to.be.greaterThan(validateStart)
    expect(
      materializeMsgIdx,
      'Expected the "Failed to find materialized block" message-class comment/reference to ' +
      'still be present inside validatePendOperations() (38-04, unchanged by 38-16)'
    ).to.be.greaterThan(validateStart)
  })

  it('the executedTransactions atomic check-then-act guard is still present', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)
    expect(
      body.includes(EXECUTED_TX_CHECK_MARKER),
      'Expected handleConsensus() to still open with the synchronous ' +
      'executedTransactions.has(record.messageHash) check-then-act guard (prevents duplicate ' +
      'execution across concurrent handleConsensus calls) — 38-16 must not disturb this atomic guard'
    ).to.equal(true)
  })

  it('superMajorityThreshold and clusterSize occurrence counts are unchanged in cluster-repo.js by the 38-16 edit (D-07 scope discipline)', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    // Both markers legitimately pre-exist in this file (superMajorityThreshold is a
    // pre-existing class field; clusterSize is not a cluster-repo.js concept at all).
    // The regression this guards against is a Task-2 edit widening scope to touch
    // cluster-sizing/threshold config, which the plan explicitly forbids.
    const superMajorityOccurrences = src.split(SUPER_MAJORITY_MARKER).length - 1
    const clusterSizeOccurrences = src.split(CLUSTER_SIZE_MARKER).length - 1
    expect(
      superMajorityOccurrences,
      'Expected superMajorityThreshold occurrence count to match the pre-38-16 baseline (4: ' +
      'field decl, constructor assignment reads it twice on one line, getTransactionPhase read) ' +
      '— any change here means the 38-16 edit touched consensus-threshold config out of scope'
    ).to.equal(4)
    expect(
      clusterSizeOccurrences,
      'Expected zero clusterSize references in cluster-repo.js — this is not a ' +
      'cluster-repo.js concept; its presence would mean the 38-16 edit touched out-of-scope config'
    ).to.equal(0)
  })
})
