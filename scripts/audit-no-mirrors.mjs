#!/usr/bin/env node
//
// scripts/audit-no-mirrors.mjs
//
// Purpose : the static rule that no mirror of app workflow code survives in the
//           CLI package or the shared workflows package. The CLI must run the
//           apps' own workflows through the package exports, never a copy, a
//           loader hook, a test fixture or a shim pulled into production code,
//           and no app or workflow may import the CLI back. This script lives
//           outside every tree it scans, so its own patterns cannot trip it.
//           It runs its fixture self-test first: one planted positive per
//           check, boundary controls just inside the rule and inverse controls
//           just outside it, then scans the real tree with the same code.
//
// Modes   : CLI only.
//             node scripts/audit-no-mirrors.mjs [--root <dir>] [--self-test-only]
//           --root defaults to the repository root derived from this file's
//           own location. --self-test-only runs the fixtures and exits without
//           touching the real tree. Exit 0 clean, 1 violation or failed
//           self-test, 2 usage.
//
// Provenance / scope: script tooling only, in the sense of
//           scripts/lib/strip-comments.mjs. Never imported by any package src,
//           never reaching a production bundle. It spawns nothing and declares
//           no dependency.
//
// Deps    : node builtins and ./lib/strip-comments.mjs.
//
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const CHECKS = Object.freeze([
  'mirror-marker',
  'app-source-read',
  'copied-logic',
  'hook-import',
  'fixture-import',
  'deep-import',
  'app-imports-cli'
])

const PKGS = Object.freeze(['packages/vote-cli', 'packages/workflows'])
const APPS = Object.freeze([
  'apps/VoteTorrentAuthority/src',
  'apps/VoteTorrentVoter/src'
])
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs'])
const DOC_EXT = new Set(['.md', '.json'])
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '__fixtures__', '__mocks__'])
const WINDOW = 8

/** Empty by design: every entry is a visible diff and a written, reviewed reason. */
const ALLOWED_APP_READS = Object.freeze({})
const ALLOWED_DUPLICATES = Object.freeze({})

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function extOf (name) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i)
}

function toPosix (p) {
  return p.split(sep).join('/')
}

function readText (abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

function clip (text, n) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

/** The register file is pinned by behaviour, not by semicolon or whitespace style. */
function squash (text) {
  return text.replace(/[\s;]/g, '')
}

function lineAt (text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') n++
  return n
}

function defaultRoot () {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const data = JSON.parse(readFileSync(manifest, 'utf8'))
        if (data.name === 'votetorrent' && data.workspaces !== undefined) return dir
      } catch {
        // Not the root manifest; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return dirname(dirname(fileURLToPath(import.meta.url)))
    dir = parent
  }
}

function walk (root, relBase, keepDir, keepFile) {
  const out = []
  const absBase = join(root, relBase)
  if (!existsSync(absBase)) return out
  const stack = [absBase]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!keepDir.has(entry.name)) stack.push(abs)
        continue
      }
      if (entry.isFile() && keepFile(entry.name)) {
        out.push({ abs, rel: toPosix(relative(root, abs)) })
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function codeFiles (root, relBase) {
  return walk(root, relBase, SKIP_DIRS, (name) => CODE_EXT.has(extOf(name)))
}

function pkgFiles (root) {
  const out = []
  for (const pkg of PKGS) {
    for (const f of walk(root, pkg, new Set(['dist', 'node_modules']), (name) => CODE_EXT.has(extOf(name)) || DOC_EXT.has(extOf(name)))) {
      out.push(f)
    }
  }
  return dedupe(out)
}

function pkgCodeFiles (root) {
  const out = []
  for (const pkg of PKGS) out.push(...codeFiles(root, pkg))
  return dedupe(out)
}

function appFiles (root) {
  const out = []
  for (const app of APPS) {
    out.push(...walk(root, app, SKIP_DIRS, (name) => {
      if (!CODE_EXT.has(extOf(name))) return false
      if (name === 'proof-flags.generated.ts') return false
      if (/\.(?:test|spec)\./.test(name)) return false
      return true
    }))
  }
  return dedupe(out)
}

function dedupe (files) {
  const seen = new Set()
  return files.filter((f) => {
    if (seen.has(f.rel)) return false
    seen.add(f.rel)
    return true
  })
}

function inPkgSrc (rel) {
  return rel.startsWith('packages/vote-cli/src/') || rel.startsWith('packages/workflows/src/')
}

function inPkgTest (rel) {
  return rel.startsWith('packages/vote-cli/test/') || rel.startsWith('packages/workflows/test/')
}

function pkgRootOf (rel) {
  const parts = rel.split('/')
  return parts.slice(0, 2).join('/')
}

/** Every quoted specifier form, type-only imports included. */
function specifiers (code) {
  const found = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      found.push({ spec: m[1], line: lineAt(code, m.index) })
    }
  }
  return found
}

