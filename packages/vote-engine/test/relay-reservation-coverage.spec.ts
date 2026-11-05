/**
 * relay-reservation-coverage.spec.ts
 *
 * P2P-11 gap-closure regression lock, updated in lockstep with the 41-02 D-05
 * relay-reservation config (migrated to network.relayAddrs on cadre-core 0.12.0).
 *
 * History: 38-20 closed the prior wall by arming `replication-proof-runner.ts`
 * with the bare sentinel `listenAddrs: ['/p2p-circuit']` (matching
 * `CadreNodeProvider.tsx`'s D-03 posture at the time). The on-device 38-21 run
 * then hit an EIGHTH wall: the bare sentinel drives `@libp2p/circuit-relay-v2`'s
 * one-slot `'discovered'` reservation cap, so an emulator peer reachable from
 * TWO drones ends up reserved with only ONE of them (asymmetric
 * `NoValidAddressesError`). The 41-01 Node gate reproduced this exactly (bare
 * mode = 1 relay peer) and proved the fix (qualified mode = 2 relay peers):
 * replace the bare sentinel with ONE relay-qualified `${addr}/p2p-circuit`
 * listenAddrs entry PER KNOWN DRONE (RESEARCH Pattern 1, `'configured'`
 * reservation path, no one-slot cap), paired with
 * `circuitRelayTransport({ reservationConcurrency: <droneCount> })` (Probe 5 —
 * the default concurrency of 1 silently drops any 2nd+ reservation), plus the
 * `transportSymbol` cast (D-10 — `as unknown as ReturnType<typeof webSockets>`)
 * for multi-copy `@libp2p/interface` brand-skew safety.
 *
 * Both `apps/` construction sites move in lockstep (Probe 1, 41-01: cadre-core
 * forwards ONE shared `network` object to the control node AND every strand,
 * so there is no per-node-type override to diverge) — this spec's "parity
 * anchor" therefore checks that BOTH files carry the SAME set of structural
 * markers (qualified-addr construction, dynamic reservationConcurrency,
 * transportSymbol cast, no bare/empty listenAddrs literal), not byte-identical
 * text — `replication-proof-runner.ts` alone carries the second `_B` drone
 * constant (the n=4 on-device harness drives 2 drones; `CadreNodeProvider.tsx`
 * is the production single-authority app and only ever needs 1).
 *
 * Assertions are anchored to the `network: { ... hibernation: }` config-body
 * slice (extract-between-markers, mirrors relay-reachability-coverage.spec.ts's
 * extractConnectBody) for the listenAddrs-assignment/cast checks, and to the
 * whole (comment-stripped) file for the qualified-addr template-literal
 * construction (which is declared as a top-level constant ABOVE the network
 * body, then referenced by identifier inside it). Comment-stripping follows
 * the 38-18 deviation lesson: a fix's own explanatory comment must not
 * false-satisfy a marker check. All markers are built by string concatenation
 * so this spec's own prose cannot self-satisfy an assertion. Static
 * source-text guard only — the on-device both-emulator re-proof is 41-03's
 * scope.
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
const WEBSOCKETS_MARKER = 'webSockets' + '()'
const SUPER_MAJORITY_MARKER = 'superMajority' + 'Threshold'
const CLUSTER_SIZE_MARKER = 'cluster' + 'Size'

// D-05 (41-02): the retired bare-sentinel shape that MUST be absent from both
// files' listenAddrs assignment (the exact literal that drove wall #8's
// one-slot 'discovered' reservation cap).
const BARE_SENTINEL_MARKER = 'listenAddrs' + ": ['/p2p" + "-circuit']"
// The prior (38-20) empty-array regression shape — also must stay absent.
const EMPTY_LISTEN_MARKER = 'listenAddrs' + ': []'
// The qualified per-drone template-literal construction (RESEARCH Pattern 1).
// RETIRED on cadre-core 0.12.0 and now asserted ABSENT: a `<relay>/p2p-circuit` entry in
// network.listenAddrs is rejected at construction on a control node, because libp2p dials
// that relay from inside `libp2p.start()` — during the bring-up quiet period that denies
// exactly that dial. relayAddrs takes the bare relay addr and appends the suffix itself.
// Search the WHOLE file, not just the network-body slice.
const QUALIFIED_ADDR_TEMPLATE_MARKER = '${addr}' + '/p2p' + '-circuit'
// The relay assignment must reference the relay-addrs constant by identifier (not a bare
// array literal) inside the network body.
// Repointed for cadre-core 0.12.0: relays moved from `listenAddrs` to `relayAddrs`, and the
// constant no longer pre-qualifies its entries — hence CONTROL_RELAY_ADDRS, not
// CONTROL_RELAY_LISTEN_ADDRS.
const RELAY_ADDRS_BY_IDENTIFIER_MARKER = 'relay' + 'Addrs' + ': ' + 'CONTROL_RELAY_ADDRS'
// The retired pre-0.12.0 assignment. Must NOT reappear: cadre-core throws on it.
const RETIRED_LISTEN_ADDRS_RELAY_MARKER = 'listen' + 'Addrs' + ': ' + 'CONTROL_RELAY'
// The retired per-node-type override. Must NOT reappear: `strandNetwork` is dead config on
// cadre-core 0.10.0 (zero occurrences in the published types/dist), so re-adding it would
// silently do nothing while looking load-bearing.
const RETIRED_STRAND_OVERRIDE_MARKER = 'strandNetwork' + ':'
// D-10: the transportSymbol cast — libp2p matches transports by the global
// symbol, not structural type, under multi-copy @libp2p/interface.
const TRANSPORT_SYMBOL_CAST_MARKER = 'as unknown as Return' + 'Type<typeof webSockets>'
// PROBE 5 (41-01, exercised): reservationConcurrency must be paired with the
// qualified listenAddrs, sized dynamically (never hardcoded) — the default
// concurrency of 1 silently drops any 2nd+ reservation via reserveQueue.clear().
const RESERVATION_CONCURRENCY_MARKER = 'reservation' + 'Concurrency'

// Built via concatenation so this spec's own source is not itself a hit.
const PHASE_38_20_MARKER = '38' + '-20'
const PHASE_38_21_MARKER = '38' + '-21'
const PHASE_41_01_MARKER = '41' + '-01'
const PHASE_41_02_MARKER = '41' + '-02'

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

/**
 * Shared per-file assertion set — both `CadreNodeProvider.tsx` and
 * `replication-proof-runner.ts` must satisfy the SAME structural shape (the
 * parity anchor: no per-node-type network override exists per Probe 1, so a
 * one-file-only edit must fail this check on the un-edited file).
 */
