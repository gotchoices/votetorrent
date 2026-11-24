// The ordered election leg table and the run context a leg body receives. The names are the lean rig's,
// so per-leg evidence lines up with earlier profiles (`network` replaces the rig's part 1 + `reopen`).
// This module registers NO bodies: runElection fails a body-less leg closed with `leg-unwired`, so an
// unwired run can never read as PASS. The leg-wiring plan attaches the bodies with wireLegBodies (or
// by filling `body` here).

import type { DaemonCallResult } from './daemon-launcher.js'
import type { LegCtx } from './legs.js'
import type { RunOptions } from './options.js'
import type { RunOutput } from './output.js'

export type LegPart = 'p1' | 'p2'

/** A peer of the run, started lazily on its first call. */
export interface RunPeer {
  readonly label: string
  /** Resolves once the peer's daemon answers; rejects with LegFail daemon-boot / daemon-timeout. */
  ready (): Promise<void>
  call (verb: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<DaemonCallResult>
  /** Voters only, after ready(): writes `STAGE <name>` into ev/<label>.log. */
  stage (name: string): void
}

export interface RunContext {
  readonly opts: RunOptions
  readonly out: RunOutput
  peer (label: string): RunPeer
  startPeers (labels: readonly string[]): Promise<void>
  /** `<state>/secrets/<name>`; the name must match /^[a-z0-9][a-z0-9.-]*$/. Secrets travel by path only. */
  secretPath (name: string): string
  registerSecretFile (path: string, opts?: { windows?: boolean }): void
}

export type ElectionLegBody = (L: LegCtx, ctx: RunContext) => Promise<void>

export interface ElectionLeg {
  readonly name: string
  readonly part: LegPart
  readonly body?: ElectionLegBody
}

export const ELECTION_LEGS: readonly ElectionLeg[] = Object.freeze([
  Object.freeze({ name: 'network', part: 'p1' as const }),
  Object.freeze({ name: 'h6-election', part: 'p2' as const }),
  Object.freeze({ name: 'h7-accept', part: 'p2' as const }),
  Object.freeze({ name: 'h8-dkg', part: 'p2' as const }),
  Object.freeze({ name: 'h9-voters', part: 'p2' as const }),
  Object.freeze({ name: 'h10-release-decrypt', part: 'p2' as const })
])

/** A copy of `table` with the given bodies attached; a body for an unknown leg name is refused. */
export function wireLegBodies (table: readonly ElectionLeg[], bodies: Readonly<Record<string, ElectionLegBody>>): readonly ElectionLeg[] {
  const names = new Set(table.map((l) => l.name))
  for (const name of Object.keys(bodies)) if (!names.has(name)) throw new TypeError('election-legs: unknown-leg')
  return Object.freeze(
    table.map((l) => {
      const body = bodies[l.name] ?? l.body
      return Object.freeze(body === undefined ? { name: l.name, part: l.part } : { name: l.name, part: l.part, body })
    })
  )
}
