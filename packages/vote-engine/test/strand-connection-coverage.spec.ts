/**
 * strand-connection-coverage.spec.ts
 *
 * P2P-11/38-14 regression lock. Per 38-14-STRAND-CONNECTION-DIAGNOSIS.md the
 * n=4 first-block write FAILed with `strandPeers=0` on BOTH emulators, then
 * `1/4 approvals (needed 3)` — drone-A `No response received`, drone-B
 * `Unexpected EOF - stream closed while reading 0/1 bytes` — because
 * `@libp2p/bootstrap`'s peer-discovery module fires exactly ONE dial attempt
 * per configured strand-cohort bootstrap peer, ~1s after strand-node start,
 * with NO automatic retry (verified against the installed libp2p/
 * @libp2p/bootstrap dist — see the diagnosis §3). A transient not-yet-ready
 * window on either drone permanently starves the emulator's strand node of
 * a live cohort connection.
 *
 * This spec locks the ROUTE A fix: `StrandInstanceManager.startStrand()`
 * actively (re)dials each configured strand-cohort bootstrap address with a
 * bounded, parallel, fire-and-forget retry loop — run in parallel with (not
 * instead of) the existing one-shot `@libp2p/bootstrap` registration, so a
 * transient not-ready race no longer permanently loses the strand-cohort
 * connection within the harness's existing strandPeers= poll window.
 *
 * Assertions are anchored to `startStrand()`'s own method BODY (extract-slice
 * helper) with markers built by string concatenation, so neither this spec's
 * own header text nor an unrelated comment elsewhere in the file can
 * self-satisfy an assertion (the 38-07/38-09/38-12 static-lock-authoring
 * lesson). Static source-text guard only — the on-device both-emulator PASS
 * is 38-15's scope.
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
  throw new Error('strand-connection-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const STRAND_MGR_PATH = join(
  REPO_ROOT, 'vendor', '@serfab', 'cadre-core', 'dist', 'strand-instance-manager.js'
)

// Markers built by concatenation so this spec's own prose cannot satisfy them.
const START_STRAND_SIGNATURE = 'async startStrand' + '(config)'
const STOP_STRAND_SIGNATURE = 'async stopStrand' + '(strandId)'
const RETRY_DIAL_FN_MARKER = 'dialStrandBootstrap' + 'Peers'
const NODE_DIAL_MARKER = 'node' + '.dial('
const MULTIADDR_CALL_MARKER = 'multiaddr' + '('
const BOOTSTRAP_ADDRS_MARKER = 'strandBootstrapNodes'

/** Slice `startStrand()`'s own body (signature -> next method signature). */
function extractStartStrandBody (src: string): string {
  const start = src.indexOf(START_STRAND_SIGNATURE)
  expect(start, `Expected to find startStrand(config) in ${STRAND_MGR_PATH}`).to.be.greaterThan(-1)
  const end = src.indexOf(STOP_STRAND_SIGNATURE, start)
  expect(end, 'Expected the stopStrand(strandId) signature after startStrand()').to.be.greaterThan(start)
  return src.slice(start, end)
}

// SUPERSEDED (Phase 40-02, PUB-01/PUB-02 de-vendoring): this spec locks Phase 38's
// hand-patched `vendor/@serfab/cadre-core` dist source, which no longer exists now
// that VT consumes it from published npm (@serfab/cadre-core@0.8.1 does not carry
// this fix upstream). Cross-peer replication (P2P-11) is out of Phase 40's scope and
// was still FAIL as of 38-21 even with this fix live — Phase 41 owns re-diagnosing/
// re-patching against the de-vendored baseline. Skipped rather than deleted to
// preserve the historical static-lock shape for that future re-patch. See
// 40-02-SUMMARY.md.
describe.skip('P2P-11/38-14: strand-cohort bootstrap retry-dial (closes the one-shot-bootstrap-dial strandPeers=0 gap)', () => {
  it('the vendored-dist source file exists at the expected transplant path', () => {
    expect(existsSync(STRAND_MGR_PATH), `Expected ${STRAND_MGR_PATH}`).to.equal(true)
  })

  it('startStrand() actively (re)dials the configured strand-cohort bootstrap addresses', () => {
    const body = extractStartStrandBody(readFileSync(STRAND_MGR_PATH, 'utf8'))
    expect(
      body.includes(RETRY_DIAL_FN_MARKER),
      'Expected startStrand() to define a strand-cohort bootstrap retry-dial helper ' +
      '(38-14-STRAND-CONNECTION-DIAGNOSIS.md §7 — closes the @libp2p/bootstrap ' +
      'one-shot-dial-with-no-retry gap that leaves strandPeers=0)'
    ).to.equal(true)
    expect(
      body.includes(NODE_DIAL_MARKER),
      'Expected the retry-dial helper to call node.dial(...) — an ACTIVE dial, not merely ' +
      'a passive bootstrapNodes config forward'
    ).to.equal(true)
    expect(
      body.includes(MULTIADDR_CALL_MARKER),
      'Expected the retry-dial helper to construct a multiaddr(...) from each configured ' +
      'strand-cohort bootstrap address before dialing it'
    ).to.equal(true)
  })

  it('the retry-dial helper is anchored to the same strandBootstrapNodes config the passive bootstrap module already reads', () => {
    const body = extractStartStrandBody(readFileSync(STRAND_MGR_PATH, 'utf8'))
    const bootstrapAddrsIdx = body.indexOf(BOOTSTRAP_ADDRS_MARKER)
    const retryFnIdx = body.indexOf(RETRY_DIAL_FN_MARKER)
    expect(bootstrapAddrsIdx, 'Expected strandBootstrapNodes to still be read in startStrand()').to.be.greaterThan(-1)
    expect(retryFnIdx, 'Expected the retry-dial helper to be defined in startStrand()').to.be.greaterThan(-1)
    // The retry-dial helper must be defined AFTER the passive bootstrapNodes forward that
    // feeds createLibp2pNode() — it operates on the same address list, not a duplicate.
    expect(
      retryFnIdx,
      'Expected the retry-dial helper definition to come after the bootstrapNodes forward ' +
      '(it dials the SAME configured addresses, run in parallel with the passive registration)'
    ).to.be.greaterThan(bootstrapAddrsIdx)
  })

  it('the strand node still forwards bootstrapNodes to createLibp2pNode (the existing @libp2p/bootstrap registration is preserved, not replaced)', () => {
    const src = readFileSync(STRAND_MGR_PATH, 'utf8')
    expect(
      src.includes('bootstrapNodes' + ': config.network?.strandBootstrapNodes'),
      'Expected the existing passive bootstrapNodes forward into createLibp2pNode() to remain ' +
      '— the retry-dial fix is additive, not a replacement'
    ).to.equal(true)
  })
})
