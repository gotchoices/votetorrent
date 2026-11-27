// The bounded relay-reservation wait every role daemon runs after its node started (RESEARCH §4
// "Relay"): READY means the node advertises a `/p2p/<relay>/p2p-circuit` address through the
// configured relay and NO direct address (a phone-shaped posture; the rig's `circuitViaRelay == true
// and nonCircuitAddrs == 0`). The poll is 1 s, the bound at most 90 s, and the failure is a named error
// whose message carries a duration only: a loopback relay's address and peer id are secrets.

export const RELAY_READY_MAX_MS = 90_000
const DEFAULT_INTERVAL_MS = 1000

export class RelayNotReadyError extends Error {
  readonly code = 'relay-reservation-timeout' as const
  readonly waitedMs: number
  readonly lastCircuit: number
  readonly lastDirect: number

  constructor(waitedMs: number, lastCircuit: number, lastDirect: number) {
    super(`relay reservation not ready within ${Math.round(waitedMs / 1000)} s`)
    this.name = 'RelayNotReadyError'
    this.waitedMs = waitedMs
    this.lastCircuit = lastCircuit
    this.lastDirect = lastDirect
  }
}

export interface RelayReadinessOptions {
  /** 1..RELAY_READY_MAX_MS. */
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RelayReadiness {
  waitedMs: number
  circuitAddrs: number
}

/** The last `/p2p/<id>` segment of a multiaddr (for a circuit address, the target; for a bare relay address, the relay). */
export function relayPeerIdOf(multiaddr: string): string {
  const parts = multiaddr.split('/p2p/')
  const last = parts[parts.length - 1] ?? ''
  const end = last.indexOf('/')
  return end === -1 ? last : last.slice(0, end)
}

function addrsOf(node: { getMultiaddrs(): ReadonlyArray<unknown> }): string[] {
  try {
    return (node.getMultiaddrs() ?? []).map((a) => String(a))
  } catch {
    return []
  }
}

/** Rejects synchronously (a thrown RangeError) on a bad bound; otherwise a promise that polls to the bound. */
export function awaitRelayReservation(
  node: { getMultiaddrs(): ReadonlyArray<unknown> },
  relayPeerId: string,
  opts: RelayReadinessOptions
): Promise<RelayReadiness> {
  const { timeoutMs } = opts
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RELAY_READY_MAX_MS) throw new RangeError('relay readiness bound out of range')
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const marker = `/p2p/${relayPeerId}/p2p-circuit`
  return (async () => {
    const started = now()
    for (;;) {
      const addrs = addrsOf(node)
      const circuit = addrs.filter((a) => a.includes('/p2p-circuit'))
      const viaRelay = circuit.some((a) => a.includes(marker))
      const direct = addrs.length - circuit.length
      const waitedMs = now() - started
      if (viaRelay && direct === 0) return { waitedMs, circuitAddrs: circuit.length }
      if (waitedMs >= timeoutMs) throw new RelayNotReadyError(waitedMs, circuit.length, direct)
      await sleep(Math.min(intervalMs, timeoutMs - waitedMs))
    }
  })()
}
