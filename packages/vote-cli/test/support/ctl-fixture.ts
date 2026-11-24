// Test fixture for every ctl spec: a temp ctl dir, a verb registry with counting test verbs, a
// SecretRegistry holding one runtime-made fixture secret, and a raw HTTP helper that can send any
// header, method, path or body shape (including a chunked body with no content-length).
//
// Nothing here prints: the fixture secret, the token and the fake peer id must never reach mocha output.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startCtlServer, type CtlCallEvent, type CtlServerHandle } from '../../src/ctl/ctl-server.js'
import { CTL_PATH, CTL_TOKEN_FILE, type Role } from '../../src/ctl/protocol.js'
import { defineVerbRegistry, type VerbRegistry } from '../../src/ctl/verb-registry.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A fake peer id built at runtime: '12D3KooW' plus 44 base58 characters. */
export function fakePeerId(seed = 3): string {
  let id = '12D3KooW'
  for (let i = 0; i < 44; i++) id += BASE58[(i * 7 + seed) % BASE58.length]
  return id
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface TestCtx {
  calls: Record<string, number>
  secret: string
  peerId: string
  hex64: string
}

export interface TestCtl {
  /** The temp dir (removed by close()). */
  dir: string
  /** The ctl dir the server was given: `<dir>/ctl`. */
  ctlDir: string
  port: number
  role: Role
  registry: VerbRegistry<TestCtx>
  secrets: SecretRegistry
  /** The fixture secret (windowed in `secrets`). */
  secret: string
  peerId: string
  hex64: string
  calls: Record<string, number>
  /** Every onCall event the server reported. */
  events: CtlCallEvent[]
  handle: CtlServerHandle
  /** Reads ctl.token (without its trailing newline). */
  readToken(): string
  close(): Promise<void>
}

export interface StartTestCtlOptions {
  role?: Role
  maxBodyBytes?: number
  beforePortFile?: (info: { port: number }) => void | Promise<void>
  onCall?: (e: CtlCallEvent) => void
  /** Reuse this temp dir instead of making a new one (sequential starts on one dir). */
  dir?: string
  /** Runs after the temp dir exists and before the server starts (pre-create or plant files). */
  prepare?: (paths: { dir: string, ctlDir: string }) => void
}

export function makeTestRegistry(): VerbRegistry<TestCtx> {
  const count = (ctx: TestCtx, name: string): void => {
    ctx.calls[name] = (ctx.calls[name] ?? 0) + 1
  }
  return defineVerbRegistry<TestCtx>({
    echo: (ctx, args) => {
      count(ctx, 'echo')
      return { keys: Object.keys(args).sort(), n: args.n ?? null }
    },
    boom: (ctx) => {
      count(ctx, 'boom')
      const inner = Object.assign(new Error('inner'), { name: 'InnerBoom' })
      const middle = Object.assign(new Error('middle', { cause: inner }), { name: 'MiddleBoom' })
      // peer id, fixture secret, a home path, a hex64 run, then filler: 300 characters in all
      const head = `${ctx.peerId} ${ctx.secret} ${homedir()}/x ${ctx.hex64} `
      const message = head + 'f'.repeat(Math.max(0, 300 - head.length))
      throw Object.assign(new Error(message, { cause: middle }), { name: 'BoomError', code: 'boom-code' })
    },
    'throw-string': (ctx) => {
      count(ctx, 'throw-string')
      throw `string failure with ${ctx.secret}`
    },
    slow: async (ctx, args) => {
      count(ctx, 'slow')
      await sleep(Number(args.ms))
      return { slept: Number(args.ms) }
    },
    big: (ctx) => {
      count(ctx, 'big')
      return { n: 10n } as unknown as Record<string, unknown>
    },
    'bad-result': (ctx) => {
      count(ctx, 'bad-result')
      return [1] as unknown as Record<string, unknown>
    }
  })
}

export async function startTestCtl(opts: StartTestCtlOptions = {}): Promise<TestCtl> {
  const role: Role = opts.role ?? 'officer'
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'vt-ctl-'))
  const ctlDir = join(dir, 'ctl')
  const secrets = new SecretRegistry()
  const secret = secrets.add('fixture-secret-' + randomBytes(12).toString('hex'), { windows: true })
  const peerId = fakePeerId()
  const hex64 = randomBytes(32).toString('hex')
  const calls: Record<string, number> = {}
  const events: CtlCallEvent[] = []
  const registry = makeTestRegistry()
  const ctx: TestCtx = { calls, secret, peerId, hex64 }
  try {
    opts.prepare?.({ dir, ctlDir })
    const handle = await startCtlServer<TestCtx>({
      dir: ctlDir,
      role,
      registry,
      ctx,
      redactor: secrets.redactor(),
      maxBodyBytes: opts.maxBodyBytes,
      beforePortFile: opts.beforePortFile,
      onCall: (e) => {
        events.push(e)
        opts.onCall?.(e)
      }
    })
    let closed = false
    return {
      dir,
      ctlDir,
      port: handle.port,
      role,
      registry,
      secrets,
      secret,
      peerId,
      hex64,
      calls,
      events,
      handle,
      readToken: () => readFileSync(join(ctlDir, CTL_TOKEN_FILE), 'utf8').replace(/\n$/, ''),
      close: async () => {
        if (closed) return
        closed = true
        try {
          await handle.close()
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

export interface RawRequestOptions {
  port: number
  host?: string
  method?: string
  path?: string
  headers?: http.OutgoingHttpHeaders
  body?: string | Buffer
  /** Send the body in 8 KiB writes with no content-length (transfer-encoding: chunked). */
  chunked?: boolean
  timeoutMs?: number
}

export interface RawReply {
  status: number
  json: unknown
  text: string
}

/** One raw HTTP request; resolves with the status and the parsed JSON body (undefined when not JSON). */
export function rawRequest(opts: RawRequestOptions): Promise<RawReply> {
  const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8')
  const headers: http.OutgoingHttpHeaders = { ...(opts.headers ?? {}) }
  if (body !== undefined && !opts.chunked && headers['content-length'] === undefined) headers['content-length'] = body.length
  return new Promise((resolve, reject) => {
    let answered = false
    const req = http.request(
      { host: opts.host ?? '127.0.0.1', port: opts.port, method: opts.method ?? 'POST', path: opts.path ?? CTL_PATH, headers, timeout: opts.timeoutMs ?? 10000 },
      (res) => {
        answered = true
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('rawRequest timeout'))
    })
    req.on('error', (e) => {
      // A write error after the server already answered (it closed early) is not a failure of the request.
      if (!answered) reject(e)
    })
    if (body === undefined) {
      req.end()
    } else if (opts.chunked) {
      const step = 8192
      let i = 0
      const writeNext = (): void => {
        if (i >= body.length) {
          req.end()
          return
        }
        const chunk = body.subarray(i, i + step)
        i += step
        if (req.write(chunk)) setImmediate(writeNext)
        else req.once('drain', writeNext)
      }
      writeNext()
    } else {
      req.end(body)
    }
  })
}

/** The standard authorised POST /ctl with `{ verb, args }`. */
export function ctlPost(
  t: Pick<TestCtl, 'port' | 'role' | 'readToken'>,
  verb: unknown,
  args?: unknown,
  overrides: { headers?: http.OutgoingHttpHeaders, token?: string | string[] | null, role?: string | null, extraBody?: Record<string, unknown> } = {}
): Promise<RawReply> {
  const token = overrides.token === undefined ? t.readToken() : overrides.token
  const role = overrides.role === undefined ? t.role : overrides.role
  const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', ...(overrides.headers ?? {}) }
  if (token !== null) headers['x-vt-token'] = token
  if (role !== null) headers['x-vt-role'] = role
  const payload: Record<string, unknown> = { ...(overrides.extraBody ?? {}) }
  if (verb !== undefined) payload.verb = verb
  if (args !== undefined) payload.args = args
  return rawRequest({ port: t.port, headers, body: JSON.stringify(payload) })
}
