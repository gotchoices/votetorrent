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
 * BLOCKER 1 RESOLVED 2026-08-05 (db-p2p 0.18.0). The mechanism worked as designed: the bump turned
 * the blocker-1 assertions RED, which is this spec's success condition, not a failure. 0.17's
 * `configuredClusterSize` yardstick (the replication factor, which a genesis cluster definitionally
 * cannot meet) was replaced by `assumedClusterSize` — "the smallest cohort this deployment can
 * genuinely field" — defaulting to `minAbsoluteClusterSize` (2) so that, per db-p2p's own
 * `cluster-policy.ts` prose, "an unconfigured two-node mesh must still be able to transact". The
 * `allowUnvalidatedSmallCluster` escape also moved from `libp2p-node-base.js` into the new
 * `cluster/cluster-policy.js` and still defaults false, which keeps issue 2 load-bearing.
 * Corroborated on device: the 2026-08-03 n=4 run on 0.18.0 logged 0 occurrences of
 * `membership-not-admitted:low-confidence-downsize`, previously the dominant signal.
 * Issue draft `db-p2p-membership-gate-blocks-cluster-genesis.md` is closed accordingly.
 * The blocker-1 assertions are INVERTED rather than deleted, so a regression to a
 * replication-factor yardstick fails here instead of silently reopening the deadlock.
 * SCOPE: this closes blocker 1 ONLY. P2P-11 stays open — the same device run still ended
 * `strandPeers=0` for unrelated reasons. Blockers 2 and 3 below are untouched and still RED-locked.
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
// RESOLVED 2026-08-05 in db-p2p 0.18.0 — the 0.17 yardstick `configuredClusterSize` (the
// replication factor) was replaced by `assumedClusterSize` (the operator's asserted cohort size),
// which DEFAULTS to a permissive 2. That is the genesis exemption this blocker tracked as missing.
const DB_P2P_CLUSTER_POLICY = ['@optimystic', 'db-p2p', 'dist', 'src', 'cluster', 'cluster-policy.js']
const ASSUMED_SIZE_UNDEFINED_ESCAPE = 'this.assumedClusterSize === undefined'
const ASSUMED_SIZE_YARDSTICK = 'this.admissionFloor(this.' + 'assumedClusterSize' + ')'
const MIN_ABSOLUTE_CLUSTER_SIZE_DECL = 'minAbsoluteClusterSize' + ' = 2'
const PERMISSIVE_DEFAULT_MARKER = 'assumedClusterSize: declaredCohortSize ?? ' + 'minAbsoluteClusterSize'
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

  it('RESOLVED in 0.18.0: the fail-closed branch now measures against a permissively-defaulted assumedClusterSize', () => {
    // INVERTED 2026-08-05 (was: 'the fail-closed branch still offers no genesis escape').
    //
    // This assertion did its job — it went RED on the 0.18.0 bump, which is the "GOOD NEWS" case
    // this spec's header describes. 0.17's `configuredClusterSize` yardstick is gone (0 occurrences);
    // 0.18 measures the low-confidence branch against `assumedClusterSize`, "the smallest cohort
    // this deployment can genuinely field", which defaults to `minAbsoluteClusterSize` (2)
    // precisely so — in db-p2p's own words — "an unconfigured two-node mesh must still be able to
    // transact". A genesis cluster is no longer rejected by the replication factor it cannot yet
    // meet, so `membership-not-admitted:low-confidence-downsize` no longer fires at genesis.
    //
    // Corroborated on device: the 2026-08-03 n=4 run on 0.18.0 observed 0 occurrences of that
    // reject reason (it was the dominant signal beforehand). P2P-11 remains open for unrelated
    // reasons — `strandPeers=0` persisted — so only THIS blocker is closed, not the umbrella.
    //
    // The assertion is kept, inverted, so a regression back to a replication-factor yardstick (or a
    // default that is not permissive) fails here rather than silently reopening the deadlock.
    const repoSrc = stripComments(readFileSync(resolveInstalled(...DB_P2P_CLUSTER_REPO) as string, 'utf8'))

    expect(
      repoSrc.includes(ASSUMED_SIZE_YARDSTICK),
      'Expected the low-confidence branch to measure against `' + ASSUMED_SIZE_YARDSTICK + '`. ' +
      'If this reverted to the replication factor, the genesis deadlock is BACK — re-open ' +
      '.planning/quick/260731-fm3-file-upstream-issues-for-post-peerid-pat/issues/' +
      'db-p2p-membership-gate-blocks-cluster-genesis.md and re-run the device n=4 proof.',
    ).to.equal(true)
    expect(
      repoSrc.includes(ASSUMED_SIZE_UNDEFINED_ESCAPE),
      'Expected the legacy-approve escape `' + ASSUMED_SIZE_UNDEFINED_ESCAPE + '` to survive the rename',
    ).to.equal(true)

    const policyPath = resolveInstalled(...DB_P2P_CLUSTER_POLICY)
    expect(policyPath, 'Expected db-p2p 0.18+ dist cluster/cluster-policy.js to be installed').to.not.equal(undefined)
    const policySrc = stripComments(readFileSync(policyPath as string, 'utf8'))

    expect(
      policySrc.includes(MIN_ABSOLUTE_CLUSTER_SIZE_DECL),
      'Expected `' + MIN_ABSOLUTE_CLUSTER_SIZE_DECL + '` — the permissive floor that makes genesis admissible',
    ).to.equal(true)
    expect(
      policySrc.includes(PERMISSIVE_DEFAULT_MARKER),
      'Expected the unconfigured default to fall back to the permissive floor (`' +
      PERMISSIVE_DEFAULT_MARKER + '`). If this now defaults to the replication factor, an ' +
      'unconfigured mesh cannot transact at genesis and the deadlock is back.',
    ).to.equal(true)
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

    // RELOCATED 2026-08-05: the escape hatch still exists and still defaults false, but 0.18.0
    // extracted it from `libp2p-node-base.js` into the dedicated `cluster/cluster-policy.js`
    // module — so reading it from the node base could no longer find it. Assert it where it lives
    // now. It stays fail-closed by default, which is what keeps issue 2 (cadre-core not forwarding
    // it) load-bearing rather than cosmetic; genesis is unblocked by the permissive
    // `assumedClusterSize` default instead, asserted above.
    const policySrc = stripComments(readFileSync(resolveInstalled(...DB_P2P_CLUSTER_POLICY) as string, 'utf8'))
    expect(
      policySrc.includes(ALLOW_SMALL_CLUSTER_KEY),
      'Expected db-p2p to expose the `' + ALLOW_SMALL_CLUSTER_KEY + '` cluster-policy option in ' +
      'cluster/cluster-policy.js (moved there in 0.18.0 from libp2p-node-base.js)',
    ).to.equal(true)
    expect(
      new RegExp(ALLOW_SMALL_CLUSTER_KEY + '[^\\n]*\\?\\?\\s*false').test(policySrc),
      'Expected `' + ALLOW_SMALL_CLUSTER_KEY + '` to still default to false (fail-closed) in db-p2p.',
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

describe('post-peerId-patch blocker 3 CLOSED: db-p2p no longer ships gossipsub at all', () => {
  // Was: db-p2p paired `@chainsafe/libp2p-gossipsub@14` (compiled against the libp2p-2 duplex
  // `Stream`) with `libp2p@3` (whose `Stream extends MessageStream` has no .source/.sink), so every
  // outbound gossipsub stream threw `fns.shift(...) is not a function`. Filed as
  // gotchoices/Optimystic#9.
  //
  // RESOLVED not by re-pairing but by REMOVAL: `@optimystic/db-p2p@0.25.1` dropped the gossipsub
  // dependency outright, and with it the 21 packages it dragged in. The three assertions below used
  // to prove the skew still existed; they now prove it cannot come back silently. A failure here
  // means gossipsub re-entered the tree — re-read Optimystic#9 before assuming that is safe.
  it('db-p2p declares no @chainsafe/libp2p-gossipsub dependency', () => {
    const dbP2pPkgPath = resolveInstalled('@optimystic', 'db-p2p', 'package.json')
    expect(dbP2pPkgPath, 'Expected @optimystic/db-p2p to be installed').to.not.equal(undefined)
    const pkg = JSON.parse(readFileSync(dbP2pPkgPath as string, 'utf8')) as {
      version: string
      dependencies?: Record<string, string>
    }
    const deps = pkg.dependencies ?? {}

    expect(deps.libp2p, 'Expected db-p2p to still depend on libp2p').to.not.equal(undefined)
    expect(majorOf(deps.libp2p as string) >= 3, 'Expected db-p2p to still be on libp2p 3.x or later').to.equal(true)
    expect(
      deps['@chainsafe/libp2p-gossipsub'],
      'db-p2p ' + pkg.version + ' has re-introduced a @chainsafe/libp2p-gossipsub dependency. That is the ' +
      'exact pairing gotchoices/Optimystic#9 documents as broken under libp2p 3 — verify the new range is ' +
      'libp2p-3 aware before accepting it, and restore the skew assertions this block replaced.',
    ).to.equal(undefined)
  })

  it('no @chainsafe/libp2p-gossipsub copy is installed anywhere in the tree', () => {
    expect(
      resolveInstalled(...GOSSIPSUB_PKG),
      'A @chainsafe/libp2p-gossipsub copy is installed again. Nothing in the stack should pull it since ' +
      'db-p2p 0.25.1 dropped it; find the new dependant before trusting this tree.',
    ).to.equal(undefined)
  })

  it('the host @libp2p/interface still defines the libp2p-3 MessageStream shape that made the pairing impossible', () => {
    // Kept as the anchor for WHY the removal was the fix: if the host Stream ever goes back to a
    // duplex, the original pairing stops being incompatible and this whole block needs re-deriving.
    const hostStreamDts = resolveInstalled(...HOST_IFACE_STREAM_DTS)
    expect(hostStreamDts, 'Expected @libp2p/interface dist/src/stream.d.ts to be installed').to.not.equal(undefined)
    const hostSrc = readFileSync(hostStreamDts as string, 'utf8')
    expect(
      hostSrc.includes(MESSAGE_STREAM_MARKER),
      'Expected the host @libp2p/interface to define `' + MESSAGE_STREAM_MARKER + '`. If the host Stream ' +
      'reverted to `' + DUPLEX_STREAM_MARKER + '`, re-derive this block from Optimystic#9.',
    ).to.equal(true)
  })
})
