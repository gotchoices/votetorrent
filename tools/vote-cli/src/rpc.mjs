// Local JSON-RPC between `vt` and a device daemon: one POST per command, loopback only.

import { createServer, request } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DAEMON_FILE = 'daemon.json'

/** A serialisable view of an error: name, code and message only. */
export function errorView (err) {
  const e = err ?? {}
  return {
    name: typeof e.name === 'string' ? e.name : 'Error',
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    message: typeof e.message === 'string' ? e.message : String(err)
  }
}

/** Serves `handlers[method](params)`; each reply carries the server-side duration in ms. */
export function serveRpc (handlers, { onListening } = {}) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      const started = performance.now()
      let reply
      try {
        const { method, params } = JSON.parse(body)
        const handler = handlers[method]
        if (typeof handler !== 'function') throw Object.assign(new Error(`unknown command: ${method}`), { code: 'unknown-command' })
        const result = await handler(params ?? {})
        reply = { ok: true, result: result ?? null, ms: Math.round(performance.now() - started) }
      } catch (err) {
        reply = { ok: false, error: errorView(err), ms: Math.round(performance.now() - started) }
      }
      const text = JSON.stringify(reply, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
      res.writeHead(200, { 'content-type': 'application/json' }).end(text)
    })
  })
  server.listen(0, '127.0.0.1', () => onListening?.(server.address().port))
  return server
}

export function readDaemonInfo (home) {
  try {
    return JSON.parse(readFileSync(join(home, DAEMON_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/** One RPC call; resolves to the daemon's `{ ok, result | error, ms }` reply. */
export function callRpc (port, method, params, { timeoutMs = 0 } = {}) {
  const payload = JSON.stringify({ method, params })
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/rpc',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`rpc ${method} timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end(payload)
  })
}
