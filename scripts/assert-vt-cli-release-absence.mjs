#!/usr/bin/env node
//
// scripts/assert-vt-cli-release-absence.mjs
//
// Purpose : the bundle-tier half of CLI-04's "fail-closed in release" proof
//           (67-CONTEXT "Release fail-closed proof"), plus CLI-02's "both apps
//           still bundle WITH the workflows package under Metro". The token
//           signer, the token attestation and the file vault live only in
//           packages/vote-cli. The jest tier (each app's
//           src/__tests__/vt-cli-unreachable.gate.test.ts) proves that by
//           walking the import graph as text. This script proves it on the
//           artifact itself: for each app it builds the REAL release bundle
//           (real index.js, real metro.config.js, dev off) into an isolated
//           scratch dir and greps the bundle text for two string-literal
//           sentinels that exist only in the CLI package (sentinel 1, the
//           token-attestation marker; sentinel 2, the approval-token env-var
//           name), and greps the sourcemap for any source under the CLI
//           package. It also requires the sourcemap to name the app's own
//           App.tsx and at least one packages/workflows/dist source, which is
//           the CLI-02 bundle proof: Metro resolves @votetorrent/workflows the
//           way jest does.
//
// Modes   : (default)   selftest, preflight, then both arms for both apps
//           --selftest  the scanner self-checks only (no Metro, seconds)
//           --app authority|voter|both    (default both)
//           --scratch <dir>   where the arms build (default: a fresh dir under
//                             the OS temp dir); it must lie OUTSIDE the repo
//           --keep      keep each arm's bundle, sourcemap and assets
//           Exit 0 = RESULT PASS, 1 = a selftest or arm failure, 2 = usage or
//           preflight failure.
//
// Defenses against a vacuous verdict (each one has bitten this repo before):
//   1. Fragments + raw self-scan. Each sentinel is assembled at run time from
//      two fragments, so this file, the two jest gates and the evidence never
//      hold a sentinel whole; selftest S5 scans the RAW text of this script and
//      both gates and proves the scan fires on a synthetic positive.
//   2. Literals, not identifiers. A minifier renames identifiers and defeats a
//      naive dist grep; a string literal survives. The scan is over string
//      literals in the bundle text and over paths in the sourcemap, nothing else.
//   3. A fresh, EMPTY temp dir per arm. Metro keeps its transform cache and
//      file-map cache under the OS temp dir, so TMPDIR pointed at an empty dir
//      is a stronger reset than the cache-reset flag and touches nothing shared
//      (that flag would clear the cache under another session's live Metro,
//      so it is never used). The dir is asserted empty before the spawn and
//      non-empty after it.
//   4. Exit code + signal + size + sourcemap. A React Native release bundle
//      can exit 0 on failure, so a verdict also needs a bundle file of at
//      least MIN_BUNDLE_BYTES, a parseable sourcemap with a sources array, and
//      the two sourcemap facts above.
//   5. The positive arm is MINIFIED: a probe entry requires the app's index.js
//      plus the built vote-cli marker and token modules, and the bundle must
//      show both sentinels, the per-run nonce and both plant paths. The probe
//      text itself carries no sentinel (selftest S8), so the literal provably
//      came from the planted module.
//   6. The subject arm is UNMINIFIED: no dead-code removal beyond what every
//      release build does, so it is the superset of what a release ships.
//   7. Both arms always run: the subject arm runs even if the selftest-level
//      plant checks are odd, and the positive arm runs even if the subject
//      failed, so the scanner is observed firing in the same invocation in
//      which it is observed clean. A positive arm that misses or errors is a
//      FAIL, never a pass.
//
// Isolation: only the `bundle` subcommand runs, so no Metro server is started
//           and no port is opened. Scratch inside the repo is refused (Metro
//           watches the whole repo). Nothing is written inside the repo.
//           Work runs under `nice -n 10` with two Metro workers, one arm at a
//           time, one app at a time. The app-local react-native binary is used.
//
// Provenance / scope: test tooling only, in the same sense
//           scripts/lib/strip-comments.mjs declares for itself: never imported
//           by any package or app `src`, never reaching a production bundle.
//
// Deps    : node builtins, ./lib/strip-comments.mjs, ./lib/dist-freshness.mjs.
//
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { stripComments } from './lib/strip-comments.mjs'
import { staleDistFiles } from './lib/dist-freshness.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO = realpathSync(resolve(dirname(SCRIPT), '..'))

