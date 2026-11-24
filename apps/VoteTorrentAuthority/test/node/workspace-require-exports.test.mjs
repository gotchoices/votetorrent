// workspace-require-exports.test.mjs — guard: every `require('@votetorrent/<pkg>/<subpath>')` in
// Authority app source resolves through that workspace package's `exports` map under the
// conditions Metro uses for a require() call (react-native, require, default).
//
// Why this exists: jest's moduleNameMapper maps the specifier directly, so a lazy require against
// an import-only exports entry stayed green in every jest run while RN 0.87's Metro failed the
// whole bundle (the 62-66 `require('@votetorrent/vote-engine/rn')`, fixed in 5eb77d0b).
//
// The workflows checks below guard the same RN 0.87 import-only-exports failure mode for the new
// shared package `@votetorrent/workflows` (phase 67, CLI-02): every subpath it exports must carry
// `types`, `import` and `default` in that order, its manifest must stay free of any react-native
// family dependency (the platform seam is injected, never imported), and the jest mappers in this
// app must point each subpath at the same dist file the exports map names. A synthetic import-only
// map is the negative control, so the gap check is seen firing on every run.
//
// Run: node --test test/node/workspace-require-exports.test.mjs   (from apps/VoteTorrentAuthority)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONDITIONS = ['react-native', 'require', 'default']
const WORKFLOWS_SUBPATHS = ['.', './authority', './voter', './platform']
const FORBIDDEN_WORKFLOWS_DEP = /^(react|react-native|react-native-.*|@react-native[-/].*|rn-leveldb|@votetorrent\/attestation-native|@quereus\/plugin-react-native-leveldb|@optimystic\/db-p2p-storage-rn|@serfab\/cadre-rn)$/
const JEST_CONFIGS = ['jest.config.js', 'jest.node.config.js']

/** Resolve one exports target: string wins; a condition object picks the FIRST matching key, recursively. */
export function resolveTarget (target, conditions = CONDITIONS) {
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t, conditions)
      if (r !== undefined) return r
    }
    return undefined
  }
  if (target && typeof target === 'object') {
    for (const key of Object.keys(target)) {
      if (conditions.includes(key)) {
        const r = resolveTarget(target[key], conditions)
        if (r !== undefined) return r
      }
    }
  }
  return undefined
}

/** Resolve `./subpath` against an exports map (exact keys, then `*` patterns). */
export function resolveSubpath (exportsField, subpath, conditions = CONDITIONS) {
  let map = exportsField
  // A bare string / condition-object `exports` is shorthand for the "." entry only.
  const isSubpathMap = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).some(k => k.startsWith('.'))
  if (!isSubpathMap) map = { '.': map }
  if (Object.prototype.hasOwnProperty.call(map, subpath)) return resolveTarget(map[subpath], conditions)
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const pre = key.slice(0, star)
    const post = key.slice(star + 1)
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1) {
      const t = resolveTarget(map[key], conditions)
      return t === undefined ? undefined : t.replace('*', subpath.slice(pre.length, subpath.length - post.length))
    }
  }
  return undefined
}

function walk (dir, out) {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'node_modules') continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(n)) out.push(p)
  }
  return out
}

function fileExists (p) {
  return ['', '.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js'].some(ext => existsSync(p + ext) && statSync(p + ext).isFile())
}

export function collectRequires () {
  const hits = []
  const re = /\brequire\(\s*['"](@votetorrent\/[^'"]+)['"]\s*\)/g
  for (const f of walk(join(appRoot, 'src'), [])) {
    const src = readFileSync(f, 'utf8')
    let m
    while ((m = re.exec(src)) !== null) hits.push({ file: f.slice(appRoot.length + 1), specifier: m[1] })
  }
  return hits
}

export function check ({ specifier }) {
  const [scope, name, ...rest] = specifier.split('/')
  const pkgDir = join(appRoot, 'node_modules', scope, name)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const sub = rest.length ? './' + rest.join('/') : '.'
  if (pkg.exports === undefined) {
    // No exports map: Metro resolves by file path / main.
    return sub === '.' ? true : fileExists(join(pkgDir, ...rest))
  }
  const target = resolveSubpath(pkg.exports, sub)
  return target !== undefined && existsSync(join(pkgDir, target))
}

/**
 * Every rule a workflows exports entry must satisfy, one `<subpath>: <reason>` string per failed
 * rule, sorted. `[]` means every subpath is a complete types+import+default entry that Metro's
 * require() view (CONDITIONS) resolves to the same file `import` names.
 */
