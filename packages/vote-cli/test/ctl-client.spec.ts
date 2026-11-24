import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from '../src/cli/exit-codes.js'
import { callCtl, exitCodeFor, type CtlReply } from '../src/ctl/ctl-client.js'
import { CTL_PORT_FILE, CTL_TOKEN_FILE } from '../src/ctl/protocol.js'
import { startTestCtl, type TestCtl } from './support/ctl-fixture.js'

describe('ctl client', function () {
  this.timeout(20000)
  const open: TestCtl[] = []
  // every non-ok reply seen by tests 2-7, with the dir and token it must never mention
  const nonOk: Array<{ reply: CtlReply, dir: string, token: string }> = []
  const start = async (opts: Parameters<typeof startTestCtl>[0] = {}): Promise<TestCtl> => {
    const t = await startTestCtl(opts)
    open.push(t)
    return t
  }
  const keep = (t: TestCtl, reply: CtlReply, token?: string): CtlReply => {
    expect(reply.body.ok).to.equal(false)
    nonOk.push({ reply, dir: t.dir, token: token ?? t.readToken() })
    return reply
  }
  afterEach(async () => {
    for (const t of open.splice(0)) await t.close()
  })

  it('returns status 200 and the reply for a registered verb (exit 0)', async () => {
    const t = await start()
    const reply = await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: { n: '3' } })
    expect(reply.status).to.equal(200)
    expect(reply.body.ok).to.equal(true)
    expect(reply.body.result).to.deep.equal({ keys: ['n'], n: '3' })
    expect(typeof reply.body.ms).to.equal('number')
    expect(exitCodeFor(reply)).to.equal(EXIT.PASS)
    const noArgs = await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo' })
    expect(noArgs.body.result).to.deep.equal({ keys: [], n: null })
    expect(t.calls.echo).to.equal(2)
  })

  it('status 0 Unreachable with code no-port-file when ctl.port is missing (exit 3)', async () => {
    const t = await start()
    rmSync(join(t.ctlDir, CTL_PORT_FILE))
    const reply = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }))
    expect(reply.status).to.equal(0)
    expect(reply.body).to.deep.equal({ ok: false, error: { name: 'Unreachable', code: 'no-port-file' } })
    expect(exitCodeFor(reply)).to.equal(EXIT.UNREACHABLE)
    expect(t.events.length).to.equal(0)
  })

  it('refuses a group- or other-readable ctl.token without sending (exit 3)', async () => {
    const t = await start()
    const tokenPath = join(t.ctlDir, CTL_TOKEN_FILE)
    for (const mode of [0o640, 0o604, 0o660, 0o644]) {
      chmodSync(tokenPath, mode)
      const reply = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }))
      expect(reply.status).to.equal(0)
      expect(reply.body).to.deep.equal({ ok: false, error: { name: 'Unreachable', code: 'token-mode' } })
      expect(exitCodeFor(reply)).to.equal(EXIT.UNREACHABLE)
    }
    expect(t.events.length).to.equal(0)
    chmodSync(tokenPath, 0o600)
    expect((await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} })).status).to.equal(200)
    expect(t.events.length).to.equal(1)
  })

  it('refuses a malformed token or port file (exit 3)', async () => {
    const t = await start()
    const tokenPath = join(t.ctlDir, CTL_TOKEN_FILE)
    const portPath = join(t.ctlDir, CTL_PORT_FILE)
    const token = t.readToken()
    writeFileSync(tokenPath, 'abc\n', { mode: 0o600 })
    const badToken = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }), token)
    expect(badToken.body).to.deep.equal({ ok: false, error: { name: 'Unreachable', code: 'token-shape' } })
    expect(exitCodeFor(badToken)).to.equal(EXIT.UNREACHABLE)
    writeFileSync(tokenPath, token.toUpperCase() + '\n', { mode: 0o600 })
    expect((keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }), token).body.error as { code: string }).code).to.equal('token-shape')
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
    writeFileSync(portPath, '99999\n', { mode: 0o600 })
    const badPort = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }))
    expect(badPort.body).to.deep.equal({ ok: false, error: { name: 'Unreachable', code: 'port-shape' } })
    expect(exitCodeFor(badPort)).to.equal(EXIT.UNREACHABLE)
    for (const text of ['0\n', 'abc\n', '1234567\n', '', ' 80\n']) {
      writeFileSync(portPath, text, { mode: 0o600 })
      expect((keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} })).body.error as { code: string }).code).to.equal('port-shape')
    }
    expect(t.events.length).to.equal(0)
    writeFileSync(portPath, `${t.port}\n`, { mode: 0o600 })
    expect((await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} })).status).to.equal(200)
  })

  it('status 0 Unreachable for a closed port (exit 3)', async () => {
    const t = await start()
    const port = t.port
    const token = t.readToken()
    await t.handle.close()
    mkdirSync(t.ctlDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(t.ctlDir, CTL_TOKEN_FILE), token + '\n', { mode: 0o600 })
    writeFileSync(join(t.ctlDir, CTL_PORT_FILE), `${port}\n`, { mode: 0o600 })
    const reply = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {}, timeoutMs: 5000 }), token)
    expect(reply.status).to.equal(0)
    expect(reply.body.error?.name).to.equal('Unreachable')
    expect(reply.body.error?.code).to.equal('ECONNREFUSED')
    expect(exitCodeFor(reply)).to.equal(EXIT.UNREACHABLE)
  })

  it('status 0 Timeout when the verb outlives timeoutMs (exit 3)', async () => {
    const t = await start()
    const startedAt = Date.now()
    const reply = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'slow', args: { ms: 2000 }, timeoutMs: 200 }))
    expect(Date.now() - startedAt).to.be.lessThan(1500)
    expect(reply.status).to.equal(0)
    expect(reply.body).to.deep.equal({ ok: false, error: { name: 'Timeout' } })
    expect(exitCodeFor(reply)).to.equal(EXIT.UNREACHABLE)
    expect(t.calls.slow).to.equal(1)
  })

  it('exit 1 for 401, 413 and 500; exit 2 for NoSuchVerb and WrongRole', async () => {
    const t = await start()
    const tokenPath = join(t.ctlDir, CTL_TOKEN_FILE)
    const token = t.readToken()
    let other = randomBytes(32).toString('hex')
    if (other === token) other = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
    writeFileSync(tokenPath, other + '\n', { mode: 0o600 })
    const unauthorized = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'echo', args: {} }), other)
    expect(unauthorized.status).to.equal(401)
    expect(unauthorized.body).to.deep.equal({ ok: false, error: { name: 'Unauthorized' } })
    expect(exitCodeFor(unauthorized)).to.equal(EXIT.FAIL)
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 })

    const small = await start({ maxBodyBytes: 64 })
    const tooLarge = keep(small, await callCtl({ dir: small.ctlDir, role: 'officer', verb: 'echo', args: { pad: 'p'.repeat(100) } }))
    expect(tooLarge.status).to.equal(413)
    expect(tooLarge.body.error?.name).to.equal('PayloadTooLarge')
    expect(exitCodeFor(tooLarge)).to.equal(EXIT.FAIL)

    const boom = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'boom', args: {} }))
    expect(boom.status).to.equal(500)
    expect(boom.body.error?.name).to.equal('BoomError')
    expect(exitCodeFor(boom)).to.equal(EXIT.FAIL)

    const badResult = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'bad-result', args: {} }))
    expect(exitCodeFor(badResult)).to.equal(EXIT.FAIL)

    const noSuch = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'nope', args: {} }))
    expect(noSuch.status).to.equal(404)
    expect(noSuch.body.error?.name).to.equal('NoSuchVerb')
    expect(exitCodeFor(noSuch)).to.equal(EXIT.USAGE)

    const wrongRole = keep(t, await callCtl({ dir: t.ctlDir, role: 'voter', verb: 'echo', args: {} }))
    expect(wrongRole.status).to.equal(400)
    expect(wrongRole.body.error?.name).to.equal('WrongRole')
    expect(exitCodeFor(wrongRole)).to.equal(EXIT.USAGE)

    const before = t.events.length
    const badName = keep(t, await callCtl({ dir: t.ctlDir, role: 'officer', verb: 'Bad_Name', args: {} }))
    expect(badName.status).to.equal(0)
    expect(badName.body).to.deep.equal({ ok: false, error: { name: 'BadVerbName' } })
    expect(exitCodeFor(badName)).to.equal(EXIT.USAGE)
    expect(t.events.length).to.equal(before)

    expect(exitCodeFor({ status: 403, body: { ok: false, error: { name: 'Forbidden' } } })).to.equal(EXIT.FAIL)
    expect(exitCodeFor({ status: 405, body: { ok: false, error: { name: 'MethodNotAllowed' } } })).to.equal(EXIT.FAIL)
    expect(exitCodeFor({ status: 400, body: { ok: false, error: { name: 'BadRequest' } } })).to.equal(EXIT.FAIL)
    expect(exitCodeFor({ status: 200, body: { ok: false, error: { name: 'BadResponse' } } })).to.equal(EXIT.FAIL)
    expect(exitCodeFor({ status: 200, body: { ok: true, result: {} } })).to.equal(EXIT.PASS)
  })

  it('never puts the ctl dir path or the token in a returned error', () => {
    expect(nonOk.length).to.be.greaterThan(10)
    for (const { reply, dir, token } of nonOk) {
      const text = JSON.stringify(reply)
      expect(text).to.not.include(dir)
      expect(text).to.not.include('vt-ctl-')
      expect(text).to.not.include(token)
      expect(text).to.not.include('fixture-secret-')
    }
  })
})