function violationsFor (check, rel, line, text, extra = '') {
  const reason = clip(`${clip(text, 60)}${extra}`, 120)
  return { check, rel, line, reason }
}

// ---------------------------------------------------------------------------
// The seven checks.
// ---------------------------------------------------------------------------

function checkMirrorMarker (files) {
  const out = []
  const mirror = /\bmirror(?:s|ed|ing)?\b/i
  const drift = /\bdrift(?:s|ed|ing)?\b/i
  // A cross-reference that disclaims the copy, pins the two shapes equal, or cites
  // one line of a screen documents parity; it is not an unqualified mirror claim.
  const disclaimer = /not a copy|no-mirror|no mirror|not a mirror|typecheck pins|shapes equal|byte-identical|same-body|pinned by|(?:Screen(?:\.tsx)?|tsx):\d+/
  const cues = [
    /(?:^|[^a-z])apps\//i,
    /VoteTorrentAuthority/,
    /VoteTorrentVoter/,
    /(?:^|[^a-z])screens\//i,
    /\b[A-Z][A-Za-z0-9]*Screen\b/,
    /\.tsx\b/,
    /CadreNodeProvider/,
    /onConfirm/
  ]
  for (const f of files) {
    const lines = readText(f.abs).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!(mirror.test(line) || drift.test(line))) continue
      if (disclaimer.test(lines.slice(i, i + 3).join('\n'))) continue
      if (!cues.some((re) => re.test(line))) continue
      out.push(violationsFor('mirror-marker', f.rel, i + 1, line))
    }
  }
  return out
}

