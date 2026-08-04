/**
 * post-peerid-patch-upstream-blockers.spec.ts
 *
 * Regression lock for the THREE upstream substrate blockers that surfaced AFTER the shared-peerId /
 * `strandNetwork` relay-path fix (sereus#1) moved the wall.
 *
 * History: commit `1888f07` landed the `strandNetwork` override — an additive
 * `.yarn/patches/@serfab-cadre-core-npm-0.9.0-*.patch` giving strand libp2p nodes a relay target
 * distinct from the control node's, closing the shared-peerId circuit-relay-v2 hop-connect collision
 * diagnosed in 41-10. The 41-12 device n=4 re-prove (2026-07-31, see
 * `.planning/phases/41-multi-peer-relay-close-published-substrate/41-UAT.md`) confirmed the fix works
 * at its own layer — `STRAND-RELAY-ROUTING DISTINCT-RELAY FIX: PASS` on Node/loopback, and the 41-09
 * device signature GONE (FRET `UnsupportedProtocolError` 52x -> 0, `NoValidAddressesError` 56x -> 0).
 * But the device proof still FAILED twice deterministically (`strandPeers=0`,
 * `relayAddrsPerDrone=0`) because a NEW, EARLIER wall now kills the founding DDL before strand-cohort
 * formation is reached.
 *
 * The three defects locked here (drafts in
 * `.planning/quick/260731-fm3-file-upstream-issues-for-post-peerid-pat/issues/`):
 *
 *   1. `@optimystic/db-p2p@0.17.0` — `ClusterMember.admitMembership` has no genesis exemption. At
 *      cluster creation FRET confidence is definitionally 0 (ring not stabilized) and the declared
 *      peer set is definitionally below `clusterSize` (the cluster does not exist yet), so the
 *      fail-closed downsize branch rejects the founding transaction:
 *      `membership-not-admitted:low-confidence-downsize`. Bootstrap deadlock.
 *   2. `@serfab/cadre-core@0.9.0` — `clusterSize: 3` is a literal at BOTH `createLibp2pNode` call
 *      sites and the inline `clusterPolicy` omits `allowUnvalidatedSmallCluster`, with no
 *      `NetworkConfig` override — so db-p2p's own escape hatch for exactly this case is unreachable.
 *   3. `@optimystic/db-p2p@0.17.0` — pairs `libp2p ^3.x` with `@chainsafe/libp2p-gossipsub ^14.x`,
 *      which was built against the libp2p-2 duplex `Stream`. libp2p 3's `Stream extends
 *      MessageStream` has no `.source`/`.sink`, so `it-pipe`'s structural duplex check fails and
 *      every outbound gossipsub stream throws `fns.shift(...) is not a function`.
 *
 * WHAT THIS SPEC IS FOR. These are UNPATCHED upstream defects — there is no local hunk to guard.
 * So, unlike the earlier patch-presence specs, these assertions lock the DEFECT SIGNATURES in the
 * installed dist. Each assertion is written to FAIL when the defect is fixed upstream, with a message
 * naming the issue draft to close and the follow-up to do. That makes a routine dependency bump the
 * trigger for closing the loop, instead of the defect quietly disappearing and the drafts rotting.
 * A failure here is GOOD NEWS — read the message.
 *
 * All markers are built by string concatenation so this spec's own prose can never self-satisfy an
 * assertion it defines (same discipline as `strand-cohort-routing-coverage.spec.ts`).
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
  throw new Error('post-peerid-patch-upstream-blockers: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()

/**
 * The workspace is nohoist'd, so vendored deps land in per-workspace node_modules rather than the
 * repo root; check each known consumer in turn. Any copy proves the invariant — the lockfile
 * resolves each package to a single version.
 */
const CONSUMER_BASES = [
  join(REPO_ROOT, 'packages', 'p2p-probe-host'),
  join(REPO_ROOT, 'apps', 'VoteTorrentAuthority'),
  join(REPO_ROOT, 'apps', 'VoteTorrentVoter'),
  REPO_ROOT,
]

