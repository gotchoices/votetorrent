/**
 * relay-reservation-coverage.spec.ts
 *
 * P2P-11 gap-closure regression lock. Per the 38-20-RELAY-RESERVATION-DIAGNOSIS.md
 * root cause: `replication-proof-runner.ts` boots its OWN self-contained CadreNode
 * (never `CadreNodeProvider`'s) whose `network:` config set `listenAddrs: []` —
 * an empty listen-address array means libp2p's `transportManager.listen()` is
 * never invoked for `/p2p-circuit` at all, so `@libp2p/circuit-relay-v2`'s
 * `ReservationStore.reserveRelay()` is never called, `pendingReservations` stays
 * permanently empty, and every auto-discovered-relay reservation attempt throws
 * `HadEnoughRelaysError` (silently swallowed) — the client never even sends a
 * RESERVE request to the drone. `CadreNodeProvider.tsx` already carries the
 * correct D-03 always-on posture (`listenAddrs: ['/p2p-circuit']`); this lock
 * confirms BOTH: (i) that reference posture stays unchanged (parity anchor),
 * and (ii) `replication-proof-runner.ts` now matches it (the load-bearing fix).
 *
 * Because the SAME `network.listenAddrs` value is forwarded unmodified to BOTH
 * the control node and the strand node (cadre-node.js / strand-instance-manager.js),
 * one edit arms the reservation-seeking machinery on both, closing the
 * `relayReservation=` observable AND the strand-level `NO_RESERVATION`
 * hop-connect denial in a single change. No vendored-dist file is touched by
 * this fix (§6/§7 of the diagnosis) — this spec locks only the two `apps/`
 * source-of-truth files.
 *
 * Assertions are anchored to the `network: { ... hibernation: }` config-body
 * slice (extract-between-markers, mirrors relay-reachability-coverage.spec.ts's
 * extractConnectBody), with comment-stripped text before searching (the 38-18
 * deviation lesson: a fix's own explanatory comment must not false-satisfy a
 * marker check) and markers built by string concatenation so this spec's own
 * prose cannot self-satisfy an assertion. Static source-text guard only — the
 * on-device both-emulator re-proof is 38-21's scope.
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
  throw new Error('relay-reservation-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const CADRE_PROVIDER_PATH = join(
  REPO_ROOT, 'apps', 'VoteTorrentAuthority', 'src', 'providers', 'CadreNodeProvider.tsx'
)
const PROOF_RUNNER_PATH = join(
  REPO_ROOT, 'apps', 'VoteTorrentAuthority', 'src', 'engines', 'replication-proof-runner.ts'
)

// Markers built by concatenation so this spec's own prose cannot satisfy them.
const NETWORK_OPEN = 'network' + ': {'
const NETWORK_CLOSE = 'hibernation' + ': { enabled: false }'
const CIRCUIT_TRANSPORT_MARKER = 'circuitRelayTransport' + '('
const QUOTED_CIRCUIT_MARKER = "'/p2p" + "-circuit'"
const FIXED_LISTEN_MARKER = 'listenAddrs' + ": ['/p2p" + "-circuit']"
const EMPTY_LISTEN_MARKER = 'listenAddrs' + ': []'
const WEBSOCKETS_MARKER = 'webSockets' + '()'
const SUPER_MAJORITY_MARKER = 'superMajority' + 'Threshold'
const CLUSTER_SIZE_MARKER = 'cluster' + 'Size'
// Built via concatenation so this spec's own source is not itself a hit.
const PHASE_20_MARKER = '38' + '-20'
const PHASE_21_MARKER = '38' + '-21'

/** Slice the `network: { ... }` config body (open marker -> next top-level close marker). */
function extractNetworkBody (src: string, path: string): string {
  const start = src.indexOf(NETWORK_OPEN)
  expect(start, `Expected to find "${NETWORK_OPEN}" in ${path}`).to.be.greaterThan(-1)
  const end = src.indexOf(NETWORK_CLOSE, start)
  expect(end, `Expected to find "${NETWORK_CLOSE}" after "${NETWORK_OPEN}" in ${path}`).to.be.greaterThan(start)
  return src.slice(start, end)
}

/**
 * Strip full-line comments (//, /*, *) before searching a body — a fix's own
 * explanatory comment referencing a marker must not false-satisfy an assertion
 * (the 38-18 deviation lesson: reworded the comment, tightened the marker).
 */
