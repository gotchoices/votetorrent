/**
 * vote-delivery-addressing-coverage.spec.ts
 *
 * P2P-11/38-18 regression lock. Per 38-18-VOTE-DELIVERY-ADDRESSING-DIAGNOSIS.md the
 * drone->peer / emu->emu consensus vote-delivery wall (`no valid addresses for peer
 * 12D3KooWC7UT...` — 920x drone-A / 38x drone-B, the 38-17 dominant blocker) is a
 * CODE-CERTAIN defect in `Libp2pKeyPeerNetwork.connect()`'s cold-dial `relayConn`
 * discovery: it checks `c.transient === false` to find "an open, non-transient
 * (direct) connection to some other peer" as a viable circuit-relay hop — but the
 * currently-installed `@libp2p/interface` `Connection` type has NO `transient` field
 * at all (confirmed in `connection.d.ts` and the runtime `libp2p` `Connection` class,
 * which instead expose a purpose-built `direct: boolean` — "Whether this connection
 * is direct or, for example, is via a relay"). Because every real connection's
 * `.transient` is `undefined`, `c.transient === false` never evaluates `true` for
 * ANY connection, so `relayConn` can never be found and every cold-dial to a
 * genuinely address-less peer (the NAT'd-emulator case) falls straight through to
 * the unconditional bare `dialProtocol(dialPeer, ...)` throw. This plan's fix
 * replaces the stale predicate with `c.direct === true`.
 *
 * Assertions are anchored to `connect()`'s own method BODY (extract-slice helper,
 * mirroring `emu-mesh-dial-address-coverage.spec.ts` / `relay-reachability-coverage.spec.ts`),
 * with markers built by string concatenation so neither this spec's own header
 * prose nor an unrelated comment elsewhere in the file can self-satisfy an
 * assertion (the 38-07/38-09 static-lock-authoring lesson). Static source-text
 * assertions only — this is a lockfile/source-tree guard, not a runtime-behaviour
 * guard (the on-device confirmation is 38-19's scope).
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
  throw new Error('vote-delivery-addressing-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const KEY_NETWORK_PATH = join(
  REPO_ROOT, 'vendor', '@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-key-network.js'
)

// Markers built by concatenation so this spec's own explanatory text above cannot
// accidentally satisfy its own assertions (mirrors the emu-mesh/relay-reachability
// static-lock-authoring lesson).
const CONNECT_SIGNATURE = 'connect' + '(peerId, protocol, options)'
const NEXT_METHOD_SIGNATURE = 'getFret' + '() {'
const BRANDED_CALL_MARKER = 'toBrandedPeerId' + '('
const WARM_REUSE_MARKER = 'open.newStream' + '([protocol]'
const CIRCUIT_MARKER = '/p2p-circuit' + '/p2p/'
const LIMITED_CONN_MARKER = 'runOnLimitedConnection' + ': true'
const PEERSTORE_MARKER = 'peerStore' + '.get'
const KNOWN_DIRECT_ADDR_MARKER = 'hasKnownDirectAddr'
// The load-bearing 38-18 fix marker — the corrected relayConn discovery predicate.
const DIRECT_FIELD_MARKER = 'c' + '.direct === true'
// The stale predicate this plan retires — must be ABSENT after the fix lands.
const STALE_TRANSIENT_MARKER = 'c' + '.transient'
const SUPER_MAJORITY_MARKER = 'superMajorityThreshold'

/** Extract the exact body of `connect()` — from its signature up to (not including)
 * the next method's signature — so all assertions are scoped to this one method. */
function extractConnectBody (src: string): string {
  const start = src.indexOf(CONNECT_SIGNATURE)
  expect(start, `Expected to find connect() in ${KEY_NETWORK_PATH}`).to.be.greaterThan(-1)
  const end = src.indexOf(NEXT_METHOD_SIGNATURE, start)
  expect(end, 'Expected the getFret() signature after connect()').to.be.greaterThan(start)
  return src.slice(start, end)
}