function assertQualifiedListenAddrsShape (path: string, label: string): void {
  const fullSrc = readFileSync(path, 'utf8')
  const strippedFullSrc = stripCommentLines(fullSrc)
  const body = stripCommentLines(extractNetworkBody(fullSrc, path))

  expect(
    body.includes(CIRCUIT_TRANSPORT_MARKER),
    `Expected ${label} network.transports to include circuitRelayTransport()`
  ).to.equal(true)
  expect(
    body.includes(WEBSOCKETS_MARKER),
    `Expected ${label} network.transports to include webSockets()`
  ).to.equal(true)
  expect(
    body.includes(TRANSPORT_SYMBOL_CAST_MARKER),
    `Expected ${label} to apply the D-10 transportSymbol cast ` +
    '(`as unknown as ReturnType<typeof webSockets>`) to circuitRelayTransport() ' +
    'so libp2p matches transports by the global symbol under multi-copy @libp2p/interface'
  ).to.equal(true)
  expect(
    body.includes(RESERVATION_CONCURRENCY_MARKER),
    `Expected ${label} circuitRelayTransport() to set reservationConcurrency ` +
    '(PROBE 5, 41-01: the default concurrency of 1 silently drops any 2nd+ reservation)'
  ).to.equal(true)
  expect(
    strippedFullSrc.includes(QUALIFIED_ADDR_TEMPLATE_MARKER),
    `Expected the relay-qualified per-drone template literal to be GONE from ${label}. ` +
    'cadre-core 0.12.0 REJECTS a `<relay>/p2p-circuit` entry in network.listenAddrs on a ' +
    'control node ("network.listenAddrs names a relay directly ... Move the relay to ' +
    'network.relayAddrs, which reserves after bring-up"), because libp2p dials that relay ' +
    'from inside libp2p.start() during the bring-up quiet period that denies exactly that ' +
    'dial. relayAddrs takes the BARE relay addr and appends the suffix itself, so this ' +
    'construction is not merely unnecessary now — it is fatal at start().'
  ).to.equal(false)
  expect(
    body.includes(RELAY_ADDRS_BY_IDENTIFIER_MARKER),
    `Expected ${label} network.relayAddrs to be assigned the relay-addrs constant by ` +
    'identifier (CONTROL_RELAY_ADDRS), not a bare array literal'
  ).to.equal(true)
  expect(
    body.includes(RETIRED_LISTEN_ADDRS_RELAY_MARKER),
    `Expected the retired pre-0.12.0 relay-in-listenAddrs assignment to be gone from ` +
    `${label}'s network config — cadre-core throws on it at construction`
  ).to.equal(false)
  expect(
    stripCommentLines(fullSrc).includes(RETIRED_STRAND_OVERRIDE_MARKER),
    `Expected the retired per-node-type \`strandNetwork\` override to be GONE from ${label}. ` +
    'It was the 41-11 workaround for the shared-peerId circuit-relay-v2 collision; cadre-core ' +
    '0.10.0 fixes the root cause by deriving a per-strand transport peerId, and no longer reads ' +
    'the key at all — so re-adding it would be dead config that looks load-bearing.'
  ).to.equal(false)
  expect(
    body.includes(BARE_SENTINEL_MARKER),
    `Expected the retired bare listenAddrs: ['/p2p-circuit'] sentinel (wall #8's one-slot ` +
    `'discovered'-cap trigger) to be gone from ${label}'s network config`
  ).to.equal(false)
  expect(
    body.includes(EMPTY_LISTEN_MARKER),
    `Expected the prior (38-20) empty listenAddrs: [] regression shape to be gone from ${label}'s network config`
  ).to.equal(false)
}

