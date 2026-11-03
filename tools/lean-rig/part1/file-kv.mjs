// file-kv.mjs - one cached JSON key/value object per file path (cache in globalThis), write-through by temp file + rename, mode 0600.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function fileKv (path) {
  const cache = (globalThis.__hr5KvCache ??= new Map())
  if (cache.has(path)) return cache.get(path)
  let data = {}
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    data = text.trim() ? JSON.parse(text) : {}
  }
  const flush = () => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  }
  const kv = {
    path,
    get (k) { return Object.hasOwn(data, k) ? data[k] : undefined },
    has (k) { return Object.hasOwn(data, k) },
    set (k, v) { data[k] = v; flush() },
    remove (k) { if (Object.hasOwn(data, k)) { delete data[k]; flush() } },
    clear () { data = {}; flush() },
    keys () { return Object.keys(data) }
  }
  cache.set(path, kv)
  return kv
}
