// The `vt <role> <verb> --peer <dir> [--flag value ...]` command table over node:util parseArgs.
//
// Flag rule (the rig's cli.mjs): `--x v` sets x, a bare `--x` is true, `--no-x` is false, `--x=v` is
// inline, repeats collect into an array, keys are camelCased. Values stay strings: verbs validate their
// own args. Nothing from argv is ever echoed (a word may be a code or a path to a secret); the role and
// verb are printed only after validation. `start` is local: a daemon that is not running cannot be asked
// to start itself. This path never calls assertFreshBuild: it only speaks HTTP.

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import { redact } from '../secrecy/redact.js'
import { callCtl, exitCodeFor } from './ctl-client.js'
import { VERB_NAME_RE, type CtlErrorView, type Role } from './protocol.js'

export const LOCAL_ONLY_VERBS: ReadonlySet<string> = new Set(['start'])

export type LocalCommand = (role: Role, args: Record<string, unknown>, io: CliIo) => Promise<ExitCode>

export const ROLE_USAGE = [
  'usage: vt <role> <verb> --peer <dir> [--json] [--timeout-ms N] [--args-json <json>] [--<name> <value> ...]',
  '',
  'roles:    officer | keyholder | voter',
  'verbs:    vt <role> verbs --peer <dir>   lists the verbs the running daemon at <dir> serves',
  '          vt <role> start --state <dir> --relay <relay.env>   starts the daemon (runs locally)',
  '',
  'flags:    --peer <dir>        the daemon dir holding ctl.port and ctl.token (default: $VT_PEER)',
  '          --json              print the whole reply, including the daemon-side ms',
  '          --timeout-ms N      give up waiting after N ms (exit 3)',
  '          --args-json <json>  extra args as one JSON object',
  '          --<name> <value>    one verb arg; a bare --<name> is true, --no-<name> is false, repeats collect',
  '',
  'values are passed as strings and the verb validates them. A secret (join code, registration code,',
  'key share, approval) is passed by FILE PATH only (e.g. --code-file <path>), never on the command line.',
  '',
  'exit codes:',
  '  0  ok',
  '  1  verb failed',
  '  2  usage',
  '  3  daemon unreachable',
  ''
].join('\n')

export type BuildVerbArgsReason =
  | 'positional'
  | 'short-option'
  | 'bad-flag-name'
  | 'duplicate-arg'
  | 'args-json-shape'
  | 'timeout-shape'
  | 'missing-value'

export interface VerbControl {
  peer?: string
  json: boolean
  argsJson?: string
  timeoutMs?: number
}

export type BuildVerbArgsResult =
  | { ok: true, control: VerbControl, args: Record<string, unknown> }
  | { ok: false, reason: BuildVerbArgsReason }

const HELP_WORDS: ReadonlySet<string> = new Set(['help', '--help', '-h'])
const FLAG_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/
const TIMEOUT_RE = /^\d{1,8}$/
const MAX_TIMEOUT_MS = 86_400_000
const CONTROL_OPTIONS = {
  peer: { type: 'string' },
  json: { type: 'boolean' },
  'args-json': { type: 'string' },
  'timeout-ms': { type: 'string' }
} as const

