// hr5-hooks.mjs - resolve/load hooks for the part-1 rehearsal (plan 64-62, D-62-12, notes 19 E24). Exactly three jobs:
//  (1) short-circuit three RN-only specifiers to data: modules (rn-leveldb, @quereus/plugin-react-native-leveldb, the
//      AsyncStorage default export, which delegates to the per-role file kv and THROWS when HR5_ASYNC_STORAGE_FILE is unset);
//  (2) from a parent under the Authority src, the Voter src or this scratch dir, map the vote-engine rn entry to the
//      vote-engine SRC and re-anchor every other bare specifier to the opener URL (one patched copy of each package);
//  (3) force format module for those apps' src ts and tsx files.
// It maps no package of the optimistic, cadre or protocol-limits families.
let cfg = {}
export function initialize (data) { cfg = data ?? {} }

const isBare = (s) => !(s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || s.startsWith('data:') || s.startsWith('file:'))
const classes = (names) => names.map((n) => `export class ${n} { constructor () { throw new Error('stubbed: RN-only module on the host') } }`).join('\n')
const trace = (spec) => `(globalThis.__hr5Stubs ??= []).push(${JSON.stringify(spec)});\n`
const STUBS = {
  'rn-leveldb': trace('rn-leveldb') + classes(['LevelDB', 'LevelDBWriteBatch']),
  '@quereus/plugin-react-native-leveldb': trace('@quereus/plugin-react-native-leveldb') + classes(['ReactNativeLevelDBProvider']),
  '@react-native-async-storage/async-storage': trace('@react-native-async-storage/async-storage') + `
const kv = () => {
  const f = process.env.HR5_ASYNC_STORAGE_FILE
  if (!f) throw new Error('hr5 AsyncStorage stub: HR5_ASYNC_STORAGE_FILE is not set')
  return globalThis.__hr5FileKv(f)
}
const AsyncStorage = {
  async getItem (k) { const v = kv().get(k); return v === undefined ? null : v },
  async setItem (k, v) { kv().set(k, v) },
  async removeItem (k) { kv().remove(k) },
  async multiGet (ks) { const s = kv(); return ks.map((k) => [k, s.get(k) === undefined ? null : s.get(k)]) },
  async multiSet (pairs) { const s = kv(); for (const [k, v] of pairs) s.set(k, v) },
  async clear () { kv().clear() }
}
export default AsyncStorage
`
}

export async function resolve (specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[specifier]), format: 'module', shortCircuit: true }
  }
  const parent = context.parentURL ?? ''
  const fromApp = [cfg.authSrc, cfg.voterSrc, cfg.s62].some((p) => p && parent.startsWith(p))
  let result
  if (fromApp && specifier === '@votetorrent/vote-engine/rn') {
    result = await nextResolve(cfg.rnEntry, context)
  } else if (fromApp && isBare(specifier) && cfg.anchor) {
    result = await nextResolve(specifier, { ...context, parentURL: cfg.anchor })
  } else {
    result = await nextResolve(specifier, context)
  }
  if (typeof result.url === 'string' && [cfg.authSrc, cfg.voterSrc].some((p) => p && result.url.startsWith(p)) && /\.tsx?$/.test(result.url)) {
    return { ...result, format: 'module' }
  }
  return result
}

export async function load (url, context, nextLoad) {
  if (url.startsWith('file:') && [cfg.authSrc, cfg.voterSrc].some((p) => p && url.startsWith(p)) && /\.tsx?$/.test(url)) {
    return nextLoad(url, { ...context, format: 'module' })
  }
  return nextLoad(url, context)
}
