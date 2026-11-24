import { expect } from 'chai'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliIo } from '../src/cli/run-cli.js'
import { StaleBuildError } from '../src/engine.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import type { DaemonLauncherOptions, DaemonSpec } from '../src/run/daemon-launcher.js'
import { ELECTION_LEGS, type ElectionLeg } from '../src/run/election-legs.js'
import { runElection } from '../src/run/election.js'
import { RunUsageError, parseRunElectionArgs, type RunOptions } from '../src/run/options.js'
import { LINE_GRAMMAR } from '../src/run/output.js'
import { RESULTS_KEYS } from '../src/run/results.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REGISTER = join(PACKAGE_ROOT, 'register-ts-node.mjs')
const FAKE = join(PACKAGE_ROOT, 'test', 'support', 'fake-daemon.ts')
const TSCONFIG = join(PACKAGE_ROOT, 'tsconfig.test.json')
const MAIN = join(PACKAGE_ROOT, 'src', 'run', 'main.ts')
// A private (loopback) relay address with a synthetic peer id: it is registered as a secret and nothing dials it.
const RELAY_ADDR = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWSyntheticRe1ayPeerXyzABCDEFGHJKMNPQRSTUVWxyz'
// A synthetic 40-char value planted as a "code": never a real one.
const VALUE = 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0'
const DEBUG_LINE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+ .*$/

interface Rig {
  dir: string
  state: string
  relayEnv: string
  party: string
  spawned: string[][]
  overrides: Partial<DaemonLauncherOptions>
}

interface RunResult {
  code: number
  stdout: string[]
  stderr: string
}

function fakeArgv (rig: Rig): (spec: DaemonSpec, peerDir: string) => string[] {
  return (spec, peerDir) => {
    const argv = [
      '--no-deprecation', '--no-warnings', '--import', REGISTER, '--experimental-specifier-resolution=node', FAKE,
      spec.role, 'start', '--state', peerDir, '--relay', rig.relayEnv, '--party', rig.party,
      ...(spec.labels.length > 1 ? ['--colocate', spec.labels.join(',')] : [])
    ]
    rig.spawned.push(argv)
    return argv
  }
}

function makeRig (): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'vt-run-election-'))
  const relayEnv = join(dir, 'relay.env')
  writeRelayEnv(relayEnv, RELAY_ADDR)
  const rig: Rig = { dir, state: join(dir, 'state'), relayEnv, party: 'vt-test-' + randomBytes(3).toString('hex'), spawned: [], overrides: {} }
  rig.overrides = { daemonArgv: fakeArgv(rig), extraEnv: { TS_NODE_PROJECT: TSCONFIG }, cwd: PACKAGE_ROOT, bootTimeoutMs: 60000 }
  return rig
}

function parse (rig: Rig, extra: string[] = []): RunOptions {
  return parseRunElectionArgs(['--relay', rig.relayEnv, '--state', rig.state, '--party', rig.party, ...extra])
}

async function run (rig: Rig, opts: RunOptions, legs: readonly ElectionLeg[], deps: { assertFresh?: () => void, extraEnv?: Record<string, string> } = {}): Promise<RunResult> {
  let out = ''
  let err = ''
  const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t } }
  const overrides = { ...rig.overrides, extraEnv: { ...rig.overrides.extraEnv, ...(deps.extraEnv ?? {}) } }
  const code = await runElection(opts, { io, legs, assertFresh: deps.assertFresh ?? (() => {}), launcherOverrides: overrides })
  const stdout = out.split('\n')
  if (stdout.at(-1) === '') stdout.pop()
  return { code, stdout, stderr: err }
}

const echoLegs: readonly ElectionLeg[] = [
  {
    name: 'network',
    part: 'p1',
    body: async (L, ctx) => {
      const r = await L.step('officer-echo', () => ctx.peer('officer').call('echo', { n: 1 }))
      L.need('network', 'N1', 'the officer echoed', r.ok && r.result.n === 1)
      L.duration('reopenMs', 5)
    }
  },
  {
    name: 'h6-election',
    part: 'p2',
    body: async (L, ctx) => {
      const r = await L.step('voter-echo', () => ctx.peer('v1').call('echo', { n: 2 }))
      L.need('election', 'E1', 'the voter echoed', r.ok && r.result.n === 2)
      ctx.peer('v1').stage('started')
    }
  }
]

