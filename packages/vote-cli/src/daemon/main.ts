import type { ExitCode } from '../cli/exit-codes.js'
import type { StartOptions } from './start-args.js'
export async function runDaemon(_opts: StartOptions & { envReport: unknown }, _deps?: { exit: (code: number) => void }): Promise<ExitCode> {
  throw new Error('unimplemented')
}
