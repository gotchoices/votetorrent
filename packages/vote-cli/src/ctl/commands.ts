// The `vt <role> <verb>` command table (red stub).

import type { ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import type { Role } from './protocol.js'

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

export function buildVerbArgs(_words: readonly string[]): BuildVerbArgsResult {
  throw new Error('unimplemented')
}

export async function runRoleCommand(
  _argv: readonly string[],
  _io: CliIo,
  _opts: { env?: NodeJS.ProcessEnv, local?: ReadonlyMap<string, LocalCommand> } = {}
): Promise<ExitCode> {
  throw new Error('unimplemented')
}
