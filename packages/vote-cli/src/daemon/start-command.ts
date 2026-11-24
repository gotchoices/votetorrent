// The local `start` command of `vt <role> start ...`: env hygiene, argument validation (incl. the
// party/posture rules), the stale-dist guard and the max-peers guard, THEN one dynamic import of the
// daemon module. The order matters: the `debug` package reads DEBUG, DEBUG_COLORS and DEBUG_HIDE_DATE
// when it is first imported, and the engine packages pull it in, so nothing on this path may import a
// package statically (node built-ins and this package's own start-path modules only). The static-import
// gate in the daemon unit spec pins that.

import { existsSync } from 'node:fs'
import { totalmem as osTotalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import type { LocalCommand } from '../ctl/commands.js'
import type { Role } from '../ctl/protocol.js'
import { assertFreshBuild } from '../engine.js'
import { defaultMaxPeers } from '../run/peer-budget.js'
import { applyDaemonEnv, type DaemonEnvReport } from './daemon-env.js'
import { parseStartArgs, type StartOptions } from './start-args.js'

/** Four directories above this module (src/daemon or dist/daemon): the repo root, which must hold packages/vote-cli. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

export interface RunStartDeps {
  assertFresh?: () => unknown
  loadMain?: () => Promise<{ runDaemon: (opts: StartOptions & { envReport: DaemonEnvReport }) => Promise<ExitCode> }>
  totalmem?: () => number
}

const BOOT_FAILED_TOKENS: ReadonlySet<string> = new Set(['max-peers', 'production-party'])

export async function runStart(role: Role, args: Record<string, unknown>, io: CliIo, deps: RunStartDeps = {}): Promise<ExitCode> {
  const assertFresh = deps.assertFresh ?? assertFreshBuild
  const loadMain = deps.loadMain ?? (() => import('./main.js'))
  const totalmem = deps.totalmem ?? osTotalmem
  // 1. env hygiene before anything else
  const envReport = applyDaemonEnv()
  // 2. arguments, layout, party and posture
  let opts: StartOptions
  try {
    if (!existsSync(join(REPO_ROOT, 'packages', 'vote-cli'))) throw new Error('vt: repo root not found')
    opts = parseStartArgs(role, args, { totalmem, repoRoot: REPO_ROOT, defaultMaxPeers })
  } catch (e) {
    const err = e as { name?: unknown, code?: unknown } | undefined
    if (err?.name !== 'StartArgsError' || typeof err.code !== 'string') throw e
    io.err(`vt: ${role} start refused (${err.code})\n`)
    io.out(`VT-DAEMON-BOOT-FAILED role=${role} peer=? token=${BOOT_FAILED_TOKENS.has(err.code) ? err.code : 'usage'}\n`)
    return EXIT.USAGE
  }
  io.out(`VT-DAEMON-POSTURE party=${opts.partyId} posture=${opts.posture}\n`)
  // 3. the dist must be fresh: a stale build would silently run old engine code
  try {
    assertFresh()
  } catch {
    io.err(`vt: ${role} start refused (stale-build)\n`)
    io.out(`VT-DAEMON-BOOT-FAILED role=${role} peer=? token=stale-build\n`)
    return EXIT.USAGE
  }
  // 4. the daemon
  const { runDaemon } = await loadMain()
  return runDaemon({ ...opts, envReport })
}

export const LOCAL_COMMANDS: ReadonlyMap<string, LocalCommand> = new Map<string, LocalCommand>([['start', (role, args, io) => runStart(role, args, io)]])
