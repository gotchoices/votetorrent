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
 * fix EXTENDS the same `p2p-fret` patch (41-06's async-completeness hunks kept byte-identical)
 * with `runOnLimitedConnection: true` at all eight call-site branches across the five senders.
 * This extension locks the new hunk — a silent revert would reopen the relay-only FRET-dial wall
 * without any other signal changing.
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

// 41-06: p2p-fret async-completeness fix markers.
const P2P_FRET_PATCH_PREFIX = 'p2p-fret-npm-'
const P2P_FRET_RESOLUTION_KEY = 'p2p-fret'
const RETURN_NODE_HANDLE_MARKER = 'return' + ' node.handle('
const AWAIT_REGISTER_RPC_HANDLERS_MARKER = 'await' + ' this.registerRpcHandlers()'
const ASYNC_REGISTER_RPC_HANDLERS_MARKER = 'async' + ' registerRpcHandlers()'
const VOID_NODE_HANDLE_ADDED_LINE = '+' + '    void node.handle('

// 41-08: registrar-skew diagnosis fix markers — p2p-fret's outbound RPC senders now pass
// `runOnLimitedConnection: true` so a FRET dial over a circuit-relay-v2 limited connection does
// not throw LimitedConnectionError before multistream-select ever runs.
const RUN_ON_LIMITED_CONNECTION_MARKER = 'runOnLimitedConnection' + ': true'

// Built via concatenation so this spec's own source is not itself a hit.
const PHASE_41_04_MARKER = '41' + '-04'

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

/** Find the (single) committed p2p-fret yarn-patch file, or undefined if absent. */
function findP2pFretPatchFile (): string | undefined {
  if (!existsSync(YARN_PATCHES_DIR)) return undefined
  const entries = readdirSync(YARN_PATCHES_DIR)
  return entries.find((f) => f.startsWith(P2P_FRET_PATCH_PREFIX) && f.endsWith('.patch'))
}

/** Count how many lines of `src` are exactly (or start with, after trimming) `marker`. */
function countMatchingLines (src: string, marker: string): number {
  return src.split('\n').filter((line) => line.includes(marker)).length
}

/**
 * ADDED (`+`), non-comment lines of a unified diff patch — a fix's own explanatory comment
 * (which may legitimately quote the same code shape it introduces, e.g. inside backticks) must
 * not false-satisfy a CODE-presence assertion. Reused by both the phase-number-leak check and
 * the 41-08 runOnLimitedConnection count below.
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

/** Count ADDED non-comment lines containing `marker` — the CODE-presence counterpart to countMatchingLines. */
function countAddedCodeLinesMatching (patchSrc: string, marker: string): number {
  return addedNonCommentLines(patchSrc).filter((l) => l.includes(marker)).length
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

  it('a @optimystic/db-p2p yarn-patch is committed under .yarn/patches/', () => {
    const patchFile = findDbP2pPatchFile()
    expect(
      patchFile,
      `Expected a @optimystic-db-p2p-*.patch file under ${YARN_PATCHES_DIR}`
    ).to.not.equal(undefined)
  })

  it('the committed @optimystic/db-p2p patch registers identifyPush alongside identify()', () => {
    const patchFile = findDbP2pPatchFile()
    expect(patchFile, 'Expected the db-p2p patch file to exist (see prior test)').to.not.equal(undefined)
    const patchSrc = readFileSync(join(YARN_PATCHES_DIR, patchFile as string), 'utf8')
    expect(
      patchSrc.includes(IDENTIFY_PUSH_IMPORT_MARKER),
      'Expected the db-p2p patch to import identifyPush alongside identify from @libp2p/identify'
    ).to.equal(true)
    expect(
      patchSrc.includes(IDENTIFY_PUSH_SERVICE_MARKER),
      'Expected the db-p2p patch to register an identifyPush service in the shared services map'
    ).to.equal(true)
  })

  it('root package.json resolves @optimystic/db-p2p through the committed patch protocol (not a bare semver)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    // Exact match on the db-p2p package itself — a substring `.includes()` would also match the
    // SIBLING `@optimystic/db-p2p-storage-rn` package (a different resolution entry, bare semver
    // by design), so require the key to be exactly the fragment or the fragment plus a version
    // qualifier (`@npm:...`), never a longer package name.
    const dbP2pEntry = Object.entries(resolutions).find(
      ([key]) => key === DB_P2P_RESOLUTION_KEY_FRAGMENT || key.startsWith(DB_P2P_RESOLUTION_KEY_FRAGMENT + '@')
    )
    expect(
      dbP2pEntry,
      `Expected a root package.json resolutions entry for ${DB_P2P_RESOLUTION_KEY_FRAGMENT}`
    ).to.not.equal(undefined)
    const [, target] = dbP2pEntry as [string, string]
    expect(
      target.startsWith(PATCH_PROTOCOL_MARKER),
      `Expected the ${DB_P2P_RESOLUTION_KEY_FRAGMENT} resolution to target a patch: protocol ` +
      `reference (found: ${target}) — a plain semver pin would silently drop the identifyPush fix`
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

describe('P2P-11/41-06: FRET strand-discovery negotiation gap — malformed // id double-slash fix + p2p-fret async-completeness fix present', () => {
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

  it('a p2p-fret yarn-patch is committed under .yarn/patches/', () => {
    const patchFile = findP2pFretPatchFile()
    expect(
      patchFile,
      `Expected a ${P2P_FRET_PATCH_PREFIX}*.patch file under ${YARN_PATCHES_DIR}`
    ).to.not.equal(undefined)
  })

  it('the committed p2p-fret patch closes the FRET-registration async-completeness gap', () => {
    const patchFile = findP2pFretPatchFile()
    expect(patchFile, 'Expected the p2p-fret patch file to exist (see prior test)').to.not.equal(undefined)
    const patchSrc = readFileSync(join(YARN_PATCHES_DIR, patchFile as string), 'utf8')

    // All four register*() call sites now return (not void-discard) their node.handle() promise.
    expect(
      countMatchingLines(patchSrc, RETURN_NODE_HANDLE_MARKER),
      'Expected register*() functions to return their node.handle(...) registration promise ' +
      '(ping.js/leave.js/maybe-act.js each return it directly; neighbors.js collects both into ' +
      'a Promise.all-awaited array — this count covers the three direct `return node.handle(` sites)'
    ).to.be.greaterThan(0)

    // No ADDED line resurrects the fire-and-forget `void node.handle(...)` pattern.
    expect(
      countMatchingLines(patchSrc, VOID_NODE_HANDLE_ADDED_LINE),
      'Expected NO added line to reintroduce a fire-and-forget `void node.handle(...)` registration'
    ).to.equal(0)

    // FretService.registerRpcHandlers() is now async and start() awaits it.
    expect(
      patchSrc.includes(ASYNC_REGISTER_RPC_HANDLERS_MARKER),
      'Expected FretService.registerRpcHandlers() to be declared async'
    ).to.equal(true)
    expect(
      patchSrc.includes(AWAIT_REGISTER_RPC_HANDLERS_MARKER),
      'Expected FretService.start() to await registerRpcHandlers() (was a synchronous, ' +
      'non-awaited call)'
    ).to.equal(true)
  })

  it('root package.json resolves p2p-fret through the committed patch protocol (not a bare semver)', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    // p2p-fret is resolved via the BARE (unqualified) key — a range-scoped key would be silently
    // shadowed by it (41-06 diagnosis §7 finding), so assert on the exact bare key only.
    const target = resolutions[P2P_FRET_RESOLUTION_KEY]
    expect(
      target,
      `Expected a root package.json resolutions entry for the bare "${P2P_FRET_RESOLUTION_KEY}" key`
    ).to.not.equal(undefined)
    expect(
      (target as string).startsWith(PATCH_PROTOCOL_MARKER),
      `Expected the ${P2P_FRET_RESOLUTION_KEY} resolution to target a patch: protocol reference ` +
      `(found: ${target}) — a plain semver pin would silently drop the async-completeness fix`
    ).to.equal(true)
  })

  it('no GSD phase number appears in a runtime-emitted string of either yarn-patch', () => {
    const dbP2pPatchFile = findDbP2pPatchFile()
    const p2pFretPatchFile = findP2pFretPatchFile()
    expect(dbP2pPatchFile, 'Expected the db-p2p patch file to exist').to.not.equal(undefined)
    expect(p2pFretPatchFile, 'Expected the p2p-fret patch file to exist').to.not.equal(undefined)
    // Patch comments carry phase markers (e.g. "VoteTorrent patch (41-06)") by design/convention —
    // those are comment lines, not runtime-emitted strings. Only ADDED, non-comment source lines
    // matter here; neither patch's added CODE lines (as opposed to its comments) reference a
    // phase number at all, so this simply confirms no phase-number literal leaked into a
    // string/template-literal a running node would ever log or throw.
    const dbP2pAddedCodeLines = addedNonCommentLines(readFileSync(join(YARN_PATCHES_DIR, dbP2pPatchFile as string), 'utf8'))
    const p2pFretAddedCodeLines = addedNonCommentLines(readFileSync(join(YARN_PATCHES_DIR, p2pFretPatchFile as string), 'utf8'))
    const offenders = [...dbP2pAddedCodeLines, ...p2pFretAddedCodeLines].filter(
      (l) => l.includes(PHASE_41_04_MARKER) || l.includes('41' + '-06') || l.includes('41' + '-08')
    )
    expect(
      offenders,
      `Expected no added CODE line (non-comment) to carry a GSD phase number; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})

describe('P2P-11/41-08: FRET strand registrar-skew — runOnLimitedConnection fix present (all three prior patches kept)', () => {
  it('the committed p2p-fret patch passes runOnLimitedConnection:true on every outbound RPC dial (8 call-site branches across 5 senders)', () => {
    const patchFile = findP2pFretPatchFile()
    expect(patchFile, 'Expected the p2p-fret patch file to exist (see prior describe block)').to.not.equal(undefined)
    const patchSrc = readFileSync(join(YARN_PATCHES_DIR, patchFile as string), 'utf8')

    // sendPing (2 branches), fetchNeighbors (1), announceNeighbors (1), sendMaybeAct (2),
    // sendLeave (2) = 8 ADDED code lines. Counted on ADDED non-comment lines only — one of this
    // patch's own explanatory comments quotes the marker inside backticks, which must not
    // false-satisfy this CODE-presence count (the 38-18 false-positive-comment lesson).
    expect(
      countAddedCodeLinesMatching(patchSrc, RUN_ON_LIMITED_CONNECTION_MARKER),
      'Expected exactly 8 added CODE lines passing runOnLimitedConnection:true (2 each for ' +
      'sendPing/sendMaybeAct/sendLeave, 1 each for fetchNeighbors/announceNeighbors) — a silent ' +
      'revert of any call site would change this count and reopen the relay-only FRET-dial wall'
    ).to.equal(8)
  })

  it('all three prior patches (41-04 identifyPush, 41-06 single-slash, 41-06 async-completeness) remain present alongside the 41-08 fix', () => {
    const dbP2pPatchFile = findDbP2pPatchFile()
    const p2pFretPatchFile = findP2pFretPatchFile()
    expect(dbP2pPatchFile, 'Expected the db-p2p patch file to exist').to.not.equal(undefined)
    expect(p2pFretPatchFile, 'Expected the p2p-fret patch file to exist').to.not.equal(undefined)
    const dbP2pPatchSrc = readFileSync(join(YARN_PATCHES_DIR, dbP2pPatchFile as string), 'utf8')
    const p2pFretPatchSrc = readFileSync(join(YARN_PATCHES_DIR, p2pFretPatchFile as string), 'utf8')

    // 41-04 identifyPush + 41-06 single-slash (same db-p2p patch, untouched by this plan).
    expect(
      dbP2pPatchSrc.includes(IDENTIFY_PUSH_IMPORT_MARKER) && dbP2pPatchSrc.includes(IDENTIFY_PUSH_SERVICE_MARKER),
      'Expected the 41-04 identifyPush hunk to remain present'
    ).to.equal(true)
    expect(
      countMatchingLines(dbP2pPatchSrc, CORRECTED_PROTOCOL_PREFIX_ADDED_LINE),
      'Expected the 41-06 single-slash protocolPrefix fix to remain present (2 added lines)'
    ).to.equal(2)

    // 41-06 async-completeness (same p2p-fret patch this plan extends).
    expect(
      p2pFretPatchSrc.includes(ASYNC_REGISTER_RPC_HANDLERS_MARKER) && p2pFretPatchSrc.includes(AWAIT_REGISTER_RPC_HANDLERS_MARKER),
      'Expected the 41-06 async-completeness fix (async registerRpcHandlers + awaited start()) to remain present'
    ).to.equal(true)
    expect(
      countMatchingLines(p2pFretPatchSrc, VOID_NODE_HANDLE_ADDED_LINE),
      'Expected NO added line to reintroduce the retired fire-and-forget void node.handle(...) pattern'
    ).to.equal(0)
  })

  it('root package.json still resolves p2p-fret through the (single, bare) committed patch protocol', () => {
    const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8')) as {
      resolutions?: Record<string, string>
    }
    const resolutions = rootPackageJson.resolutions ?? {}
    // Exactly one p2p-fret-shaped resolution key (the bare key) — a range-scoped sibling key
    // (silently shadowed by the bare key per 41-06's diagnosis §7 finding, re-confirmed by this
    // plan's own yarn patch-commit workflow auto-adding one) must NOT be present.
    const p2pFretKeys = Object.keys(resolutions).filter(
      (key) => key === P2P_FRET_RESOLUTION_KEY || key.startsWith(P2P_FRET_RESOLUTION_KEY + '@')
    )
    expect(
      p2pFretKeys,
      `Expected exactly one p2p-fret resolution key (the bare "${P2P_FRET_RESOLUTION_KEY}"); ` +
      `found: ${JSON.stringify(p2pFretKeys)} — a range-scoped sibling key would be silently shadowed`
    ).to.deep.equal([P2P_FRET_RESOLUTION_KEY])
    const target = resolutions[P2P_FRET_RESOLUTION_KEY] as string
    expect(
      target.startsWith(PATCH_PROTOCOL_MARKER),
      `Expected the ${P2P_FRET_RESOLUTION_KEY} resolution to target a patch: protocol reference ` +
      `(found: ${target}) — a plain semver pin would silently drop the runOnLimitedConnection fix`
    ).to.equal(true)
  })

  it('no GSD phase number appears in a runtime-emitted (added, non-comment) string of the p2p-fret patch', () => {
    const p2pFretPatchFile = findP2pFretPatchFile()
    expect(p2pFretPatchFile, 'Expected the p2p-fret patch file to exist').to.not.equal(undefined)
    const p2pFretAddedCodeLines = addedNonCommentLines(readFileSync(join(YARN_PATCHES_DIR, p2pFretPatchFile as string), 'utf8'))
    const offenders = p2pFretAddedCodeLines.filter((l) => l.includes('41' + '-08'))
    expect(
      offenders,
      `Expected no added CODE line (non-comment) to carry the 41-08 phase marker; found: ${JSON.stringify(offenders)}`
    ).to.have.length(0)
  })
})
