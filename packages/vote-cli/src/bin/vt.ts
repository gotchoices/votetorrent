#!/usr/bin/env node
// vt: the VoteTorrent command-line entry. It only hands argv to runCli and reports the exit code
// through process.exitCode, so stdout and stderr flush before the process ends. An unexpected throw
// prints the error's name alone: a message could carry a code, a path or an address.

import { runCli } from '../cli/run-cli.js'
import { EXIT } from '../cli/exit-codes.js'

const io = {
  out: (text: string): void => {
    process.stdout.write(text)
  },
  err: (text: string): void => {
    process.stderr.write(text)
  }
}

try {
  process.exitCode = await runCli(process.argv.slice(2), io)
} catch (err) {
  const name = err instanceof Error && err.name ? err.name : 'Error'
  process.stderr.write(`vt: ${name}\n`)
  process.exitCode = EXIT.FAIL
}
