// pair-wire.spec.ts — the pair-mint wire over an in-memory libp2p fake: round trips, the caller
// identity, the frame cap, framing, the read timeout, the client's error marking and the parsers.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import {
  PAIR_MINT_MAX_FRAME_BYTES,
  PAIR_MINT_PROTOCOL,
  PAIR_MINT_READ_TIMEOUT_MS,
  PAIR_MINT_REFUSAL_CODES,
  PairMintTransportError,
  attachPairMint,
  parsePairMintReply,
  parsePairMintRequest,
  requestPairMint,
  type PairMintHandler,
  type PairMintMintRequest,
  type PairMintRemoveRequest,
  type PairMintReply
} from '../src/pairing/pair-wire.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

const MINT: PairMintMintRequest = {
  t: 'mint',
  v: 1,
  networkHash: 'a'.repeat(64),
  userId: 'user-1',
  nonce: 'AbCdEfGhIjKlMnOp',
  expiresAt: '2030-01-01T00:00:00',
  requesterPeerId: 'peerA',
  keyPub: '02' + 'ab'.repeat(32),
  sig: 'cd'.repeat(64)
}
const REMOVE: PairMintRemoveRequest = {
  t: 'remove',
  v: 1,
  networkHash: 'a'.repeat(64),
  userId: 'user-1',
  nonce: 'AbCdEfGhIjKlMnOp',
  peerId: 'peerB',
  expiresAt: '2030-01-01T00:00:00',
  keyPub: '02' + 'ab'.repeat(32),
  sig: 'cd'.repeat(64)
}
const MINTED: PairMintReply = { t: 'minted', v: 1, invitation: 'sereus-invite:1.abc', inviteKey: 'ik-1', expiresAt: '2030-01-01T00:00:00' }

function frameOf (obj: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(obj))
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

function concat (...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const tick = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 5))

async function until (cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await tick()
  }
}

// ---- in-memory stream pair -----------------------------------------------------------------

class FakeStream {
  peer!: FakeStream
  queue: Uint8Array[] = []
  ended = false
  aborted: unknown = null
  closeCalls = 0
  private waiter: ((r: IteratorResult<Uint8Array>) => void) | null = null

  send (bytes: Uint8Array): void { this.peer.push(bytes) }
  push (bytes: Uint8Array): void {
    if (this.waiter !== null) {
      const w = this.waiter
      this.waiter = null
      w({ value: bytes, done: false })
    } else this.queue.push(bytes)
  }

  end (): void {
    this.ended = true
    if (this.waiter !== null) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  async close (): Promise<void> { this.closeCalls++; this.peer.end() }
  abort (err: unknown): void { this.aborted = err ?? new Error('aborted'); this.end(); this.peer.end() }

  [Symbol.asyncIterator] (): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const q = this.queue.shift()
        if (q !== undefined) return { value: q, done: false }
        if (this.ended) return { value: undefined, done: true }
        return await new Promise<IteratorResult<Uint8Array>>(resolve => { this.waiter = resolve })
      }
    }
  }
}

function connectedPair (): { client: FakeStream, server: FakeStream } {
  const client = new FakeStream()
  const server = new FakeStream()
  client.peer = server
  server.peer = client
  return { client, server }
}

interface FakeLibp2p {
  handled: Array<{ protocol: string, options: unknown }>
  dials: Array<{ target: unknown, protocol: string, options: any }>
  unhandled: string[]
  servers: FakeStream[]
  connection: unknown
  failDial: boolean
  handle: (protocol: string, handler: (s: any, c: any) => void, options?: any) => void
  unhandle: (protocol: string) => void
  dialProtocol: (target: unknown, protocol: string, options?: any) => Promise<any>
}

function fakeLibp2p (): FakeLibp2p {
  let handler: ((s: any, c: any) => void) | null = null
  const f: FakeLibp2p = {
    handled: [],
    dials: [],
    unhandled: [],
    servers: [],
    connection: { remotePeer: { toString: () => 'peerA' } },
    failDial: false,
    handle (protocol, h, options) { handler = h; f.handled.push({ protocol, options }) },
    unhandle (protocol) { f.unhandled.push(protocol) },
    async dialProtocol (target, protocol, options) {
      f.dials.push({ target, protocol, options })
      if (f.failDial || handler === null) throw new Error('no route SECRETMARK')
      const { client, server } = connectedPair()
      f.servers.push(server)
      handler(server, f.connection)
      return client
    }
  }
  return f
}

