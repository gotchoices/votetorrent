import { expect } from 'chai'
import { EXIT } from '../src/cli/exit-codes.js'
import { runCli, USAGE, type CliIo } from '../src/cli/run-cli.js'
import { LOCAL_ONLY_VERBS, ROLE_USAGE, buildVerbArgs, runRoleCommand, type LocalCommand } from '../src/ctl/commands.js'
import { startTestCtl, type TestCtl } from './support/ctl-fixture.js'

interface Capture extends CliIo {
  out_: string[]
  err_: string[]
  stdout(): string
  stderr(): string
}

function capture(): Capture {
  const out_: string[] = []
  const err_: string[] = []
  return {
    out_,
    err_,
    out: (t) => { out_.push(t) },
    err: (t) => { err_.push(t) },
    stdout: () => out_.join(''),
    stderr: () => err_.join('')
  }
}

function oneJsonLine(text: string): unknown {
  const lines = text.split('\n')
  expect(lines.length).to.equal(2)
  expect(lines[1]).to.equal('')
  return JSON.parse(lines[0] as string)
}

describe('ctl commands: vt role verb', function () {
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

  it('vt officer echo --peer DIR --n 3 prints the result as one JSON line and exits 0', async () => {
    const t = await start()
    const io = capture()
    const code = await runCli(['officer', 'echo', '--peer', t.ctlDir, '--n', '3'], io)
    expect(code).to.equal(EXIT.PASS)
    expect(io.stderr()).to.equal('')
    expect(oneJsonLine(io.stdout())).to.deep.equal({ keys: ['n'], n: '3' })
    expect(t.calls.echo).to.equal(1)
  })

  it('--json prints the whole reply including ms', async () => {
    const t = await start()
    const io = capture()
    const code = await runCli(['officer', 'echo', '--peer', t.ctlDir, '--n', '3', '--json'], io)
    expect(code).to.equal(EXIT.PASS)
    const body = oneJsonLine(io.stdout()) as { ok: boolean, result: unknown, ms: unknown }
    expect(body.ok).to.equal(true)
    expect(body.result).to.deep.equal({ keys: ['n'], n: '3' })
    expect(typeof body.ms).to.equal('number')
    expect(io.stderr()).to.equal('')
  })

  it('flags map to camelCase args: bare flag true, --no-x false, repeats collect, --x=v', async () => {
    const built = buildVerbArgs(['--code-file', 'f', '--flag', '--no-x', '--tag', 'a', '--tag', 'b', '--k=v'])
    expect(built.ok).to.equal(true)
    if (!built.ok) return
    expect(built.args).to.deep.equal({ codeFile: 'f', flag: true, x: false, tag: ['a', 'b'], k: 'v' })
    expect(Object.keys(built.args).sort()).to.deep.equal(['codeFile', 'flag', 'k', 'tag', 'x'])
    expect(built.control).to.deep.equal({ json: false })
    const withControl = buildVerbArgs(['--peer', 'd', '--json', '--timeout-ms', '2500', '--n', '1'])
    expect(withControl).to.deep.equal({ ok: true, control: { peer: 'd', json: true, timeoutMs: 2500 }, args: { n: '1' } })
    const t = await start()
    const io = capture()
    const code = await runCli(['officer', 'echo', '--peer', t.ctlDir, '--code-file', 'f', '--flag', '--no-x', '--tag', 'a', '--tag', 'b', '--k=v'], io)
    expect(code).to.equal(EXIT.PASS)
    expect((oneJsonLine(io.stdout()) as { keys: string[] }).keys).to.deep.equal(['codeFile', 'flag', 'k', 'tag', 'x'])
  })

  it('--args-json merges an object; a non-object or a duplicate key exits 2', async () => {
    const merged = buildVerbArgs(['--args-json', '{"m":"1","deep":{"a":1}}', '--n', '2'])
    expect(merged).to.deep.equal({ ok: true, control: { json: false, argsJson: '{"m":"1","deep":{"a":1}}' }, args: { n: '2', m: '1', deep: { a: 1 } } })
    expect(buildVerbArgs(['--args-json', '[1]'])).to.deep.equal({ ok: false, reason: 'args-json-shape' })
    expect(buildVerbArgs(['--args-json', 'null'])).to.deep.equal({ ok: false, reason: 'args-json-shape' })
    expect(buildVerbArgs(['--args-json', '{'])).to.deep.equal({ ok: false, reason: 'args-json-shape' })
    expect(buildVerbArgs(['--args-json', '{"n":"1"}', '--n', '2'])).to.deep.equal({ ok: false, reason: 'duplicate-arg' })
    expect(buildVerbArgs(['--timeout-ms', 'soon'])).to.deep.equal({ ok: false, reason: 'timeout-shape' })
    expect(buildVerbArgs(['--timeout-ms', '0'])).to.deep.equal({ ok: false, reason: 'timeout-shape' })
    expect(buildVerbArgs(['--peer'])).to.deep.equal({ ok: false, reason: 'missing-value' })
    expect(buildVerbArgs(['-n', '1'])).to.deep.equal({ ok: false, reason: 'short-option' })
    expect(buildVerbArgs(['--Bad'])).to.deep.equal({ ok: false, reason: 'bad-flag-name' })
    expect(buildVerbArgs(['--a_b', '1'])).to.deep.equal({ ok: false, reason: 'bad-flag-name' })
    expect(buildVerbArgs(['--' + 'a'.repeat(65)])).to.deep.equal({ ok: false, reason: 'bad-flag-name' })
    const t = await start()
    const io = capture()
    expect(await runCli(['officer', 'echo', '--peer', t.ctlDir, '--args-json', '{"m":"1"}', '--n', '2'], io)).to.equal(EXIT.PASS)
    expect((oneJsonLine(io.stdout()) as { keys: string[] }).keys).to.deep.equal(['m', 'n'])
    const bad = capture()
    expect(await runCli(['officer', 'echo', '--peer', t.ctlDir, '--args-json', '[1]'], bad)).to.equal(EXIT.USAGE)
    expect(bad.stderr()).to.equal('vt: bad arguments (args-json-shape)\n')
    const dup = capture()
    expect(await runCli(['officer', 'echo', '--peer', t.ctlDir, '--args-json', '{"n":"1"}', '--n', '2'], dup)).to.equal(EXIT.USAGE)
    expect(dup.stderr()).to.equal('vt: bad arguments (duplicate-arg)\n')
    expect(t.calls.echo).to.equal(1)
  })

  it('a stray positional exits 2 and is not echoed', async () => {
    const t = await start()
    const io = capture()
    const code = await runCli(['officer', 'echo', '--peer', t.ctlDir, '--flag', 'x', 'STRAY-SENTINEL'], io)
    expect(code).to.equal(EXIT.USAGE)
    expect(io.stderr()).to.equal('vt: bad arguments (positional)\n')
    expect(io.stdout()).to.equal('')
    expect(io.stdout() + io.stderr()).to.not.include('SENTINEL')
    const term = capture()
    expect(await runCli(['officer', 'echo', '--peer', t.ctlDir, '--', 'SENTINEL'], term)).to.equal(EXIT.USAGE)
    expect(term.stdout() + term.stderr()).to.not.include('SENTINEL')
    expect(t.calls.echo ?? 0).to.equal(0)
    expect(t.events.length).to.equal(0)
  })

  it('missing verb prints role usage to stderr and exits 2; --help prints it to stdout and exits 0', async () => {
    const io = capture()
    expect(await runCli(['officer'], io)).to.equal(EXIT.USAGE)
    expect(io.stderr()).to.equal(ROLE_USAGE)
    expect(io.stdout()).to.equal('')
    for (const word of ['--help', '-h', 'help']) {
      const h = capture()
      expect(await runCli(['keyholder', word], h)).to.equal(EXIT.PASS)
      expect(h.stdout()).to.equal(ROLE_USAGE)
      expect(h.stderr()).to.equal('')
    }
    expect(ROLE_USAGE.startsWith('usage: vt <role> <verb> --peer <dir> [--json] [--timeout-ms N] [--args-json <json>] [--<name> <value> ...]\n')).to.equal(true)
    for (const word of ['officer', 'keyholder', 'voter', 'VT_PEER', 'verbs --peer', 'FILE PATH', '--code-file']) expect(ROLE_USAGE).to.include(word)
    expect(ROLE_USAGE).to.match(/0 {2}ok/)
    expect(ROLE_USAGE).to.match(/3 {2}daemon unreachable/)
    expect(ROLE_USAGE).to.not.match(/[Pp]hase [0-9]|67-[0-9]{2}/)
  })

  it('missing --peer exits 2; VT_PEER from env is used when present', async () => {
    const t = await start()
    const io = capture()
    expect(await runRoleCommand(['officer', 'echo', '--n', '1'], io, { env: {} })).to.equal(EXIT.USAGE)
    expect(io.stderr()).to.equal('vt: --peer <dir> is required (or set VT_PEER)\n')
    expect(io.stdout()).to.equal('')
    const viaEnv = capture()
    expect(await runRoleCommand(['officer', 'echo', '--n', '1'], viaEnv, { env: { VT_PEER: t.ctlDir } })).to.equal(EXIT.PASS)
    expect(oneJsonLine(viaEnv.stdout())).to.deep.equal({ keys: ['n'], n: '1' })
    expect(t.calls.echo).to.equal(1)
  })

  it('an invalid verb name exits 2 before any request', async () => {
    const t = await start()
    for (const verb of ['../echo-SENTINEL', 'Echo-SENTINEL', 'a/SENTINEL', 'a'.repeat(65)]) {
      const io = capture()
      expect(await runCli(['officer', verb, '--peer', t.ctlDir], io)).to.equal(EXIT.USAGE)
      expect(io.stderr()).to.equal('vt: invalid verb name (see vt <role> --help)\n')
      expect(io.stdout() + io.stderr()).to.not.include('SENTINEL')
    }
    expect(t.events.length).to.equal(0)
  })

  it('an unknown verb exits 2 and a verb error exits 1 with a redacted error on stderr', async () => {
    const t = await start()
    const unknown = capture()
    expect(await runCli(['officer', 'nope', '--peer', t.ctlDir], unknown)).to.equal(EXIT.USAGE)
    expect(oneJsonLine(unknown.stderr())).to.deep.equal({ error: { name: 'NoSuchVerb' } })
    expect(unknown.stdout()).to.equal('')
    const boom = capture()
    expect(await runCli(['officer', 'boom', '--peer', t.ctlDir], boom)).to.equal(EXIT.FAIL)
    const body = oneJsonLine(boom.stderr()) as { error: { name: string, code: string, message: string, chain: string[] } }
    expect(body.error.name).to.equal('BoomError')
    expect(body.error.code).to.equal('boom-code')
    expect(body.error.chain).to.deep.equal(['BoomError', 'MiddleBoom', 'InnerBoom'])
    expect(body.error.message).to.include('<secret>')
    expect(boom.stderr()).to.not.include(t.secret)
    expect(boom.stderr()).to.not.include('fixture-secret-')
    expect(boom.stderr()).to.not.include('12D3KooW')
    expect(boom.stderr()).to.not.include('stack')
    expect(boom.stdout()).to.equal('')
    const boomJson = capture()
    expect(await runCli(['officer', 'boom', '--peer', t.ctlDir, '--json'], boomJson)).to.equal(EXIT.FAIL)
    const whole = oneJsonLine(boomJson.stdout()) as { ok: boolean, error: { name: string }, ms: unknown }
    expect(whole.ok).to.equal(false)
    expect(whole.error.name).to.equal('BoomError')
    expect(typeof whole.ms).to.equal('number')
    expect(oneJsonLine(boomJson.stderr())).to.have.property('error')
  })

  it('the wrong role for the peer exits 2', async () => {
    const t = await start()
    const io = capture()
    expect(await runCli(['voter', 'echo', '--peer', t.ctlDir], io)).to.equal(EXIT.USAGE)
    expect(oneJsonLine(io.stderr())).to.deep.equal({ error: { name: 'WrongRole' } })
    expect(t.calls.echo ?? 0).to.equal(0)
  })

  it('start is never forwarded: a local handler runs it, none exits 2', async () => {
    expect([...LOCAL_ONLY_VERBS]).to.deep.equal(['start'])
    const t = await start()
    const seen: Array<{ role: string, args: Record<string, unknown> }> = []
    const handler: LocalCommand = async (role, args, io) => {
      seen.push({ role, args })
      io.out('started\n')
      return EXIT.PASS
    }
    const io = capture()
    const code = await runRoleCommand(['keyholder', 'start', '--peer', t.ctlDir, '--state', 's', '--relay', 'r.env', '--colocate'], io, {
      local: new Map([['start', handler]])
    })
    expect(code).to.equal(EXIT.PASS)
    expect(seen).to.deep.equal([{ role: 'keyholder', args: { state: 's', relay: 'r.env', colocate: true } }])
    expect(io.stdout()).to.equal('started\n')
    const failing: LocalCommand = async () => EXIT.FAIL
    expect(await runRoleCommand(['officer', 'start', '--peer', t.ctlDir], capture(), { local: new Map([['start', failing]]) })).to.equal(EXIT.FAIL)
    const none = capture()
    expect(await runRoleCommand(['officer', 'start', '--peer', t.ctlDir], none, {})).to.equal(EXIT.USAGE)
    expect(none.stderr()).to.equal('vt: officer start has no local handler in this command table\n')
    const viaCli = capture()
    expect(await runCli(['voter', 'start', '--state', 's'], viaCli)).to.equal(EXIT.USAGE)
    expect(viaCli.stderr()).to.equal('vt: voter start has no local handler in this command table\n')
    expect(t.events.length).to.equal(0)
  })

  it('a stopped daemon exits 3', async () => {
    const t = await start()
    await t.handle.close()
    const io = capture()
    expect(await runCli(['officer', 'echo', '--peer', t.ctlDir], io)).to.equal(EXIT.UNREACHABLE)
    const body = oneJsonLine(io.stderr()) as { error: { name: string, code: string } }
    expect(body.error.name).to.equal('Unreachable')
    expect(body.error.code).to.equal('no-port-file')
    expect(io.stderr()).to.not.include(t.dir)
    expect(io.stdout()).to.equal('')
    const missing = capture()
    expect(await runCli(['officer', 'echo', '--peer', '/nonexistent-vt-peer-SENTINEL'], missing)).to.equal(EXIT.UNREACHABLE)
    expect(missing.stderr()).to.not.include('SENTINEL')
  })

  it('runCli routes officer, keyholder and voter to the command table and keeps the unknown-command rule', async () => {
    for (const role of ['officer', 'keyholder', 'voter']) {
      const io = capture()
      expect(await runCli([role], io)).to.equal(EXIT.USAGE)
      expect(io.stderr()).to.equal(ROLE_USAGE)
      expect(io.stdout()).to.equal('')
    }
    const bogus = capture()
    expect(await runCli(['bogus-SENTINEL', 'echo'], bogus)).to.equal(EXIT.USAGE)
    expect(bogus.stderr()).to.equal('vt: unknown command (see vt --help)\n')
    expect(bogus.stdout() + bogus.stderr()).to.not.include('SENTINEL')
    const upper = capture()
    expect(await runCli(['Officer', 'echo'], upper)).to.equal(EXIT.USAGE)
    expect(upper.stderr()).to.equal('vt: unknown command (see vt --help)\n')
    const empty = capture()
    expect(await runCli([], empty)).to.equal(EXIT.USAGE)
    expect(empty.stderr()).to.equal(USAGE)
    const help = capture()
    expect(await runCli(['--help'], help)).to.equal(EXIT.PASS)
    expect(help.stdout()).to.equal(USAGE)
  })
})