/** Run order. */
const APPS = { authority: 'apps/VoteTorrentAuthority', voter: 'apps/VoteTorrentVoter' }

/** Each sentinel is the two-fragment concatenation; never the whole literal. */
export const SENTINELS = [
  {
    id: 'marker',
    value: 'vt-cli-token-' + 'attestation-v1',
    home: 'packages/vote-cli/src/attestation/marker.ts',
    plant: 'packages/vote-cli/dist/attestation/marker.js',
    exportName: 'TOKEN_ATTESTATION_MARKER'
  },
  {
    id: 'token-env',
    value: 'VT_APPROVAL_' + 'TOKEN',
    home: 'packages/vote-cli/src/approval/token.ts',
    plant: 'packages/vote-cli/dist/approval/token.js',
    exportName: 'APPROVAL_TOKEN_ENV'
  }
]

const GATE_FILES = [
  'apps/VoteTorrentAuthority/src/__tests__/vt-cli-unreachable.gate.test.ts',
  'apps/VoteTorrentVoter/src/__tests__/vt-cli-unreachable.gate.test.ts'
]

const MIN_BUNDLE_BYTES = 8000000
const BUNDLE_TIMEOUT_MS = 900000
const MAX_WORKERS = '2'
const REBUILD_HINT = 'nice -n 10 yarn --cwd packages/vote-core build && nice -n 10 yarn --cwd packages/vote-engine build && nice -n 10 yarn --cwd packages/workflows build && nice -n 10 yarn --cwd packages/vote-cli build'

const toPosix = (p) => p.split(sep).join('/')
const repoRel = (p) => toPosix(relative(REPO, p))

function countOccurrences (text, needle) {
  let n = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    n += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return n
}

function offsetsOf (text, needle, limit = 20) {
  const out = []
  let at = text.indexOf(needle)
  while (at !== -1 && out.length < limit) {
    out.push(at)
    at = text.indexOf(needle, at + needle.length)
  }
  return out
}

/**
 * Raw occurrence counts of both sentinels. The text is deliberately NOT comment-stripped: a minified
 * bundle is a few huge lines, and a line-comment strip can delete a real literal that follows a `//`
 * inside a string or a regex. An absence scan must only ever over-report.
 */
export function countSentinels (text) {
  return { marker: countOccurrences(text, SENTINELS[0].value), 'token-env': countOccurrences(text, SENTINELS[1].value) }
}

/** `'value'` plus `"value"` occurrences in an already comment-stripped text. */
export function quotedOccurrences (strippedText, value) {
  return countOccurrences(strippedText, `'${value}'`) + countOccurrences(strippedText, `"${value}"`)
}

