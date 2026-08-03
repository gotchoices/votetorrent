/**
 * strand-cohort-routing-coverage.spec.ts
 *
 * P2P-11 gap-closure regression lock for 41-04's strand-cohort-formation fix on the published
 * `@serfab/cadre-core@0.8.1` / `@optimystic/db-p2p@0.14.1` substrate.
 *
 * History: 41-03 hit a NEW dominant wall on the published substrate — `strandPeers=0` on Peer A,
 * with the drone D-08 histogram dominated by `NoValidAddressesError: no valid addresses for peer`
 * (132x). 41-04's diagnosis (41-04-STRAND-COHORT-DIAGNOSIS.md) found the app's D-05 relay-qualified
 * addressing posture (`STRAND_RELAY_LISTEN_ADDRS` in both `replication-proof-runner.ts` and
 * `CadreNodeProvider.tsx`) was ALREADY correct since 41-02 — this spec's job is to confirm that
 * posture has NOT regressed (parity anchor, reusing `relay-reservation-coverage.spec.ts`'s
 * extraction/comment-strip/concatenation-marker patterns verbatim), not to lock a NEW app-file
 * shape. The actual fix landed one layer below app config: `@optimystic/db-p2p@0.14.1`'s
 * `createLibp2pNodeBase` registers `identify()` but never its companion `identifyPush()` service,
 * so a relay-only peer's address gained AFTER an existing connection is established never
 * propagates to an already-connected sibling's peerStore — the exact mechanism behind the
 * dominant `NoValidAddressesError` signal. The fix is a `.yarn/patches/@optimystic-db-p2p-*`
 * yarn-patch adding `identifyPush` to that services map, resolved via a root `package.json`
 * `resolutions` entry. This spec locks BOTH halves: the unchanged app-side addressing posture
 * (parity across the two libp2p-node-construction sites, Probe 1: no per-node-type override
 * exists) AND the yarn-patch's presence/content/resolution-wiring (a silent revert of either
 * would reopen the 41-03 wall without any other signal changing).
 *
 * Does NOT resurrect any of the 8 `describe.skip`'d Phase-38 vendor-path specs (Pitfall 3 — they
 * `readFileSync` a `vendor/` path Phase 40 deleted). All markers are built by string concatenation
 * so this spec's own prose can never self-satisfy an assertion it defines.
 *
 * 41-06 EXTENSION: the device n=4 re-prove (41-05) with the identifyPush patch live shifted the
 * dominant wall to the p2p-fret strand-discovery protocol layer — FRET `UnsupportedProtocolError`
 * jumped ~6x -> 77x, plus a malformed `//optimystic/strand-<id>/id/1.0.0` double-slash (6x).
 * 41-06's diagnosis (41-06-FRET-NEGOTIATION-DIAGNOSIS.md) root-caused the double-slash to
 * `@optimystic/db-p2p` passing an already-slash-prefixed `protocolPrefix` into `@libp2p/identify`
 * (which itself prepends another leading slash), and found a real async-completeness gap in
 * `p2p-fret`: `registerRpcHandlers()` never awaited its four fire-and-forget `node.handle(...)`
 * registrations, so the Startable `start()` chain could resolve before the FRET handlers'
 * `peerStore` advertisement had actually settled. The fix is TWO yarn-patches: the existing
 * `@optimystic/db-p2p` patch EXTENDED with the single-slash `protocolPrefix` correction
 * (identifyPush kept, unchanged in behavior), and a NEW sibling `p2p-fret` patch making
 * `registerPing`/`registerNeighbors`/`registerMaybeAct`/`registerLeave` return their
 * `node.handle()` promise and `FretService.start()` await `registerRpcHandlers()`. This extension
 * locks BOTH new hunks + BOTH resolution entries — a silent revert of either must fail this spec.
 *
 * 41-08 EXTENSION: the device n=4 re-prove (41-07) with the 41-06 fixes live left the wall
 * PARTIALLY closed — the malformed `//id` double-slash was confirmed gone (6x -> 0x) but the
 * well-formed FRET `fret/1.0.0/{ping,neighbors}` handlers were STILL not negotiable
 * (`UnsupportedProtocolError` 89x). 41-07's route-forward named the multi-copy
 * `@libp2p/interface` registrar skew as the prime suspect; 41-08's diagnosis
 * (41-08-FRET-REGISTRAR-SKEW-DIAGNOSIS.md) FALSIFIED that hypothesis (Registrar is a
 * single-copy `libp2p`-owned class; `@libp2p/interface` exports only types + two
 * `Symbol.for()`-keyed capability tags) and instead found + reproduced a REAL defect: none of
 * `p2p-fret`'s five outbound RPC senders (`sendPing`, `fetchNeighbors`, `announceNeighbors`,
 * `sendMaybeAct`, `sendLeave`) passed `{ runOnLimitedConnection: true }`, so every FRET dial over
 * a circuit-relay-v2 "limited" connection (the on-device NAT-only reachability shape between
 * strand-cohort members) threw `LimitedConnectionError` before multistream-select ever ran. The
 * fix (at the time) EXTENDED the same `p2p-fret` patch (41-06's async-completeness hunks kept
 * byte-identical) with `runOnLimitedConnection: true` at all eight call-site branches across the
 * five senders.
 *
 * 260715-keg ADOPTION (patch dropped in favor of `p2p-fret ^0.6.0`): a Node relay-gate experiment
 * (`relay-multi-peer-smoke.mjs`, 2026-07-15) proved unpatched `p2p-fret@0.6.0` forms the strand
 * cohort (STRAND-COHORT SMOKE PASS, `strandPeers 2/2`, reproducible 3/3) where the hand-patched
 * `0.4.0` cannot (FAIL, `strandPeers 0/0`). `0.6.0`'s `openRpcStream()` centralizes stream opening
 * with `{ runOnLimitedConnection: true, negotiateFully: false }` and prefers direct-over-limited —
 * carrying the 41-08 `runOnLimitedConnection` fix AND additional cohort-formation fixes upstream.
 * The local `p2p-fret-npm-0.4.0-*.patch` (41-06's async-completeness hunks + the 41-08
 * runOnLimitedConnection hunks) is RETIRED entirely — dropped in favor of a bare `^0.6.0`
 * resolution. This spec section inverts to lock the NEW reality: NO p2p-fret patch exists under
 * `.yarn/patches/`, and the root `package.json` bare `p2p-fret` resolution key targets a bare
 * (non-`patch:`) semver range `>=0.6.0` — a silent revert to the retired `0.4.0` patch string
 * fails these assertions immediately (it starts with the `patch:` protocol marker). The
 * `@optimystic/db-p2p` patch (identifyPush + single-slash protocolPrefix) is UNAFFECTED and stays
 * locked exactly as before.
 *
 * 41-10 EXTENSION (diagnosis-only — NO new patch/resolution): the 41-09 device n=4 re-prove on
 * the `^0.6.0` substrate localized the residual wall to strand-node relay-ADDRESS ROUTING across
 * the emulator NAT (`relayAddrsPerDrone=0`, `NoValidAddressesError` 56x, `UnsupportedProtocolError`
 * 52x) despite the control network forming fine. 41-10's diagnosis
 * (41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md) REFUTES the prime suspect (the app's relay-qualified
 * `STRAND_RELAY_LISTEN_ADDRS` does reach the strand node's `addresses.listen` — traced file:line
 * through `cadre-node.js`/`strand-instance-manager.js`/`libp2p-node-base.js`) and instead
 * CONFIRMS, via a Node/loopback reproduction, a shared-PeerId relay-reservation/hop-connect
 * collision: the control node and every per-strand libp2p node instance share one PeerId and dial
 * the same relay, and `@libp2p/circuit-relay-v2`'s server-side reservation store + hop-connect
 * delivery are keyed solely by PeerId — a sibling's hop-connect meant for the strand node's own
 * connection can be delivered to the control node's connection instead. This extension locks the
 * presence of the new `STRAND-RELAY-ROUTING SMOKE` Node-gate probe added to
 * `relay-multi-peer-smoke.js` (the config-divergence check + the shared-identity collision
 * sub-check) — a silent revert of either would remove this diagnosis's regression coverage with
 * no other signal changing. NO new patch/resolution assertion is added (no fix landed this plan);
 * all prior db-p2p-patch + p2p-fret-^0.6.0-no-patch + app-parity assertions above stay unchanged.
 */

