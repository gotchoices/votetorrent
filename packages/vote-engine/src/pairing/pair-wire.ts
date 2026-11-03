// pair-wire.ts — the pair-mint protocol on a libp2p node: one length-prefixed JSON request and one
// reply per stream, on PAIR_MINT_PROTOCOL. A current officer's phone that is not a cadre owner uses
// it to ask an owner phone for one single-use cadre invitation (D-22). The protocol lives on the
// control node; nothing here reaches a strand (D-28). Duck-typed against libp2p 3, like
// pool-wire.ts, so vote-engine takes no libp2p dependency.
//
// Gotcha carried from pool-wire.ts and cadre-core's control stream: a libp2p 3 stream iterator that
// is attached after the remote half-closed never ends, so both sides read IMMEDIATELY and stop at
// one complete frame instead of waiting for end-of-stream.
//
// The caller is always the connection's authenticated remote peer, never a request field. A failure
// after the request frame went out carries `requestSent: true`: the owner may already have minted,
// and a resend elsewhere would spend a second invitation. The reply carries a bearer secret, so
// every error here is a fixed string with a closed `reason` and no copy of any reply.

import { utf8ToBytes } from '@noble/hashes/utils.js'
import { decodeUtf8Fatal } from '../key-release/election-block.js'

export const PAIR_MINT_PROTOCOL = '/votetorrent/pair-mint/1.0.0'
export const PAIR_MINT_MAX_FRAME_BYTES = 16 * 1024
export const PAIR_MINT_READ_TIMEOUT_MS = 15_000
const CLIENT_DEFAULT_TIMEOUT_MS = 10_000

export const PAIR_MINT_REFUSAL_CODES = Object.freeze([
  'not-officer',
  'bad-signature',
  'expired',
  'replayed',
  'rate-limited',
  'not-reachable',
  'not-owner',
  'switched-off',
  'unknown-pairing',
  'malformed',
  'requester-mismatch'
] as const)
export type PairMintRefusalCode = typeof PAIR_MINT_REFUSAL_CODES[number]

export type PairMintMintRequest = {
  t: 'mint', v: 1, networkHash: string, userId: string, nonce: string, expiresAt: string,
  requesterPeerId: string, keyPub: string, sig: string
}
export type PairMintRemoveRequest = {
  t: 'remove', v: 1, networkHash: string, userId: string, nonce: string, peerId: string,
  expiresAt: string, keyPub: string, sig: string
}
export type PairMintRequest = PairMintMintRequest | PairMintRemoveRequest

export type PairMintReply =
  | { t: 'minted', v: 1, invitation: string, inviteKey: string, expiresAt: string }
  | { t: 'removed', v: 1, peerId: string }
  | { t: 'refused', v: 1, code: PairMintRefusalCode }

export interface PairMintHandler {
  handle (fromPeerId: string, request: unknown): Promise<PairMintReply>
  close (): void | Promise<void>
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PairMintLibp2pLike = {
  handle: (protocol: string, handler: (stream: any, connection: any) => void, options?: any) => Promise<void> | void
  unhandle?: (protocol: string) => Promise<void> | void
  dialProtocol: (target: any, protocol: string, options?: any) => Promise<any>
}

// ---------------------------------------------------------------------------------------------
// Strict parsers: exact key sets, closed shapes, never throw, return null on any failure.
// ---------------------------------------------------------------------------------------------

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/
const KEY_RE = /^[0-9a-fA-F]{2,256}$/
const SIG_RE = /^[0-9a-fA-F]{2,512}$/
const PEER_RE = /^[A-Za-z0-9]{1,128}$/

function isRecord (v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exactKeys (o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))
}

function sized (v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}

function shaped (re: RegExp, v: unknown): v is string {
  return typeof v === 'string' && re.test(v)
}

const MINT_KEYS = ['t', 'v', 'networkHash', 'userId', 'nonce', 'expiresAt', 'requesterPeerId', 'keyPub', 'sig'] as const
const REMOVE_KEYS = ['t', 'v', 'networkHash', 'userId', 'nonce', 'peerId', 'expiresAt', 'keyPub', 'sig'] as const