function realOr (p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Sourcemap sources resolved against `appDir`: `cli` = repo-relative paths under the CLI package,
 * `workflowsDist` = count of packages/workflows/dist sources, `appEntry` = the app's real App.tsx is listed.
 */
export function classifySources (sources, appDir) {
  const appTsx = join(appDir, 'App.tsx')
  const appTsxReal = realOr(appTsx)
  const cli = []
  let workflowsDist = 0
  let appEntry = false
  for (const s of sources) {
    if (typeof s !== 'string') continue
    const abs = resolve(appDir, s)
    const real = realOr(abs)
    const forms = [toPosix(abs), toPosix(real)]
    if (forms.some((p) => p.includes('/packages/vote-cli/') || p.includes('/node_modules/@votetorrent/vote-cli/'))) {
      cli.push(real.startsWith(REPO + sep) ? repoRel(real) : toPosix(real))
    }
    if (forms.some((p) => p.includes('/packages/workflows/dist/') || p.includes('/node_modules/@votetorrent/workflows/dist/'))) workflowsDist += 1
    if (abs === appTsx || real === appTsxReal) appEntry = true
  }
  return { total: sources.length, cli, workflowsDist, appEntry }
}

/**
 * Every source listed in a sourcemap given as BYTES. Metro 0.87 writes an INDEX map (`sections`, one
 * per module, each with its own one-element `sources`), and an unminified release bundle's map carries
 * `sourcesContent` for every module and can exceed Node's maximum string length, so the map is never
 * decoded whole and no single array is trusted: every `"sources"` key is found (inside JSON string
 * content a quote is escaped, so `"sources"` followed by `:` is always a key), the array after it is
 * scanned to its matching `]` with string state tracked, and only those slices are parsed. The union
 * is returned in file order. A flat map yields its one array.
 */
export function sourcemapSources (buf) {
  const key = Buffer.from('"sources"')
  const out = []
  let arrays = 0
  let keyAt = buf.indexOf(key)
  while (keyAt !== -1) {
    let i = keyAt + key.length
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x09)) i += 1
    if (buf[i] !== 0x3a) {
      keyAt = buf.indexOf(key, keyAt + key.length)
      continue
    }
    i += 1
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x09)) i += 1
    if (buf[i] !== 0x5b) throw new Error('sourcemap "sources" is not an array')
    let inString = false
    let escaped = false
    let depth = 0
    let end = -1
    for (let j = i; j < buf.length; j += 1) {
      const c = buf[j]
      if (inString) {
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) inString = false
        continue
      }
      if (c === 0x22) inString = true
      else if (c === 0x5b) depth += 1
      else if (c === 0x5d) {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) throw new Error('sourcemap "sources" array is unterminated')
    const arr = JSON.parse(buf.subarray(i, end + 1).toString('utf8'))
    if (!Array.isArray(arr)) throw new Error('sourcemap "sources" did not parse to an array')
    out.push(...arr)
    arrays += 1
    keyAt = buf.indexOf(key, end + 1)
  }
  if (arrays === 0) throw new Error('sourcemap has no "sources" key')
  return out
}

/**
 * The positive arm's probe: a CommonJS entry that requires the app's real index.js and the two built
 * vote-cli modules, referencing each sentinel export in an object-literal property position, and a
 * CommonJS Metro config that wraps the app's real config, adds the probe's own directory to watchFolders
 * and stubs a Node builtin that the app's resolver cannot resolve with the app's empty shim.
 * Neither text contains a sentinel value: the literal must come from the planted module.
 */
