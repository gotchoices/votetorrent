// hr5-ctl.mjs - node hr5-ctl.mjs <role> <verb> [<json args>] prints ONE JSON line {ok, ...}.
// Exit 0 ok, 1 verb error, 2 usage, 3 unreachable. The control port is 127.0.0.1 with a 0600 token (D-62-02).
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

// run roots and secrets live outside the repo: no default under tools/lean-rig
const mustEnv = (k) => { throw new Error(`hr5-ctl: ${k} is not set`) }

/** Resolves {status, body}; never rejects. status 0 = unreachable. */
export function ctlRaw (role, verb, args, { runRoot = process.env.HR5_RUN_ROOT || mustEnv('HR5_RUN_ROOT'), secDir = process.env.HR5_SEC || mustEnv('HR5_SEC'), timeoutMs = 1_000_000, moduleFile } = {}) {
  return new Promise((resolve) => {
    const portFile = join(runRoot, role, 'ctl.port')
    const tokenFile = join(secDir, 'ctl.token')
    if (!existsSync(portFile) || !existsSync(tokenFile)) return resolve({ status: 0, body: { ok: false, error: { name: 'Unreachable', message: 'no ctl.port' } } })
    const port = Number(readFileSync(portFile, 'utf8').trim())
    const token = readFileSync(tokenFile, 'utf8').trim()
    const payload = JSON.stringify({ verb, args: args ?? {}, ...(moduleFile ? { module: moduleFile } : {}) })
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/ctl', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-hr5-token': token }, timeout: timeoutMs }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => { let body; try { body = JSON.parse(text) } catch { body = { ok: false, error: { name: 'BadResponse' } } } resolve({ status: res.statusCode, body }) })
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { ok: false, error: { name: 'Timeout' } } }) })
    req.on('error', (e) => resolve({ status: 0, body: { ok: false, error: { name: 'Unreachable', message: String(e.code ?? e.name) } } }))
    req.end(payload)
  })
}

export async function ctl (role, verb, args, opts) {
  const r = await ctlRaw(role, verb, args, opts)
  return { status: r.status, ...r.body }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, verb, json] = process.argv.slice(2)
  if (!role || !verb || !/^[a-z0-9-]+$/.test(role) || !/^[a-z0-9-]+$/.test(verb)) { console.error('usage: hr5-ctl.mjs <role> <verb> [<json args>]'); process.exit(2) }
  let args = {}
  if (json !== undefined) { try { args = JSON.parse(json) } catch { console.error('usage: args must be JSON'); process.exit(2) } }
  const r = await ctlRaw(role, verb, args)
  console.log(JSON.stringify(r.status === 0 ? { ok: false, ...r.body.error ? { error: r.body.error } : {} } : r.body))
  process.exit(r.status === 0 ? 3 : r.body.ok === true ? 0 : 1)
}
