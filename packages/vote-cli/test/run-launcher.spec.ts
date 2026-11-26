import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT } from '../src/cli/exit-codes.js'
import { runCli, type CliIo } from '../src/cli/run-cli.js'
import { runRoleCommand } from '../src/ctl/commands.js'
import { LOCAL_COMMANDS } from '../src/daemon/start-command.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import {
  DaemonBootError,
  INSTRUMENTS_PRELOAD,
  createDaemonLauncher,
  defaultDaemonArgv,
  formatCommandLine,
  loadableInstrumentsPreload,
  roleForLabel,
  type DaemonLauncher,
  type DaemonLauncherOptions,
  type DaemonSpec
} from '../src/run/daemon-launcher.js'
import { SecretRegistry } from '../src/run/secret-scan.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REGISTER = join(PACKAGE_ROOT, 'register-ts-node.mjs')
const FAKE = join(PACKAGE_ROOT, 'test', 'support', 'fake-daemon.ts')
const TSCONFIG = join(PACKAGE_ROOT, 'tsconfig.test.json')
const RELAY_ADDR = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWSyntheticRe1ayPeerXyzABCDEFGHJKMNPQRSTUVWxyz'

interface Rig {
  dir: string
  state: string
  ev: string
  relayEnv: string
  party: string
  spawned: string[][]
  steps: Array<{ name: string }>
  opts: DaemonLauncherOptions
  launcher: DaemonLauncher
}

function makeRig (overrides: Partial<DaemonLauncherOptions> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'vt-run-launcher-'))
  const state = join(dir, 'state')
  const ev = join(dir, 'ev')
  mkdirSync(ev, { recursive: true, mode: 0o700 })
  const relayEnv = join(dir, 'relay.env')
  writeRelayEnv(relayEnv, RELAY_ADDR)
  const party = 'vt-launch-' + randomBytes(3).toString('hex')
  const rig: Rig = {
    dir, state, ev, relayEnv, party, spawned: [], steps: [], opts: undefined as unknown as DaemonLauncherOptions,
    launcher: undefined as unknown as DaemonLauncher
  }
  const daemonArgv = (spec: DaemonSpec, peerDir: string): string[] => {
    const argv = [
      '--no-deprecation', '--no-warnings', '--import', REGISTER, '--experimental-specifier-resolution=node', FAKE,
      spec.role, 'start', '--state', peerDir, '--relay', rig.relayEnv, '--party', rig.party,
      ...(spec.labels.length > 1 ? ['--colocate', spec.labels.join(',')] : [])
    ]
    rig.spawned.push(argv)
    return argv
  }
  rig.opts = {
    stateDir: state,
    party,
    relayEnvPath: relayEnv,
    evDir: ev,
    registry: new SecretRegistry(),
    mask: (s: string) => s,
    cpuProf: false,
    instruments: false,
    bootTimeoutMs: 60000,
    daemonArgv,
    extraEnv: { TS_NODE_PROJECT: TSCONFIG },
    cwd: PACKAGE_ROOT,
    onStep: (w) => {
      rig.steps.push({ name: w.name })
    },
    ...overrides
  }
  rig.launcher = createDaemonLauncher(rig.opts)
  return rig
}

const specOf = (label: string, labels: string[] = [label]): DaemonSpec => ({
  label,
  role: label === 'officer' ? 'officer' : (label.startsWith('kh-') ? 'keyholder' : 'voter'),
  kind: label.startsWith('v') ? 'voter' : 'authority',
  labels
})

const capture = (): { io: CliIo, out: () => string, err: () => string } => {
  let out = ''
  let err = ''
  return {
    io: { out: (t) => { out += t }, err: (t) => { err += t } },
    out: () => out,
    err: () => err
  }
}