import { expect } from 'chai'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('strand-cohort-routing-coverage: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()
const CADRE_PROVIDER_PATH = join(
  REPO_ROOT, 'apps', 'VoteTorrentAuthority', 'src', 'providers', 'CadreNodeProvider.tsx'
)
const PROOF_RUNNER_PATH = join(
  REPO_ROOT, 'apps', 'VoteTorrentAuthority', 'src', 'engines', 'replication-proof-runner.ts'
)
const ROOT_PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json')
const YARN_PATCHES_DIR = join(REPO_ROOT, '.yarn', 'patches')
const RELAY_MULTI_PEER_SMOKE_PATH = join(
  REPO_ROOT, 'packages', 'p2p-probe-host', 'relay-multi-peer-smoke.js'
)

// Markers built by concatenation so this spec's own prose cannot satisfy them.
const NETWORK_OPEN = 'network' + ': {'
const NETWORK_CLOSE = 'hibernation' + ': { enabled: false }'
// The relay-qualified per-drone template-literal construction (RESEARCH Pattern 1) — declared as
// a top-level constant above the network body in both files, then referenced by identifier
// inside listenAddrs. Search the WHOLE (comment-stripped) file, not just the network-body slice.
const QUALIFIED_ADDR_TEMPLATE_MARKER = '${addr}' + '/p2p' + '-circuit'
// The listenAddrs assignment must reference the qualified-addrs constant by identifier.
const LISTEN_ADDRS_BY_IDENTIFIER_MARKER = 'listenAddrs' + ': ' + 'STRAND_RELAY_LISTEN_ADDRS'
// The retired direct-only advertise posture that MUST stay absent from the network body — a
// bare direct WS listen entry would defeat the whole point of relay-routing across the emulator
// NAT surface (D-02).
const DIRECT_ONLY_LISTEN_MARKER = 'listenAddrs' + ": ['/ip4/0.0.0.0/tcp/0/ws']"
// The dead `strandBootstrapNodes` field (41-04 finding: retired on the published substrate,
// replaced by cadre-core's own control-mesh strand-addr RPC) staying present-but-inert is fine —
// this spec does NOT assert its absence (that cleanup is explicitly deferred, per the diagnosis
// doc §6, to a future pass — asserting it here would over-scope this plan's diagnosed fix locus).

// identifyPush yarn-patch markers.
const IDENTIFY_PUSH_IMPORT_MARKER = 'identify, identify' + 'Push'
const IDENTIFY_PUSH_SERVICE_MARKER = 'identifyPush' + ': identifyPush('
const DB_P2P_PATCH_PREFIX = '@optimystic-db-p2p-npm-'
const DB_P2P_RESOLUTION_KEY_FRAGMENT = '@optimystic/db-p2p'
const PATCH_PROTOCOL_MARKER = 'patch' + ':'

// 41-06: malformed `//` id double-slash fix markers — the CORRECTED (single-slash) protocolPrefix
// value, as it appears on an ADDED (`+`) diff line, built by concatenation so this spec's own
// prose (which quotes both the malformed and corrected forms above) can never self-satisfy it.
const CORRECTED_PROTOCOL_PREFIX_ADDED_LINE =
  '+' + '                protocolPrefix: ' + '`optimystic/${options.networkName}`'
// The retired malformed shape (leading-slash protocolPrefix fed to identify/identifyPush) — this
// must NOT remain on any ADDED line (it legitimately still appears on the REMOVED `-` context
// line the diff carries, which is fine and expected).
const MALFORMED_PROTOCOL_PREFIX_ADDED_LINE =
  '+' + '                protocolPrefix: ' + '`/optimystic/${options.networkName}`'

// p2p-fret patch-file naming prefix — used by findP2pFretPatchFile() to assert its ABSENCE
// under the 260715-keg ^0.6.0 adoption (no patch content markers survive; the patch is retired).
const P2P_FRET_PATCH_PREFIX = 'p2p-fret-npm-'
const P2P_FRET_RESOLUTION_KEY = 'p2p-fret'
// 260715-keg: the bare-semver resolution the p2p-fret key must now target — `>=0.6.0`, not the
// `patch:` protocol. Checked via a non-`patch:` prefix + a `^0.<minor>.` shape with minor >= 6.
const P2P_FRET_MIN_MINOR = 6

// Built via concatenation so this spec's own source is not itself a hit.
const PHASE_41_04_MARKER = '41' + '-04'

// 41-10: the STRAND-RELAY-ROUTING Node-gate probe markers (relay-multi-peer-smoke.js). Built by
// concatenation so this spec's own prose (which quotes the same strings above, in the file
// header comment) can never self-satisfy an assertion built against the PROBE FILE's source.
const STRAND_RELAY_ROUTING_FN_MARKER = 'async function runStrandRelayRouting' + 'ConfigCheck'
const STRAND_RELAY_ROUTING_SUBCHECK_FN_MARKER =
  'async function runStrandRelayRoutingShared' + 'IdentitySubCheck'
const STRAND_RELAY_ROUTING_SMOKE_FN_MARKER = 'async function runStrandRelayRouting' + 'Smoke'
const STRAND_RELAY_ROUTING_VERDICT_MARKER = 'STRAND' + '-RELAY-ROUTING SMOKE' + ':'
const STRAND_RELAY_ROUTING_SUBCHECK_VERDICT_MARKER =
  'STRAND' + '-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK' + ':'
const CREATE_LIBP2P_NODE_CALL_MARKER = 'createLibp2pNode' + '('
const GET_MULTIADDRS_CIRCUIT_MARKER = 'getMultiaddrs' + '()' + '.map'
const CIRCUIT_SUFFIX_MARKER = '/p2p' + '-circuit'
const SHARED_KEYPAIR_MARKER = 'generateKeyPair' + "('Ed25519')"
const SHARED_PEERID_ASSERT_MARKER = 'controlMimic.peerId.toString()' + ' !== ' + 'strandMimic.peerId.toString()'

/** Slice the `network: { ... }` config body (open marker -> next top-level close marker). */
function extractNetworkBody (src: string, path: string): string {
  const start = src.indexOf(NETWORK_OPEN)
  expect(start, `Expected to find "${NETWORK_OPEN}" in ${path}`).to.be.greaterThan(-1)
  const end = src.indexOf(NETWORK_CLOSE, start)
  expect(end, `Expected to find "${NETWORK_CLOSE}" after "${NETWORK_OPEN}" in ${path}`).to.be.greaterThan(start)
  return src.slice(start, end)
}

/**
 * Strip full-line comments (//, /*, *) before searching a body — a fix's own explanatory
 * comment referencing a marker must not false-satisfy an assertion (the 38-18 deviation lesson).
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
 * Shared per-file assertion set — both `CadreNodeProvider.tsx` and `replication-proof-runner.ts`
 * must still carry the D-05 relay-qualified strand-routing posture (the parity anchor: Probe 1
 * confirms cadre-core forwards ONE shared `network` object to the control node AND every strand,
 * so a one-file-only regression must fail this check on the drifted file).
 */
function assertStrandRelayRoutingIntact (path: string, label: string): void {
  const fullSrc = readFileSync(path, 'utf8')
  const strippedFullSrc = stripCommentLines(fullSrc)
  const body = stripCommentLines(extractNetworkBody(fullSrc, path))

  expect(
    strippedFullSrc.includes(QUALIFIED_ADDR_TEMPLATE_MARKER),
    `Expected ${label} to still construct a relay-qualified per-drone listenAddrs entry ` +
    '(the `${addr}/p2p-circuit` template literal) — not merely a comment reference'
  ).to.equal(true)
  expect(
    body.includes(LISTEN_ADDRS_BY_IDENTIFIER_MARKER),
    `Expected ${label} network.listenAddrs to still be assigned the qualified-addrs constant by ` +
    'identifier (STRAND_RELAY_LISTEN_ADDRS), not a bare/direct array literal'
  ).to.equal(true)
  expect(
    body.includes(DIRECT_ONLY_LISTEN_MARKER),
    `Expected the retired direct-only listenAddrs posture to be absent from ${label}'s network ` +
    'config (a direct listen address would defeat relay-routing across the emulator NAT surface)'
  ).to.equal(false)
}

/** Find the (single) committed @optimystic/db-p2p yarn-patch file, or undefined if absent. */
function findDbP2pPatchFile (): string | undefined {
  if (!existsSync(YARN_PATCHES_DIR)) return undefined
  const entries = readdirSync(YARN_PATCHES_DIR)
  return entries.find((f) => f.startsWith(DB_P2P_PATCH_PREFIX) && f.endsWith('.patch'))
}

/**
 * Resolve an installed @optimystic/db-p2p's `dist/src/libp2p-node-base.js`, or undefined.
 * The workspace is nohoist'd, so db-p2p lands in per-workspace node_modules rather than the
 * repo root; check each known consumer in turn. Any copy proves the invariant — the lockfile
 * resolves db-p2p to a single version (asserted by the published-stack-lock spec).
 */
function resolveDbP2pNodeBase (): string | undefined {
  const candidates = [
    join(REPO_ROOT, 'packages', 'p2p-probe-host'),
    join(REPO_ROOT, 'apps', 'VoteTorrentAuthority'),
    join(REPO_ROOT, 'apps', 'VoteTorrentVoter'),
    REPO_ROOT,
  ]
  for (const base of candidates) {
    const p = join(base, 'node_modules', '@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-node-base.js')
    if (existsSync(p)) return p
  }
  return undefined
}

/** Find the (single) committed p2p-fret yarn-patch file, or undefined if absent. */
function findP2pFretPatchFile (): string | undefined {
  if (!existsSync(YARN_PATCHES_DIR)) return undefined
  const entries = readdirSync(YARN_PATCHES_DIR)
  return entries.find((f) => f.startsWith(P2P_FRET_PATCH_PREFIX) && f.endsWith('.patch'))
}

/**
 * 260715-keg: assert a root package.json resolution target is a BARE (non-`patch:`) semver range
 * whose `0.x` minor is `>= P2P_FRET_MIN_MINOR` — the shape the p2p-fret key must have now that the
 * local patch is retired in favor of an upstream version bump. A silent revert to the `0.4.0`
 * patch string fails the first check (it starts with `patch:`); a revert to a bare `0.4.0`/`0.5.0`
 * would fail the second (minor < 6).
 */
function assertBareResolutionAtLeastMinor (target: string, packageLabel: string, minMinor: number): void {
  expect(
    target.startsWith(PATCH_PROTOCOL_MARKER),
    `Expected the ${packageLabel} resolution to NOT target a patch: protocol reference ` +
    `(found: ${target}) — the local patch is retired in favor of an upstream version bump`
  ).to.equal(false)
  const match = /^\^?0\.(\d+)\./.exec(target)
  expect(
    match,
    `Expected the ${packageLabel} resolution to be a bare 0.x semver range (found: ${target})`
  ).to.not.equal(null)
  const minor = Number((match as RegExpExecArray)[1])
  expect(
    minor >= minMinor,
    `Expected the ${packageLabel} resolution minor version to be >= ${minMinor} (found: ${target})`
  ).to.equal(true)
}

/** Count how many lines of `src` are exactly (or start with, after trimming) `marker`. */
function countMatchingLines (src: string, marker: string): number {
  return src.split('\n').filter((line) => line.includes(marker)).length
}

/**
 * 41-10: slice a named function's body out of `relay-multi-peer-smoke.js` — from its
 * `async function <name>` declaration up to the next top-level `async function` declaration (or
 * EOF). Mirrors `extractNetworkBody`'s open-marker/next-marker slicing so a marker assertion is
 * scoped to THIS probe's own code, not merely "appears somewhere in the file" (which the file
 * header's prose describing the probe would otherwise satisfy).
 */
function extractFunctionBody (src: string, startMarker: string, label: string): string {
  const start = src.indexOf(startMarker)
  expect(start, `Expected to find "${startMarker}" in ${label}`).to.be.greaterThan(-1)
  const nextFnStart = src.indexOf('async function ', start + startMarker.length)
  const end = nextFnStart === -1 ? src.length : nextFnStart
  expect(end, `Expected to find the end of "${startMarker}" in ${label}`).to.be.greaterThan(start)
  return src.slice(start, end)
}

/**
 * ADDED (`+`), non-comment lines of a unified diff patch — a fix's own explanatory comment
 * (which may legitimately quote the same code shape it introduces, e.g. inside backticks) must
 * not false-satisfy a CODE-presence assertion. Used by the phase-number-leak checks below.
 */
function addedNonCommentLines (patchSrc: string): string[] {
  return patchSrc
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .map((l) => l.slice(1)) // strip the diff `+` marker before comment-sniffing
    .filter((l) => {
      const t = l.trim()
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')
    })
}

describe('P2P-11/41-04: strand-cohort NoValidAddressesError fix — app-side parity intact + identifyPush yarn-patch present', () => {
  it('both apps/ source files exist at the expected paths', () => {
    expect(existsSync(CADRE_PROVIDER_PATH), `Expected ${CADRE_PROVIDER_PATH}`).to.equal(true)
    expect(existsSync(PROOF_RUNNER_PATH), `Expected ${PROOF_RUNNER_PATH}`).to.equal(true)
  })

  it('CadreNodeProvider.tsx: D-05 relay-qualified strand-routing posture intact (unchanged since 41-02)', () => {
    assertStrandRelayRoutingIntact(CADRE_PROVIDER_PATH, 'CadreNodeProvider.tsx')
  })

  it('replication-proof-runner.ts: D-05 relay-qualified strand-routing posture intact (unchanged since 41-02)', () => {
    assertStrandRelayRoutingIntact(PROOF_RUNNER_PATH, 'replication-proof-runner.ts')
  })

  it('parity anchor: both files satisfy the identical structural shape (no per-node-type network override, Probe 1)', () => {
    // If either file's addressing posture had regressed (a one-file drift), the corresponding
    // call would throw — reproducible by reasoning: temporarily reverting either file's
    // listenAddrs assignment to a direct-only literal fails that file's own assertion above.
    expect(() => assertStrandRelayRoutingIntact(CADRE_PROVIDER_PATH, 'CadreNodeProvider.tsx')).to.not.throw()
    expect(() => assertStrandRelayRoutingIntact(PROOF_RUNNER_PATH, 'replication-proof-runner.ts')).to.not.throw()
  })

  // The identifyPush + slash-stripped-protocolPrefix fixes were carried by a local
  // yarn-patch against @optimystic/db-p2p@0.14.1 (phases 41-04 / 41-06). Upstream
  // ABSORBED both in 0.16.3 — its dist/src/libp2p-node-base.js imports identifyPush,
  // registers the service, and passes the slash-stripped `optimystic/<network>` prefix
  // to identify/identifyPush while keeping the slash-prefixed form for every other
  // service. The patch was therefore retired rather than forward-ported.
  //
  // These guards deliberately assert against the INSTALLED PACKAGE rather than a patch
  // file: the invariant that matters is "the shipped db-p2p registers identifyPush",
  // and checking the resolved dist proves that whether the fix arrives via patch or
  // upstream. A patch-file check would now pass vacuously off an orphaned patch file.
  it('the resolved @optimystic/db-p2p registers identifyPush alongside identify()', () => {
    const nodeBase = resolveDbP2pNodeBase()
    expect(
      nodeBase,
      'Expected to resolve @optimystic/db-p2p dist/src/libp2p-node-base.js from an installed copy'
    ).to.not.equal(undefined)
    const src = readFileSync(nodeBase as string, 'utf8')
    expect(
      src.includes(IDENTIFY_PUSH_IMPORT_MARKER),
      'Expected the installed db-p2p to import identifyPush alongside identify from @libp2p/identify (41-04 fix)'
    ).to.equal(true)
    expect(
      src.includes(IDENTIFY_PUSH_SERVICE_MARKER),
      'Expected the installed db-p2p to register an identifyPush service in the shared services map (41-04 fix)'
    ).to.equal(true)
    expect(
      src.includes('protocolPrefix: `optimystic/${options.networkName}`'),
      'Expected the installed db-p2p to pass the slash-STRIPPED protocolPrefix to identify/identifyPush ' +
      '(41-06 fix — a leading slash yields the malformed double-slash `//optimystic/...` protocol string)'
    ).to.equal(true)
  })

  it('root package.json pins @optimystic/db-p2p at >= 0.16.3 (the release that upstreamed the identifyPush fix)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    // Exact match on the db-p2p package itself — a substring `.includes()` would also match the
    // SIBLING `@optimystic/db-p2p-storage-rn` package (a different resolution entry), so require
    // the key to be exactly the fragment or the fragment plus a version qualifier (`@npm:...`),
    // never a longer package name.
    const dbP2pEntry = Object.entries(resolutions).find(
      ([key]) => key === DB_P2P_RESOLUTION_KEY_FRAGMENT || key.startsWith(DB_P2P_RESOLUTION_KEY_FRAGMENT + '@')
    )
    expect(
      dbP2pEntry,
      `Expected a root package.json resolutions entry for ${DB_P2P_RESOLUTION_KEY_FRAGMENT}`
    ).to.not.equal(undefined)
    const [, target] = dbP2pEntry as [string, string]
    const minor = /^\^?0\.(\d+)\./.exec(target)
    expect(
      minor !== null && Number(minor[1]) >= 16,
      `Expected the ${DB_P2P_RESOLUTION_KEY_FRAGMENT} resolution to target >= 0.16.x (found: ${target}) — ` +
      'earlier lines predate the upstreamed identifyPush/protocolPrefix fixes and would need the retired yarn-patch'
    ).to.equal(true)
  })

  it('no GSD phase number appears on a runtime (non-comment) line of either app file or this spec\'s own assertions', () => {
    const providerLines = runtimeLines(readFileSync(CADRE_PROVIDER_PATH, 'utf8'))
    const runnerLines = runtimeLines(readFileSync(PROOF_RUNNER_PATH, 'utf8'))
    const isOffender = (l: string): boolean => l.includes(PHASE_41_04_MARKER)
    const offenders = [...providerLines, ...runnerLines].filter(isOffender)
    expect(
      offenders,
      `Expected no runtime line to carry a GSD phase number; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})

describe('P2P-11/41-06: FRET strand-discovery negotiation gap — malformed // id double-slash fix present; p2p-fret patch dropped for bare ^0.6.0 (260715-keg)', () => {
  it('the committed @optimystic/db-p2p patch corrects the malformed // id double-slash for BOTH identify and identifyPush', () => {
    const patchFile = findDbP2pPatchFile()
    expect(patchFile, 'Expected the db-p2p patch file to exist (see prior describe block)').to.not.equal(undefined)
    const patchSrc = readFileSync(join(YARN_PATCHES_DIR, patchFile as string), 'utf8')

    // Exactly two ADDED lines carry the corrected (single-slash) protocolPrefix value — one for
    // identify, one for identifyPush. A silent revert of either would drop this count to 1 or 0.
    expect(
      countMatchingLines(patchSrc, CORRECTED_PROTOCOL_PREFIX_ADDED_LINE),
      'Expected exactly 2 added lines with the corrected single-slash protocolPrefix ' +
      '(identify + identifyPush) — a silent revert of either would change this count'
    ).to.equal(2)

    // The retired malformed (leading-slash) form must NOT remain on any ADDED line — it is
    // expected and fine as a REMOVED (`-`) context line (that is simply the diff showing what
    // was fixed), but must not have been silently re-introduced as a new addition.
    expect(
      countMatchingLines(patchSrc, MALFORMED_PROTOCOL_PREFIX_ADDED_LINE),
      'Expected NO added line to re-introduce the malformed leading-slash protocolPrefix value'
    ).to.equal(0)

    // identifyPush (41-04) stays intact alongside the 41-06 double-slash fix.
    expect(
      patchSrc.includes(IDENTIFY_PUSH_IMPORT_MARKER) && patchSrc.includes(IDENTIFY_PUSH_SERVICE_MARKER),
      'Expected the 41-04 identifyPush hunk to remain present alongside the 41-06 double-slash fix'
    ).to.equal(true)
  })

  it('260715-keg: NO p2p-fret yarn-patch exists under .yarn/patches/ (patch dropped in favor of ^0.6.0)', () => {
    const patchFile = findP2pFretPatchFile()
    expect(
      patchFile,
      `Expected NO ${P2P_FRET_PATCH_PREFIX}*.patch file under ${YARN_PATCHES_DIR} — a silent ` +
      're-add of the retired 0.4.0 patch (or any stub matching this prefix) fails here'
    ).to.equal(undefined)
  })

  it('260715-keg: root package.json resolves the bare p2p-fret key to a bare >=0.6.0 semver (not the patch protocol)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    const target = resolutions[P2P_FRET_RESOLUTION_KEY]
    expect(
      target,
      `Expected a root package.json resolutions entry for the bare "${P2P_FRET_RESOLUTION_KEY}" key`
    ).to.not.equal(undefined)
    assertBareResolutionAtLeastMinor(target as string, P2P_FRET_RESOLUTION_KEY, P2P_FRET_MIN_MINOR)
  })

  it('260715-keg: keeps exactly one bare p2p-fret resolution key (no range-scoped sibling)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    // A range-scoped sibling key (e.g. `p2p-fret@npm:^0.5.0`) would be silently shadowed by the
    // bare key (41-06 diagnosis §7 finding, re-confirmed by 41-08's own yarn patch-commit
    // workflow auto-adding one) — this must never regress.
    const p2pFretKeys = Object.keys(resolutions).filter(
      (key) => key === P2P_FRET_RESOLUTION_KEY || key.startsWith(P2P_FRET_RESOLUTION_KEY + '@')
    )
    expect(
      p2pFretKeys,
      `Expected exactly one p2p-fret resolution key (the bare "${P2P_FRET_RESOLUTION_KEY}"); ` +
      `found: ${JSON.stringify(p2pFretKeys)} — a range-scoped sibling key would be silently shadowed`
    ).to.deep.equal([P2P_FRET_RESOLUTION_KEY])
  })

  it('no GSD phase number appears in a runtime-emitted string of the db-p2p yarn-patch (p2p-fret patch no longer exists)', () => {
    const dbP2pPatchFile = findDbP2pPatchFile()
    expect(dbP2pPatchFile, 'Expected the db-p2p patch file to exist').to.not.equal(undefined)
    // Patch comments carry phase markers (e.g. "VoteTorrent patch (41-06)") by design/convention —
    // those are comment lines, not runtime-emitted strings. Only ADDED, non-comment source lines
    // matter here; the patch's added CODE lines (as opposed to its comments) reference no phase
    // number at all, so this simply confirms no phase-number literal leaked into a
    // string/template-literal a running node would ever log or throw.
    const dbP2pAddedCodeLines = addedNonCommentLines(readFileSync(join(YARN_PATCHES_DIR, dbP2pPatchFile as string), 'utf8'))
    const offenders = dbP2pAddedCodeLines.filter(
      (l) => l.includes(PHASE_41_04_MARKER) || l.includes('41' + '-06') || l.includes('41' + '-08')
    )
    expect(
      offenders,
      `Expected no added CODE line (non-comment) to carry a GSD phase number; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})

describe('P2P-11/41-08: FRET strand registrar-skew — runOnLimitedConnection fix now carried by p2p-fret ^0.6.0 upstream (260715-keg; db-p2p patch kept)', () => {
  it('260715-keg: the db-p2p half (identifyPush + single-slash protocolPrefix) is the only surviving "prior patch present" assertion', () => {
    const dbP2pPatchFile = findDbP2pPatchFile()
    expect(dbP2pPatchFile, 'Expected the db-p2p patch file to exist').to.not.equal(undefined)
    const dbP2pPatchSrc = readFileSync(join(YARN_PATCHES_DIR, dbP2pPatchFile as string), 'utf8')

    // 41-04 identifyPush + 41-06 single-slash (same db-p2p patch, untouched by this plan).
    expect(
      dbP2pPatchSrc.includes(IDENTIFY_PUSH_IMPORT_MARKER) && dbP2pPatchSrc.includes(IDENTIFY_PUSH_SERVICE_MARKER),
      'Expected the 41-04 identifyPush hunk to remain present'
    ).to.equal(true)
    expect(
      countMatchingLines(dbP2pPatchSrc, CORRECTED_PROTOCOL_PREFIX_ADDED_LINE),
      'Expected the 41-06 single-slash protocolPrefix fix to remain present (2 added lines)'
    ).to.equal(2)

    // The p2p-fret patch (41-06 async-completeness + 41-08 runOnLimitedConnection) is RETIRED —
    // that fix now lives upstream in p2p-fret ^0.6.0's openRpcStream(), not in a local patch file.
    expect(
      findP2pFretPatchFile(),
      'Expected NO p2p-fret patch file to exist — the runOnLimitedConnection + async-completeness ' +
      'fixes are superseded by the ^0.6.0 version bump'
    ).to.equal(undefined)
  })

  it('260715-keg: p2p-fret still resolves to a bare >=0.6.0 semver (carries the runOnLimitedConnection + cohort-formation fixes upstream)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    const p2pFretKeys = Object.keys(resolutions).filter(
      (key) => key === P2P_FRET_RESOLUTION_KEY || key.startsWith(P2P_FRET_RESOLUTION_KEY + '@')
    )
    expect(
      p2pFretKeys,
      `Expected exactly one p2p-fret resolution key (the bare "${P2P_FRET_RESOLUTION_KEY}"); ` +
      `found: ${JSON.stringify(p2pFretKeys)} — a range-scoped sibling key would be silently shadowed`
    ).to.deep.equal([P2P_FRET_RESOLUTION_KEY])
    const target = resolutions[P2P_FRET_RESOLUTION_KEY] as string
    assertBareResolutionAtLeastMinor(target, P2P_FRET_RESOLUTION_KEY, P2P_FRET_MIN_MINOR)
  })
})

describe('P2P-11/41-10: strand-relay-routing diagnosis — Node D-02 gate probe present (diagnosis-only, no new patch)', () => {
  it('relay-multi-peer-smoke.js exists at the expected path', () => {
    expect(existsSync(RELAY_MULTI_PEER_SMOKE_PATH), `Expected ${RELAY_MULTI_PEER_SMOKE_PATH}`).to.equal(true)
  })

  it('the STRAND-RELAY-ROUTING config-divergence check function is present and inspects a strand-config createLibp2pNode\'s getMultiaddrs()/p2p-circuit addresses', () => {
    const src = readFileSync(RELAY_MULTI_PEER_SMOKE_PATH, 'utf8')
    const body = stripCommentLines(
      extractFunctionBody(src, STRAND_RELAY_ROUTING_FN_MARKER, 'relay-multi-peer-smoke.js')
    )
    expect(
      body.includes(CREATE_LIBP2P_NODE_CALL_MARKER),
      'Expected the STRAND-RELAY-ROUTING config-divergence check to build a strand-config node ' +
      'directly via createLibp2pNode (the D-02 workaround, no CadreNode wrapper)'
    ).to.equal(true)
    expect(
      body.includes(CIRCUIT_SUFFIX_MARKER),
      'Expected the STRAND-RELAY-ROUTING config-divergence check to inspect the strand node\'s ' +
      'advertised addresses for a relay-qualified /p2p-circuit entry'
    ).to.equal(true)
    expect(
      body.includes(STRAND_RELAY_ROUTING_VERDICT_MARKER),
      'Expected the STRAND-RELAY-ROUTING config-divergence check to print a ' +
      '"STRAND-RELAY-ROUTING SMOKE:" verdict line'
    ).to.equal(true)
  })

  it('the STRAND-RELAY-ROUTING shared-identity sub-check function is present and reproduces the shared-PeerId relay collision', () => {
    const src = readFileSync(RELAY_MULTI_PEER_SMOKE_PATH, 'utf8')
    const body = stripCommentLines(
      extractFunctionBody(src, STRAND_RELAY_ROUTING_SUBCHECK_FN_MARKER, 'relay-multi-peer-smoke.js')
    )
    expect(
      body.includes(SHARED_KEYPAIR_MARKER),
      'Expected the shared-identity sub-check to construct one generated Ed25519 keypair shared ' +
      'by both mimic nodes (mirrors CadreNode\'s shared control/strand identity)'
    ).to.equal(true)
    expect(
      body.includes(SHARED_PEERID_ASSERT_MARKER),
      'Expected the shared-identity sub-check to assert the two mimic nodes share one PeerId'
    ).to.equal(true)
    expect(
      body.includes(CREATE_LIBP2P_NODE_CALL_MARKER),
      'Expected the shared-identity sub-check to build its mimic/sibling nodes directly via ' +
      'createLibp2pNode (the D-02 workaround)'
    ).to.equal(true)
    expect(
      body.includes(STRAND_RELAY_ROUTING_SUBCHECK_VERDICT_MARKER),
      'Expected the shared-identity sub-check to print a ' +
      '"STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK:" verdict line'
    ).to.equal(true)
  })

  it('the STRAND-RELAY-ROUTING smoke entry point wires both checks into main() (retained verdicts must not regress)', () => {
    const src = readFileSync(RELAY_MULTI_PEER_SMOKE_PATH, 'utf8')
    const body = stripCommentLines(
      extractFunctionBody(src, STRAND_RELAY_ROUTING_SMOKE_FN_MARKER, 'relay-multi-peer-smoke.js')
    )
    expect(
      body.includes('runStrandRelayRouting' + 'ConfigCheck()'),
      'Expected runStrandRelayRoutingSmoke() to call the config-divergence check'
    ).to.equal(true)
    expect(
      body.includes('runStrandRelayRoutingShared' + 'IdentitySubCheck()'),
      'Expected runStrandRelayRoutingSmoke() to call the shared-identity sub-check'
    ).to.equal(true)
    // The retained prior verdicts (MULTI-PEER RELAY / STRAND-COHORT / FRET-NEGOTIATION /
    // REGISTRAR-SKEW) must still be present in the whole file — a regression would drop one.
    const stripped = stripCommentLines(src)
    for (const priorVerdict of [
      'MULTI' + '-PEER RELAY SMOKE' + ':',
      'STRAND' + '-COHORT SMOKE' + ':',
      'FRET' + '-NEGOTIATION SMOKE' + ':',
      'REGISTRAR' + '-SKEW SMOKE' + ':',
    ]) {
      expect(
        stripped.includes(priorVerdict),
        `Expected the retained verdict "${priorVerdict}" to remain present in relay-multi-peer-smoke.js`
      ).to.equal(true)
    }
  })

  it('the diagnosis doc is present and cites the key installed-dist + app-source file:line anchors', () => {
    const diagnosisPath = join(
      REPO_ROOT, '.planning', 'phases', '41-multi-peer-relay-close-published-substrate',
      '41-10-STRAND-RELAY-ROUTING-DIAGNOSIS.md'
    )
    expect(existsSync(diagnosisPath), `Expected ${diagnosisPath}`).to.equal(true)
    const doc = readFileSync(diagnosisPath, 'utf8')
    for (const anchor of [
      'strand-instance-manager.js',
      'libp2p-node-base.js',
      'replication-proof-runner.ts',
      'CadreNodeProvider.tsx',
      'listenAddrs',
      'identifyPush',
    ]) {
      expect(doc.includes(anchor), `Expected the diagnosis doc to cite "${anchor}"`).to.equal(true)
    }
  })

})