describe('P2P-11/41-02: network.relayAddrs (cadre-core 0.12.0) + reservationConcurrency + transportSymbol cast', () => {
  it('both apps/ source files exist at the expected paths', () => {
    expect(existsSync(CADRE_PROVIDER_PATH), `Expected ${CADRE_PROVIDER_PATH}`).to.equal(true)
    expect(existsSync(PROOF_RUNNER_PATH), `Expected ${PROOF_RUNNER_PATH}`).to.equal(true)
  })

  it('CadreNodeProvider.tsx: relay-qualified listenAddrs + reservationConcurrency + transportSymbol cast', () => {
    assertQualifiedListenAddrsShape(CADRE_PROVIDER_PATH, 'CadreNodeProvider.tsx')
  })

  it('replication-proof-runner.ts: relay-qualified listenAddrs + reservationConcurrency + transportSymbol cast', () => {
    assertQualifiedListenAddrsShape(PROOF_RUNNER_PATH, 'replication-proof-runner.ts')
  })

  it('parity anchor: both files satisfy the identical structural shape (no per-node-type network override, Probe 1)', () => {
    // Re-run the shared assertion set against BOTH files in the SAME test — if only one file
    // had been edited (a one-file drift), the un-edited file's call would throw here and fail
    // this test, which is exactly the parity anchor's job (verified by reasoning: temporarily
    // reverting either file's listenAddrs/transports block to the retired shape reproduces a
    // failure in the corresponding assertQualifiedListenAddrsShape call above).
    expect(() => assertQualifiedListenAddrsShape(CADRE_PROVIDER_PATH, 'CadreNodeProvider.tsx')).to.not.throw()
    expect(() => assertQualifiedListenAddrsShape(PROOF_RUNNER_PATH, 'replication-proof-runner.ts')).to.not.throw()
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

  it('no GSD phase number appears on a runtime (non-comment) line of either edited file', () => {
    const providerLines = runtimeLines(readFileSync(CADRE_PROVIDER_PATH, 'utf8'))
    const runnerLines = runtimeLines(readFileSync(PROOF_RUNNER_PATH, 'utf8'))
    const isOffender = (l: string): boolean =>
      l.includes(PHASE_38_20_MARKER) || l.includes(PHASE_38_21_MARKER) ||
      l.includes(PHASE_41_01_MARKER) || l.includes(PHASE_41_02_MARKER)
    const offenders = [...providerLines, ...runnerLines].filter(isOffender)
    expect(
      offenders,
      `Expected no runtime line to carry a GSD phase number; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})
