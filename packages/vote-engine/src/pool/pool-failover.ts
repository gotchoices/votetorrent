// pool-failover.ts — a rendezvous client over several transports to the SAME authority rendezvous,
// one per join-bootstrap address (R3, D-30).
//
// Rules:
//   - the client that answered last is tried first (sticky last-good), then the others in index order;
//   - fail over only on a throw BEFORE the request was sent (a failed dial or stream open). An
//     `error` REPLY means the host was reached and answered, so it is returned as is, never retried
//     elsewhere;
//   - a throw marked `requestSent: true` (the frame went out, then no reply came) is NOT resent
//     through another address: a request such as a `form` is not idempotent, and a second delivery
//     costs a member a second consent prompt (WR-01). It throws `Error('rendezvous did not reply')`,
//     and the next call starts on the following address so one hung address cannot keep every call;
//   - when no client answers, one stable `Error('rendezvous unreachable')` is thrown: no raw
//     transport text, no `cause`, so nothing hostile reaches a screen.
// Transport-free and Hermes/browser-pure: type-only imports, no Node API, no clock.
import type { PoolRendezvousClient, RendezvousReply, RendezvousRequest } from './pool-rendezvous.js'

export interface FailoverRendezvousClient extends PoolRendezvousClient {
  /** index of the client that answered most recently; -1 before any answer */
  lastGood (): number
}

/** A client marks an error thrown after its request frame went out with `requestSent: true`. */
function requestWasSent (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { requestSent?: unknown }).requestSent === true
}

export function createFailoverRendezvousClient (clients: readonly PoolRendezvousClient[]): FailoverRendezvousClient {
  const list = clients.slice()
  let good = -1
  /** the client tried first: the last that answered, or the one after a client that went silent after a send */
  let first = -1
  return {
    lastGood: () => good,
    async call (request: RendezvousRequest, extraWaitMs?: number): Promise<RendezvousReply> {
      const order: number[] = []
      if (first >= 0 && first < list.length) order.push(first)
      for (let i = 0; i < list.length; i++) if (i !== first) order.push(i)
      for (const i of order) {
        try {
          const reply = await list[i]!.call(request, extraWaitMs)
          good = i
          first = i
          return reply
        } catch (err) {
          if (requestWasSent(err)) {
            first = (i + 1) % list.length
            throw new Error('rendezvous did not reply')
          }
          // this address was not reached; try the next
        }
      }
      throw new Error('rendezvous unreachable')
    }
  }
}