const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function buildVerbArgs(words: readonly string[]): BuildVerbArgsResult {
  let tokens: ReturnType<typeof parseArgs>['tokens']
  try {
    tokens = parseArgs({ args: [...words], options: CONTROL_OPTIONS, strict: false, allowPositionals: true, tokens: true }).tokens
  } catch {
    return { ok: false, reason: 'bad-flag-name' }
  }
  const control: VerbControl = { json: false }
  const args: Record<string, unknown> = {}
  const add = (key: string, value: unknown): void => {
    args[key] = Object.hasOwn(args, key) ? ([] as unknown[]).concat(args[key] as unknown[], [value]) : value
  }
  const list = tokens ?? []
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    if (t === undefined) break
    if (t.kind !== 'option') return { ok: false, reason: 'positional' }
    if (!t.rawName.startsWith('--')) return { ok: false, reason: 'short-option' }
    if (Object.hasOwn(CONTROL_OPTIONS, t.name)) {
      if (t.name === 'json') {
        if (t.value !== undefined) return { ok: false, reason: 'bad-flag-name' }
        control.json = true
        continue
      }
      if (typeof t.value !== 'string') return { ok: false, reason: 'missing-value' }
      if (t.name === 'peer') control.peer = t.value
      else if (t.name === 'args-json') control.argsJson = t.value
      else {
        if (!TIMEOUT_RE.test(t.value)) return { ok: false, reason: 'timeout-shape' }
        const n = Number(t.value)
        if (n < 1 || n > MAX_TIMEOUT_MS) return { ok: false, reason: 'timeout-shape' }
        control.timeoutMs = n
      }
      continue
    }
    if (!FLAG_NAME_RE.test(t.name)) return { ok: false, reason: 'bad-flag-name' }
    let key = t.name
    let value: unknown
    const next = list[i + 1]
    if (t.value !== undefined) {
      value = t.value
    } else if (next !== undefined && next.kind === 'positional') {
      value = next.value
      i++
    } else if (key.startsWith('no-')) {
      key = key.slice(3)
      if (key.length === 0) return { ok: false, reason: 'bad-flag-name' }
      value = false
    } else {
      value = true
    }
    add(camel(key), value)
  }
  if (control.argsJson !== undefined) {
    let extra: unknown
    try {
      extra = JSON.parse(control.argsJson)
    } catch {
      return { ok: false, reason: 'args-json-shape' }
    }
    if (!isPlainObject(extra)) return { ok: false, reason: 'args-json-shape' }
    for (const key of Object.keys(extra)) {
      if (Object.hasOwn(args, key)) return { ok: false, reason: 'duplicate-arg' }
      args[key] = extra[key]
    }
  }
  return { ok: true, control, args }
}

function redactErrorView(error: CtlErrorView | undefined): CtlErrorView {
  if (error === undefined) return { name: 'BadResponse' }
  const out: CtlErrorView = { name: redact(error.name) }
  if (typeof error.code === 'string') out.code = redact(error.code)
  if (typeof error.message === 'string') out.message = redact(error.message)
  if (Array.isArray(error.chain)) out.chain = error.chain.map((c) => redact(c))
  return out
}

export async function runRoleCommand(
  argv: readonly string[],
  io: CliIo,
  opts: { env?: NodeJS.ProcessEnv, local?: ReadonlyMap<string, LocalCommand> } = {}
): Promise<ExitCode> {
  const role = argv[0] as Role
  const verb = argv[1]
  if (verb === undefined) {
    io.err(ROLE_USAGE)
    return EXIT.USAGE
  }
  if (HELP_WORDS.has(verb)) {
    io.out(ROLE_USAGE)
    return EXIT.PASS
  }
  if (!VERB_NAME_RE.test(verb)) {
    io.err('vt: invalid verb name (see vt <role> --help)\n')
    return EXIT.USAGE
  }
  const built = buildVerbArgs(argv.slice(2))
  if (!built.ok) {
    io.err(`vt: bad arguments (${built.reason})\n`)
    return EXIT.USAGE
  }
  const { control, args } = built
  if (LOCAL_ONLY_VERBS.has(verb)) {
    const local = opts.local?.get(verb)
    if (local === undefined) {
      io.err(`vt: ${role} ${verb} has no local handler in this command table\n`)
      return EXIT.USAGE
    }
    return local(role, args, io)
  }
  const peer = control.peer ?? opts.env?.VT_PEER
  if (peer === undefined || peer.length === 0) {
    io.err('vt: --peer <dir> is required (or set VT_PEER)\n')
    return EXIT.USAGE
  }
  const reply = await callCtl({ dir: resolve(peer), role, verb, args, timeoutMs: control.timeoutMs })
  const code = exitCodeFor(reply)
  if (code === EXIT.PASS) {
    io.out(JSON.stringify(control.json ? reply.body : reply.body.result ?? {}) + '\n')
    return code
  }
  io.err(JSON.stringify({ error: redactErrorView(reply.body.error) }) + '\n')
  if (control.json) io.out(JSON.stringify(reply.body) + '\n')
  return code
}