export function exportsConditionGaps (exportsField, subpaths) {
  const gaps = []
  for (const sub of subpaths) {
    const entry = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) ? exportsField[sub] : undefined
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      gaps.push(`${sub}: entry is missing or is not a condition object`)
      continue
    }
    const keys = Object.keys(entry)
    if (keys.join(',') !== 'types,import,default') gaps.push(`${sub}: keys are [${keys.join(', ')}], expected exactly [types, import, default] in that order`)
    if (entry.default !== entry.import) gaps.push(`${sub}: default (${entry.default}) differs from import (${entry.import})`)
    if (typeof entry.import !== 'string' || entry.types !== entry.import.replace(/\.js$/, '.d.ts')) gaps.push(`${sub}: types (${entry.types}) is not import with .js replaced by .d.ts`)
    const seenByRequire = resolveSubpath(exportsField, sub, CONDITIONS)
    if (seenByRequire !== entry.import) gaps.push(`${sub}: Metro require() view resolves to ${seenByRequire}, expected ${entry.import}`)
  }
  return gaps.sort()
}

/** The workflows manifest as THIS app resolves it, through its own node_modules link. Called lazily inside tests. */
export function workflowsManifest () {
  return JSON.parse(readFileSync(join(appRoot, 'node_modules', '@votetorrent', 'workflows', 'package.json'), 'utf8'))
}

test('the guard finds the lazy workspace requires it is meant to protect', () => {
  const specs = collectRequires().map(h => h.specifier)
  assert.ok(specs.includes('@votetorrent/vote-engine/rn'), `expected vote-engine/rn among ${specs.join(', ')}`)
})

test('resolver unit: import-only entry does not match require; default does', () => {
  assert.equal(resolveSubpath({ './rn': { types: './a.d.ts', import: './rn.js' } }, './rn'), undefined)
  assert.equal(resolveSubpath({ './rn': { types: './a.d.ts', import: './rn.js', default: './rn.js' } }, './rn'), './rn.js')
  assert.equal(resolveSubpath({ './src/*': './src/*.ts' }, './src/x/y'), './src/x/y.ts')
})

test('every require(@votetorrent/...) in app source resolves under react-native/require/default', () => {
  const failures = []
  for (const hit of collectRequires()) {
    let ok = false
    try { ok = check(hit) } catch (e) { ok = false }
    if (!ok) failures.push(`${hit.specifier}  (in ${hit.file})`)
  }
  assert.deepEqual(failures, [], `unresolvable under require conditions:\n  ${failures.join('\n  ')}`)
})

test('workflows exports gap check flags an import-only subpath (negative control)', () => {
  const full = (name) => ({ types: `./dist/${name}index.d.ts`, import: `./dist/${name}index.js`, default: `./dist/${name}index.js` })
  const complete = { '.': full(''), './authority': full('authority/'), './voter': full('voter/'), './platform': full('platform/') }
  const importOnlyAuthority = { ...complete, './authority': { types: './dist/authority/index.d.ts', import: './dist/authority/index.js' } }
  const gaps = exportsConditionGaps(importOnlyAuthority, WORKFLOWS_SUBPATHS)
  assert.ok(gaps.length > 0, 'an import-only ./authority must produce at least one gap')
  assert.ok(gaps.every(g => g.startsWith('./authority: ')), `only ./authority may be flagged, got:\n  ${gaps.join('\n  ')}`)
  assert.deepEqual(exportsConditionGaps(complete, WORKFLOWS_SUBPATHS), [])
})

test('every @votetorrent/workflows export carries types, import and default', () => {
  const { exports: exportsField } = workflowsManifest()
  assert.deepEqual(Object.keys(exportsField).sort(), [...WORKFLOWS_SUBPATHS].sort())
  assert.deepEqual(exportsConditionGaps(exportsField, WORKFLOWS_SUBPATHS), [])
})

test('the @votetorrent/workflows manifest declares no react-native-family dependency', () => {
  const manifest = workflowsManifest()
  const offenders = []
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (FORBIDDEN_WORKFLOWS_DEP.test(name)) offenders.push(`${field}: ${name}`)
    }
  }
  assert.deepEqual(offenders, [], `react-native-family dependencies in @votetorrent/workflows:\n  ${offenders.join('\n  ')}`)
})

test('jest maps every @votetorrent/workflows subpath to the dist file its exports name', () => {
  const { exports: exportsField } = workflowsManifest()
  const require = createRequire(import.meta.url)
  const problems = []
  for (const file of JEST_CONFIGS) {
    const mapper = require(join(appRoot, file)).moduleNameMapper ?? {}
    for (const sub of WORKFLOWS_SUBPATHS) {
      const key = sub === '.' ? '^@votetorrent/workflows$' : `^@votetorrent/workflows/${sub.slice(2)}$`
      const expected = '<rootDir>/node_modules/@votetorrent/workflows/' + String(exportsField[sub]?.import ?? '').replace(/^\.\//, '')
      if (!(key in mapper)) problems.push(`${file}: missing mapper key ${key}`)
      else if (mapper[key] !== expected) problems.push(`${file}: ${key} -> ${mapper[key]}, expected ${expected}`)
    }
  }
  assert.deepEqual(problems, [], `jest mapper drift against the workflows exports map:\n  ${problems.join('\n  ')}`)
})