export function parsePairMintRequest (value: unknown): PairMintRequest | null {
  try {
    if (!isRecord(value) || value.v !== 1) return null
    if (value.t === 'mint') {
      if (!exactKeys(value, MINT_KEYS)) return null
      if (!sized(value.networkHash, 1, 128) || !sized(value.userId, 1, 128)) return null
      if (!shaped(NONCE_RE, value.nonce) || !shaped(CANONICAL_RE, value.expiresAt)) return null
      if (!shaped(PEER_RE, value.requesterPeerId)) return null
      if (!shaped(KEY_RE, value.keyPub) || !shaped(SIG_RE, value.sig)) return null
      return {
        t: 'mint', v: 1, networkHash: value.networkHash, userId: value.userId, nonce: value.nonce,
        expiresAt: value.expiresAt, requesterPeerId: value.requesterPeerId, keyPub: value.keyPub, sig: value.sig
      }
    }
    if (value.t === 'remove') {
      if (!exactKeys(value, REMOVE_KEYS)) return null
      if (!sized(value.networkHash, 1, 128) || !sized(value.userId, 1, 128)) return null
      if (!shaped(NONCE_RE, value.nonce) || !shaped(CANONICAL_RE, value.expiresAt)) return null
      if (!shaped(PEER_RE, value.peerId)) return null
      if (!shaped(KEY_RE, value.keyPub) || !shaped(SIG_RE, value.sig)) return null
      return {
        t: 'remove', v: 1, networkHash: value.networkHash, userId: value.userId, nonce: value.nonce,
        peerId: value.peerId, expiresAt: value.expiresAt, keyPub: value.keyPub, sig: value.sig
      }
    }
    return null
  } catch {
    return null
  }
}

export function parsePairMintReply (value: unknown): PairMintReply | null {
  try {
    if (!isRecord(value) || value.v !== 1) return null
    if (value.t === 'minted') {
      if (!exactKeys(value, ['t', 'v', 'invitation', 'inviteKey', 'expiresAt'])) return null
      if (!sized(value.invitation, 1, 8192) || !sized(value.inviteKey, 1, 512) || !sized(value.expiresAt, 1, 64)) return null
      return { t: 'minted', v: 1, invitation: value.invitation, inviteKey: value.inviteKey, expiresAt: value.expiresAt }
    }
    if (value.t === 'removed') {
      if (!exactKeys(value, ['t', 'v', 'peerId']) || !shaped(PEER_RE, value.peerId)) return null
      return { t: 'removed', v: 1, peerId: value.peerId }
    }
    if (value.t === 'refused') {
      if (!exactKeys(value, ['t', 'v', 'code'])) return null
      const code = value.code
      if (typeof code !== 'string' || !(PAIR_MINT_REFUSAL_CODES as readonly string[]).includes(code)) return null
      return { t: 'refused', v: 1, code: code as PairMintRefusalCode }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Transport error: a closed reason and whether the request frame was sent. Nothing else.
// ---------------------------------------------------------------------------------------------

export class PairMintTransportError extends Error {
  readonly name = 'PairMintTransportError'
  readonly reason: 'dial-failed' | 'timeout' | 'stream-failed' | 'malformed-reply'
  readonly requestSent: boolean

  constructor (reason: 'dial-failed' | 'timeout' | 'stream-failed' | 'malformed-reply', requestSent: boolean) {
    super('pair-mint transport failed: ' + reason)
    this.reason = reason
    this.requestSent = requestSent
  }
}

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

type ReadFailure = 'too-large' | 'timeout' | 'ended'

class FrameReadError extends Error {
  readonly kind: ReadFailure
  constructor (kind: ReadFailure) {
    super(kind === 'too-large' ? 'pair-mint frame too large' : kind === 'timeout' ? 'pair-mint read timed out' : 'pair-mint stream ended')
    this.kind = kind
  }
}

function frame (obj: unknown): Uint8Array {
  const body = utf8ToBytes(JSON.stringify(obj))
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

/** Read one complete frame's body bytes; later bytes in the same chunk are ignored. */
async function readBody (stream: any, timeoutMs: number): Promise<Uint8Array> {
  let buf = new Uint8Array(0)
  const it = stream[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false)
      if (len > PAIR_MINT_MAX_FRAME_BYTES) throw new FrameReadError('too-large')
      if (buf.length >= 4 + len) return buf.subarray(4, 4 + len)
    }
    const left = deadline - Date.now()
    if (left <= 0) throw new FrameReadError('timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const next: any = await Promise.race([
      it.next(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), left) })
    ])
    clearTimeout(timer)
    if (next.timeout === true) throw new FrameReadError('timeout')
    if (next.done === true) throw new FrameReadError('ended')
    const chunk: Uint8Array = typeof next.value?.subarray === 'function' ? next.value.subarray() : next.value
    const merged = new Uint8Array(buf.length + chunk.length)
    merged.set(buf)
    merged.set(chunk, buf.length)
    buf = merged
  }
}

