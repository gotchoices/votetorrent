// workspace-require-exports.test.mjs — guard: every `require('@votetorrent/<pkg>/<subpath>')` in
// Authority app source resolves through that workspace package's `exports` map under the
// conditions Metro uses for a require() call (react-native, require, default).
//
// Why this exists: jest's moduleNameMapper maps the specifier directly, so a lazy require against
// an import-only exports entry stayed green in every jest run while RN 0.87's Metro failed the
// whole bundle (the 62-66 `require('@votetorrent/vote-engine/rn')`, fixed in 5eb77d0b).
//
// Run: node --test test/node/workspace-require-exports.test.mjs   (from apps/VoteTorrentAuthority)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONDITIONS = ['react-native', 'require', 'default']

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
