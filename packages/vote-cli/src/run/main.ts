#!/usr/bin/env node
// The process entry for `vt run election` and `vt selfcheck` (exit 0/1/2). runVtCommand is the function
// the vt binary's dispatch hands `run ...` and `selfcheck` argv to; this file is also runnable on its own
// as `node dist/run/main.js ...`. argv is untrusted and is never echoed: a usage error prints its code
// alone plus the VOID RESULT line.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import { runElection } from './election.js'
import { RunUsageError, parseRunElectionArgs } from './options.js'
import { RESULTS_TOOL } from './results.js'
import { runSelfcheck } from './selfcheck.js'

export const RUN_USAGE = [
  'usage: vt run election --relay <relay.env> --state <dir> --party <id> [--lead-ms N] [--window-ms N] [--marks-file F] [--max-peers N] [--keyholders 1|2] [--voters N] [--colocate a,b] [--debug NS] [--import F] [--cpu-prof] [--instruments] [--alarm-s N]',
  '       vt selfcheck',
  ''
].join('\n')

export async function runVtCommand (argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const [first, second, ...rest] = argv
  if (first === 'selfcheck' && argv.length === 1) return runSelfcheck({ out: (t) => io.out(t + '\n') })
  if (first === 'run' && second === 'election') {
    let opts
    try {
      opts = parseRunElectionArgs(rest)
    } catch (e) {
      if (e instanceof RunUsageError) {
        io.err(`vt run: ${e.code}\n`)
        io.out('RESULT ' + JSON.stringify({ tool: RESULTS_TOOL, verdict: 'VOID', reason: 'usage', code: e.code }) + '\n')
        return EXIT.USAGE
      }
      throw e
    }
    return runElection(opts, { io, handleSignals: true })
  }
  io.err(RUN_USAGE)
  return EXIT.USAGE
}

function isProcessEntry (): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isProcessEntry()) {
  const io: CliIo = {
    out: (text) => {
      process.stdout.write(text)
    },
    err: (text) => {
      process.stderr.write(text)
    }
  }
  try {
    process.exitCode = await runVtCommand(process.argv.slice(2), io)
  } catch (err) {
    const name = err instanceof Error && err.name ? err.name : 'Error'
    process.stderr.write(`vt run: ${name}\n`)
    process.exitCode = EXIT.FAIL
  }
}