describe('P2P-11/38-18: vote-delivery relayConn discovery uses the version-correct direct field', () => {
  it('libp2p-key-network.js exists at the expected vendored-dist path', () => {
    expect(existsSync(KEY_NETWORK_PATH), `Expected ${KEY_NETWORK_PATH} to exist`).to.equal(true)
  })

  it('the load-bearing 38-18 fix: relayConn discovery checks c.direct === true (not the stale c.transient)', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    expect(
      body.includes(DIRECT_FIELD_MARKER),
      'Expected connect()\'s cold-dial relayConn candidate filter to check c.direct === true — ' +
      'the version-correct, publicly-documented @libp2p/interface Connection field for "not a ' +
      'circuit-relay hop" (38-18-VOTE-DELIVERY-ADDRESSING-DIAGNOSIS.md SS2/SS3). The stale ' +
      'c.transient === false check never matches any real connection (no such field exists on ' +
      'this libp2p version), which is why relayConn can never be found and the dominant 920x ' +
      '"no valid addresses for peer" class fires.'
    ).to.equal(true)
  })

  it('the stale c.transient predicate is retired from connect() (no dead-code regression)', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    expect(
      body.includes(STALE_TRANSIENT_MARKER),
      'Expected the non-existent c.transient field check to be fully replaced by c.direct — ' +
      'leaving both would be dead-code-adjacent and misleading about which predicate is load-bearing'
    ).to.equal(false)
  })

  it('toBrandedPeerId( is still the FIRST call inside connect() (P2P-10/D-06 chokepoint preserved)', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    const brandedIdx = body.indexOf(BRANDED_CALL_MARKER)
    expect(brandedIdx, 'Expected toBrandedPeerId( inside connect()').to.be.greaterThan(-1)
    const circuitIdx = body.indexOf(CIRCUIT_MARKER)
    if (circuitIdx > -1) {
      expect(
        brandedIdx,
        'toBrandedPeerId( must precede the /p2p-circuit construction (P2P-10/D-06 stays first)'
      ).to.be.lessThan(circuitIdx)
    }
  })

  it('the warm-connection reuse branch (open.newStream([protocol]) is still present, unchanged', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    expect(
      body.includes(WARM_REUSE_MARKER),
      'Expected connect() to still contain the warm-connection reuse branch — the 38-18 fix ' +
      'must not regress it'
    ).to.equal(true)
  })

  it('the 38-09 cold-dial /p2p-circuit construction and the 38-12 hasKnownDirectAddr guard are both preserved', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    expect(
      body.includes(CIRCUIT_MARKER),
      'Expected connect() to still construct a /p2p-circuit dial target (38-09 fix preserved)'
    ).to.equal(true)
    expect(
      body.includes(KNOWN_DIRECT_ADDR_MARKER),
      'Expected connect() to still consult hasKnownDirectAddr (38-12 guard-tightening preserved)'
    ).to.equal(true)
    const peerStoreIdx = body.indexOf(PEERSTORE_MARKER)
    const circuitIdx = body.indexOf(CIRCUIT_MARKER)
    expect(peerStoreIdx, 'Expected peerStore.get( inside connect()').to.be.greaterThan(-1)
    expect(
      peerStoreIdx,
      'The peerStore known-direct-address check must still precede the /p2p-circuit construction'
    ).to.be.lessThan(circuitIdx)
  })

  it('runOnLimitedConnection: true still appears in connect() (required for limited/circuit streams)', () => {
    const body = extractConnectBody(readFileSync(KEY_NETWORK_PATH, 'utf8'))
    const occurrences = body.split(LIMITED_CONN_MARKER).length - 1
    expect(
      occurrences,
      'Expected runOnLimitedConnection: true to appear at least once in connect()'
    ).to.be.greaterThan(0)
  })

  it('no quorum-threshold config is touched: superMajorityThreshold does not occur in this file', () => {
    const src = readFileSync(KEY_NETWORK_PATH, 'utf8')
    expect(
      (src.split(SUPER_MAJORITY_MARKER).length - 1),
      'libp2p-key-network.js must not gain a superMajorityThreshold occurrence — this fix must ' +
      'not touch quorum logic (T-38-18-03)'
    ).to.equal(0)
  })
})
