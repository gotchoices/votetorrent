/**
 * drone-materialize-defer-coverage.spec.ts
 *
 * P2P-11/38-07 regression lock — the narrow drone-side materialize-defer guard
 * lands at StorageRepo.get()'s `getBlock(context?.rev)` call site, and does NOT
 * reintroduce the broad StorageRepo.get()-level catch that was reverted in 38-04
 * (see 38-04-SUMMARY.md "Attempted-and-reverted: storage-repo.js" — that broader
 * fix broke solo bootstrap strand creation across 3 runs because it swallowed the
 * load-bearing `Pending action <id> not found` throw on the creation path).
 *
 * Three invariants, parsed from the vendored dist source (the source of truth for
 * what actually ships):
 *
 *   1. Defer-guard present — the single `blockRev = await blockStorage.getBlock(...)`
 *      statement is wrapped in a localized try/catch that recognizes the
 *      "Failed to find materialized block" error class (mirrors the already-landed
 *      cluster-repo.js:498 validatePendOperations defer analog).
 *   2. Broad-catch anti-pattern absent — StorageRepo.get()'s body does NOT open
 *      with a try immediately after the method signature (the shape the reverted
 *      broad fix took).
 *   3. Creation-path throw preserved — the `Pending action ${context.actionId} not
 *      found` throw (the load-bearing branch broken by the reverted broad catch)
 *      is still present, and sits textually AFTER the narrow catch closes — i.e.
 *      it is not nested inside the narrow guard either.
 *
 * Mirrors branded-peer-id-coverage.spec.ts / quereus-single-copy-regression.spec.ts's
 * "read a file with fs, regex/index-assert on its text" shape. Static source-text
 * assertions only — this is a lockfile/source-tree guard, not a runtime-behaviour
 * guard (the runtime consensus-round behaviour is proven on-device, per 38-CONTEXT).
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
  throw new Error('drone-materialize-defer-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const STORAGE_REPO_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'storage', 'storage-repo.js'
)

// The narrow guard: a try wrapping ONLY the getBlock(context?.rev) assignment,
// followed by a catch. Flexible on whitespace (compiled dist formatting), strict
// on the statement shape — this is what makes the fix "narrow" by construction.
const NARROW_TRY_GETBLOCK_RE =
  /try\s*\{\s*blockRev\s*=\s*await\s*blockStorage\.getBlock\(context\?\.rev\)\s*;\s*\}\s*catch/

// The load-bearing creation-path throw string (get()'s pending-action branch).
const PENDING_ACTION_THROW = 'Pending action ${context.actionId} not found'

describe('P2P-11/38-07: drone-side materialize-defer at the getBlock() call site', () => {
  it('storage-repo.js exists at the expected vendored-dist path', () => {
    expect(existsSync(STORAGE_REPO_PATH), `Expected ${STORAGE_REPO_PATH} to exist`).to.equal(true)
  })

  it('defer-guard is present: getBlock(context?.rev) is wrapped in a localized try/catch', () => {
    const src = readFileSync(STORAGE_REPO_PATH, 'utf8')
    expect(
      NARROW_TRY_GETBLOCK_RE.test(src),
      'Expected storage-repo.js StorageRepo.get() to wrap ONLY the ' +
      '`blockRev = await blockStorage.getBlock(context?.rev)` statement in a ' +
      'try/catch (P2P-11/38-07 narrow materialize-defer guard missing or widened)'
    ).to.equal(true)
  })

  it('the catch recognizes the "Failed to find materialized block" error class and the throw stays reachable and un-caught elsewhere', () => {
    const src = readFileSync(STORAGE_REPO_PATH, 'utf8')
    const match = NARROW_TRY_GETBLOCK_RE.exec(src)
    expect(match, 'Precondition: narrow try/catch must be found first').to.not.equal(null)
    const catchStart = (match as RegExpExecArray).index

    // Search for the message-class match STARTING FROM the narrow catch's open
    // position — the guard's own explanatory comment (immediately above the
    // try/catch) also legitimately mentions this message class, so an
    // unconstrained indexOf() would find that comment instead of the live
    // catch-block check this test means to verify.
    const materializeMsgIdx = src.indexOf('Failed to find materialized block', catchStart)
    const pendingActionThrowIdx = src.indexOf(PENDING_ACTION_THROW)

    expect(
      materializeMsgIdx,
      'Expected "Failed to find materialized block" message-class match to appear in storage-repo.js (P2P-11/38-07)'
    ).to.be.greaterThan(-1)
    expect(
      pendingActionThrowIdx,
      'Expected the creation-path `Pending action ${context.actionId} not found` throw to still be present (load-bearing, 38-04)'
    ).to.be.greaterThan(-1)

    // The materialize-not-found message-class check must live INSIDE the narrow
    // catch — i.e. after the catch opens and before the (unrelated,
    // un-nested) creation-path throw appears later in the method.
    expect(
      materializeMsgIdx,
      '"Failed to find materialized block" must appear after the narrow catch opens'
    ).to.be.greaterThan(catchStart)
    expect(
      materializeMsgIdx,
      '"Failed to find materialized block" must appear before the creation-path Pending-action throw (i.e. inside the narrow catch, not spanning into the creation-path branch)'
    ).to.be.lessThan(pendingActionThrowIdx)
  })

  it('broad get()-level catch anti-pattern is ABSENT: StorageRepo.get() does not open with a try immediately after its signature', () => {
    const src = readFileSync(STORAGE_REPO_PATH, 'utf8')
    const getSignature = 'async get({ blockIds, context }, _options) {'
    const getStart = src.indexOf(getSignature)
    expect(getStart, 'Expected to find the StorageRepo.get() method signature').to.be.greaterThan(-1)

    // Look only at the code immediately following the signature (skipping past
    // it, not into the narrow guard many lines later) — the reverted broad fix's
    // shape wrapped the ENTIRE body starting right here.
    const bodyOpen = src.slice(getStart + getSignature.length, getStart + getSignature.length + 120)
    expect(
      /^\s*try\s*\{/.test(bodyOpen),
      'Expected StorageRepo.get() to NOT open with a bare `try {` immediately after its ' +
      'signature — this is the reverted-broad-catch shape (38-04-SUMMARY ' +
      '"Attempted-and-reverted: storage-repo.js") that swallowed the load-bearing ' +
      'Pending-action throw and broke solo bootstrap (P2P-11/38-07 regression)'
    ).to.equal(false)
  })

  it('creation-path throw is preserved and reachable (not enclosed by the narrow catch)', () => {
    const src = readFileSync(STORAGE_REPO_PATH, 'utf8')
    expect(
      src.includes(PENDING_ACTION_THROW),
      'Expected `Pending action ${context.actionId} not found` throw to remain present ' +
      'in storage-repo.js — this is the load-bearing creation-path branch broken by the ' +
      'reverted broad StorageRepo.get() catch (38-04) and MUST NOT be swallowed by the ' +
      'P2P-11/38-07 narrow defer guard'
    ).to.equal(true)

    // The throw must sit inside the `if (context?.actionId !== undefined) { ... }`
    // branch, which itself begins AFTER the narrow try/catch closes (per the prior
    // test's ordering assertion) — i.e. it is a sibling statement to the guard,
    // not nested inside it.
    const ifActionIdIdx = src.indexOf('if (context?.actionId !== undefined)')
    const pendingActionThrowIdx = src.indexOf(PENDING_ACTION_THROW)
    expect(ifActionIdIdx, 'Expected the actionId branch to exist').to.be.greaterThan(-1)
    expect(
      pendingActionThrowIdx,
      'Expected the Pending-action throw to sit inside/after the actionId branch, not before it'
    ).to.be.greaterThan(ifActionIdIdx)
  })
})