describe('run: launcher wiring', function () {
  this.timeout(180000)
  const rigs: Rig[] = []
  const rig = (overrides: Partial<DaemonLauncherOptions> = {}): Rig => {
    const r = makeRig(overrides)
    rigs.push(r)
    return r
  }

  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      await r.launcher.stopAll()
      rmSync(r.dir, { recursive: true, force: true })
    }
  })

  it('a non-colocated label is called through its own peer dir with its own role and no peer key', async () => {
    const r = rig()
    expect(roleForLabel('kh-b')).to.equal('keyholder')
    expect(roleForLabel('officer')).to.equal('officer')
    expect(roleForLabel('v2')).to.equal('voter')
    expect(() => roleForLabel('other')).to.throw(DaemonBootError)
    const h = await r.launcher.start(specOf('officer'))
    expect(h.dir).to.equal(join(r.state, r.party, 'officer'))
    expect(h.role).to.equal('officer')
    const reply = await h.call('echo', { n: 7 })
    expect(reply.ok).to.equal(true)
    if (reply.ok) {
      expect(Object.keys(reply.result)).to.deep.equal(['n', 'label', 'pid'])
      expect(reply.result.label).to.equal('officer')
    }
    expect(formatCommandLine({ iso: '2026-01-01T00:00:00.000Z', label: 'officer', verb: 'echo', ok: true, ms: 3 }))
      .to.equal('2026-01-01T00:00:00.000Z officer echo ok=true ms=3')
    expect(formatCommandLine({ iso: '2026-01-01T00:00:00.000Z', label: 'officer', verb: 'bad verb', ok: false, ms: 4 }))
      .to.equal('2026-01-01T00:00:00.000Z officer - ok=false ms=4')
    expect(readFileSync(join(r.ev, 'commands.log'), 'utf8')).to.match(/ officer echo ok=true ms=\d+\n$/)
  })

  it('each colocated label is called through its own peer dir and ctl token, with role keyholder for kh-*', async () => {
    const r = rig()
    const primary = await r.launcher.start(specOf('officer', ['officer', 'kh-a', 'kh-b']))
    const kh = r.launcher.handle('kh-a')
    expect(kh).to.not.equal(undefined)
    expect(kh!.dir).to.equal(join(r.state, r.party, 'kh-a'))
    expect(kh!.role).to.equal('keyholder')
    expect(r.launcher.handle('kh-b')!.role).to.equal('keyholder')
    const a = await primary.call('echo', { n: 1 })
    const b = await kh!.call('echo', { n: 2 })
    expect(a.ok && b.ok).to.equal(true)
    if (a.ok && b.ok) {
      expect(a.result.label).to.equal('officer')
      expect(b.result.label).to.equal('kh-a')
      expect(a.result.pid).to.equal(b.result.pid)
    }
    const tokens = ['officer', 'kh-a', 'kh-b'].map((l) => readFileSync(join(r.state, r.party, l, 'ctl.token'), 'utf8').trim())
    expect(new Set(tokens).size).to.equal(3)
    expect(r.spawned).to.have.length(1)
  })

  it('the colocated boot waits for every label\'s ctl.port and registers every label\'s token', async () => {
    const r = rig()
    await r.launcher.start(specOf('officer', ['officer', 'kh-a', 'kh-b']))
    for (const label of ['officer', 'kh-a', 'kh-b']) {
      expect(existsSync(join(r.state, r.party, label, 'ctl.port'))).to.equal(true)
    }
    expect(r.opts.registry.size).to.be.at.least(3)
    expect(r.steps.map((s) => s.name)).to.deep.equal(['start-officer'])
  })

  it('only the officer\'s start argv carries --accept-token-attestations', async () => {
    const r = rig()
    await r.launcher.start(specOf('officer'))
    await r.launcher.start(specOf('kh-a'))
    await r.launcher.start(specOf('v1'))
    expect(r.spawned).to.have.length(3)
    expect(r.spawned[0]!.filter((a) => a === '--accept-token-attestations')).to.have.length(1)
    expect(r.spawned[1]!.filter((a) => a === '--accept-token-attestations')).to.have.length(0)
    expect(r.spawned[2]!.filter((a) => a === '--accept-token-attestations')).to.have.length(0)
    const direct = defaultDaemonArgv({ relayEnvPath: r.relayEnv, party: r.party, instruments: false })(
      specOf('officer'), join(r.state, r.party, 'officer'))
    expect(direct.filter((a) => a === '--accept-token-attestations')).to.have.length(1)
    const colocated = rig()
    await colocated.launcher.start(specOf('officer', ['officer', 'kh-a']))
    expect(colocated.spawned[0]!.filter((a) => a === '--accept-token-attestations')).to.have.length(1)
  })

  it('--instruments adds the instruments preload after a user --import and sets the instruments dir', async () => {
    const withPreload = REGISTER
    const r = rig({ instruments: true, importFile: withPreload })
    const h = await r.launcher.start(specOf('officer'))
    const flags = await h.call('node-flags')
    expect(flags.ok).to.equal(true)
    if (flags.ok) {
      const list = flags.result.flags as string[]
      const at = list.indexOf(withPreload)
      const preload = loadableInstrumentsPreload()
      expect(INSTRUMENTS_PRELOAD).to.equal(join(PACKAGE_ROOT, 'src', 'run', 'instruments', 'daemon-preload.js'))
      expect(at).to.be.greaterThan(-1)
      expect(list.slice(at - 1, list.indexOf(preload) + 1))
        .to.deep.equal(['--import', withPreload, '--import', preload])
    }
    const env = await h.call('instr-env')
    expect(env.ok).to.equal(true)
    if (env.ok) {
      expect(env.result.instrDir).to.equal(join(r.state, r.party, 'officer', 'instruments'))
      expect(env.result.instrRole).to.equal('officer')
    }
    expect(statSync(join(r.state, r.party, 'officer', 'instruments')).mode & 0o777).to.equal(0o700)
    const plain = rig()
    const ph = await plain.launcher.start(specOf('officer'))
    const pflags = await ph.call('node-flags')
    if (pflags.ok) expect(pflags.result.flags as string[]).to.not.include(loadableInstrumentsPreload())
    const penv = await ph.call('instr-env')
    if (penv.ok) expect(penv.result.instrDir).to.equal(null)
  })

  it('restart stops the label\'s process cleanly and starts it again on the same peer dir', async () => {
    const r = rig()
    const first = await r.launcher.start(specOf('officer'))
    const dir = first.dir
    const oldToken = readFileSync(join(dir, 'ctl.token'), 'utf8').trim()
    const again = await r.launcher.restart('officer')
    expect(again.dir).to.equal(dir)
    expect(r.launcher.startedCount()).to.equal(1)
    expect(r.steps.map((s) => s.name)).to.deep.equal(['start-officer', 'restart-officer'])
    const newToken = readFileSync(join(dir, 'ctl.token'), 'utf8').trim()
    expect(newToken).to.not.equal(oldToken)
    expect(existsSync(join(dir, 'ctl.port'))).to.equal(true)
    const reply = await again.call('echo', { n: 9 })
    expect(reply.ok).to.equal(true)
  })

  it('run-cli dispatches vt run and vt selfcheck to runVtCommand and leaves every other command unchanged', async () => {
    const self = capture()
    expect(await runCli(['selfcheck'], self.io)).to.equal(EXIT.PASS)
    expect(self.out().split('\n').filter((l) => l.length > 0).at(-1)).to.equal('SELFCHECK: PASS 8/8')
    const run = capture()
    expect(await runCli(['run'], run.io)).to.equal(EXIT.USAGE)
    expect(run.out()).to.equal('')
    expect(run.err().startsWith('usage: vt run election')).to.equal(true)
    const viaCli = capture()
    const viaDirect = capture()
    const a = await runCli(['officer', '--help'], viaCli.io)
    const b = await runRoleCommand(['officer', '--help'], viaDirect.io, { env: process.env, local: LOCAL_COMMANDS })
    expect(a).to.equal(b)
    expect(viaCli.out()).to.equal(viaDirect.out())
    expect(viaCli.err()).to.equal(viaDirect.err())
    const unknown = capture()
    expect(await runCli(['not-a-command'], unknown.io)).to.equal(EXIT.USAGE)
    expect(unknown.err()).to.equal('vt: unknown command (see vt --help)\n')
  })
})
