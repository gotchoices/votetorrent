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
