// The peer budget of `vt run`: a CadreNode peer peaks at 550-700 MB RSS, and the whole session on this
// shared Mac stays under 45% of memory. The default is derived from os.totalmem(): on macOS the
// "free" figure excludes reclaimable cache and under-reports badly. The refusal runs before any state
// dir or process exists, so an over-sized topology leaves nothing behind.

import { totalmem } from 'node:os'

/** 700 MiB: the measured peak of one CadreNode peer with its strands. */
export const PEER_RSS_BYTES = 734003200
export const PEER_BUDGET_FRACTION = 0.45

export function defaultMaxPeers (totalmemBytes: number = totalmem()): number {
  return Math.floor((PEER_BUDGET_FRACTION * totalmemBytes) / PEER_RSS_BYTES)
}

export class PeerBudgetError extends Error {
  readonly code = 'max-peers' as const
  readonly requested: number
  readonly max: number

  constructor (requested: number, max: number) {
    super(`max-peers: requested ${requested} exceeds ${max}`)
    this.name = 'PeerBudgetError'
    this.requested = requested
    this.max = max
  }
}

export function assertPeerBudget (requested: number, max: number): void {
  if (requested > max) throw new PeerBudgetError(requested, max)
}
