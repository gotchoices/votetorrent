// workflows-graph.ts — the shared engine of the two @votetorrent/workflows guards (phase 67, CLI-02):
// test/purity.spec.ts (no react-native, no require, no builtin, no app escape in any src file) and
// test/load-under-node.spec.ts (every module the exports map reaches loads in a plain, hook-free node).
//
// What a false PASS of each would let through:
//   - purity: a src file that imports react-native, the native attestation module, rn-leveldb, an
//     AsyncStorage or @votetorrent/vote-cli (token signer / token attestation / file vault), or that
//     calls require(). Metro bundles this package into BOTH release apps and the vt CLI loads it under
//     plain node, so such a file either breaks the RN bundle or drags token paths into shared code.
//   - load-under-node: a module list that is empty, inherits mocha's --import hook through NODE_OPTIONS,
//     or shares one process so a sibling's side-effect shim lets a broken module load; a src file no
//     export reaches (an orphan) that neither guard ever sees; a stale dist standing in for the src.
//
// The detectors below (specifiers, moduleClosure, orphanFiles, purityHits, loadUnderNode) are themselves
// under test in both specs: planted-violation self-tests and positive/negative controls were committed
// RED against vacuous versions before the real bodies landed. A guard whose detector cannot see a
// violation reports PASS, so the detector is the asset under attack here.
//
// Comment stripping is scripts/lib/strip-comments.mjs, the quote-aware stripper (keeps `https://` inside
// a string), never a regex copy. Style: ESM, no semicolons, `.js` suffix on relative imports.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { stripComments } from '../../../../scripts/lib/strip-comments.mjs'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SRC_DIR = join(PACKAGE_ROOT, 'src')

/** The 4 subpath index files and the 9 group barrels fixed by the phase-67 barrel rule. */
export const PINNED_ENTRY_FILES: readonly string[] = [
  'src/index.ts',
  'src/authority/index.ts',
  'src/voter/index.ts',
  'src/platform/index.ts',
  'src/authority/keyholder.ts',
  'src/authority/node.ts',
  'src/authority/network.ts',
  'src/authority/officer.ts',
  'src/authority/election.ts',
  'src/common/strand.ts',
  'src/common/join-node.ts',
  'src/voter/ceremony.ts',
  'src/voter/reads.ts',
]

/** Matched as an exact specifier or as a `<name>/` prefix; type-only imports count too. */
export const FORBIDDEN_PACKAGES: readonly string[] = [
  'react-native',
  '@react-native-async-storage/async-storage',
  '@votetorrent/attestation-native',
  'rn-leveldb',
  '@quereus/plugin-react-native-leveldb',
  '@votetorrent/vote-cli',
]

/** Any specifier starting with one of these is forbidden (the whole @react-native family). */
export const FORBIDDEN_PREFIXES: readonly string[] = ['@react-native/', '@react-native-']

export type ReadFn = (absFile: string) => string
export const readReal: ReadFn = (f) => readFileSync(f, 'utf8')

export type SpecifierKind = 'static' | 'side-effect' | 'dynamic' | 'require'
export interface Specifier {
  spec: string
  typeOnly: boolean
  kind: SpecifierKind
}

export interface LoadResult {
  ok: boolean
  code: number | null
  /** The last 400 chars of the child's stderr (or `timeout <ms> ms`). */
  stderrTail: string
}

export interface ChildInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

const toPosix = (p: string): string => p.split(sep).join('/')

function walkTs (dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(p, base))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(toPosix(relative(base, p)))
  }
  return out
}

/** `true` when `target` is strictly inside `dir`. */
export function isInside (dir: string, target: string): boolean {
  const r = relative(dir, target)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

/** Sorted package-relative `src/**\/*.ts`, excluding `.d.ts`. */
export function listSrcFiles (packageRoot: string): string[] {
  return walkTs(join(packageRoot, 'src'), packageRoot).sort()
}

/**
 * The src files behind the package's `exports` map: each subpath's `import` target `./dist/<x>.js` is
 * mapped to `src/<x>.ts`. Throws, naming the subpath, when a target does not map to an existing src file.
 */
export function exportRoots (packageRoot: string): string[] {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> }
  const roots: string[] = []
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    const target = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.import
    if (typeof target !== 'string') throw new Error(`exports["${subpath}"] has no string import target`)
    const m = /^\.\/dist\/(.+)\.js$/.exec(target)
    if (!m) throw new Error(`exports["${subpath}"] import target ${target} is not ./dist/<x>.js`)
    const srcRel = `src/${m[1] as string}.ts`
    if (!existsSync(join(packageRoot, srcRel))) throw new Error(`exports["${subpath}"] -> ${target} maps to ${srcRel}, which does not exist`)
    roots.push(srcRel)
  }
  return roots
}