export function buildProbe (appDir, nonce) {
  const appReal = realOr(appDir)
  const entry = realOr(join(appReal, 'index.js'))
  const plants = SENTINELS.map((s) => realOr(join(REPO, s.plant)))
  const entryText = [
    '// Probe entry written by scripts/assert-vt-cli-release-absence.mjs (positive arm). Lives in scratch only.',
    `require(${JSON.stringify(entry)})`,
    `var p0 = require(${JSON.stringify(plants[0])})`,
    `var p1 = require(${JSON.stringify(plants[1])})`,
    `globalThis.__vt25Probe = { nonce: ${JSON.stringify(nonce)}, s0: p0.${SENTINELS[0].exportName}, s1: p1.${SENTINELS[1].exportName} }`,
    ''
  ].join('\n')
  const configText = [
    '// Probe Metro config written by scripts/assert-vt-cli-release-absence.mjs (positive arm). Lives in scratch only.',
    `const base = require(${JSON.stringify(join(appReal, 'metro.config.js'))})`,
    "const { builtinModules } = require('node:module')",
    `const EMPTY = ${JSON.stringify(join(appReal, 'polyfills', 'empty.js'))}`,
    'const upstream = base.resolver && base.resolver.resolveRequest',
    'function resolveRequest (context, moduleName, platform) {',
    '  try {',
    '    return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform)',
    '  } catch (err) {',
    "    if (moduleName.startsWith('node:') || builtinModules.includes(moduleName)) return { type: 'sourceFile', filePath: EMPTY }",
    '    throw err',
    '  }',
    '}',
    'module.exports = Object.assign({}, base, {',
    '  watchFolders: (base.watchFolders || []).concat([__dirname]),',
    '  resolver: Object.assign({}, base.resolver, { resolveRequest })',
    '})',
    ''
  ].join('\n')
  return { entryText, configText }
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function runSelftest () {
  const checks = []
  const notes = []
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail })
    process.stdout.write(`SELFTEST ${id} ${ok ? 'PASS' : 'FAIL'}${ok || !detail ? '' : ` ${detail}`}\n`)
  }
  const s1 = SENTINELS[0].value
  const s2 = SENTINELS[1].value

  const positive = `const a = 1\nexport const M = '${s1}'\nconst b = 2\n`
  check('S1', countSentinels(positive).marker === 1, 'a quoted sentinel 1 must count 1')
  check('S2', countSentinels('const a = 1\nexport const M = \'other\'\nconst b = 2\n').marker === 0, 'a text without sentinel 1 must count 0')

  const cut = s1.indexOf('attestation-v1')
  const fragmentForm = `const m = '${s1.slice(0, cut)}' + '${s1.slice(cut)}'\n`
  check('S3', cut > 0 && countSentinels(fragmentForm).marker === 0, 'the two-fragment source form must count 0')

  const minifiedShape = `var u="https://x.invalid";//x\nexports.${SENTINELS[0].exportName}="${s1}";`
  const oneLine = minifiedShape.replace('\n', '')
  check('S4', countSentinels(oneLine).marker === 1, 'a URL, a // and the literal on one line must still count 1')

  let rawClean = true
  const rawDetail = []
  for (const f of [SCRIPT, ...GATE_FILES.map((g) => join(REPO, g))]) {
    if (!existsSync(f)) {
      rawClean = false
      rawDetail.push(`missing ${repoRel(f)}`)
      continue
    }
    const c = countSentinels(readFileSync(f, 'utf8'))
    if (c.marker !== 0 || c['token-env'] !== 0) {
      rawClean = false
      rawDetail.push(`${repoRel(f)} marker=${c.marker} token-env=${c['token-env']}`)
    }
  }
  const synthetic = countSentinels(`x = "${s1}"; y = "${s2}"`)
  check('S5', rawClean && synthetic.marker === 1 && synthetic['token-env'] === 1, rawDetail.join('; ') || 'synthetic positive must count 1/1')

  let homesOk = true
  const homeDetail = []
  for (const s of SENTINELS) {
    const home = join(REPO, s.home)
    if (!existsSync(home) || quotedOccurrences(stripComments(readFileSync(home, 'utf8')), s.value) < 1) {
      homesOk = false
      homeDetail.push(`${s.id}: home ${s.home} does not hold the literal`)
    }
    const plant = join(REPO, s.plant)
    if (!existsSync(plant)) {
      notes.push(`plant missing (a preflight item): ${s.plant}`)
    } else if (countOccurrences(readFileSync(plant, 'utf8'), s.value) < 1) {
      homesOk = false
      homeDetail.push(`${s.id}: plant ${s.plant} does not hold the literal`)
    }
  }
  check('S6', homesOk, homeDetail.join('; '))

  const cls = classifySources(
    ['../../packages/vote-cli/dist/attestation/marker.js', '../../node_modules/@votetorrent/workflows/dist/authority/index.js', 'App.tsx'],
    join(REPO, APPS.authority)
  )
  check('S7', cls.cli.length === 1 && cls.workflowsDist === 1 && cls.appEntry === true, JSON.stringify({ cli: cls.cli.length, workflowsDist: cls.workflowsDist, appEntry: cls.appEntry }))

  const nonce = randomBytes(16).toString('hex')
  const probe = buildProbe(join(REPO, APPS.authority), nonce)
  const probeCounts = countSentinels(probe.entryText + probe.configText)
  const s8 =
    probe.entryText.includes(nonce) &&
    SENTINELS.every((s) => probe.entryText.includes(realOr(join(REPO, s.plant)))) &&
    probeCounts.marker === 0 &&
    probeCounts['token-env'] === 0 &&
    probe.configText.includes('watchFolders') &&
    probe.configText.includes('polyfills/empty.js')
  check('S8', s8, 'probe entry must carry the nonce and both plant paths, no sentinel; config must carry watchFolders and the empty shim')

  let s9 = false
  let s9Detail = ''
  try {
    const syntheticMap = Buffer.from(
      JSON.stringify({ version: 3, sources: ['a]b.js', 'c\\"d.js', '../../packages/vote-cli/dist/x.js'], sourcesContent: ['"sources":[1]', 'x'], names: [], mappings: '' })
    )
    const got = sourcemapSources(syntheticMap)
    const indexMap = Buffer.from(
      JSON.stringify({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['App.tsx'], sourcesContent: ['const k = "sources": 1'], names: [], mappings: '' } },
          { offset: { line: 9, column: 0 }, map: { version: 3, sources: ['../../packages/workflows/dist/index.js'], names: [], mappings: '' } }
        ]
      })
    )
    const gotIndex = sourcemapSources(indexMap)
    s9 =
      got.length === 3 && got[0] === 'a]b.js' && got[1] === 'c\\"d.js' && got[2] === '../../packages/vote-cli/dist/x.js' &&
      gotIndex.length === 2 && gotIndex[0] === 'App.tsx' && gotIndex[1] === '../../packages/workflows/dist/index.js'
    s9Detail = JSON.stringify({ flat: got, index: gotIndex })
  } catch (err) {
    s9Detail = err instanceof Error ? err.message : String(err)
  }
  check('S9', s9, `sourcemap byte scan must return the 3 synthetic sources: ${s9Detail}`)

  for (const n of notes) process.stdout.write(`NOTE ${n}\n`)
  const passed = checks.filter((c) => c.ok).length
  const ok = passed === checks.length
  process.stdout.write(ok ? `SELFTEST PASS ${passed}/${checks.length}\n` : `SELFTEST FAIL ${passed}/${checks.length}\n`)
  return { ok, passed, total: checks.length, checks, notes }
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function newestMtimeMs (dir) {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    max = Math.max(max, entry.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs)
  }
  return max
}

