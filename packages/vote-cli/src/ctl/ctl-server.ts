// The per-peer HTTP control endpoint: 127.0.0.1 on an ephemeral port, every request gated on the
// x-vt-token header (SHA-256 digests compared with timingSafeEqual), verbs dispatched from a static
// registry, a 64 KiB body cap, a redacted 200-char error view, 0600 files in a 0700 dir and ctl.port
// written LAST so a poller on it implies READY. Port of the lean rig's hr5-peer server with the
// `module` override dropped, the `!==` token compare replaced and the role header added.

import { createHash, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { redact } from '../secrecy/redact.js'
import { ensurePrivateDir, newCtlToken, writePrivateFileAtomic } from './ctl-files.js'
import { ctlErrorView } from './error-view.js'
import {
  BUILTIN_VERBS_VERB,
  CTL_MAX_BODY_BYTES,
  CTL_PATH,
  CTL_PORT_FILE,
  CTL_ROLE_HEADER,
  CTL_TOKEN_FILE,
  CTL_TOKEN_HEADER,
  VERB_NAME_RE,
  isRole,
  type CtlReplyBody,
  type Role
} from './protocol.js'
import type { VerbRegistry } from './verb-registry.js'

export interface CtlCallEvent {
  /** The validated verb name, or '-' when the request never reached a valid verb. */
  verb: string
  status: number
  ms: number
  errorName?: string
}

export interface CtlServerOptions<C> {
  /** The ctl dir (0700): holds ctl.token and ctl.port. */
  dir: string
  role: Role
  registry: VerbRegistry<C>
  ctx: C
  /** Redacts 500 messages; defaults to redact() with an empty registry (hex64, peer, LAN, home rules). */
  redactor?: (s: string) => string
  maxBodyBytes?: number
  /** Called with ('verb.<name>', err) when a verb throws. */
  record?: (where: string, err: unknown) => void
  /** Called after every response with the verb, status and ms only: never args, messages or headers. */
  onCall?: (e: CtlCallEvent) => void
  /** Runs after the server answers and before ctl.port is written (print READY, write pid, ...). */
  beforePortFile?: (info: { port: number }) => void | Promise<void>
}

export interface CtlServerHandle {
  port: number
  dir: string
  close(): Promise<void>
}

const REQUEST_TIMEOUT_MS = 30000
const HEADERS_TIMEOUT_MS = 10000

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readBody(req: http.IncomingMessage, max: number): Promise<{ ok: true, text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > max) {
        done = true
        chunks.length = 0
        resolve({ ok: false })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve({ ok: false })
    })
  })
}

export async function startCtlServer<C>(opts: CtlServerOptions<C>): Promise<CtlServerHandle> {
  if (!isRole(opts.role)) throw new TypeError('ctl server: bad-role')
  const { dir, role, registry, ctx } = opts
  const redactor = opts.redactor ?? ((s: string) => redact(s))
  const maxBodyBytes = opts.maxBodyBytes ?? CTL_MAX_BODY_BYTES
  const portPath = join(dir, CTL_PORT_FILE)
  const tokenPath = join(dir, CTL_TOKEN_FILE)

  ensurePrivateDir(dir)
  rmSync(portPath, { force: true })
  const expectedDigest = ((): Buffer => {
    const token = newCtlToken()
    writePrivateFileAtomic(tokenPath, token + '\n')
    return sha256(token)
  })()

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = performance.now()
    let verbName = '-'
    const elapsed = (): number => Math.round(performance.now() - started)
    const finish = (status: number, body: CtlReplyBody): void => {
      const text = JSON.stringify(body, bigintReplacer)
      const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
      if (status !== 200) headers.connection = 'close'
      res.writeHead(status, headers)
      res.end(text)
      const event: CtlCallEvent = { verb: verbName, status, ms: elapsed() }
      if (body.error !== undefined) event.errorName = body.error.name
      opts.onCall?.(event)
    }
    const reject = (status: number, name: string): void => {
      req.resume()
      finish(status, { ok: false, error: { name } })
    }

    // 1. token: a digest compare in constant time; missing, non-string, short or repeated (joined) all fail
    const presented = req.headers[CTL_TOKEN_HEADER]
    if (typeof presented !== 'string' || !timingSafeEqual(sha256(presented), expectedDigest)) return reject(401, 'Unauthorized')
    // 2. no browser page is ever a legitimate caller
    if (req.headers.origin !== undefined) return reject(403, 'Forbidden')
    // 3. method
    if (req.method !== 'POST') return reject(405, 'MethodNotAllowed')
    // 4. path, exactly
    if (req.url !== CTL_PATH) return reject(404, 'NotFound')
    // 5. role: one ctl server per peer, each with its own dir, token and port
    if (req.headers[CTL_ROLE_HEADER] !== role) return reject(400, 'WrongRole')
    // 6. size, by the declared length before reading and by the streamed count while reading
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > maxBodyBytes) return reject(413, 'PayloadTooLarge')
    const body = await readBody(req, maxBodyBytes)
    if (!body.ok) {
      res.once('finish', () => req.destroy())
      return reject(413, 'PayloadTooLarge')
    }
    // 7. shape: a plain object with only verb and args, args a plain object when present
    let parsed: unknown
    try {
      parsed = JSON.parse(body.text)
    } catch {
      return reject(400, 'BadRequest')
    }
    if (!isPlainObject(parsed)) return reject(400, 'BadRequest')
    for (const key of Object.keys(parsed)) if (key !== 'verb' && key !== 'args') return reject(400, 'BadRequest')
    const hasArgs = Object.prototype.hasOwnProperty.call(parsed, 'args')
    if (hasArgs && !isPlainObject(parsed.args)) return reject(400, 'BadRequest')
    const args: Record<string, unknown> = hasArgs ? (parsed.args as Record<string, unknown>) : {}
    // 8. verb name
    const verb = parsed.verb
    if (typeof verb !== 'string' || !VERB_NAME_RE.test(verb)) return reject(404, 'NoSuchVerb')
    // 9. the built-in listing
    if (verb === BUILTIN_VERBS_VERB) {
      verbName = verb
      return finish(200, { ok: true, result: { role, verbs: registry.names() }, ms: elapsed() })
    }
    // 10. registry lookup (own keys only: no prototype names)
    const handler = registry.get(verb)
    if (handler === undefined) return reject(404, 'NoSuchVerb')
    verbName = verb
    // 11-12. run
    try {
      const result = await handler(ctx, args)
      const value = result === undefined ? {} : result
      if (!isPlainObject(value)) {
        return finish(500, { ok: false, error: { name: 'BadVerbResult', message: 'verb returned a non-object', chain: ['BadVerbResult'] }, ms: elapsed() })
      }
      return finish(200, { ok: true, result: value, ms: elapsed() })
    } catch (err) {
      try {
        opts.record?.(`verb.${verb}`, err)
      } catch {
        // a recorder failure never changes the reply
      }
      return finish(500, { ok: false, error: ctlErrorView(err, redactor), ms: elapsed() })
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('ctl server: no-port')
  }
  const port = address.port

  await opts.beforePortFile?.({ port })
  writePrivateFileAtomic(portPath, String(port) + '\n')

  let closing: Promise<void> | undefined
  return {
    port,
    dir,
    close: () => {
      closing ??= (async () => {
        rmSync(portPath, { force: true })
        rmSync(tokenPath, { force: true })
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })()
      return closing
    }
  }
}
