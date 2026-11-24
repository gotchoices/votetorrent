// Top-level dispatch for the vt binary: help, usage and the unknown-command path.
//
// argv is untrusted: a word may be a join code, a registration code or the path to a secret, so
// nothing from argv is ever echoed back. This module never calls assertFreshBuild: a usage or help
// request must work on an unbuilt tree, and the daemon start and `vt run` commands guard themselves.

import { EXIT, type ExitCode } from './exit-codes.js'
import { runRoleCommand } from '../ctl/commands.js'
import { isRole } from '../ctl/protocol.js'

export interface CliIo {
  out(text: string): void
  err(text: string): void
}

export const USAGE = [
  'usage: vt <role> <verb> [--flag value ...]',
  '',
  'roles:',
  '  officer     the authority officer daemon (founds the network, runs the election)',
  '  keyholder   a keyholder daemon (accepts its invitation, runs the DKG, releases its share)',
  '  voter       a voter daemon (joins, registers, casts and sends a vote)',
  '',
  'forms:',
  '  vt <role> start --state <dir> --relay <relay.env>',
  '  vt run election --relay <relay.env> --state <dir> --party <id>',
  '  vt help | vt --help | vt -h',
  '',
  'exit codes:',
  '  0  PASS',
  '  1  FAIL',
  '  2  usage',
  '  3  daemon unreachable',
  ''
].join('\n')

const HELP_WORDS: ReadonlySet<string> = new Set(['help', '--help', '-h'])

export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const first = argv[0]
  if (first === undefined) {
    io.err(USAGE)
    return EXIT.USAGE
  }
  if (HELP_WORDS.has(first)) {
    io.out(USAGE)
    return EXIT.PASS
  }
  if (isRole(first)) return runRoleCommand(argv, io, { env: process.env })
  io.err('vt: unknown command (see vt --help)\n')
  return EXIT.USAGE
}
