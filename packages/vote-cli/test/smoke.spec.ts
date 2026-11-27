import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT } from '../src/cli/exit-codes.js'
import { runCli, USAGE, type CliIo } from '../src/cli/run-cli.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = []
  const err_: string[] = []
  return {
    out_,
    err_,
    out: (t) => { out_.push(t) },
    err: (t) => { err_.push(t) }
  }
}

describe('vote-cli smoke', () => {
  it('manifest names the vt bin at dist/bin/vt.js', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    expect(manifest.name).to.equal('@votetorrent/vote-cli')
    expect(manifest.private).to.equal(true)
    expect(manifest.type).to.equal('module')
    expect(manifest.bin.vt).to.equal('./dist/bin/vt.js')
    expect(manifest.engines.node).to.equal('>=22')
  })

  it('runCli with no arguments writes usage to stderr and returns 2', async () => {
    const io = capture()
    const code = await runCli([], io)
    expect(code).to.equal(EXIT.USAGE)
    expect(code).to.equal(2)
    expect(io.err_.join('')).to.equal(USAGE)
    expect(io.out_.join('')).to.equal('')
  })

  it('runCli --help writes usage to stdout and returns 0', async () => {
    const io = capture()
    const code = await runCli(['--help'], io)
    expect(code).to.equal(EXIT.PASS)
    expect(io.out_.join('')).to.equal(USAGE)
    expect(io.out_.join('').startsWith('usage: vt <role> <verb>')).to.equal(true)
    expect(io.err_.join('')).to.equal('')
  })

  it('runCli with an unknown command returns 2 and does not echo the argument', async () => {
    const io = capture()
    const code = await runCli(['vtjoin2.SENTINEL-NOT-A-CODE'], io)
    expect(code).to.equal(EXIT.USAGE)
    expect(io.err_.join('')).to.equal('vt: unknown command (see vt --help)\n')
    expect(io.out_.join('')).to.not.include('SENTINEL')
    expect(io.err_.join('')).to.not.include('SENTINEL')
  })

  it('the vt bin exits 2 with usage on stderr', function () {
    this.timeout(40000)
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.DEBUG
    env.TS_NODE_PROJECT = join(PACKAGE_ROOT, 'tsconfig.test.json')
    env.FORCE_COLOR = '0'
    // --no-deprecation: the ts-node loader itself prints a DEP0180 (fs.Stats) warning on Node 22,
    // which would land on stderr ahead of vt's usage text. The built dist/bin/vt.js has no loader.
    const result = spawnSync(
      process.execPath,
      ['--no-deprecation', '--import', './register-ts-node.mjs', '--experimental-specifier-resolution=node', 'src/bin/vt.ts'],
      { cwd: PACKAGE_ROOT, env, encoding: 'utf8', timeout: 30000 }
    )
    expect(result.error).to.equal(undefined)
    expect(result.status).to.equal(2)
    expect(result.stderr.startsWith('usage: vt ')).to.equal(true)
  })
})
