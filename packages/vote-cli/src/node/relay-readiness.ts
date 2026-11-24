export const RELAY_READY_MAX_MS = 90_000

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
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function relayPeerIdOf(_multiaddr: string): string {
  throw new Error('unimplemented')
}

export async function awaitRelayReservation(
  _node: { getMultiaddrs(): ReadonlyArray<unknown> },
  _relayPeerId: string,
  _opts: RelayReadinessOptions
): Promise<{ waitedMs: number, circuitAddrs: number }> {
  throw new Error('unimplemented')
}