function checkAppSourceRead (files, allowed) {
  const out = []
  const allowedOut = []
  const literal = /'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g
  for (const f of files) {
    const code = stripComments(readText(f.abs))
    const lits = []
    for (let m = literal.exec(code); m !== null; m = literal.exec(code)) {
      lits.push({ text: m[0], line: lineAt(code, m.index), at: m.index })
    }
    const hits = []
    for (let i = 0; i < lits.length; i++) {
      const lit = lits[i]
      if (lit.text.includes('apps/VoteTorrent')) hits.push(lit)
      const isApps = /^['"]apps['"]$/.test(lit.text)
      if (isApps && i + 1 < lits.length && lits[i + 1].text.includes('VoteTorrent')) {
        hits.push(lits[i + 1])
      }
      if (lit.text.includes('VoteTorrent') && i > 0 && /^['"]apps['"]$/.test(lits[i - 1].text) && lits[i - 1].at + 200 >= lit.at) {
        hits.push(lit)
      }
    }
    // The test-side target of this check is a drift test pinning a copy against
    // screen source. Reads of engine or provider source by a shape gate are not
    // that shape.
    const screenOnly = inPkgTest(f.rel)
      ? hits.filter((h) => /(?:^|\/)screens\/|\b[A-Z][A-Za-z0-9]*Screen\b|\.tsx\b/.test(h.text))
      : hits
    const unique = [...new Map(screenOnly.map((h) => [`${h.line}:${h.text}`, h])).values()]
    if (unique.length === 0) continue
    if (inPkgTest(f.rel) && Object.hasOwn(allowed, f.rel)) {
      allowedOut.push({ check: 'app-source-read', rel: f.rel, reason: clip(allowed[f.rel], 120) })
      continue
    }
    for (const h of unique) out.push(violationsFor('app-source-read', f.rel, h.line, h.text))
  }
  return { violations: out, allowed: allowedOut }
}

function significantLines (code) {
  return code.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter((line) => {
    if (line === '') return false
    if (/^[{}\[\]();,]+$/.test(line)) return false
    if (/^import\b/.test(line)) return false
    if (/^export\b.*\bfrom\b/.test(line)) return false
    return true
  })
}

function shingle (lines) {
  return createHash('sha1').update(lines.join('\n')).digest('hex')
}

function checkCopiedLogic (pkgSrc, app, allowed) {
  const appWindows = new Map()
  for (const f of app) {
    const lines = significantLines(stripComments(readText(f.abs)))
    for (let i = 0; i + WINDOW <= lines.length; i++) {
      const key = shingle(lines.slice(i, i + WINDOW))
      if (!appWindows.has(key)) appWindows.set(key, [])
      appWindows.get(key).push({ rel: f.rel, start: i })
    }
  }
  const pairs = new Map()
  const parityNote = /pinned by|byte-identical|same-body|the voter app's|the app's/i
  const dataField = /^[A-Za-z_$][\w$]*\s*:\s*/
  for (const f of pkgSrc) {
    const raw = readText(f.abs)
    // A file whose header declares that a shape is the app's and pinned is the
    // documented exception class: a shared table both sides must hold equal.
    if (parityNote.test(raw.split('\n').slice(0, 20).join('\n'))) continue
    const lines = significantLines(stripComments(raw))
    for (let i = 0; i + WINDOW <= lines.length; i++) {
      const window = lines.slice(i, i + WINDOW)
      // Windows made only of object-literal fields are data tables, not logic.
      if (window.every((line) => dataField.test(line))) continue
      const key = shingle(window)
      for (const hit of appWindows.get(key) ?? []) {
        const pair = `${f.rel}|${hit.rel}`
        if (!pairs.has(pair)) pairs.set(pair, [])
        pairs.get(pair).push({ p: i, a: hit.start })
      }
    }
  }
  const out = []
  for (const [pair, hits] of pairs) {
    const [pkgRel, appRel] = pair.split('|')
    if (Object.hasOwn(allowed, pair)) continue
    hits.sort((x, y) => (x.p - y.p) || (x.a - y.a))
    const groups = []
    for (const hit of hits) {
      const last = groups.at(-1)
      if (last !== undefined && hit.p - last.endP < WINDOW && hit.a - last.endA < WINDOW) {
        last.endP = Math.max(last.endP, hit.p + WINDOW - 1)
        last.endA = Math.max(last.endA, hit.a + WINDOW - 1)
      } else {
        groups.push({ startP: hit.p, startA: hit.a, endP: hit.p + WINDOW - 1, endA: hit.a + WINDOW - 1 })
      }
    }
    for (const g of groups) {
      const text = `copied logic ${pkgRel}:${g.startP + 1} and ${appRel}:${g.startA + 1}`
      out.push(violationsFor('copied-logic', pkgRel, g.startP + 1, text))
    }
  }
  return out
}

function checkHookImport (files, manifests, bootstrap) {
  const out = []
  const hooks = ['s63-hooks', 'authority-hooks', 'hr5-hooks', 'mocha-shim', 'shims/react-native']
  const loader = /\b--(?:experimental-)?loader\b/
  const exportedHook = /\bexport\s+(?:async\s+)?function\s+(?:resolve|load)\s*\(|\bexport\s+(?:default\s+)?(?:const|let|var)\s+(?:resolve|load)\s*=|\bexport\s*\{[^}]*\b(?:resolve|load)\b/
  const moduleImport = /(?:from\s*|require\s*\(\s*)['"](?:node:)?module['"]/
  const registerCall = /\bregister\s*\(/
  const nodeOptions = /(?:NODE_OPTIONS\s*[:=]\s*|['"]NODE_OPTIONS['"]\s*:\s*)['"][^'"]+['"]/
  for (const f of files) {
    const raw = readText(f.abs)
    const code = stripComments(raw)
    if (f.rel.endsWith('package.json')) {
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        continue
      }
      for (const [key, value] of Object.entries(data.scripts ?? {})) {
        const script = String(value)
        if (loader.test(script)) out.push(violationsFor('hook-import', f.rel, 1, `scripts.${key} loader flag`))
        for (const hook of hooks) {
          if (script.includes(hook)) out.push(violationsFor('hook-import', f.rel, 1, `scripts.${key} ${hook}`))
        }
        for (const m of script.matchAll(/(?:--import[= ]|import=)([^\s'"]+)/g)) {
          if (m[1] !== './register-ts-node.mjs') {
            out.push(violationsFor('hook-import', f.rel, 1, `scripts.${key} import target ${m[1]}`))
          }
        }
      }
      continue
    }
    if (loader.test(code)) out.push(violationsFor('hook-import', f.rel, 1, 'loader flag in source'))
    for (const hook of hooks) {
      if (code.includes(hook)) out.push(violationsFor('hook-import', f.rel, 1, `${hook} reference`))
    }
    if (exportedHook.test(code)) out.push(violationsFor('hook-import', f.rel, 1, 'exported resolve or load hook'))
    if (moduleImport.test(code) && registerCall.test(code)) {
      const isRootRegister = /^packages\/[^/]+\/register-ts-node\.mjs$/.test(f.rel) && squash(raw) === squash(bootstrap)
      if (!isRootRegister) out.push(violationsFor('hook-import', f.rel, 1, 'module register call outside the pinned register file'))
    }
    if (inPkgSrc(f.rel) && nodeOptions.test(code)) {
      out.push(violationsFor('hook-import', f.rel, 1, 'NODE_OPTIONS assignment in src'))
    }
  }
  void manifests
  return out
}

const BAD_SPEC_PART = /(?:^|\/)test\/|(?:^|\/)test\/fixtures|(?:^|\/)test\/harness|(?:^|\/)__fixtures__|(?:^|\/)__tests__|(?:^|\/)__mocks__|(?:^|\/)shims\//

function checkFixtureImport (files) {
  const out = []
  for (const f of files) {
    const code = stripComments(readText(f.abs))
    const specs = specifiers(code)
    if (inPkgSrc(f.rel)) {
      for (const s of specs) {
        if (BAD_SPEC_PART.test(s.spec)) {
          out.push(violationsFor('fixture-import', f.rel, s.line, s.spec))
        } else if (s.spec.startsWith('.')) {
          const target = posix.normalize(posix.join(posix.dirname(f.rel), s.spec))
          const root = pkgRootOf(f.rel)
          if (target !== root && !target.startsWith(root + '/')) {
            out.push(violationsFor('fixture-import', f.rel, s.line, s.spec, ' escapes package'))
          }
        }
      }
      const globals = /\b(?:globalThis|global)\.(?:describe|it)\s*=/
      if (globals.test(code)) out.push(violationsFor('fixture-import', f.rel, 1, 'mocha global assignment'))
    } else if (inPkgTest(f.rel)) {
      for (const s of specs) {
        if (!s.spec.startsWith('.')) continue
        const target = posix.normalize(posix.join(posix.dirname(f.rel), s.spec))
        if (target.startsWith('apps/') || target.startsWith('tools/')) {
          out.push(violationsFor('fixture-import', f.rel, s.line, s.spec, ' reaches an app or tool'))
        }
      }
    }
  }
  return out
}

function readExports (root) {
  const map = new Map()
  const dir = join(root, 'packages')
  if (!existsSync(dir)) return map
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(dir, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof data.name === 'string') map.set(data.name, data.exports ?? null)
    } catch {
      // A malformed manifest is handled by the deep-import check as no exports.
    }
  }
  return map
}

function checkDeepImport (files, exportsMap) {
  const out = []
  for (const f of files) {
    if (!inPkgSrc(f.rel)) continue
    for (const s of specifiers(stripComments(readText(f.abs)))) {
      const m = /^@votetorrent\/([^/]+)\/(.+)$/.exec(s.spec)
      if (m === null) continue
      const sub = m[2]
      if (sub.startsWith('dist/') || sub.startsWith('src/')) {
        out.push(violationsFor('deep-import', f.rel, s.line, s.spec))
        continue
      }
      const exp = exportsMap.get(`@votetorrent/${m[1]}`)
      const keys = exp !== null && typeof exp === 'object' ? Object.keys(exp) : []
      if (!keys.includes(`./${sub}`)) out.push(violationsFor('deep-import', f.rel, s.line, s.spec))
    }
  }
  return out
}

function checkAppImportsCli (files) {
  const out = []
  for (const f of files) {
    const isApp = f.rel.startsWith('apps/')
    const isWorkflowSrc = f.rel.startsWith('packages/workflows/src/')
    if (!isApp && !isWorkflowSrc) continue
    for (const s of specifiers(stripComments(readText(f.abs)))) {
      if (s.spec === '@votetorrent/vote-cli' || s.spec.startsWith('@votetorrent/vote-cli/')) {
        out.push(violationsFor('app-imports-cli', f.rel, s.line, s.spec))
      } else if (s.spec.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(f.rel), s.spec))
        if (target.startsWith('packages/vote-cli/')) {
          out.push(violationsFor('app-imports-cli', f.rel, s.line, s.spec, ' reaches the CLI'))
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One scan, used for both fixtures and the real tree.
// ---------------------------------------------------------------------------

function scan (root) {
  const allPkg = pkgFiles(root)
  const codePkg = dedupe([...allPkg.filter((f) => CODE_EXT.has(extOf(f.rel)))])
  const src = codePkg.filter((f) => inPkgSrc(f.rel))
  const app = appFiles(root)
  const bootstrap = readText(join(root, 'packages/bootstrap-rendezvous-service/register-ts-node.mjs'))
  const exportsMap = readExports(root)
  const cliTargets = dedupe([...app, ...codePkg.filter((f) => f.rel.startsWith('packages/workflows/src/'))])

  const read = checkAppSourceRead(allPkg, ALLOWED_APP_READS)
  const results = [
    { check: CHECKS[0], files: allPkg.length, violations: checkMirrorMarker(allPkg), allowed: [] },
    { check: CHECKS[1], files: allPkg.length, violations: read.violations, allowed: read.allowed },
    { check: CHECKS[2], files: src.length + app.length, violations: checkCopiedLogic(src, app, ALLOWED_DUPLICATES), allowed: [] },
    { check: CHECKS[3], files: allPkg.length, violations: checkHookImport(allPkg, exportsMap, bootstrap), allowed: [] },
    { check: CHECKS[4], files: codePkg.length, violations: checkFixtureImport(codePkg), allowed: [] },
    { check: CHECKS[5], files: src.length, violations: checkDeepImport(src, exportsMap), allowed: [] },
    { check: CHECKS[6], files: cliTargets.length, violations: checkAppImportsCli(cliTargets), allowed: [] }
  ]
  const files = dedupe([...allPkg, ...app]).length
  const violations = results.flatMap((r) => r.violations)
  const allowed = results.flatMap((r) => r.allowed)
  return { results, files, violations, allowed }
}

// ---------------------------------------------------------------------------
// Fixture self-test. Fixture text is assembled here, never written in-repo.
// ---------------------------------------------------------------------------

const REGISTER_FILE = [
  "import { register } from 'node:module'",
  "import { pathToFileURL } from 'node:url'",
  '',
  "register('ts-node/esm', pathToFileURL('./'))",
  ''
].join('\n')

const SAMPLE_LINES = [
  'export function sampleCompute (a: number, b: number): number {',
  '  const first = a + b',
  '  const second = a - b',
  '  const third = a * b',
  '  const fourth = a / b',
  '  const fifth = first + second',
  '  const sixth = third - fourth',
  '  const seventh = fifth * sixth',
  '  const eighth = seventh + first',
  '  const ninth = eighth - second',
  '  const tenth = ninth + third',
  '  const eleventh = tenth - fourth',
  '  return eleventh',
  '}'
]

function writeText (root, rel, text) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

function writeJson (root, rel, obj) {
  writeText(root, rel, JSON.stringify(obj, null, 2) + '\n')
}

function buildFixture (root) {
  writeJson(root, 'packages/vote-cli/package.json', {
    name: '@votetorrent/vote-cli',
    scripts: { test: 'mocha --node-option=import=./register-ts-node.mjs "test/**/*.spec.ts"' },
    exports: null
  })
  writeJson(root, 'packages/workflows/package.json', {
    name: '@votetorrent/workflows',
    exports: { '.': { import: './dist/index.js' } }
  })
  writeJson(root, 'packages/vote-engine/package.json', {
    name: '@votetorrent/vote-engine',
    exports: { '.': { import: './dist/index.js' }, './rn': { import: './dist/rn-entry.js' } }
  })
  writeText(root, 'packages/bootstrap-rendezvous-service/register-ts-node.mjs', REGISTER_FILE)
  writeText(root, 'packages/vote-cli/register-ts-node.mjs', REGISTER_FILE)
  writeText(root, 'packages/workflows/register-ts-node.mjs', REGISTER_FILE)
  writeText(root, 'packages/vote-cli/src/clean.ts', 'export const cliValue = 1\n')
  writeText(root, 'packages/vote-cli/test/clean.spec.ts', "import { cliValue } from '../src/clean.js'\n")
  writeText(root, 'packages/workflows/src/clean.ts', 'export const workflowValue = 2\n')
  writeText(root, 'packages/workflows/test/clean.spec.ts', "import { workflowValue } from '../src/clean.js'\n")
  writeText(root, 'apps/VoteTorrentAuthority/src/engines/sample.ts', SAMPLE_LINES.join('\n') + '\n')
}

function appendCli (root, lines) {
  const rel = 'packages/vote-cli/src/clean.ts'
  writeText(root, rel, readText(join(root, rel)) + lines.join('\n') + '\n')
}

function appendTest (root, lines) {
  const rel = 'packages/vote-cli/test/clean.spec.ts'
  writeText(root, rel, readText(join(root, rel)) + lines.join('\n') + '\n')
}

function appendWorkflow (root, lines) {
  const rel = 'packages/workflows/src/clean.ts'
  writeText(root, rel, readText(join(root, rel)) + lines.join('\n') + '\n')
}

function only (check) {
  return (r) => r.violations.length === 1 && r.violations[0].check === check && r.allowed.length === 0
}

function clean (r) {
  return r.violations.length === 0 && r.allowed.length === 0
}

const CASES = Object.freeze([
  { name: 'clean tree', mutate: () => {}, expect: clean },
  {
    name: 'mirror-marker positive',
    mutate: (root) => appendCli(root, ['// mirrors apps/VoteTorrentVoter/src/screens/ConfirmationScreen.tsx onConfirm']),
    expect: only('mirror-marker')
  },
  {
    name: 'app-source-read positive',
    mutate: (root) => appendCli(root, ["const source = 'apps/VoteTorrentAuthority/src/screens/SampleScreen.tsx'"]),
    expect: only('app-source-read')
  },
  {
    name: 'copied-logic positive',
    mutate: (root) => appendCli(root, SAMPLE_LINES.slice(1, 9)),
    expect: only('copied-logic')
  },
  {
    name: 'hook-import positive',
    mutate: (root) => appendCli(root, ['export function resolve (x: string) { return x }']),
    expect: only('hook-import')
  },
  {
    name: 'fixture-import positive',
    mutate: (root) => appendCli(root, ["import type { Sample } from '../../vote-engine/test/fixtures/x.js'"]),
    expect: only('fixture-import')
  },
  {
    name: 'deep-import positive',
    mutate: (root) => appendCli(root, ["import { x } from '@votetorrent/vote-engine/dist/x.js'"]),
    expect: only('deep-import')
  },
  {
    name: 'app-imports-cli positive',
    mutate: (root) => appendWorkflow(root, ["import { x } from '@votetorrent/vote-cli'"]),
    expect: only('app-imports-cli')
  },
  {
    name: 'seven-line copy boundary',
    mutate: (root) => appendCli(root, SAMPLE_LINES.slice(1, 8)),
    expect: clean
  },
  {
    name: 'rig mirror line boundary',
    mutate: (root) => appendCli(root, ['// mirrors the lean rig, not an app screen']),
    expect: clean
  },
  {
    name: 'test fixture import boundary',
    mutate: (root) => appendTest(root, ["import { x } from '../../vote-engine/test/fixtures/x.js'"]),
    expect: clean
  },
  {
    name: 'unmodified register boundary',
    mutate: () => {},
    expect: clean
  },
  {
    name: 'allowed subpath boundary',
    mutate: (root) => appendCli(root, ["import { x } from '@votetorrent/vote-engine/rn'"]),
    expect: clean
  },
  {
    name: 'changed register inverse',
    mutate: (root) => writeText(root, 'packages/vote-cli/register-ts-node.mjs', REGISTER_FILE + '\n// changed\n'),
    expect: only('hook-import')
  },
  {
    name: 'eight-line copy inverse',
    mutate: (root) => appendCli(root, SAMPLE_LINES.slice(1, 9)),
    expect: only('copied-logic')
  },
  {
    name: 'type-only fixture inverse',
    mutate: (root) => appendCli(root, ["import type { Sample } from '../test/fixtures/x.js'"]),
    expect: only('fixture-import')
  },
  {
    name: 'dist subpath inverse',
    mutate: (root) => appendCli(root, ["import { x } from '@votetorrent/vote-engine/dist/x.js'"]),
    expect: only('deep-import')
  }
])

function selfTest () {
  let passed = 0
  for (const c of CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'vt-no-mirror-'))
    let okCase = false
    try {
      buildFixture(dir)
      c.mutate(dir)
      okCase = c.expect(scan(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    if (!okCase) {
      process.stdout.write(`SELFTEST FAIL ${c.name}\n`)
      return false
    }
    passed++
  }
  process.stdout.write(`SELFTEST PASS ${passed}/${passed}\n`)
  return true
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function usage () {
  process.stderr.write('usage: node scripts/audit-no-mirrors.mjs [--root <dir>] [--self-test-only]\n')
  process.exit(2)
}

function main () {
  const argv = process.argv.slice(2)
  let root = defaultRoot()
  let selfOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--self-test-only') {
      selfOnly = true
    } else if (arg === '--root') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('-')) usage()
      root = resolve(value)
    } else {
      usage()
    }
  }
  if (!selfTest()) process.exit(1)
  if (selfOnly) process.exit(0)
  if (!existsSync(join(root, 'packages')) || !existsSync(join(root, 'apps'))) {
    process.stderr.write('audit: root is not a checkout\n')
    process.exit(2)
  }
  const result = scan(root)
  for (const r of result.results) {
    process.stdout.write(`AUDIT ${r.check} files=${r.files} violations=${r.violations.length}\n`)
  }
  for (const v of result.violations) {
    process.stdout.write(`VIOLATION ${v.check} ${v.rel}:${v.line} ${v.reason}\n`)
  }
  for (const a of result.allowed) {
    process.stdout.write(`ALLOWED ${a.check} ${a.rel} ${a.reason}\n`)
  }
  if (result.violations.length > 0) {
    process.stdout.write(`FAIL no-mirror-audit violations=${result.violations.length}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `RECEIPT no-mirror-audit checks=${CHECKS.length} files=${result.files} violations=0 allowed=${result.allowed.length}\n`
  )
}

main()