function childEnv (extra) {
  const env = { ...process.env, FORCE_COLOR: '0', ...extra }
  delete env.NODE_OPTIONS
  return env
}

function runPreflight (scratchReal) {
  const items = []
  const add = (item, ok, detail) => items.push({ item, ok, detail })

  const sh = spawnSync('bash', [join(REPO, 'scripts', 'check-dist-freshness.sh')], { cwd: REPO, env: childEnv(), encoding: 'utf8' })
  add('check-dist-freshness.sh exits 0', sh.status === 0, `status=${sh.status}`)

  let wf = { distPresent: false, problems: [] }
  try {
    wf = staleDistFiles(join(REPO, 'packages', 'workflows'))
  } catch (err) {
    add('workflows dist present and fresh', false, err instanceof Error ? err.message : String(err))
  }
  add('workflows dist present and fresh', wf.distPresent === true && wf.problems.length === 0, `distPresent=${wf.distPresent} problems=${wf.problems.length}`)

  // vote-core builds with aegir (incremental tsc -b): an unchanged output keeps its old mtime after a fresh
  // build, so the rule is the newest-file one that dist-freshness.mjs and the CLI's assertFreshBuild use.
  const vcSrc = join(REPO, 'packages', 'vote-core', 'src')
  const vcDist = join(REPO, 'packages', 'vote-core', 'dist')
  const vcOk = existsSync(vcDist) && existsSync(join(vcDist, 'src', 'index.js')) && newestMtimeMs(vcSrc) <= newestMtimeMs(vcDist)
  add('vote-core dist not older than its src', vcOk, existsSync(vcDist) ? `srcNewest=${Math.round(newestMtimeMs(vcSrc))} distNewest=${Math.round(newestMtimeMs(vcDist))}` : 'dist missing')

  for (const s of SENTINELS) {
    const home = join(REPO, s.home)
    const plant = join(REPO, s.plant)
    const ok = existsSync(plant) && existsSync(home) && statSync(plant).mtimeMs >= statSync(home).mtimeMs
    add(`vote-cli plant built for ${s.id}`, ok, existsSync(plant) ? `plant ${s.plant} vs home ${s.home}` : `plant missing: ${s.plant}`)
  }

  for (const [key, dir] of Object.entries(APPS)) {
    const bin = join(REPO, dir, 'node_modules', '.bin', 'react-native')
    add(`${key} react-native binary present`, existsSync(bin), repoRel(bin))
  }

  const inside = scratchReal === REPO || scratchReal.startsWith(REPO + sep)
  add('scratch lies outside the repo', !inside, inside ? 'scratch is inside the repo' : 'ok')

  for (const it of items) process.stdout.write(`PREFLIGHT ${it.item}: ${it.ok ? 'OK' : 'FAIL'} (${it.detail})\n`)
  const failed = items.filter((it) => !it.ok)
  for (const it of failed) process.stdout.write(`PREFLIGHT FAIL ${it.item}\n`)
  if (failed.length > 0) process.stdout.write(`Rebuild with: ${REBUILD_HINT}\n`)
  return { ok: failed.length === 0, items }
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

function sha256File (p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function runArm (appKey, arm, scratch, keep) {
  const appDir = realpathSync(join(REPO, APPS[appKey]))
  const rnBin = join(appDir, 'node_modules', '.bin', 'react-native')
  const armDir = join(scratch, `${appKey}-${arm}`)
  const tmp = join(armDir, 'tmp')
  const out = join(armDir, 'out')
  mkdirSync(tmp, { recursive: true })
  mkdirSync(out, { recursive: true })
  if (readdirSync(tmp).length !== 0) throw new Error(`isolated temp dir is not empty before the spawn: ${armDir}/tmp`)
  const bundle = join(out, 'bundle.js')
  const map = join(out, 'bundle.map')
  const assets = join(out, 'assets')

  let entryFile = 'index.js'
  let extra = ['--minify', 'false']
  let nonce = null
  if (arm === 'positive') {
    nonce = randomBytes(16).toString('hex')
    const probeDir = join(scratch, `${appKey}-probe`)
    mkdirSync(probeDir, { recursive: true })
    const probeEntry = join(probeDir, 'probe.entry.js')
    const probeConfig = join(probeDir, 'metro.probe.config.cjs')
    const probe = buildProbe(appDir, nonce)
    writeFileSync(probeEntry, probe.entryText)
    writeFileSync(probeConfig, probe.configText)
    if (!existsSync(probeEntry) || !existsSync(probeConfig)) throw new Error('probe files were not written')
    entryFile = probeEntry
    extra = ['--config', probeConfig, '--minify', 'true']
  }

  const args = [
    '-n', '10', rnBin, 'bundle',
    '--platform', 'android',
    '--dev', 'false',
    '--max-workers', MAX_WORKERS,
    '--entry-file', entryFile,
    '--bundle-output', bundle,
    '--sourcemap-output', map,
    '--assets-dest', assets,
    ...extra
  ]
  const t0 = Date.now()
  const r = spawnSync('nice', args, {
    cwd: appDir,
    env: childEnv({ TMPDIR: tmp }),
    timeout: BUNDLE_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  const wallMs = Date.now() - t0
  writeFileSync(join(out, 'metro.log'), `${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}${r.error ? `\n--- spawn error ---\n${r.error.message}\n` : ''}`)

  const rec = {
    arm,
    verdict: 'ERROR',
    status: r.status,
    signal: r.signal,
    wallMs,
    bundleBytes: 0,
    bundleSha256: null,
    mapBytes: 0,
    mapParsed: false,
    mapError: null,
    mapSources: 0,
    appEntry: false,
    workflowsDist: 0,
    cliSources: [],
    sentinelCounts: { s1: 0, s2: 0 },
    nonceSeen: 0,
    isolatedCacheEntries: readdirSync(tmp).length,
    log: `${appKey}-${arm}/out/metro.log`,
    problems: []
  }

  let offsets = { s1: [], s2: [] }
  const bundleStat = statSync(bundle, { throwIfNoEntry: false })
  if (bundleStat && bundleStat.isFile()) {
    const text = readFileSync(bundle, 'utf8')
    rec.bundleBytes = bundleStat.size
    rec.bundleSha256 = sha256File(bundle)
    const counts = countSentinels(text)
    rec.sentinelCounts = { s1: counts.marker, s2: counts['token-env'] }
    offsets = { s1: offsetsOf(text, SENTINELS[0].value), s2: offsetsOf(text, SENTINELS[1].value) }
    if (nonce) rec.nonceSeen = countOccurrences(text, nonce)
  }
  const mapStat = statSync(map, { throwIfNoEntry: false })
  rec.mapBytes = mapStat && mapStat.isFile() ? mapStat.size : 0
  try {
    if (rec.mapBytes === 0) throw new Error('sourcemap file missing or empty')
    const sources = sourcemapSources(readFileSync(map))
    rec.mapParsed = true
    const c = classifySources(sources, appDir)
    rec.mapSources = c.total
    rec.appEntry = c.appEntry
    rec.workflowsDist = c.workflowsDist
    rec.cliSources = c.cli
  } catch (err) {
    rec.mapParsed = false
    rec.mapError = err instanceof Error ? err.message : String(err)
  }

  if (arm === 'subject') {
    if (rec.sentinelCounts.s1 > 0 || rec.sentinelCounts.s2 > 0 || rec.cliSources.length > 0) {
      rec.verdict = 'FOUND'
    } else {
      if (r.status !== 0) rec.problems.push(`status=${r.status}`)
      if (r.signal !== null) rec.problems.push(`signal=${r.signal}`)
      if (r.error) rec.problems.push(`spawn: ${r.error.message}`)
      if (rec.bundleBytes < MIN_BUNDLE_BYTES) rec.problems.push(`bundleBytes=${rec.bundleBytes} < ${MIN_BUNDLE_BYTES}`)
      if (!rec.mapParsed) rec.problems.push(`sourcemap unusable (${rec.mapBytes} bytes): ${rec.mapError}`)
      if (rec.isolatedCacheEntries === 0) rec.problems.push('isolated temp dir stayed empty (cache did not go there)')
      if (!rec.appEntry) rec.problems.push('sourcemap does not list App.tsx')
      if (rec.workflowsDist < 1) rec.problems.push('sourcemap lists no packages/workflows/dist source')
      rec.verdict = rec.problems.length === 0 ? 'CLEAN' : 'ERROR'
    }
  } else {
    const plantsRel = SENTINELS.map((s) => repoRel(realOr(join(REPO, s.plant))))
    const plantsSeen = plantsRel.every((p) => rec.cliSources.includes(p))
    const built = r.status === 0 && rec.bundleBytes > 0
    if (built && rec.nonceSeen >= 1 && rec.sentinelCounts.s1 >= 1 && rec.sentinelCounts.s2 >= 1 && plantsSeen) {
      rec.verdict = 'CAUGHT'
    } else if (built) {
      rec.verdict = 'MISSED'
      if (rec.nonceSeen < 1) rec.problems.push('nonce not seen')
      if (rec.sentinelCounts.s1 < 1) rec.problems.push('sentinel 1 not seen')
      if (rec.sentinelCounts.s2 < 1) rec.problems.push('sentinel 2 not seen')
      if (!plantsSeen) rec.problems.push(`plant paths not all in sourcemap (saw ${rec.cliSources.length} cli sources)`)
    } else {
      rec.verdict = 'ERROR'
      rec.problems.push(`status=${r.status} signal=${r.signal} bundleBytes=${rec.bundleBytes}${r.error ? ` spawn: ${r.error.message}` : ''}`)
    }
  }

  process.stdout.write(
    `ARM ${appKey} ${arm} ${rec.verdict} bytes=${rec.bundleBytes} sources=${rec.mapSources} workflows=${rec.workflowsDist} cli=${rec.cliSources.length} s1=${rec.sentinelCounts.s1} s2=${rec.sentinelCounts.s2} wallMs=${rec.wallMs}\n`
  )
  if (rec.verdict === 'FOUND') {
    process.stdout.write(`  FOUND offsets s1=${JSON.stringify(offsets.s1)} s2=${JSON.stringify(offsets.s2)}\n`)
    for (const p of rec.cliSources) process.stdout.write(`  FOUND cli source ${p}\n`)
  }
  if (rec.problems.length > 0) process.stdout.write(`  ${arm} problems: ${rec.problems.join('; ')} (log: <scratch>/${rec.log})\n`)

  if (!keep) {
    for (const p of [bundle, map, assets]) rmSync(p, { recursive: true, force: true })
  }
  return rec
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage () {
  process.stderr.write('usage: node scripts/assert-vt-cli-release-absence.mjs [--selftest] [--app authority|voter|both] [--scratch <dir>] [--keep]\n')
  return 2
}

function main (argv) {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        selftest: { type: 'boolean', default: false },
        app: { type: 'string', default: 'both' },
        scratch: { type: 'string' },
        keep: { type: 'boolean', default: false }
      }
    }))
  } catch {
    return usage()
  }
  if (!['authority', 'voter', 'both'].includes(values.app)) return usage()

  const startedAt = new Date().toISOString()
  const selftest = runSelftest()
  if (!selftest.ok) return 1
  if (values.selftest) return 0

  const scratch = values.scratch ? resolve(values.scratch) : mkdtempSync(join(tmpdir(), 'vt25-absence-'))
  mkdirSync(scratch, { recursive: true })
  const scratchReal = realpathSync(scratch)

  const preflight = runPreflight(scratchReal)
  const verdictPath = join(scratchReal, 'verdict.json')
  const record = { startedAt, endedAt: null, selftest, preflight, apps: {}, result: null }
  if (!preflight.ok) {
    record.endedAt = new Date().toISOString()
    record.result = 'PREFLIGHT FAIL'
    writeFileSync(verdictPath, JSON.stringify(record, null, 2), { flag: 'wx' })
    process.stdout.write(`VERDICT ${verdictPath}\n`)
    return 2
  }

  const apps = values.app === 'both' ? Object.keys(APPS) : [values.app]
  let firstFail = null
  for (const appKey of apps) {
    const subject = runArm(appKey, 'subject', scratchReal, values.keep)
    const positive = runArm(appKey, 'positive', scratchReal, values.keep)
    record.apps[appKey] = { subject, positive }
    if (!firstFail && subject.verdict !== 'CLEAN') firstFail = `${appKey}:subject:${subject.verdict}`
    if (!firstFail && positive.verdict !== 'CAUGHT') firstFail = `${appKey}:positive:${positive.verdict}`
  }

  record.endedAt = new Date().toISOString()
  record.result = firstFail ? `RESULT FAIL ${firstFail}` : 'RESULT PASS'
  writeFileSync(verdictPath, JSON.stringify(record, null, 2), { flag: 'wx' })
  process.stdout.write(`VERDICT ${verdictPath}\n`)
  process.stdout.write(`${record.result}\n`)
  return firstFail ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