/** `src/<x>.ts` -> absolute `<PACKAGE_ROOT>/dist/<x>.js`. */
export function distFileFor (srcRel: string): string {
  if (!srcRel.startsWith('src/') || !srcRel.endsWith('.ts')) throw new Error(`not a src/*.ts path: ${srcRel}`)
  return join(PACKAGE_ROOT, 'dist', `${srcRel.slice('src/'.length, -'.ts'.length)}.js`)
}

/**
 * A plain `node` child that imports one dist file: no loader hook in argv, and an env with NODE_OPTIONS,
 * NODE_PATH and every TS_NODE_* key removed (mocha's --import hook and ts-node config must not leak in).
 */
export function childInvocation (distFile: string): ChildInvocation {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  for (const key of Object.keys(env)) if (key.startsWith('TS_NODE_')) delete env[key]
  return {
    command: process.execPath,
    args: ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(distFile).href],
    env,
  }
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// `import {..} from`, `export {..} from`, `export * from`, `export * as x from`, `import type`, multi-line
// clauses. Quotes cannot appear inside the clause, so a quote ends any attempt to pair an `import` with a
// later statement's `from`. `import{`/`export{` without a space are accepted.
const STATIC_RE = /\b(import|export)(?:\s+|(?=[{*]))(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT_RE = /\bimport\s*['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** `{ type A, type B }` with every member typed is type-only even without the `import type` keyword. */
function allMembersTyped (clause: string): boolean {
  const c = clause.trim()
  if (!c.startsWith('{') || !c.endsWith('}')) return false
  const members = c.slice(1, -1).split(',').map((m) => m.trim()).filter((m) => m.length > 0)
  return members.length > 0 && members.every((m) => /^type\s+/.test(m))
}

/** Every import/export specifier in `text` (comments stripped first), in source order. */
export function specifiers (text: string): Specifier[] {
  const code = stripComments(text)
  const found: Array<Specifier & { at: number }> = []
  for (const m of code.matchAll(STATIC_RE)) {
    const typeOnly = m[2] !== undefined || allMembersTyped(m[3] ?? '')
    found.push({ spec: m[4] as string, typeOnly, kind: 'static', at: m.index ?? 0 })
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) found.push({ spec: m[1] as string, typeOnly: false, kind: 'side-effect', at: m.index ?? 0 })
  for (const m of code.matchAll(DYNAMIC_RE)) found.push({ spec: m[1] as string, typeOnly: false, kind: 'dynamic', at: m.index ?? 0 })
  for (const m of code.matchAll(REQUIRE_RE)) found.push({ spec: m[1] as string, typeOnly: false, kind: 'require', at: m.index ?? 0 })
  found.sort((a, b) => a.at - b.at)
  return found.map(({ spec, typeOnly, kind }) => ({ spec, typeOnly, kind }))
}

/** `./x.js` (or `./x`) next to `fromAbs` -> absolute `./x.ts` candidate. */
function relativeTarget (fromAbs: string, spec: string): string {
  return resolve(dirname(fromAbs), `${spec.replace(/\.js$/, '')}.ts`)
}

/** Sorted package-relative src files reachable from `exportRoots` through relative specifiers (value or type). */
export function moduleClosure (packageRoot: string, read: ReadFn = readReal): string[] {
  const srcDir = join(packageRoot, 'src')
  const seen = new Set<string>()
  const queue = exportRoots(packageRoot).map((rel) => join(packageRoot, rel))
  while (queue.length > 0) {
    const abs = queue.shift() as string
    if (seen.has(abs)) continue
    seen.add(abs)
    for (const { spec } of specifiers(read(abs))) {
      if (!spec.startsWith('.')) continue
      const target = relativeTarget(abs, spec)
      // Unresolved or escaping relatives are purityHits' job; the closure follows what exists in src.
      if (isInside(srcDir, target) && existsSync(target) && !seen.has(target)) queue.push(target)
    }
  }
  return [...seen].map((abs) => toPosix(relative(packageRoot, abs))).sort()
}

/** `listSrcFiles` minus `moduleClosure`, sorted. */
export function orphanFiles (packageRoot: string, read: ReadFn = readReal): string[] {
  const closure = new Set(moduleClosure(packageRoot, read))
  return listSrcFiles(packageRoot).filter((f) => !closure.has(f)).sort()
}

const isForbiddenPackage = (spec: string): boolean =>
  FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`)) || FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p))

/** `node:` specifiers, and bare specifiers whose first path segment is a Node builtin (Metro bundles this package). */
const isNodeBuiltin = (spec: string): boolean => {
  if (spec.startsWith('node:')) return true
  if (spec.startsWith('.') || spec.startsWith('/')) return false
  return builtinModules.includes(spec.split('/')[0] as string)
}

/** `<src rel>: <rule>: <detail>` for every purity violation in every src file (not only the closure). */
export function purityHits (packageRoot: string, read: ReadFn = readReal): string[] {
  const srcDir = join(packageRoot, 'src')
  const hits = new Set<string>()
  for (const rel of listSrcFiles(packageRoot)) {
    const abs = join(packageRoot, rel)
    const text = read(abs)
    const code = stripComments(text)
    const add = (rule: string, detail?: string): void => {
      hits.add(detail === undefined ? `${rel}: ${rule}` : `${rel}: ${rule}: ${detail}`)
    }
    if (/\brequire\s*\(/.test(code)) add('require-call')
    if (/\bcreateRequire\b/.test(code)) add('create-require')
    if (/\b(globalThis|global)\s*\.\s*require\b/.test(code)) add('global-require')
    if (/\bimport\s*\(\s*(?!['"])/.test(code)) add('dynamic-import-nonliteral')
    for (const { spec } of specifiers(text)) {
      if (isForbiddenPackage(spec)) add('forbidden-package', spec)
      if (isNodeBuiltin(spec)) add('node-builtin', spec)
      if (!spec.startsWith('.')) continue
      if (!spec.endsWith('.js')) {
        add('relative-no-js-suffix', spec)
        continue
      }
      const target = relativeTarget(abs, spec)
      if (!isInside(srcDir, target)) add('relative-escapes-package', spec)
      else if (!existsSync(target)) add('relative-unresolved', spec)
    }
  }
  return [...hits].sort()
}

const TAIL_CHARS = 400

/**
 * The last 400 chars of the child's stderr with stack frames, blank lines and Node's version footer
 * removed, keeping the thrown error's own line in view: Node 22 follows `ReferenceError: require is not
 * defined in ES module scope` with ~250 chars of `.cjs` advice, four frames and the footer, so a raw tail
 * would show only the advice and never the error.
 */
function stderrTailOf (stderr: string): string {
  const lines = stderr.split('\n').filter((l) => l.trim() !== '' && !/^\s+at /.test(l) && !/^Node\.js v\d/.test(l))
  const body = lines.join('\n')
  if (body.length <= TAIL_CHARS) return body
  const tail = body.slice(-TAIL_CHARS)
  const errorLine = lines.find((l) => /^[A-Za-z]*Error\b/.test(l))
  if (errorLine === undefined || tail.includes(errorLine)) return tail
  const head = errorLine.slice(0, TAIL_CHARS - 1)
  return `${head}\n${body.slice(-(TAIL_CHARS - head.length - 1))}`
}

/** Load `distFile` in its own plain node child; `ok` is exit 0, a hang past `timeoutMs` is SIGKILLed and reported. */
export function loadUnderNode (distFile: string, timeoutMs: number): Promise<LoadResult> {
  const { command, args, env } = childInvocation(distFile)
  // A fresh, empty cwd: nothing cwd-relative (node_modules, package.json) may help resolution.
  const cwd = mkdtempSync(join(tmpdir(), 'wf-load-'))
  return new Promise<LoadResult>((done) => {
    let settled = false
    let stderr = ''
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (r: LoadResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rmSync(cwd, { recursive: true, force: true })
      done(r)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: null, stderrTail: `timeout ${timeoutMs} ms` })
    }, timeoutMs)
    child.stdout.resume()
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-4000)
    })
    child.on('error', (err) => finish({ ok: false, code: null, stderrTail: String(err.message).slice(-TAIL_CHARS) }))
    child.on('close', (code) => finish({ ok: code === 0, code, stderrTail: stderrTailOf(stderr) }))
  })
}
