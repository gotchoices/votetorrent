/**
 * consensus-pend-race-coverage.spec.ts
 *
 * P2P-11/38-10 regression lock — `ClusterMember.handleConsensus`'s `'pend' in
 * operation` branch recognizes an idempotent-self-pend retry (the SAME
 * `actionId` re-delivered against a member that already partially pended it
 * in a prior attempt — see `38-10-CONSENSUS-DIAGNOSIS.md` §2) instead of
 * throwing the mislabeled "Consensus pend failed ...: stale revision" that
 * blocked first-block-creation consensus in the 38-08 n=4 capture (308
 * occurrences).
 *
 * Four invariants, parsed from the vendored dist source (the source of truth
 * for what actually ships), all anchored to `handleConsensus()`'s own method
 * body so a comment elsewhere in the file (or in this spec) cannot
 * self-satisfy the assertion (the 38-07/38-09 spec-authoring lesson):
 *
 *   1. The pend-fail path inside `handleConsensus` distinguishes a genuine
 *      stale revision (`result.missing`) from a self-only pending conflict
 *      (every `result.pending` entry's actionId matches the operation's own
 *      actionId) — the 38-10 fix is present and anchored INSIDE
 *      `handleConsensus`, not merely mentioned in a comment.
 *   2. The 38-04 `validatePendOperations` staleness try/catch defer
 *      (defer-on-"Failed to find materialized block") is still present,
 *      unchanged.
 *   3. The `executedTransactions` atomic check-then-act guard
 *      (`this.executedTransactions.has(record.messageHash)` check followed
 *      by the synchronous `.set(...)` before any `await`) is still present.
 *   4. `superMajorityThreshold` / `clusterSize` are NOT introduced or altered
 *      by this file's edit (D-07 single-file transplant scope discipline).
 *
 * Mirrors drone-materialize-defer-coverage.spec.ts / emu-mesh-dial-address-
 * coverage.spec.ts's "read a file with fs, regex/index-assert on its text,
 * anchored to the method body" shape. Static source-text assertions only —
 * this is a lockfile/source-tree guard, not a runtime-behaviour guard (the
 * on-device confirmation of an actual REPLICATION VERDICT: PASS is 38-11's
 * scope, per this plan's <verification>).
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
  throw new Error('consensus-pend-race-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const CLUSTER_REPO_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'cluster', 'cluster-repo.js'
)

// Build markers via concatenation so this spec's own explanatory text above
// cannot accidentally satisfy its own assertions (mirrors the
// branded-peer-id-coverage.spec.ts / 36-02 static-lock-authoring lesson).
const HANDLE_CONSENSUS_SIGNATURE = 'async handleConsensus' + '(record) {'
const NEXT_METHOD_SIGNATURE = 'async handleRejection' + '(_record) {'
const IDEMPOTENT_SELF_PEND_MARKER = 'isIdempotentSelfPend'
const RESULT_MISSING_MARKER = 'result.missing'
const RESULT_PENDING_MARKER = 'result.pending'
const ACTION_ID_MATCH_MARKER = 'p.actionId === operation.pend.actionId'
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

// SUPERSEDED (Phase 40-02, PUB-01/PUB-02 de-vendoring): this spec locks Phase 38's
// hand-patched `vendor/@optimystic/db-p2p` dist source, which no longer exists now
// that VT consumes it from published npm (@optimystic/db-p2p@0.14.1 does not carry
// this fix upstream). Cross-peer replication (P2P-11) is out of Phase 40's scope and
// was still FAIL as of 38-21 even with this fix live — Phase 41 owns re-diagnosing/
// re-patching against the de-vendored baseline. Skipped rather than deleted to
// preserve the historical static-lock shape for that future re-patch. See
// 40-02-SUMMARY.md.
describe.skip('P2P-11/38-10: idempotent-self-pend recognition in handleConsensus (stale-revision/pend-race fix)', () => {
  it('cluster-repo.js exists at the expected vendored-dist path', () => {
    expect(existsSync(CLUSTER_REPO_PATH), `Expected ${CLUSTER_REPO_PATH} to exist`).to.equal(true)
  })

  it('handleConsensus distinguishes a genuine stale revision (result.missing) from a self-only pending conflict, anchored inside the method body', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)

    expect(
      body.includes(IDEMPOTENT_SELF_PEND_MARKER),
      'Expected handleConsensus() to contain the 38-10 idempotent-self-pend recognition ' +
      '(isIdempotentSelfPend) — the fix must be anchored inside the method body, not merely ' +
      'referenced in a comment elsewhere in the file'
    ).to.equal(true)
    expect(
      body.includes(RESULT_MISSING_MARKER),
      'Expected handleConsensus() to check result.missing (genuine stale revision) before ' +
      'relaxing the pend-fail throw — a real conflicting prior revision must still reject (T-38-10-01)'
    ).to.equal(true)
    expect(
      body.includes(RESULT_PENDING_MARKER),
      'Expected handleConsensus() to inspect result.pending when deciding whether a pend ' +
      'failure is a self-only retry conflict'
    ).to.equal(true)
    expect(
      body.includes(ACTION_ID_MATCH_MARKER),
      'Expected handleConsensus() to require EVERY result.pending entry\'s actionId to match ' +
      'the operation\'s own actionId before treating a pend failure as an idempotent self-retry ' +
      '— a pending entry belonging to a DIFFERENT action must still be treated as a real conflict'
    ).to.equal(true)
    expect(
      body.includes(CONSENSUS_PEND_FAILED_THROW),
      'Expected the original "Consensus pend failed for action ..." throw to remain present ' +
      'for the genuine-conflict case (safety preserved, T-38-10-01)'
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
      'validatePendOperations() — this 38-10 plan must NOT disturb the 38-04 defer'
    ).to.be.greaterThan(validateStart)
    expect(
      materializeMsgIdx,
      'Expected the "Failed to find materialized block" message-class comment/reference to ' +
      'still be present inside validatePendOperations() (38-04, unchanged by 38-10)'
    ).to.be.greaterThan(validateStart)
  })

  it('the executedTransactions atomic check-then-act guard is still present', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    const body = extractHandleConsensusBody(src)
    expect(
      body.includes(EXECUTED_TX_CHECK_MARKER),
      'Expected handleConsensus() to still open with the synchronous ' +
      'executedTransactions.has(record.messageHash) check-then-act guard (prevents duplicate ' +
      'execution across concurrent handleConsensus calls) — 38-10 must not disturb this atomic guard'
    ).to.equal(true)
  })

  it('superMajorityThreshold and clusterSize are NOT introduced or altered in cluster-repo.js by the 38-10 edit', () => {
    const src = readFileSync(CLUSTER_REPO_PATH, 'utf8')
    // Both markers legitimately pre-exist in this file (superMajorityThreshold is a
    // pre-existing class field; clusterSize is not a cluster-repo.js concept at all).
    // The regression this guards against is a Task-2 edit widening scope to touch
    // cluster-sizing/threshold config, which the plan explicitly forbids.
    const superMajorityOccurrences = src.split(SUPER_MAJORITY_MARKER).length - 1
    const clusterSizeOccurrences = src.split(CLUSTER_SIZE_MARKER).length - 1
    expect(
      superMajorityOccurrences,
      'Expected superMajorityThreshold occurrence count to match the pre-38-10 baseline (4: ' +
      'field decl, constructor assignment reads it twice on one line, getTransactionPhase read) ' +
      '— any change here means the 38-10 edit touched consensus-threshold config out of scope'
    ).to.equal(4)
    expect(
      clusterSizeOccurrences,
      'Expected zero clusterSize references in cluster-repo.js — this is not a ' +
      'cluster-repo.js concept; its presence would mean the 38-10 edit touched out-of-scope config'
    ).to.equal(0)
  })
})
