// The ordered election leg table and the run context a leg body receives. The names are the lean rig's,
// so per-leg evidence lines up with earlier profiles (`network` replaces the rig's part 1 + `reopen`).
// Every entry carries its body; runElection still fails a body-less leg closed with `leg-unwired`, so
// an unwired run can never read as PASS. wireLegBodies remains the seam for injecting replacement bodies.

import type { DaemonCallResult, DaemonHandle } from './daemon-launcher.js'
import { acceptBody, dkgBody } from './leg-bodies/accept-dkg.js'
import { electionBody } from './leg-bodies/election.js'
import { networkBody } from './leg-bodies/network.js'
import { releaseBody } from './leg-bodies/release.js'
import { votersBody } from './leg-bodies/voters.js'
import type { LegCtx } from './legs.js'
import type { RunInstruments } from './instruments/run-instruments.js'
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

/** Mutable values handed from one leg to the next; protocol ids, never secret material. */
export interface RunShared {
  topology: 'full' | 'reduced'
  networkHash: string
  networkName: string
  authorityId: string
  electionId: string
  ballotId: string
  votingStartsAtMs: number
  closedAtMs: number
  releasingKeysAtMs: number
  seatFiles: Record<string, string>
  codeFiles: Record<string, string>
  fingerprintFiles: Record<string, string>
  needleFile: string
  votersChoices: Record<string, number>
  peerId8: string
}

export interface RunContext {
  readonly opts: RunOptions
  readonly out: RunOutput
  peer (label: string): RunPeer
  startPeers (labels: readonly string[]): Promise<void>
  /** `<state>/secrets/<name>`; the name must match /^[a-z0-9][a-z0-9.-]*$/. Secrets travel by path only. */
  secretPath (name: string): string
  registerSecretFile (path: string, opts?: { windows?: boolean }): void
  /** The per-peer approval token path; the token content never leaves the daemon's file. */
  tokenFile (label: string): string
  /** Restarts the label's daemon and records the restart step. */
  restart (label: string): Promise<DaemonHandle>
  /** Values discovered by earlier legs. */
  shared: RunShared
  /** Null unless --instruments; every observation is opt-in. */
  instruments: RunInstruments | null
  /** The run's injected clock (Date.now by default). */
  nowMs (): number
  /** The run's sleep (a real timer by default, an instant clock advance under the scripted rig). */
  sleep (ms: number): Promise<void>
}

export type ElectionLegBody = (L: LegCtx, ctx: RunContext) => Promise<void>

export interface ElectionLeg {
  readonly name: string
  readonly part: LegPart
  readonly body?: ElectionLegBody
}

export const ELECTION_LEGS: readonly ElectionLeg[] = Object.freeze([
  Object.freeze({ name: 'network', part: 'p1' as const, body: networkBody }),
  Object.freeze({ name: 'h6-election', part: 'p2' as const, body: electionBody }),
  Object.freeze({ name: 'h7-accept', part: 'p2' as const, body: acceptBody }),
  Object.freeze({ name: 'h8-dkg', part: 'p2' as const, body: dkgBody }),
  Object.freeze({ name: 'h9-voters', part: 'p2' as const, body: votersBody }),
  Object.freeze({ name: 'h10-release-decrypt', part: 'p2' as const, body: releaseBody })
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
