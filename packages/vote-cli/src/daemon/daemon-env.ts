// Daemon env hygiene, applied BEFORE any engine module loads (the `debug` package reads DEBUG,
// DEBUG_COLORS and DEBUG_HIDE_DATE when it is first imported, so this runs on the start path, ahead
// of the single dynamic import of main.js).
//
// What is forced and why:
// - FORCE_COLOR=0, DEBUG_COLORS=0: ANSI codes break every log-parsing gate (prof/netstats, the
//   secret scan's window matching).
// - DEBUG_HIDE_DATE=0: the profile tools key on the `<ISO> <namespace> <msg>` line shape.
// - DEBUG is FILTERED to the `optimystic:` and `sereus:` namespaces (what the profile tools consume);
//   `*`, `libp2p:*` and anything else is dropped. Whenever any namespace is kept, the eleven
//   secret-bearing cadre-core namespaces below are appended as exclusions; `debug` applies skips
//   before enables, so an exclusion always wins over a wildcard.
// - DUMP_SESSION_KEYS is deleted: it makes a TLS stack write session keys to a file.
//
// Redacted namespaces (cadre-core 1.24): each can print key, owner-grant, push-token, invitation or
// seed-trust material at debug level.

export const DEBUG_ALLOWED_PREFIXES: readonly string[] = Object.freeze(['optimystic:', 'sereus:'])

export const DEBUG_REDACTED_NAMESPACES: readonly string[] = Object.freeze([
  'sereus:cadre:identity-key',
  'sereus:cadre:invite-proto',
  'sereus:cadre:key-store-file',
  'sereus:cadre:owner-grant-proto',
  'sereus:cadre:peer-authorization',
  'sereus:cadre:provider-oauth',
  'sereus:cadre:push:*',
  'sereus:cadre:seed-bootstrap',
  'sereus:cadre:seed-trust-policy',
  'sereus:cadre:strand-party-key-rotation',
  'sereus:cadre:trusted-owner-store'
])

const TOKEN_RE = /^[a-z0-9:_.*-]{1,128}$/

export interface DebugFilterResult {
  /** The filtered DEBUG value, or undefined when nothing is kept (unset DEBUG). */
  value: string | undefined
  kept: number
  dropped: number
}

/** Keeps the allowed-prefix tokens (and their `-` negations), drops the rest, appends the exclusions. Counts only. */
export function filterDebugNamespaces(raw: string | undefined): DebugFilterResult {
  if (raw === undefined) return { value: undefined, kept: 0, dropped: 0 }
  const kept: string[] = []
  let dropped = 0
  for (const token of raw.split(/[\s,]+/)) {
    if (token.length === 0) continue
    const bare = token.startsWith('-') ? token.slice(1) : token
    const allowed = TOKEN_RE.test(bare) && DEBUG_ALLOWED_PREFIXES.some((p) => bare.startsWith(p))
    if (allowed) kept.push(token)
    else dropped++
  }
  if (kept.length === 0) return { value: undefined, kept: 0, dropped }
  const excluded = DEBUG_REDACTED_NAMESPACES.map((ns) => `-${ns}`)
  return { value: [...kept, ...excluded].join(','), kept: kept.length, dropped }
}

export interface DaemonEnvReport {
  debugKept: number
  debugDropped: number
  nodeOptionsSet: boolean
}

export function applyDaemonEnv(env: NodeJS.ProcessEnv = process.env): DaemonEnvReport {
  const nodeOptionsSet = typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.length > 0
  env.FORCE_COLOR = '0'
  env.DEBUG_COLORS = '0'
  env.DEBUG_HIDE_DATE = '0'
  delete env.DUMP_SESSION_KEYS
  const debug = filterDebugNamespaces(env.DEBUG)
  if (debug.value === undefined) delete env.DEBUG
  else env.DEBUG = debug.value
  return { debugKept: debug.kept, debugDropped: debug.dropped, nodeOptionsSet }
}
