// The one-call ctl client (port of the rig's ctl layer ctlRaw with a per-peer token): it never rejects.
// status 0 = unreachable (no or bad ctl.port/ctl.token, connect error, timeout). It refuses a token file
// another local user could read or swap BEFORE any network I/O, and no returned error ever carries the
// peer dir, a file path or the token.

import http from 'node:http'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import { readCtlPort, readCtlToken } from './ctl-files.js'
import { CTL_PATH, CTL_ROLE_HEADER, CTL_TOKEN_HEADER, VERB_NAME_RE, type CtlReplyBody, type Role } from './protocol.js'

/** The rig's client bound: DKG and approval verbs run long. */
export const DEFAULT_CTL_TIMEOUT_MS = 1_000_000

export interface CtlReply {
  /** The HTTP status, or 0 when the daemon was never reached. */
  status: number
  body: CtlReplyBody
}

export interface CtlRequest {
  /** The peer's ctl dir (holds ctl.port and ctl.token). */
  dir: string
  role: Role
  verb: string
  args?: Record<string, unknown>
  timeoutMs?: number
}

const unreachable = (code: string): CtlReply => ({ status: 0, body: { ok: false, error: { name: 'Unreachable', code } } })

export function callCtl(req: CtlRequest): Promise<CtlReply> {
  if (!VERB_NAME_RE.test(req.verb)) return Promise.resolve({ status: 0, body: { ok: false, error: { name: 'BadVerbName' } } })
  const port = readCtlPort(req.dir)
  if (!port.ok) return Promise.resolve(unreachable(port.code))
  const token = readCtlToken(req.dir)
  if (!token.ok) return Promise.resolve(unreachable(token.code))
  const payload = JSON.stringify({ verb: req.verb, args: req.args ?? {} })
  const timeoutMs = req.timeoutMs ?? DEFAULT_CTL_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const settle = (reply: CtlReply): void => {
      if (settled) return
      settled = true
      resolve(reply)
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port: port.port,
        method: 'POST',
        path: CTL_PATH,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          [CTL_TOKEN_HEADER]: token.token,
          [CTL_ROLE_HEADER]: req.role
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('error', (e: NodeJS.ErrnoException) => settle(unreachable(String(e.code ?? 'response'))))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          let body: CtlReplyBody
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape')
            body = parsed as CtlReplyBody
          } catch {
            body = { ok: false, error: { name: 'BadResponse' } }
          }
          settle({ status, body })
        })
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      settle({ status: 0, body: { ok: false, error: { name: 'Timeout' } } })
    })
    request.on('error', (e: NodeJS.ErrnoException) => settle(unreachable(String(e.code ?? 'connect'))))
    request.end(payload)
  })
}

/** 0 ok; 3 unreachable (status 0, except a bad verb name = 2); 2 NoSuchVerb or WrongRole; 1 everything else. */
export function exitCodeFor(reply: CtlReply): ExitCode {
  const name = reply.body.error?.name
  if (reply.status === 0) return name === 'BadVerbName' ? EXIT.USAGE : EXIT.UNREACHABLE
  if (reply.status === 200 && reply.body.ok === true) return EXIT.PASS
  if (reply.status === 404 && name === 'NoSuchVerb') return EXIT.USAGE
  if (reply.status === 400 && name === 'WrongRole') return EXIT.USAGE
  return EXIT.FAIL
}
