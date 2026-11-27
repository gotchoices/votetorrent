import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { CtlSetupError } from '../src/ctl/ctl-files.js'
import { CTL_PORT_FILE, CTL_TOKEN_FILE } from '../src/ctl/protocol.js'
import { ctlPost, rawRequest, startTestCtl, type TestCtl } from './support/ctl-fixture.js'

const METRO_PORTS = new Set([8081, 8091, 8097])
const HEX64_RE = /[0-9a-fA-F]{64}/

function rejection(reply: { status: number, json: unknown }, status: number, name: string): void {
  expect(reply.status).to.equal(status)
  expect(reply.json).to.deep.equal({ ok: false, error: { name } })
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return undefined
}

async function connectFails(port: number, host: string): Promise<boolean> {
  try {
    await rawRequest({ port, host, body: '{}', timeoutMs: 2000 })
    return false
  } catch {
    return true
  }
}

describe('ctl server', function () {
  this.timeout(20000)
  const open: TestCtl[] = []
  const start = async (opts: Parameters<typeof startTestCtl>[0] = {}): Promise<TestCtl> => {
    const t = await startTestCtl(opts)
    open.push(t)
    return t
  }
  afterEach(async () => {
    for (const t of open.splice(0)) await t.close()
  })

  it('binds 127.0.0.1 only on an ephemeral port', async () => {
    const t = await start()
    expect(t.port).to.be.within(1024, 65535)
    expect(METRO_PORTS.has(t.port)).to.equal(false)
    expect(readFileSync(join(t.ctlDir, CTL_PORT_FILE), 'utf8')).to.equal(`${t.port}\n`)
    expect(t.handle.port).to.equal(t.port)
    expect(t.handle.dir).to.equal(t.ctlDir)
    expect((await ctlPost(t, 'echo', {})).status).to.equal(200)
    expect(await connectFails(t.port, '::1')).to.equal(true)
    const lan = lanAddress()
    if (lan !== undefined) expect(await connectFails(t.port, lan)).to.equal(true)
  })

  it('401 Unauthorized without the x-vt-token header and the verb never runs', async () => {
    const t = await start()
    rejection(await ctlPost(t, 'echo', {}, { token: null }), 401, 'Unauthorized')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('401 Unauthorized for a wrong token of the right length', async () => {
    const t = await start()
    const right = t.readToken()
    let wrong = randomBytes(32).toString('hex')
    if (wrong === right) wrong = (right[0] === 'a' ? 'b' : 'a') + right.slice(1)
    expect(wrong.length).to.equal(64)
    rejection(await ctlPost(t, 'echo', {}, { token: wrong }), 401, 'Unauthorized')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('401 Unauthorized for a short token and for a repeated header', async () => {
    const t = await start()
    const right = t.readToken()
    rejection(await ctlPost(t, 'echo', {}, { token: right.slice(0, 20) }), 401, 'Unauthorized')
    rejection(await ctlPost(t, 'echo', {}, { token: [right, right] }), 401, 'Unauthorized')
    rejection(await ctlPost(t, 'echo', {}, { token: '' }), 401, 'Unauthorized')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('403 Forbidden for a request carrying an Origin header even with the right token', async () => {
    const t = await start()
    rejection(await ctlPost(t, 'echo', {}, { headers: { origin: 'http://127.0.0.1:5173' } }), 403, 'Forbidden')
    rejection(await ctlPost(t, 'echo', {}, { headers: { origin: 'null' } }), 403, 'Forbidden')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('405 MethodNotAllowed for GET and 404 NotFound for another path', async () => {
    const t = await start()
    const headers = { 'x-vt-token': t.readToken(), 'x-vt-role': t.role }
    rejection(await rawRequest({ port: t.port, method: 'GET', headers }), 405, 'MethodNotAllowed')
    rejection(await rawRequest({ port: t.port, method: 'PUT', headers, body: '{}' }), 405, 'MethodNotAllowed')
    rejection(await rawRequest({ port: t.port, path: '/other', headers, body: '{"verb":"echo"}' }), 404, 'NotFound')
    rejection(await rawRequest({ port: t.port, path: '/ctl?x=1', headers, body: '{"verb":"echo"}' }), 404, 'NotFound')
    rejection(await rawRequest({ port: t.port, path: '/ctl/', headers, body: '{"verb":"echo"}' }), 404, 'NotFound')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('400 BadRequest for invalid JSON, a non-object body and non-object args', async () => {
    const t = await start()
    const headers = { 'content-type': 'application/json', 'x-vt-token': t.readToken(), 'x-vt-role': t.role }
    for (const body of ['{', '[]', 'null', '"echo"', '7', '']) {
      rejection(await rawRequest({ port: t.port, headers, body }), 400, 'BadRequest')
    }
    rejection(await ctlPost(t, 'echo', [1]), 400, 'BadRequest')
    rejection(await ctlPost(t, 'echo', null), 400, 'BadRequest')
    rejection(await ctlPost(t, 'echo', 'x'), 400, 'BadRequest')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('400 BadRequest for a module key and the verb never runs', async () => {
    const t = await start()
    rejection(await ctlPost(t, 'echo', {}, { extraBody: { module: '/etc/hosts' } }), 400, 'BadRequest')
    rejection(await ctlPost(t, 'echo', {}, { extraBody: { extra: 1 } }), 400, 'BadRequest')
    // an own `__proto__` key can only be sent as raw text: an object literal would set the prototype instead
    const headers = { 'content-type': 'application/json', 'x-vt-token': t.readToken(), 'x-vt-role': t.role }
    rejection(await rawRequest({ port: t.port, headers, body: '{"verb":"echo","args":{},"__proto__":{"x":1}}' }), 400, 'BadRequest')
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('404 NoSuchVerb for traversal, case, empty, overlong and prototype names', async () => {
    const t = await start()
    for (const verb of ['../echo', 'a/b', 'Echo', '', 'a'.repeat(65), 'constructor', 'to-string', '__proto__', 'has-own-property']) {
      rejection(await ctlPost(t, verb, {}), 404, 'NoSuchVerb')
    }
    rejection(await ctlPost(t, 5, {}), 404, 'NoSuchVerb')
    rejection(await ctlPost(t, undefined, {}), 404, 'NoSuchVerb')
    expect(t.calls.echo ?? 0).to.equal(0)
    expect(Object.values(t.calls).reduce((a, b) => a + b, 0)).to.equal(0)
  })

  it('400 WrongRole for a missing or mismatched x-vt-role header', async () => {
    const t = await start({ role: 'keyholder' })
    rejection(await ctlPost(t, 'echo', {}, { role: null }), 400, 'WrongRole')
    rejection(await ctlPost(t, 'echo', {}, { role: 'officer' }), 400, 'WrongRole')
    rejection(await ctlPost(t, 'echo', {}, { role: 'Keyholder' }), 400, 'WrongRole')
    expect((await ctlPost(t, 'echo', {})).status).to.equal(200)
    expect(t.calls.echo).to.equal(1)
  })

  it('413 PayloadTooLarge by content-length and by streamed size, verb never runs', async () => {
    const t = await start()
    const headers = { 'content-type': 'application/json', 'x-vt-token': t.readToken(), 'x-vt-role': t.role }
    const body = JSON.stringify({ verb: 'echo', args: { pad: 'p'.repeat(70000) } })
    expect(body.length).to.be.greaterThan(65536)
    rejection(await rawRequest({ port: t.port, headers, body }), 413, 'PayloadTooLarge')
    rejection(await rawRequest({ port: t.port, headers, body, chunked: true }), 413, 'PayloadTooLarge')
    expect(t.calls.echo ?? 0).to.equal(0)
    const small = await startTestCtl({ maxBodyBytes: 64 })
    open.push(small)
    rejection(await ctlPost(small, 'echo', { pad: 'p'.repeat(100) }), 413, 'PayloadTooLarge')
    expect((await ctlPost(small, 'echo', {})).status).to.equal(200)
  })

  it('200 with result and ms for a registered verb; bigint becomes a number', async () => {
    const t = await start()
    const echo = await ctlPost(t, 'echo', { n: 3, a: 'x' })
    expect(echo.status).to.equal(200)
    const body = echo.json as { ok: boolean, result: { keys: string[], n: unknown }, ms: unknown }
    expect(body.ok).to.equal(true)
    expect(body.result.keys).to.deep.equal(['a', 'n'])
    expect(body.result.n).to.equal(3)
    expect(typeof body.ms).to.equal('number')
    expect(Object.keys(body).sort()).to.deep.equal(['ms', 'ok', 'result'])
    expect(t.calls.echo).to.equal(1)
    const noArgs = await ctlPost(t, 'echo')
    expect((noArgs.json as { result: { keys: string[] } }).result.keys).to.deep.equal([])
    const big = await ctlPost(t, 'big', {})
    expect(big.status).to.equal(200)
    expect((big.json as { result: { n: unknown } }).result.n).to.equal(10)
  })

  it('500 with a redacted, truncated error view and no stack', async () => {
    const t = await start()
    const reply = await ctlPost(t, 'boom', {})
    expect(reply.status).to.equal(500)
    const body = reply.json as { ok: boolean, error: { name: string, code?: string, message: string, chain: string[] }, ms: unknown }
    expect(body.ok).to.equal(false)
    expect(typeof body.ms).to.equal('number')
    expect(body.error.name).to.equal('BoomError')
    expect(body.error.code).to.equal('boom-code')
    expect(body.error.chain).to.deep.equal(['BoomError', 'MiddleBoom', 'InnerBoom'])
    expect(Object.keys(body.error).sort()).to.deep.equal(['chain', 'code', 'message', 'name'])
    const m = body.error.message
    expect(m.length).to.be.at.most(200)
    expect(m).to.include(`<peer:${t.peerId.slice(-8)}>`)
    expect(m).to.include('<secret>')
    expect(m).to.include('<home>/x')
    expect(m).to.include('<hex64>')
    expect(m).to.not.include(t.secret)
    for (let i = 0; i + 16 <= t.secret.length; i++) expect(m).to.not.include(t.secret.slice(i, i + 16))
    expect(m).to.not.include(t.peerId.slice(0, 20))
    expect(m).to.not.include(homedir())
    expect(HEX64_RE.test(m)).to.equal(false)
    expect(reply.text).to.not.include('stack')
    expect(reply.text).to.not.include(t.hex64)
    expect(t.calls.boom).to.equal(1)
    const str = await ctlPost(t, 'throw-string', {})
    expect(str.status).to.equal(500)
    const strBody = str.json as { error: { name: string, message: string } }
    expect(strBody.error.name).to.equal('Error')
    expect(strBody.error.message).to.equal('string failure with <secret>')
  })

  it('500 BadVerbResult when a verb returns a non-object', async () => {
    const t = await start()
    const reply = await ctlPost(t, 'bad-result', {})
    expect(reply.status).to.equal(500)
    const body = reply.json as { ok: boolean, error: Record<string, unknown>, ms: unknown }
    expect(body.ok).to.equal(false)
    expect(body.error).to.deep.equal({ name: 'BadVerbResult', message: 'verb returned a non-object', chain: ['BadVerbResult'] })
    expect(typeof body.ms).to.equal('number')
    expect(t.calls['bad-result']).to.equal(1)
  })

  it('the built-in verbs verb lists the registry names sorted', async () => {
    const t = await start({ role: 'voter' })
    const reply = await ctlPost(t, 'verbs', {})
    expect(reply.status).to.equal(200)
    const body = reply.json as { ok: boolean, result: { role: string, verbs: string[] }, ms: unknown }
    expect(body.ok).to.equal(true)
    expect(body.result.role).to.equal('voter')
    expect(body.result.verbs).to.deep.equal(['bad-result', 'big', 'boom', 'echo', 'slow', 'throw-string'])
    expect(body.result.verbs).to.deep.equal(t.registry.names())
    expect(typeof body.ms).to.equal('number')
  })

  it('onCall reports verb, status and ms but never args or messages', async () => {
    const t = await start()
    await ctlPost(t, 'echo', { note: 'args-SENTINEL-value' })
    await ctlPost(t, 'boom', {})
    await ctlPost(t, 'nope', {})
    await ctlPost(t, 'echo', {}, { token: null })
    await ctlPost(t, 'echo', {}, { extraBody: { module: 'x' } })
    expect(t.events.map((e) => [e.verb, e.status, e.errorName ?? null])).to.deep.equal([
      ['echo', 200, null],
      ['boom', 500, 'BoomError'],
      ['-', 404, 'NoSuchVerb'],
      ['-', 401, 'Unauthorized'],
      ['-', 400, 'BadRequest']
    ])
    for (const e of t.events) {
      expect(typeof e.ms).to.equal('number')
      expect(Object.keys(e).sort()).to.satisfy((keys: string[]) => keys.every((k) => ['verb', 'status', 'ms', 'errorName'].includes(k)))
    }
    const text = JSON.stringify(t.events)
    expect(text).to.not.include('fixture-secret-')
    expect(text).to.not.include('SENTINEL')
    expect(text).to.not.include('ffff')
    expect(text).to.not.include(t.readToken())
    expect(text).to.not.include(t.peerId.slice(-8))
  })

  it('writes ctl.token and ctl.port 0600 inside a 0700 dir, tightening an existing 0755 dir', async () => {
    const t = await start({
      prepare: ({ ctlDir }) => {
        mkdirSync(ctlDir, { recursive: true, mode: 0o755 })
        chmodSync(ctlDir, 0o755)
        expect(statSync(ctlDir).mode & 0o777).to.equal(0o755)
      }
    })
    expect(statSync(t.ctlDir).mode & 0o777).to.equal(0o700)
    expect(statSync(join(t.ctlDir, CTL_TOKEN_FILE)).mode & 0o777).to.equal(0o600)
    expect(statSync(join(t.ctlDir, CTL_PORT_FILE)).mode & 0o777).to.equal(0o600)
  })

  it('ctl.token is 64 lowercase hex plus newline and differs on every start', async () => {
    const first = await start()
    const tokenA = readFileSync(join(first.ctlDir, CTL_TOKEN_FILE), 'utf8')
    expect(tokenA).to.match(/^[0-9a-f]{64}\n$/)
    await first.handle.close()
    const second = await startTestCtl({ dir: first.dir })
    open.push(second)
    const tokenB = readFileSync(join(second.ctlDir, CTL_TOKEN_FILE), 'utf8')
    expect(tokenB).to.match(/^[0-9a-f]{64}\n$/)
    expect(tokenB).to.not.equal(tokenA)
    expect(t2Readable(second)).to.equal(true)
  })

  it('ctl.port is written last: absent during beforePortFile while the server already answers', async () => {
    let seen: { portFile: boolean, tokenFile: boolean, status: number } | undefined
    let ctlDir = ''
    const t = await start({
      prepare: (paths) => {
        ctlDir = paths.ctlDir
      },
      beforePortFile: async (info) => {
        const token = readFileSync(join(ctlDir, CTL_TOKEN_FILE), 'utf8').replace(/\n$/, '')
        const reply = await rawRequest({
          port: info.port,
          headers: { 'content-type': 'application/json', 'x-vt-token': token, 'x-vt-role': 'officer' },
          body: JSON.stringify({ verb: 'echo', args: { n: 1 } })
        })
        seen = { portFile: existsSync(join(ctlDir, CTL_PORT_FILE)), tokenFile: existsSync(join(ctlDir, CTL_TOKEN_FILE)), status: reply.status }
      }
    })
    expect(seen).to.deep.equal({ portFile: false, tokenFile: true, status: 200 })
    expect(existsSync(join(t.ctlDir, CTL_PORT_FILE))).to.equal(true)
    expect(t.calls.echo).to.equal(1)
  })

  it('removes a stale ctl.port before listening and leaves no temp files', async () => {
    let staleDuringHook: boolean | undefined
    let ctlDir = ''
    const t = await start({
      prepare: (paths) => {
        ctlDir = paths.ctlDir
        mkdirSync(ctlDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(ctlDir, CTL_PORT_FILE), '1\n', { mode: 0o600 })
      },
      beforePortFile: () => {
        staleDuringHook = existsSync(join(ctlDir, CTL_PORT_FILE))
      }
    })
    expect(staleDuringHook).to.equal(false)
    expect(readFileSync(join(t.ctlDir, CTL_PORT_FILE), 'utf8')).to.equal(`${t.port}\n`)
    const entries = readdirSync(t.ctlDir)
    expect(entries.filter((e) => e.includes('.tmp-'))).to.deep.equal([])
    expect(entries.sort()).to.deep.equal([CTL_PORT_FILE, CTL_TOKEN_FILE])
  })

  it('refuses a ctl dir that is a symlink', async () => {
    let dirSeen = ''
    let caught: unknown
    try {
      await startTestCtl({
        prepare: ({ dir, ctlDir }) => {
          dirSeen = dir
          mkdirSync(join(dir, 'real'), { mode: 0o700 })
          symlinkSync(join(dir, 'real'), ctlDir)
        }
      })
    } catch (e) {
      caught = e
    }
    expect(caught).to.be.instanceOf(CtlSetupError)
    expect((caught as CtlSetupError).code).to.equal('dir-symlink')
    expect((caught as Error).name).to.equal('CtlSetupError')
    expect((caught as Error).message).to.not.include(dirSeen)
    expect(existsSync(dirSeen)).to.equal(false)
  })

  it('close removes ctl.port and ctl.token and stops answering', async () => {
    const t = await start()
    const port = t.port
    expect((await ctlPost(t, 'echo', {})).status).to.equal(200)
    await t.handle.close()
    expect(existsSync(join(t.ctlDir, CTL_PORT_FILE))).to.equal(false)
    expect(existsSync(join(t.ctlDir, CTL_TOKEN_FILE))).to.equal(false)
    expect(await connectFails(port, '127.0.0.1')).to.equal(true)
    await t.handle.close()
  })
})

function t2Readable(t: TestCtl): boolean {
  return existsSync(join(t.ctlDir, CTL_PORT_FILE)) && existsSync(join(t.ctlDir, CTL_TOKEN_FILE))
}