function stripCommentLines (body: string): string {
  return body
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

/** Every non-comment line of `src` — used for the phase-number-on-runtime-line check. */
function runtimeLines (src: string): string[] {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
}

describe('P2P-11/38-20: relay-reservation-establishment fix (replication-proof-runner arms /p2p-circuit)', () => {
  it('both apps/ source files exist at the expected paths', () => {
    expect(existsSync(CADRE_PROVIDER_PATH), `Expected ${CADRE_PROVIDER_PATH}`).to.equal(true)
    expect(existsSync(PROOF_RUNNER_PATH), `Expected ${PROOF_RUNNER_PATH}`).to.equal(true)
  })

  it('CadreNodeProvider.tsx: the D-03 reference posture is unchanged (parity anchor)', () => {
    const body = stripCommentLines(
      extractNetworkBody(readFileSync(CADRE_PROVIDER_PATH, 'utf8'), CADRE_PROVIDER_PATH)
    )
    expect(
      body.includes(CIRCUIT_TRANSPORT_MARKER),
      'Expected CadreNodeProvider.tsx network.transports to still include circuitRelayTransport()'
    ).to.equal(true)
    expect(
      body.includes(QUOTED_CIRCUIT_MARKER),
      "Expected CadreNodeProvider.tsx network.listenAddrs to still include '/p2p-circuit' " +
      '(D-03 always-on relay-client posture, unchanged by this plan)'
    ).to.equal(true)
  })

  it('replication-proof-runner.ts: the load-bearing fix — listenAddrs now arms /p2p-circuit reservation-seeking', () => {
    const rawBody = extractNetworkBody(readFileSync(PROOF_RUNNER_PATH, 'utf8'), PROOF_RUNNER_PATH)
    const body = stripCommentLines(rawBody)
    expect(
      body.includes(FIXED_LISTEN_MARKER),
      "Expected replication-proof-runner.ts's network.listenAddrs to include the real array " +
      "element ['/p2p-circuit'] (not merely a comment reference) — per " +
      '38-20-RELAY-RESERVATION-DIAGNOSIS.md §3/§6, this arms @libp2p/circuit-relay-v2\'s ' +
      'ReservationStore.reserveRelay() on BOTH the control and strand nodes'
    ).to.equal(true)
  })

  it('replication-proof-runner.ts: the retired empty-listenAddrs bug shape is absent (regression guard)', () => {
    const body = stripCommentLines(
      extractNetworkBody(readFileSync(PROOF_RUNNER_PATH, 'utf8'), PROOF_RUNNER_PATH)
    )
    expect(
      body.includes(EMPTY_LISTEN_MARKER),
      'Expected the retired `listenAddrs: []` shape (never arms the ReservationStore) to be ' +
      'gone from replication-proof-runner.ts\'s network config'
    ).to.equal(false)
  })

  it('replication-proof-runner.ts: the fix is additive — webSockets() and circuitRelayTransport() both still present', () => {
    const body = stripCommentLines(
      extractNetworkBody(readFileSync(PROOF_RUNNER_PATH, 'utf8'), PROOF_RUNNER_PATH)
    )
    expect(body.includes(WEBSOCKETS_MARKER), 'Expected webSockets() to remain in transports').to.equal(true)
    expect(
      body.includes(CIRCUIT_TRANSPORT_MARKER),
      'Expected circuitRelayTransport() to remain in transports (no new import beyond the ' +
      'already-imported @libp2p/circuit-relay-v2)'
    ).to.equal(true)
  })

  it('no superMajorityThreshold/clusterSize literal is introduced in either edited file', () => {
    const providerSrc = readFileSync(CADRE_PROVIDER_PATH, 'utf8')
    const runnerSrc = readFileSync(PROOF_RUNNER_PATH, 'utf8')
    expect(providerSrc.includes(SUPER_MAJORITY_MARKER)).to.equal(false)
    expect(providerSrc.includes(CLUSTER_SIZE_MARKER)).to.equal(false)
    expect(runnerSrc.includes(SUPER_MAJORITY_MARKER)).to.equal(false)
    expect(runnerSrc.includes(CLUSTER_SIZE_MARKER)).to.equal(false)
  })

  it('no GSD phase number appears on a runtime (non-comment) line of replication-proof-runner.ts', () => {
    const lines = runtimeLines(readFileSync(PROOF_RUNNER_PATH, 'utf8'))
    const offenders = lines.filter((l) => l.includes(PHASE_20_MARKER) || l.includes(PHASE_21_MARKER))
    expect(
      offenders,
      `Expected no runtime line to carry a GSD phase number; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})