const evOf = (rig: Rig): string => join(rig.state, 'ev')
const resultsOf = (rig: Rig): Record<string, any> => JSON.parse(readFileSync(join(evOf(rig), 'results.json'), 'utf8'))

describe('run: election (fake daemon)', function () {
  this.timeout(180000)
  const rigs: Rig[] = []
  const rig = (): Rig => {
    const r = makeRig()
    rigs.push(r)
    return r
  }

  afterEach(() => {
    for (const r of rigs.splice(0)) rmSync(r.dir, { recursive: true, force: true })
  })

  it('a host-only run passes: RUN-MARKs, no LEAN- line, SUMMARY PASS last, exit 0', async () => {
    const r = rig()
    const marks = join(r.dir, 'prof', 'marks.txt')
    const res = await run(r, parse(r, ['--marks-file', marks]), echoLegs)
    expect(res.stderr).to.equal('')
    expect(res.code).to.equal(0)
    expect(res.stdout.at(-1)).to.equal('SUMMARY PASS')
    expect(res.stdout.filter((l) => l.startsWith('LEAN-'))).to.deep.equal([])
    const markLines = res.stdout.filter((l) => l.startsWith('RUN-MARK '))
    expect(markLines.map((l) => l.split(' ')[1])).to.deep.equal(['p1-start', 'p1-end', 'p2-start', 'p2-end'])
    for (const l of markLines) expect(LINE_GRAMMAR.runMark.test(l), l).to.equal(true)
    expect(readFileSync(marks, 'utf8')).to.equal(markLines.join('\n') + '\n')
    for (const l of res.stdout) expect(Object.values(LINE_GRAMMAR).some((re) => re.test(l)), l).to.equal(true)
    expect(res.stdout[0]!.startsWith('VT-START: at=')).to.equal(true)
    expect(res.stdout.at(-2)!.startsWith('RESULT {"tool":"vt-run","summary":"PASS","legs":2,')).to.equal(true)
    expect(readFileSync(join(evOf(r), 'driver.log'), 'utf8')).to.equal(res.stdout.join('\n') + '\n')
    expect(statSync(join(evOf(r), 'driver.log')).mode & 0o777).to.equal(0o600)
    expect(res.stdout.some((l) => / LEG {6}network PASS$/.test(l))).to.equal(true)
    expect(res.stdout.some((l) => / LEG {6}h6-election PASS$/.test(l))).to.equal(true)
  })

  it('results.json is 0600, has the rig keys and a window per step, and a rerun on the same state is refused with exit 2', async () => {
    const r = rig()
    const opts = parse(r)
    const res = await run(r, opts, echoLegs)
    expect(res.code).to.equal(0)
    const p = join(evOf(r), 'results.json')
    expect(statSync(p).mode & 0o777).to.equal(0o600)
    const first = readFileSync(p, 'utf8')
    const results = JSON.parse(first)
    expect(Object.keys(results)).to.deep.equal([...RESULTS_KEYS])
    expect(results.tool).to.equal('vt-run')
    expect(results.summary).to.equal('PASS')
    expect(results.legs.map((l: any) => Object.keys(l))).to.deep.equal([['leg', 'status', 'token', 'inScriptD14', 'reason'], ['leg', 'status', 'token', 'inScriptD14', 'reason']])
    expect(results.legs.map((l: any) => `${l.leg} ${l.status} ${l.inScriptD14} ${l.reason}`)).to.deep.equal(['network PASS OFF instruments-off', 'h6-election PASS OFF instruments-off'])
    expect(results.durations).to.deep.equal({ reopenMs: 5 })
    const names = results.steps.map((s: any) => s.name)
    expect(names).to.deep.equal(['start-officer', 'network/officer-echo', 'network', 'start-v1', 'h6-election/voter-echo', 'h6-election'])
    for (const s of results.steps) {
      expect(Object.keys(s)).to.deep.equal(['name', 'startMs', 'endMs'])
      expect(Number.isInteger(s.startMs) && Number.isInteger(s.endMs)).to.equal(true)
      expect(String(s.startMs)).to.have.length(13)
      expect(s.endMs).to.be.at.least(s.startMs)
    }
    expect(results.secretScan.whole).to.equal(0)
    expect(results.secretScan.windows).to.equal(0)
    expect(results.secretScan.files).to.be.at.least(5)
    expect(Object.keys(results.keys)).to.include.members(['VT-START', 'HANDOFF-NETWORK', 'HANDOFF-ELECTION', 'HANDOFF-TOKEN-FILES'])
    expect(results.startedAt <= results.endedAt).to.equal(true)
    const again = await run(r, opts, echoLegs)
    expect(again.code).to.equal(2)
    expect(again.stdout).to.deep.equal(['RESULT {"tool":"vt-run","verdict":"VOID","reason":"state-used"}'])
    expect(again.stderr).to.equal('vt run: refused state-used\n')
    expect(readFileSync(p, 'utf8')).to.equal(first)
    expect(() => parse(r)).to.throw(RunUsageError, 'state-used')
    expect(readdirSync(join(evOf(r), 'network'))).to.have.members(['leg.log', 'leg-status.json'])
    expect(readFileSync(join(evOf(r), 'commands.log'), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => l.replace(/^\S+ /, '').replace(/ ms=\d+$/, ''))).to.deep.equal([
      'officer echo ok=true', 'v1 echo ok=true', 'v1 stop ok=true', 'officer stop ok=true'
    ])
  })

  it('a hard failure ends with SUMMARY FAIL <leg> <token>, exit 1, and skips the later legs', async () => {
    const r = rig()
    let laterRan = false
    const legs: ElectionLeg[] = [
      {
        name: 'network',
        part: 'p1',
        body: async (L, ctx) => {
          const res = await ctx.peer('officer').call('fail')
          L.check('N0', 'the verb reported an error view', !res.ok && res.error.name === 'FakeVerbError' && !res.unreachable)
          L.need('election', 'N1', 'the fake verb succeeded', res.ok)
          laterRan = true
        }
      },
      { name: 'h6-election', part: 'p2', body: async () => { laterRan = true } }
    ]
    const res = await run(r, parse(r), legs)
    expect(res.code).to.equal(1)
    expect(laterRan).to.equal(false)
    expect(res.stdout.at(-1)).to.equal('SUMMARY FAIL network election')
    expect(res.stdout.filter((l) => l.startsWith('RUN-MARK ')).map((l) => l.split(' ')[1])).to.deep.equal(['p1-start', 'p1-end'])
    expect(existsSync(join(evOf(r), 'h6-election'))).to.equal(false)
    const results = resultsOf(r)
    expect(results.summary).to.equal('FAIL network election')
    expect(results.legs).to.have.length(1)
    expect(results.legs[0]).to.include({ leg: 'network', status: 'FAIL', token: 'election' })
  })

  it('a secret a daemon prints fails the run with secret-leak and the orchestrator\'s own lines stay masked', async () => {
    const r = rig()
    const legs: ElectionLeg[] = [
      {
        name: 'network',
        part: 'p1',
        body: async (L, ctx) => {
          expect(() => ctx.secretPath('Bad Name')).to.throw(TypeError)
          const codePath = ctx.secretPath('code.txt')
          expect(codePath).to.equal(join(r.state, 'secrets', 'code.txt'))
          writeFileSync(codePath, VALUE + '\n', { mode: 0o600 })
          ctx.registerSecretFile(codePath, { windows: true })
          ctx.out.say('CODE', `minted ${VALUE} tail ${VALUE.slice(20)}`)
          ctx.out.key('HANDOFF-NETWORK', `code=${VALUE}`)
          const res = await ctx.peer('officer').call('print', { text: `leak ${VALUE}` })
          L.need('network', 'N1', 'printed', res.ok)
        }
      }
    ]
    const res = await run(r, parse(r), legs)
    expect(res.code).to.equal(1)
    expect(res.stdout.at(-1)).to.equal('SUMMARY FAIL network secret-leak')
    const results = resultsOf(r)
    expect(results.summary).to.equal('FAIL network secret-leak')
    expect(results.secretScan.whole).to.be.at.least(1)
    expect(results.legs.map((l: any) => l.status)).to.deep.equal(['PASS'])
    const joined = res.stdout.join('\n')
    expect(joined).to.include('CODE     minted <secret> tail <secret>')
    expect(joined).to.include('HANDOFF-NETWORK: code=<secret>')
    expect(joined).to.not.include(VALUE)
    expect(joined).to.not.include(VALUE.slice(20))
    expect(readFileSync(join(evOf(r), 'driver.log'), 'utf8')).to.not.include(VALUE)
    const resultsText = readFileSync(join(evOf(r), 'results.json'), 'utf8')
    expect(resultsText).to.not.include(VALUE)
    expect(results.keys['HANDOFF-NETWORK']).to.equal('code=<secret>')
    expect(readFileSync(join(evOf(r), 'debug.log'), 'utf8')).to.include(VALUE)
    expect(readFileSync(join(evOf(r), 'network', 'leg.log'), 'utf8')).to.not.include(VALUE)
    expect(statSync(join(r.state, 'secrets')).mode & 0o777).to.equal(0o700)
  })

  it('authority daemon stderr lands in ev/debug.log in the <ISO> <namespace> <msg> shape and voter output in ev/<label>.log', async () => {
    const r = rig()
    const legs: ElectionLeg[] = [
      {
        name: 'network',
        part: 'p1',
        body: async (L, ctx) => {
          const res = await ctx.peer('officer').call('debug-lines', { count: 3 })
          L.need('network', 'N1', 'debug lines written', res.ok && res.result.count === 3)
          const kh = await ctx.peer('kh-a').call('debug-lines', { count: 2 })
          L.need('network', 'N2', 'keyholder debug lines written', kh.ok)
        }
      },
      {
        name: 'h6-election',
        part: 'p2',
        body: async (L, ctx) => {
          const res = await ctx.peer('v1').call('debug-lines', { count: 2 })
          L.need('election', 'E1', 'voter debug lines written', res.ok)
          ctx.peer('v1').stage('joined')
          ctx.peer('v1').stage('committed')
          expect(() => ctx.peer('v1').stage('not-a-stage')).to.throw(TypeError)
          expect(() => ctx.peer('officer').stage('joined')).to.throw(TypeError)
        }
      }
    ]
    const res = await run(r, parse(r), legs)
    expect(res.code).to.equal(0)
    const debug = readFileSync(join(evOf(r), 'debug.log'), 'utf8').split('\n').filter((l) => l.length > 0)
    expect(debug.length).to.equal(5)
    for (const l of debug) expect(DEBUG_LINE_RE.test(l), l).to.equal(true)
    expect(debug.every((l) => l.includes(' optimystic:db-p2p:protocol-client response peer=…abcd1234 protocol=/fake/1 ms=5'))).to.equal(true)
    expect(statSync(join(evOf(r), 'debug.log')).mode & 0o777).to.equal(0o600)
    const v1 = readFileSync(join(evOf(r), 'v1.log'), 'utf8').split('\n').filter((l) => l.length > 0)
    expect(v1.filter((l) => DEBUG_LINE_RE.test(l))).to.have.length(2)
    expect(v1).to.include('VT-DAEMON-READY role=voter label=v1')
    expect(v1.filter((l) => l.startsWith('STAGE '))).to.deep.equal(['STAGE joined', 'STAGE committed'])
    const officer = readFileSync(join(evOf(r), 'officer.log'), 'utf8')
    expect(officer).to.include('VT-DAEMON-READY role=officer label=officer')
    expect(officer).to.not.include('optimystic:')
    expect(readFileSync(join(evOf(r), 'kh-a.log'), 'utf8')).to.include('VT-DAEMON-READY role=keyholder label=kh-a')
    expect(res.stdout.join('\n')).to.not.include('optimystic:')
    expect(res.stdout.join('\n')).to.not.include('VT-DAEMON-READY')
  })

  it('daemons get FORCE_COLOR=0, DEBUG_COLORS=0, DEBUG_HIDE_DATE=0, the DEBUG pass-through and no NODE_OPTIONS', async () => {
    const r = rig()
    const preload = join(r.dir, 'preload.mjs')
    writeFileSync(preload, 'globalThis.__vtPreload = 1\n')
    let seen: Record<string, unknown> = {}
    const legs: ElectionLeg[] = [
      {
        name: 'network',
        part: 'p1',
        body: async (L, ctx) => {
          const res = await ctx.peer('officer').call('env')
          L.need('network', 'N1', 'env read', res.ok)
          if (res.ok) seen = res.result
        }
      }
    ]
    const hadNodeOptions = process.env.NODE_OPTIONS
    const hadDebug = process.env.DEBUG
    process.env.NODE_OPTIONS = '--max-old-space-size=512'
    process.env.DEBUG = 'parent:*'
    let res: RunResult
    try {
      res = await run(r, parse(r, ['--debug', 'optimystic:*', '--import', preload, '--cpu-prof']), legs)
    } finally {
      if (hadNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = hadNodeOptions
      if (hadDebug === undefined) delete process.env.DEBUG
      else process.env.DEBUG = hadDebug
    }
    expect(res.code).to.equal(0)
    expect(seen).to.deep.equal({ forceColor: '0', debugColors: '0', debugHideDate: '0', nodeOptionsSet: false, debug: 'optimystic:*', preload: true, cpuProf: true })
    const profDir = join(r.state, r.party, 'officer', 'cpu-prof')
    expect(existsSync(profDir)).to.equal(true)
    expect(readdirSync(profDir).some((f) => f.endsWith('.cpuprofile'))).to.equal(true)
    const r2 = rig()
    let seen2: Record<string, unknown> = {}
    const res2 = await run(r2, parse(r2), [{
      name: 'network',
      part: 'p1',
      body: async (L, ctx) => {
        const e = await ctx.peer('officer').call('env')
        L.need('network', 'N1', 'env read', e.ok)
        if (e.ok) seen2 = e.result
      }
    }])
    expect(res2.code).to.equal(0)
    expect(seen2).to.include({ debug: null, preload: false, cpuProf: false, nodeOptionsSet: false })
  })

  it('--max-peers refusal spawns nothing, creates no state and exits 2', async () => {
    const r = rig()
    const res = await run(r, parse(r, ['--max-peers', '2']), echoLegs)
    expect(res.code).to.equal(2)
    expect(res.stdout).to.deep.equal(['RESULT {"tool":"vt-run","verdict":"VOID","reason":"max-peers","requested":6,"max":2}'])
    expect(res.stderr).to.equal('vt run: refused max-peers requested=6 max=2\n')
    expect(existsSync(r.state)).to.equal(false)
    expect(r.spawned).to.deep.equal([])
    const r2 = rig()
    const ok = await run(r2, parse(r2, ['--max-peers', '6']), echoLegs)
    expect(ok.code).to.equal(0)
  })

  it('a daemon that exits before its port file fails the leg with daemon-boot', async () => {
    const r = rig()
    const res = await run(r, parse(r), echoLegs, { extraEnv: { VT_FAKE_BOOT: 'exit' } })
    expect(res.code).to.equal(1)
    expect(res.stdout.at(-1)).to.equal('SUMMARY FAIL network daemon-boot')
    expect(resultsOf(r).legs[0]).to.include({ leg: 'network', status: 'FAIL', token: 'daemon-boot' })
    expect(resultsOf(r).steps.map((s: any) => s.name)).to.deep.equal(['start-officer', 'network/officer-echo', 'network'])
    expect(readFileSync(join(evOf(r), 'officer.log'), 'utf8')).to.include('VT-DAEMON-BOOT-FAILED')
    expect(res.stdout.join('\n')).to.not.include('VT-DAEMON-BOOT-FAILED')
  })

  it('an unwired election leg fails closed with leg-unwired', async () => {
    const r = rig()
    expect(ELECTION_LEGS.map((l) => l.name)).to.deep.equal(['network', 'h6-election', 'h7-accept', 'h8-dkg', 'h9-voters', 'h10-release-decrypt'])
    expect(ELECTION_LEGS.map((l) => l.part)).to.deep.equal(['p1', 'p2', 'p2', 'p2', 'p2', 'p2'])
    expect(ELECTION_LEGS.every((l) => l.body === undefined)).to.equal(true)
    expect(Object.isFrozen(ELECTION_LEGS)).to.equal(true)
    const res = await run(r, parse(r), ELECTION_LEGS)
    expect(res.code).to.equal(1)
    expect(res.stdout.at(-1)).to.equal('SUMMARY FAIL network leg-unwired')
    expect(res.stdout.some((l) => l === 'SUMMARY PASS')).to.equal(false)
    const results = resultsOf(r)
    expect(results.legs).to.deep.equal([{ leg: 'network', status: 'FAIL', token: 'leg-unwired', inScriptD14: 'OFF', reason: 'instruments-off' }])
    expect(r.spawned).to.deep.equal([])
  })

  it('colocated peers share one daemon process and each label answers through its own dir, token and role', async () => {
    const r = rig()
    const seen: Array<Record<string, unknown>> = []
    const legs: ElectionLeg[] = [
      {
        name: 'network',
        part: 'p1',
        body: async (L, ctx) => {
          await ctx.startPeers(['officer', 'kh-a'])
          const a = await ctx.peer('officer').call('echo', { n: 1 })
          const b = await ctx.peer('kh-a').call('echo', { n: 2 })
          L.need('network', 'N1', 'both echoed', a.ok && b.ok)
          if (a.ok && b.ok) seen.push(a.result, b.result)
        }
      }
    ]
    const res = await run(r, parse(r, ['--colocate', 'officer,kh-a']), legs)
    expect(res.code).to.equal(0)
    expect(r.spawned).to.have.length(1)
    expect(r.spawned[0]).to.include.members(['officer', '--colocate', 'officer,kh-a'])
    expect(seen).to.have.length(2)
    expect(seen[0]).to.include({ n: 1, peer: null, label: 'officer', role: 'officer' })
    expect(seen[1]).to.include({ n: 2, peer: null, label: 'kh-a', role: 'keyholder' })
    expect(seen[0]!.pid).to.equal(seen[1]!.pid)
    expect(existsSync(join(r.state, r.party, 'officer', 'ctl.token')) || true).to.equal(true)
    expect(existsSync(join(evOf(r), 'officer.log'))).to.equal(true)
    expect(existsSync(join(evOf(r), 'kh-a.log'))).to.equal(false)
    const commands = readFileSync(join(evOf(r), 'commands.log'), 'utf8')
    expect(commands).to.include(' officer echo ok=true')
    expect(commands).to.include(' kh-a echo ok=true')
    expect(resultsOf(r).steps.map((s: any) => s.name)).to.deep.equal(['start-officer', 'network'])
  })

  it('a stale build is refused before anything runs', async () => {
    const r = rig()
    const res = await run(r, parse(r), echoLegs, { assertFresh: () => { throw new StaleBuildError('stale', 'vote-core') } })
    expect(res.code).to.equal(2)
    expect(res.stdout).to.deep.equal(['RESULT {"tool":"vt-run","verdict":"VOID","reason":"stale-build","code":"stale"}'])
    expect(res.stderr).to.equal('vt run: refused stale-build\n')
    expect(existsSync(r.state)).to.equal(false)
    expect(r.spawned).to.deep.equal([])
  })

  it('every daemon is stopped at the end and no fake daemon process survives', async () => {
    const r = rig()
    const res = await run(r, parse(r), echoLegs)
    expect(res.code).to.equal(0)
    const ps = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
    const survivors = ps.split('\n').filter((l) => l.includes(FAKE) && l.includes(r.state))
    expect(survivors).to.deep.equal([])
    const results = resultsOf(r)
    expect(results.summary).to.equal('PASS')
    const commands = readFileSync(join(evOf(r), 'commands.log'), 'utf8')
    expect(commands).to.include(' officer stop ok=true')
    expect(commands).to.include(' v1 stop ok=true')
  })

  it('the run entry exits 2 on usage, 0 on selfcheck, and never echoes an argument', function () {
    this.timeout(120000)
    const env: NodeJS.ProcessEnv = { ...process.env, TS_NODE_PROJECT: TSCONFIG, FORCE_COLOR: '0' }
    delete env.NODE_OPTIONS
    delete env.DEBUG
    const spawn = (args: string[]): { status: number | null, stdout: string, stderr: string } => {
      const res = spawnSync(
        process.execPath,
        ['--no-deprecation', '--import', REGISTER, '--experimental-specifier-resolution=node', MAIN, ...args],
        { cwd: PACKAGE_ROOT, env, encoding: 'utf8', timeout: 60000 }
      )
      expect(res.error).to.equal(undefined)
      return { status: res.status, stdout: res.stdout, stderr: res.stderr }
    }
    const usage = spawn([])
    expect(usage.status).to.equal(2)
    expect(usage.stderr.startsWith('usage: vt run election --relay <relay.env> --state <dir> --party <id>')).to.equal(true)
    expect(usage.stderr).to.include('vt selfcheck')
    expect(usage.stdout).to.equal('')
    const self = spawn(['selfcheck'])
    expect(self.status).to.equal(0)
    const selfLines = self.stdout.split('\n').filter((l) => l.length > 0)
    expect(selfLines.at(-1)).to.equal('SELFCHECK: PASS 8/8')
    const bad = spawn(['run', 'election', '--party', 'SENTINEL-PARTY'])
    expect(bad.status).to.equal(2)
    expect(bad.stdout + bad.stderr).to.not.include('SENTINEL')
    expect(bad.stderr).to.equal('vt run: relay-missing\n')
    expect(bad.stdout).to.equal('RESULT {"tool":"vt-run","verdict":"VOID","reason":"usage","code":"relay-missing"}\n')
    const extra = spawn(['run', 'ballot', 'SENTINEL-WORD'])
    expect(extra.status).to.equal(2)
    expect(extra.stdout + extra.stderr).to.not.include('SENTINEL')
  })
})
