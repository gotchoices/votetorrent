// pool-wire.ts — the rendezvous on a libp2p node: one length-prefixed JSON request and one reply
// per stream, on POOL_RENDEZVOUS_PROTOCOL. Duck-typed against libp2p 3 so vote-engine takes no
// libp2p dependency (the apps and the drone hand in their node).
//
// Gotcha carried from spike 102 / cadre-core control-stream.ts: a libp2p 3 stream iterator that is
// attached after the remote half-closed never ends, so both sides read IMMEDIATELY and stop at one
// complete frame instead of waiting for end-of-stream.

import { utf8ToBytes } from '@noble/hashes/utils.js'
import { decodeUtf8Fatal } from '../key-release/election-block.js'
import type { PoolRendezvous, PoolRendezvousClient, RendezvousReply, RendezvousRequest } from './pool-rendezvous.js'

export const POOL_RENDEZVOUS_PROTOCOL = '/votetorrent/pool-rendezvous/1.0.0'
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/* eslint-disable @typescript-eslint/no-explicit-any */
type Libp2pLike = {
  handle: (protocol: string, handler: (stream: any, connection: any) => void, options?: any) => Promise<void> | void
  unhandle?: (protocol: string) => Promise<void> | void
  dialProtocol: (target: any, protocol: string, options?: any) => Promise<any>
}

function frame (obj: unknown): Uint8Array {
  const body = utf8ToBytes(JSON.stringify(obj))
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

async function readFrame (stream: any, timeoutMs: number): Promise<unknown> {
  let buf = new Uint8Array(0)
  const it = stream[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false)
      if (len > MAX_FRAME_BYTES) throw new Error('pool frame too large')
      if (buf.length >= 4 + len) return JSON.parse(decodeUtf8Fatal(buf.subarray(4, 4 + len)))
    }
    const left = deadline - Date.now()
    if (left <= 0) throw new Error('pool frame read timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    const next: any = await Promise.race([
      it.next(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), left) })
    ])
    clearTimeout(timer)
    if (next.timeout === true) throw new Error('pool frame read timed out')
    if (next.done === true) throw new Error(`pool stream ended after ${buf.length} bytes`)
    const chunk: Uint8Array = typeof next.value?.subarray === 'function' ? next.value.subarray() : next.value
    const merged = new Uint8Array(buf.length + chunk.length)
    merged.set(buf)
    merged.set(chunk, buf.length)
    buf = merged
  }
}

function sendFrame (stream: any, obj: unknown): void {
  // libp2p 3: send(); libp2p 2-style sinks are not supported here.
  stream.send(frame(obj))
}

/**
 * Serve `rendezvous` on `libp2p`. The caller is the connection's authenticated remote peer —
 * never a field of the request.
 */
export async function attachPoolRendezvous (libp2p: Libp2pLike, rendezvous: PoolRendezvous): Promise<() => Promise<void>> {
  await libp2p.handle(POOL_RENDEZVOUS_PROTOCOL, (stream: any, connection: any) => {
    const from = String(connection?.remotePeer?.toString?.() ?? '')
    readFrame(stream, 15_000)
      .then(async (request) => {
        const reply = from.length > 0
          ? await rendezvous.handle(from, request as RendezvousRequest)
          : { t: 'error', reason: 'unauthenticated' }
        sendFrame(stream, reply)
        await stream.close()
      })
      .catch((e: Error) => { try { stream.abort(e) } catch { /* already gone */ } })
  }, { runOnLimitedConnection: true })
  return async () => {
    rendezvous.close()
    try { await libp2p.unhandle?.(POOL_RENDEZVOUS_PROTOCOL) } catch { /* node stopping */ }
  }
}

/**
 * A voter's client for a rendezvous reachable at `target` (whatever the node's `dialProtocol`
 * accepts: a PeerId, a Multiaddr or a Multiaddr list — built by the caller, which owns libp2p).
 * One stream per request. A failed dial or a timeout throws; an `error` reply is returned. A throw
 * after the request frame was sent carries `requestSent: true`: the host may have acted on it, so a
 * failover must not resend it elsewhere (pool-failover.ts).
 */
export function createLibp2pRendezvousClient (libp2p: Libp2pLike, target: unknown, options: { requestTimeoutMs?: number } = {}): PoolRendezvousClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000
  return {
    async call (request: RendezvousRequest, extraWaitMs = 0): Promise<RendezvousReply> {
      const timeoutMs = requestTimeoutMs + extraWaitMs
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const stream = await libp2p.dialProtocol(target, POOL_RENDEZVOUS_PROTOCOL, { signal: controller.signal, runOnLimitedConnection: true })
        try {
          sendFrame(stream, request)
          try {
            return await readFrame(stream, timeoutMs) as RendezvousReply
          } catch (err) {
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { requestSent: true as const })
          }
        } finally {
          try { await stream.close() } catch { /* best effort */ }
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