function recordingService (reply: unknown = MINTED): PairMintHandler & { calls: Array<{ from: string, req: unknown }>, closed: number } {
  const s = {
    calls: [] as Array<{ from: string, req: unknown }>,
    closed: 0,
    async handle (from: string, req: unknown): Promise<PairMintReply> { s.calls.push({ from, req }); return reply as PairMintReply },
    close () { s.closed++ }
  }
  return s
}

/** Read one reply frame off a raw client stream. */
async function readReply (stream: FakeStream): Promise<unknown> {
  let buf: Uint8Array = new Uint8Array(0)
  const it = stream[Symbol.asyncIterator]()
  for (;;) {
    if (buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false)
      if (buf.length >= 4 + len) return JSON.parse(dec.decode(buf.subarray(4, 4 + len)))
    }
    const n = await it.next()
    if (n.done === true) throw new Error('ended')
    buf = concat(buf, n.value)
  }
}

describe('pair-wire', function () {
  describe('server and client', () => {
    it('W-1 a mint request reaches the handler with the connection peer and the reply comes back', async () => {
      const lib = fakeLibp2p()
      const service = recordingService()
      await attachPairMint(lib, service)
      const reply = await requestPairMint(lib, 'target', MINT)
      expect(reply).to.deep.equal(MINTED)
      expect(service.calls).to.have.length(1)
      expect(service.calls[0]!.from).to.equal('peerA')
      expect(service.calls[0]!.req).to.deep.equal(MINT)
    })

    it('W-2 a connection without a remote peer is refused not-officer and never reaches the handler', async () => {
      const lib = fakeLibp2p()
      lib.connection = {}
      const service = recordingService()
      await attachPairMint(lib, service)
      const reply = await requestPairMint(lib, 't', MINT)
      expect(reply).to.deep.equal({ t: 'refused', v: 1, code: 'not-officer' })
      expect(service.calls).to.have.length(0)
      expect(parsePairMintRequest({ ...MINT, from: 'peerX' })).to.equal(null)
      expect(parsePairMintRequest({ ...MINT, peerId: 'peerX' })).to.equal(null)
    })

    it('W-3 a length header over the cap aborts the stream; exactly the cap is read', async () => {
      const lib = fakeLibp2p()
      const service = recordingService({ t: 'refused', v: 1, code: 'malformed' })
      await attachPairMint(lib, service)

      const over = await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      const header = new Uint8Array(4)
      new DataView(header.buffer).setUint32(0, PAIR_MINT_MAX_FRAME_BYTES + 1, false)
      over.send(header)
      await until(() => lib.servers[0]!.aborted !== null)
      expect(service.calls).to.have.length(0)

      // A JSON string of exactly the cap: the reader accepts it and the handler sees it.
      const body = '"' + 'x'.repeat(PAIR_MINT_MAX_FRAME_BYTES - 2) + '"'
      expect(enc.encode(body).length).to.equal(PAIR_MINT_MAX_FRAME_BYTES)
      const exact = await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      const head = new Uint8Array(4)
      new DataView(head.buffer).setUint32(0, PAIR_MINT_MAX_FRAME_BYTES, false)
      exact.send(concat(head, enc.encode(body)))
      await until(() => service.calls.length === 1)
      expect(lib.servers[1]!.aborted).to.equal(null)
    })

    it('W-4 a split frame parses, a second frame in one chunk is ignored, non-JSON is malformed', async () => {
      const lib = fakeLibp2p()
      const service = recordingService()
      await attachPairMint(lib, service)

      const split = await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      const bytes = frameOf(MINT)
      const a = Math.floor(bytes.length / 3)
      split.send(bytes.subarray(0, a))
      await tick()
      split.send(bytes.subarray(a, 2 * a))
      await tick()
      split.send(bytes.subarray(2 * a))
      expect(await readReply(split)).to.deep.equal(MINTED)
      expect(service.calls).to.have.length(1)

      const twin = await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      twin.send(concat(frameOf(MINT), frameOf({ ...MINT, userId: 'user-2' })))
      await readReply(twin)
      expect(service.calls).to.have.length(2)
      expect((service.calls[1]!.req as { userId: string }).userId).to.equal('user-1')

      const junk = await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      const body = enc.encode('not json at all')
      const head = new Uint8Array(4)
      new DataView(head.buffer).setUint32(0, body.length, false)
      junk.send(concat(head, body))
      expect(await readReply(junk)).to.deep.equal({ t: 'refused', v: 1, code: 'malformed' })
      expect(service.calls).to.have.length(2)
    })

    it('W-5 a silent client is aborted by the server read timeout', async () => {
      expect(PAIR_MINT_READ_TIMEOUT_MS).to.equal(15_000)
      const lib = fakeLibp2p()
      await attachPairMint(lib, recordingService(), { readTimeoutMs: 50 })
      await lib.dialProtocol('t', PAIR_MINT_PROTOCOL)
      const started = Date.now()
      await until(() => lib.servers[0]!.aborted !== null, 1000)
      expect(Date.now() - started).to.be.lessThan(1000)
    })

    it('W-6 client errors carry the right reason and requestSent, and never the reply text', async () => {
      const failing = fakeLibp2p()
      failing.failDial = true
      const dial = await requestPairMint(failing, 't', MINT, { timeoutMs: 200 }).catch(e => e)
      expect(dial).to.be.instanceOf(PairMintTransportError)
      expect(dial.reason).to.equal('dial-failed')
      expect(dial.requestSent).to.equal(false)
      expect(String(dial)).to.not.contain('SECRETMARK')

      const sent: Uint8Array[] = []
      const silent = {
        send: (b: Uint8Array) => { sent.push(b) },
        close: async () => undefined,
        [Symbol.asyncIterator]: () => ({ next: async () => await new Promise<never>(() => undefined) })
      }
      const hung = await requestPairMint({ handle: () => undefined, dialProtocol: async () => silent }, 't', MINT, { timeoutMs: 80 }).catch(e => e)
      expect(sent).to.have.length(1)
      expect(hung.reason).to.equal('timeout')
      expect(hung.requestSent).to.equal(true)

      const ended = await requestPairMint({
        handle: () => undefined,
        dialProtocol: async () => ({ send: () => undefined, close: async () => undefined, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) })
      }, 't', MINT, { timeoutMs: 80 }).catch(e => e)
      expect(ended.reason).to.equal('stream-failed')
      expect(ended.requestSent).to.equal(true)

      const throwing = await requestPairMint({
        handle: () => undefined,
        dialProtocol: async () => ({ send: () => { throw new Error('boom') }, close: async () => undefined, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) })
      }, 't', MINT, { timeoutMs: 80 }).catch(e => e)
      expect(throwing.reason).to.equal('stream-failed')
      expect(throwing.requestSent).to.equal(true)

      const secret = 'sereus-invite:1.SECRETMARK'
      const badReplies: unknown[] = [
        { t: 'weird', v: 1 },
        { ...MINTED, v: 2 },
        { ...MINTED, invitation: secret, extra: true },
        { t: 'refused', v: 1, code: 'not-a-code' },
        { ...MINTED, invitation: secret + 'a'.repeat(9000) }
      ]
      for (const bad of badReplies) {
        const lib = fakeLibp2p()
        await attachPairMint(lib, recordingService(bad))
        const err = await requestPairMint(lib, 't', MINT, { timeoutMs: 500 }).catch(e => e)
        expect(err, JSON.stringify(Object.keys(bad as object))).to.be.instanceOf(PairMintTransportError)
        expect(err.reason).to.equal('malformed-reply')
        expect(err.requestSent).to.equal(true)
        for (const text of [String(err), err.message, String(err.stack), JSON.stringify(Object.entries(err))]) {
          expect(text).to.not.contain('SECRETMARK')
        }
        expect('cause' in err).to.equal(false)
      }
    })

    it('W-7 handle is registered limited-connection-friendly and dials pass a signal', async () => {
      const lib = fakeLibp2p()
      await attachPairMint(lib, recordingService())
      expect(lib.handled).to.have.length(1)
      expect(lib.handled[0]!.protocol).to.equal(PAIR_MINT_PROTOCOL)
      expect(lib.handled[0]!.options).to.deep.equal({ runOnLimitedConnection: true })
      await requestPairMint(lib, 'tt', MINT)
      expect(lib.dials[0]!.protocol).to.equal(PAIR_MINT_PROTOCOL)
      expect(lib.dials[0]!.target).to.equal('tt')
      expect(lib.dials[0]!.options.runOnLimitedConnection).to.equal(true)
      expect(lib.dials[0]!.options.signal).to.be.instanceOf(AbortSignal)
    })

    it('W-9 detach closes the service and unhandles once; a throwing handler gives not-reachable without text', async () => {
      const lib = fakeLibp2p()
      const service = recordingService()
      const detach = await attachPairMint(lib, service)
      await detach()
      expect(service.closed).to.equal(1)
      expect(lib.unhandled).to.deep.equal([PAIR_MINT_PROTOCOL])

      const lib2 = fakeLibp2p()
      await attachPairMint(lib2, {
        handle: async () => { throw new Error('SECRETMARK inside the handler') },
        close: () => undefined
      })
      const reply = await requestPairMint(lib2, 't', MINT)
      expect(reply).to.deep.equal({ t: 'refused', v: 1, code: 'not-reachable' })
      expect(JSON.stringify(reply)).to.not.contain('SECRETMARK')
    })
  })

  describe('parsers', () => {
    it('W-8 valid shapes parse and every invalid case is null', () => {
      expect(parsePairMintRequest(MINT)).to.deep.equal(MINT)
      expect(parsePairMintRequest(REMOVE)).to.deep.equal(REMOVE)
      const reqBad: unknown[] = [
        null, 'text', [], 42,
        (() => { const { requesterPeerId, ...rest } = MINT; return rest })(),
        { ...MINT, extra: 1 },
        { ...MINT, t: 'other' },
        { ...MINT, v: 2 },
        { ...MINT, userId: 7 },
        { ...MINT, nonce: 'short' },
        { ...MINT, nonce: 'bad nonce!!!!!!!!!!' },
        { ...MINT, expiresAt: '2030-01-01 00:00:00' },
        { ...MINT, keyPub: 'zz'.repeat(33) },
        { ...MINT, sig: 'xyz' },
        { ...MINT, requesterPeerId: 'peer-A' },
        { ...MINT, userId: 'u'.repeat(129) },
        { ...MINT, networkHash: '' },
        { ...MINT, keyPub: 'ab'.repeat(129) },
        { ...REMOVE, requesterPeerId: 'peerA' },
        { ...REMOVE, peerId: 'peer-B' },
        (() => { const { peerId, ...rest } = REMOVE; return rest })()
      ]
      for (const v of reqBad) expect(parsePairMintRequest(v), JSON.stringify(v)).to.equal(null)

      expect(parsePairMintReply(MINTED)).to.deep.equal(MINTED)
      expect(parsePairMintReply({ t: 'removed', v: 1, peerId: 'peerB' })).to.deep.equal({ t: 'removed', v: 1, peerId: 'peerB' })
      for (const code of PAIR_MINT_REFUSAL_CODES) {
        expect(parsePairMintReply({ t: 'refused', v: 1, code })).to.deep.equal({ t: 'refused', v: 1, code })
      }
      const replyBad: unknown[] = [
        null, 'x', [],
        { t: 'minted', v: 1, invitation: '', inviteKey: 'k', expiresAt: 'x' },
        { t: 'minted', v: 1, invitation: 'i', inviteKey: 'k' },
        { ...MINTED, inviteKey: 'k'.repeat(513) },
        { ...MINTED, expiresAt: 'e'.repeat(65) },
        { ...MINTED, v: 2 },
        { t: 'removed', v: 1, peerId: 'peer-B' },
        { t: 'removed', v: 1, peerId: 'peerB', extra: 1 },
        { t: 'refused', v: 1, code: 'nope' },
        { t: 'refused', v: 1, code: 'malformed', extra: 1 }
      ]
      for (const v of replyBad) expect(parsePairMintReply(v), JSON.stringify(v)).to.equal(null)
    })
  })

  describe('source', () => {
    it('W-10 the code set is closed and the source avoids Hermes-hostile and secret-leaking constructs', () => {
      expect([...PAIR_MINT_REFUSAL_CODES]).to.deep.equal([
        'not-officer', 'bad-signature', 'expired', 'replayed', 'rate-limited', 'not-reachable',
        'not-owner', 'switched-off', 'unknown-pairing', 'malformed', 'requester-mismatch'
      ])
      expect(Object.isFrozen(PAIR_MINT_REFUSAL_CODES)).to.equal(true)
      const file = join(dirname(fileURLToPath(import.meta.url)), '../src/pairing/pair-wire.ts')
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      expect(code).to.not.match(/console\.|\bBuffer\b|TextDecoder|TextEncoder|from 'node:|cadre-core|AbortSignal\.timeout/)
      expect(code).to.contain('connection?.remotePeer')
      expect(code).to.contain('runOnLimitedConnection: true')
    })
  })
})