function resolveInstalled (...segments: string[]): string | undefined {
  for (const base of CONSUMER_BASES) {
    const p = join(base, 'node_modules', ...segments)
    if (existsSync(p)) return p
  }
  return undefined
}

/** Strip line- and block-comments so an assertion can never be satisfied by a doc comment. */
function stripComments (src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

// ── Issue 1 markers — db-p2p membership-gate genesis deadlock ───────────────────────────────────
const DB_P2P_CLUSTER_REPO = ['@optimystic', 'db-p2p', 'dist', 'src', 'cluster', 'cluster-repo.js']
const DB_P2P_NODE_BASE = ['@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-node-base.js']
// The reject reason the device runs observed is COMPOSED at runtime, not stored as one literal:
//   `${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`
// so assert its two halves separately. Markers assembled by concatenation so this file's own prose
// can't satisfy them.
const MEMBERSHIP_NOT_ADMITTED_CONST_MARKER = "MEMBERSHIP_NOT_ADMITTED = " + "'membership-not-admitted'"
const LOW_CONFIDENCE_DOWNSIZE_SUFFIX_MARKER = ':' + 'low-confidence-downsize'
/** The reason string as it reaches the wire (what the device logs showed) — for messages only. */
const LOW_CONFIDENCE_DOWNSIZE_WIRE = 'membership-not-admitted' + ':' + 'low-confidence-downsize'
// The fail-closed branch's only two approve escapes.
const CONFIGURED_SIZE_UNDEFINED_ESCAPE = 'this.configuredClusterSize === undefined'
const DECLARED_GTE_CONFIGURED_ESCAPE = 'declared.length >= this.configuredClusterSize'
// Confidence is sourced solely from FRET, which is cold at genesis.
const FRET_CONFIDENCE_MARKER = 'getNetworkSizeEstimate' + '()' + '.confidence'
// The escape hatch and its fail-closed default.
const ALLOW_SMALL_CLUSTER_KEY = 'allowUnvalidated' + 'SmallCluster'
// Tokens that would indicate an upstream genesis exemption has landed.
const GENESIS_EXEMPTION_TOKENS = ['genesis', 'bootstrapGrace', 'isFoundingBlock', 'noPriorRevision']

// ── Issue 2 markers — cadre-core hardcoded cluster policy ───────────────────────────────────────
const CADRE_NODE_DIST = ['@serfab', 'cadre-core', 'dist', 'cadre-node.js']
const CADRE_STRAND_MANAGER_DIST = ['@serfab', 'cadre-core', 'dist', 'strand-instance-manager.js']
const CADRE_TYPES_DIST = ['@serfab', 'cadre-core', 'dist', 'types.d.ts']
const HARDCODED_CLUSTER_SIZE_MARKER = 'clusterSize' + ': ' + '3'
const CLUSTER_POLICY_KEY_MARKER = 'clusterPolicy'

// ── Issue 3 markers — gossipsub / libp2p-3 Stream incompatibility ───────────────────────────────
const GOSSIPSUB_PKG = ['@chainsafe', 'libp2p-gossipsub', 'package.json']
const GOSSIPSUB_NESTED_IFACE = [
  '@chainsafe', 'libp2p-gossipsub', 'node_modules', '@libp2p', 'interface', 'package.json',
]
const HOST_IFACE_STREAM_DTS = ['@libp2p', 'interface', 'dist', 'src', 'stream.d.ts']
const MESSAGE_STREAM_MARKER = 'interface Stream extends ' + 'MessageStream'
const DUPLEX_STREAM_MARKER = 'interface Stream extends ' + 'Duplex'

/** Read the first `major` of a semver-ish version string. */
function majorOf (version: string): number {
  const m = /^\D*(\d+)/.exec(version)
  return m ? Number(m[1]) : NaN
}

describe('post-peerId-patch blocker 1: db-p2p membership admission gate deadlocks cluster genesis', () => {
  it('the low-confidence-downsize reject reason still exists in the installed db-p2p dist', () => {
    const p = resolveInstalled(...DB_P2P_CLUSTER_REPO)
    expect(p, 'Expected @optimystic/db-p2p dist cluster-repo.js to be installed').to.not.equal(undefined)
    const src = stripComments(readFileSync(p as string, 'utf8'))
    const staleMessage =
      'The `' + LOW_CONFIDENCE_DOWNSIZE_WIRE + '` reject reason is GONE from the installed ' +
      '@optimystic/db-p2p dist. That is the blocker this spec tracks — if it was removed or renamed ' +
      'upstream, re-run the device n=4 replication proof (scripts/run-replication-proof.sh) and close ' +
      '.planning/quick/260731-fm3-file-upstream-issues-for-post-peerid-pat/issues/' +
      'db-p2p-membership-gate-blocks-cluster-genesis.md, then delete this assertion.'
    // The wire string is composed from a constant + a template suffix — assert both halves.
    expect(src.includes(MEMBERSHIP_NOT_ADMITTED_CONST_MARKER), staleMessage).to.equal(true)
    expect(src.includes(LOW_CONFIDENCE_DOWNSIZE_SUFFIX_MARKER), staleMessage).to.equal(true)
  })

  it('the fail-closed branch still offers no genesis escape (only undefined-size or already-full-size)', () => {
    const p = resolveInstalled(...DB_P2P_CLUSTER_REPO)
    const src = stripComments(readFileSync(p as string, 'utf8'))

    // Both known escapes are present, and BOTH are unreachable at genesis for a consumer that sets
    // clusterSize (cadre-core sets 3): the size is defined, and the declared set is below it.
    expect(
      src.includes(CONFIGURED_SIZE_UNDEFINED_ESCAPE),
      'Expected the `' + CONFIGURED_SIZE_UNDEFINED_ESCAPE + '` legacy-approve escape in admitMembership',
    ).to.equal(true)
    expect(
      src.includes(DECLARED_GTE_CONFIGURED_ESCAPE),
      'Expected the `' + DECLARED_GTE_CONFIGURED_ESCAPE + '` full-size escape in admitMembership',
    ).to.equal(true)

    // No third, genesis-shaped escape has appeared.
    const found = GENESIS_EXEMPTION_TOKENS.filter((t) => src.includes(t))
    expect(
      found,
      'A genesis-shaped exemption token ' + JSON.stringify(found) + ' appeared in db-p2p\'s ' +
      'admitMembership path. If upstream added a genesis exemption, this blocker may be FIXED — ' +
      're-run the device n=4 proof and close the db-p2p-membership-gate issue draft.',
    ).to.deep.equal([])
  })

  it('admission confidence is still sourced solely from FRET (cold at genesis) and fails closed', () => {
    const nodeBase = resolveInstalled(...DB_P2P_NODE_BASE)
    expect(nodeBase, 'Expected @optimystic/db-p2p dist libp2p-node-base.js to be installed').to.not.equal(undefined)
    const src = stripComments(readFileSync(nodeBase as string, 'utf8'))

    // deriveExpectedCluster reads confidence from FRET alone — there is no other source, so a
    // cold-started node cannot reach the confident branch no matter how it is configured.
    expect(
      src.includes(FRET_CONFIDENCE_MARKER),
      'Expected deriveExpectedCluster to source confidence from FRET `' + FRET_CONFIDENCE_MARKER + '`. ' +
      'If this changed, the genesis-deadlock analysis in the db-p2p-membership-gate issue draft needs ' +
      're-verification before filing.',
    ).to.equal(true)

    // The escape hatch exists but defaults false — this is what makes issue 2 (cadre-core not
    // forwarding it) load-bearing rather than cosmetic.
    expect(
      src.includes(ALLOW_SMALL_CLUSTER_KEY),
      'Expected db-p2p to expose the `' + ALLOW_SMALL_CLUSTER_KEY + '` cluster-policy option',
    ).to.equal(true)
    expect(
      new RegExp(ALLOW_SMALL_CLUSTER_KEY + '[^\\n]*\\?\\?\\s*false').test(src),
      'Expected `' + ALLOW_SMALL_CLUSTER_KEY + '` to still default to false (fail-closed) in db-p2p. ' +
      'If the default flipped to true, the genesis deadlock may be gone — re-run the device proof.',
    ).to.equal(true)
  })
})

describe('post-peerId-patch blocker 2: cadre-core hardcodes clusterSize and drops allowUnvalidatedSmallCluster', () => {
  it('both createLibp2pNode call sites still hardcode clusterSize: 3', () => {
    for (const dist of [CADRE_NODE_DIST, CADRE_STRAND_MANAGER_DIST]) {
      const p = resolveInstalled(...dist)
      expect(p, 'Expected ' + dist.join('/') + ' to be installed').to.not.equal(undefined)
      const src = stripComments(readFileSync(p as string, 'utf8'))
      expect(
        src.includes(HARDCODED_CLUSTER_SIZE_MARKER),
        'Expected the hardcoded `' + HARDCODED_CLUSTER_SIZE_MARKER + '` literal in ' + dist.join('/') +
        '. If it now reads from config, cadre-core may have added the passthrough — close ' +
        '.planning/quick/260731-fm3-file-upstream-issues-for-post-peerid-pat/issues/' +
        'cadre-core-hardcoded-clustersize-no-clusterpolicy-passthrough.md and wire the option through ' +
        'CadreNodeProvider.tsx + replication-proof-runner.ts.',
      ).to.equal(true)
    }
  })

  it('neither call site forwards allowUnvalidatedSmallCluster, so db-p2p\'s escape hatch is unreachable', () => {
    for (const dist of [CADRE_NODE_DIST, CADRE_STRAND_MANAGER_DIST]) {
      const p = resolveInstalled(...dist)
      const src = stripComments(readFileSync(p as string, 'utf8'))
      // The clusterPolicy object is constructed inline...
      expect(
        src.includes(CLUSTER_POLICY_KEY_MARKER),
        'Expected an inline `' + CLUSTER_POLICY_KEY_MARKER + '` in ' + dist.join('/'),
      ).to.equal(true)
      // ...and it does NOT include the one key that would let a consumer opt out of the fail-closed gate.
      expect(
        src.includes(ALLOW_SMALL_CLUSTER_KEY),
        'cadre-core\'s ' + dist.join('/') + ' now mentions `' + ALLOW_SMALL_CLUSTER_KEY + '`. If the ' +
        'passthrough landed, this blocker is FIXED — set it from app config and close the ' +
        'cadre-core-hardcoded-clustersize issue draft.',
      ).to.equal(false)
    }
  })

  it('CadreNodeConfig/NetworkConfig still expose no cluster-size or cluster-policy override', () => {
    const p = resolveInstalled(...CADRE_TYPES_DIST)
    expect(p, 'Expected @serfab/cadre-core dist types.d.ts to be installed').to.not.equal(undefined)
    const src = stripComments(readFileSync(p as string, 'utf8'))
    for (const key of ['clusterSize', CLUSTER_POLICY_KEY_MARKER]) {
      expect(
        src.includes(key),
        'cadre-core\'s public types now declare `' + key + '`. The override may exist — verify and ' +
        'close the cadre-core-hardcoded-clustersize issue draft, then thread it from app config.',
      ).to.equal(false)
    }
  })
})

describe('post-peerId-patch blocker 3: db-p2p pairs libp2p 3.x with a gossipsub built for libp2p 2.x', () => {
  it('gossipsub still depends on a @libp2p/interface major older than the host copy', () => {
    const gossipPkgPath = resolveInstalled(...GOSSIPSUB_PKG)
    expect(gossipPkgPath, 'Expected @chainsafe/libp2p-gossipsub to be installed').to.not.equal(undefined)
    const gossipPkg = JSON.parse(readFileSync(gossipPkgPath as string, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const gossipIfaceRange = gossipPkg.dependencies?.['@libp2p/interface']
    expect(gossipIfaceRange, 'Expected gossipsub to declare an @libp2p/interface dependency').to.not.equal(undefined)

    const hostIfacePath = resolveInstalled('@libp2p', 'interface', 'package.json')
    expect(hostIfacePath, 'Expected a host @libp2p/interface copy to be installed').to.not.equal(undefined)
    const hostIfaceVersion = (JSON.parse(readFileSync(hostIfacePath as string, 'utf8')) as { version: string }).version

    expect(
      majorOf(gossipIfaceRange as string) < majorOf(hostIfaceVersion),
      'gossipsub\'s @libp2p/interface range (' + String(gossipIfaceRange) + ') is no longer behind the ' +
      'host copy (' + hostIfaceVersion + '). The major skew may be resolved — re-run the device n=4 ' +
      'proof, confirm the `fns.shift(...) is not a function` errors are gone from the drone logs, and ' +
      'close .planning/quick/260731-fm3-file-upstream-issues-for-post-peerid-pat/issues/' +
      'db-p2p-gossipsub-libp2p3-stream-incompatibility.md.',
    ).to.equal(true)
  })

  it('the host Stream is a MessageStream while gossipsub\'s nested copy still expects a Duplex', () => {
    const hostStreamDts = resolveInstalled(...HOST_IFACE_STREAM_DTS)
    expect(hostStreamDts, 'Expected @libp2p/interface dist/src/stream.d.ts to be installed').to.not.equal(undefined)
    const hostSrc = readFileSync(hostStreamDts as string, 'utf8')
    expect(
      hostSrc.includes(MESSAGE_STREAM_MARKER),
      'Expected the host @libp2p/interface to define `' + MESSAGE_STREAM_MARKER + '` (the libp2p-3 ' +
      'shape with no .source/.sink). If this changed, re-verify the gossipsub issue draft\'s mechanism.',
    ).to.equal(true)

    // The nested v2 copy is the one gossipsub was compiled against — a Duplex with .source/.sink.
    const nestedPkg = resolveInstalled(...GOSSIPSUB_NESTED_IFACE)
    if (nestedPkg === undefined) {
      // No nested copy => the skew is gone. That is the fixed state, not the tracked defect.
      expect.fail(
        'gossipsub no longer carries a nested @libp2p/interface copy — the major skew appears resolved. ' +
        'Re-run the device n=4 proof and close the db-p2p-gossipsub-libp2p3-stream-incompatibility.md draft.',
      )
    }
    const nestedConnDts = join(dirname(nestedPkg as string), 'dist', 'src', 'connection.d.ts')
    expect(existsSync(nestedConnDts), 'Expected the nested @libp2p/interface connection.d.ts').to.equal(true)
    expect(
      readFileSync(nestedConnDts, 'utf8').includes(DUPLEX_STREAM_MARKER),
      'Expected gossipsub\'s nested @libp2p/interface to define `' + DUPLEX_STREAM_MARKER + '` — the ' +
      'libp2p-2 duplex shape whose absence at runtime causes `fns.shift(...) is not a function`.',
    ).to.equal(true)
  })

  it('db-p2p still declares the incompatible pairing in its own manifest', () => {
    const dbP2pPkgPath = resolveInstalled('@optimystic', 'db-p2p', 'package.json')
    expect(dbP2pPkgPath, 'Expected @optimystic/db-p2p to be installed').to.not.equal(undefined)
    const pkg = JSON.parse(readFileSync(dbP2pPkgPath as string, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = pkg.dependencies ?? {}
    const libp2pRange = deps.libp2p
    const gossipRange = deps['@chainsafe/libp2p-gossipsub']

    expect(libp2pRange, 'Expected db-p2p to depend on libp2p').to.not.equal(undefined)
    expect(gossipRange, 'Expected db-p2p to depend on @chainsafe/libp2p-gossipsub').to.not.equal(undefined)
    expect(
      majorOf(libp2pRange as string) >= 3 && majorOf(gossipRange as string) <= 14,
      'db-p2p\'s libp2p (' + String(libp2pRange) + ') / gossipsub (' + String(gossipRange) + ') pairing ' +
      'changed. If gossipsub moved past 14 (libp2p-3 aware) or was dropped, this blocker is likely ' +
      'FIXED — close the db-p2p-gossipsub-libp2p3-stream-incompatibility.md draft.',
    ).to.equal(true)
  })
})
