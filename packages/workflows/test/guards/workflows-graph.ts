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

/** Every import/export specifier in `text` (comments stripped first), in source order. */
export function specifiers (text: string): Specifier[] {
  void stripComments(text)
  return [] // vacuous: implemented in Task 3 of 67-04
}

/** Sorted package-relative src files reachable from `exportRoots` through relative specifiers (value or type). */
export function moduleClosure (packageRoot: string, read: ReadFn = readReal): string[] {
  void packageRoot
  void read
  return [] // vacuous: implemented in Task 3 of 67-04
}

/** `listSrcFiles` minus `moduleClosure`, sorted. */
export function orphanFiles (packageRoot: string, read: ReadFn = readReal): string[] {
  void packageRoot
  void read
  return [] // vacuous: implemented in Task 3 of 67-04
}

/** `<src rel>: <rule>: <detail>` for every purity violation in every src file (not only the closure). */
export function purityHits (packageRoot: string, read: ReadFn = readReal): string[] {
  void packageRoot
  void read
  void builtinModules
  return [] // vacuous: implemented in Task 3 of 67-04
}

/** Load `distFile` in its own plain node child; `ok` is exit 0, a hang past `timeoutMs` is SIGKILLed and reported. */
export function loadUnderNode (distFile: string, timeoutMs: number): Promise<LoadResult> {
  void distFile
  void timeoutMs
  void spawn
  void mkdtempSync
  void rmSync
  void tmpdir
  return Promise.resolve({ ok: true, code: 0, stderrTail: '' }) // vacuous: implemented in Task 3 of 67-04
}
