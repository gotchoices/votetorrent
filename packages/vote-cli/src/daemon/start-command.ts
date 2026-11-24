import type { ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import type { LocalCommand } from '../ctl/commands.js'
import type { Role } from '../ctl/protocol.js'
export interface RunStartDeps {
  assertFresh?: () => unknown
  loadMain?: () => Promise<{ runDaemon: (opts: unknown) => Promise<ExitCode> }>
  totalmem?: () => number
}
export async function runStart(_role: Role, _args: Record<string, unknown>, _io: CliIo, _deps?: RunStartDeps): Promise<ExitCode> {
  throw new Error('unimplemented')
}
export const LOCAL_COMMANDS: ReadonlyMap<string, LocalCommand> = new Map<string, LocalCommand>([['start', (role, args, io) => runStart(role, args, io)]])