function refused (code: PairMintRefusalCode): PairMintReply {
  return { t: 'refused', v: 1, code }
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

/**
 * Serve `service` on `libp2p`. The caller is the connection's authenticated remote peer. Returns a
 * detach function that closes the service and removes the handler.
 */
export async function attachPairMint (
  libp2p: PairMintLibp2pLike,
  service: PairMintHandler,
  options: { readTimeoutMs?: number } = {}
): Promise<() => Promise<void>> {
  const readTimeoutMs = options.readTimeoutMs ?? PAIR_MINT_READ_TIMEOUT_MS
  await libp2p.handle(PAIR_MINT_PROTOCOL, (stream: any, connection: any) => {
    const from = String(connection?.remotePeer?.toString?.() ?? '')
    readBody(stream, readTimeoutMs)
      .then(async (body) => {
        let reply: PairMintReply
        if (from.length === 0) {
          reply = refused('not-officer')
        } else {
          let parsed: unknown
          let ok = true
          try { parsed = JSON.parse(decodeUtf8Fatal(body)) } catch { ok = false }
          if (!ok) {
            reply = refused('malformed')
          } else {
            try {
              reply = await service.handle(from, parsed)
            } catch {
              reply = refused('not-reachable')
            }
          }
        }
        // libp2p 3: send(); libp2p 2-style sinks are not supported here.
        stream.send(frame(reply))
        await stream.close()
      })
      .catch((e: unknown) => {
        try { stream.abort(e instanceof FrameReadError ? e : new Error('pair-mint stream failed')) } catch { /* already gone */ }
      })
  }, { runOnLimitedConnection: true })
  return async () => {
    try { await service.close() } catch { /* best effort */ }
    try { await libp2p.unhandle?.(PAIR_MINT_PROTOCOL) } catch { /* node stopping */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/**
 * Send one request to the owner reachable at `target` (whatever the node's `dialProtocol` accepts)
 * and return its reply; a refusal is a returned reply, not a throw. A dial failure throws with
 * `requestSent: false`. From the moment the frame is sent, every failure throws with
 * `requestSent: true`, so no caller resends a mint to a second owner.
 */
export async function requestPairMint (
  libp2p: PairMintLibp2pLike,
  target: unknown,
  request: PairMintRequest,
  options: { timeoutMs?: number } = {}
): Promise<PairMintReply> {
  const timeoutMs = options.timeoutMs ?? CLIENT_DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let stream: any
    try {
      stream = await libp2p.dialProtocol(target, PAIR_MINT_PROTOCOL, { signal: controller.signal, runOnLimitedConnection: true })
    } catch {
      throw new PairMintTransportError('dial-failed', false)
    }
    try {
      try {
        stream.send(frame(request))
      } catch {
        throw new PairMintTransportError('stream-failed', true)
      }
      let body: Uint8Array
      try {
        body = await readBody(stream, Math.max(1, timeoutMs - (Date.now() - startedAt)))
      } catch (err) {
        const kind = err instanceof FrameReadError ? err.kind : 'ended'
        throw new PairMintTransportError(kind === 'timeout' ? 'timeout' : 'stream-failed', true)
      }
      let reply: PairMintReply | null = null
      try { reply = parsePairMintReply(JSON.parse(decodeUtf8Fatal(body))) } catch { reply = null }
      if (reply === null) throw new PairMintTransportError('malformed-reply', true)
      return reply
    } finally {
      try { await stream.close() } catch { /* best effort */ }
    }
  } finally {
    clearTimeout(timer)
  }
}
