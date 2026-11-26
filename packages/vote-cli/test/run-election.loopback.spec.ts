import { expect } from 'chai'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { writeApprovalTokenFile } from '../src/approval/token.js'
import { callCtl, type CtlReply } from '../src/ctl/ctl-client.js'
import { assertFreshBuild } from '../src/engine.js'
import { DURATION_KEYS, RESULTS_KEYS } from '../src/run/results.js'
import { readControlLeafReply, writeControlLeafRequest } from '../src/run/instruments/run-instruments.js'
import { REPO_ROOT } from '../src/run/options.js'
import { checkCommandsLogCoverage, parseCommandsLog } from '../src/run/verb-inventory.js'
import { daemonEnv, PACKAGE_ROOT, VT_DIST_BIN } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'

const PRELOAD = join(PACKAGE_ROOT, 'dist', 'run', 'instruments', 'daemon-preload.js')
const NETWORK_NAME = 'vt31 net'
const DEBUG_NAMESPACES = 'optimystic:db-p2p:protocol-client,optimystic:db-p2p:cluster,optimystic:db-core:network-transactor,sereus:cadre:timing,sereus:cadre:relay-reservation,sereus:cadre:peer-dial,sereus:cadre:strand-first-sync'
const ISO_LINE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+ .*$/
const ISO_START_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface ResultsView {
  legs: Array<{ leg: string, status: string }>
  durations: Record<string, unknown>
  steps: Array<{ name: string }>
  secretScan: { whole: number, windows: number, files: number }
  keys: Record<string, string>
}

interface RecordedRun {
  dir: string
  stateDir: string
  exitPath: string
  outPath: string
  code: number | null
}

interface InstrumentDaemon {
  runDir: string
  peerDir: string
  instrDir: string
  ready: boolean
  stop(): Promise<void>
}

function partyOf (prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`
}

function modeOf (path: string): number {
  return statSync(path).mode & 0o777
}

function linesOf (path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
}

function insideRepo (path: string): boolean {
  const repo = realpathSync(REPO_ROOT).replace(/\/$/, '')
  const real = realpathSync(path)
  return real === repo || real.startsWith(repo + '/')
}

function makeRoot (): string {
  const env = process.env.VT_RUN31_ROOT
  const root = env !== undefined && env.length > 0 ? env : mkdtempSync(join(tmpdir(), 'vt-31-'))
  if (!isAbsolute(root)) throw new Error('VT_RUN31_ROOT must be absolute')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  if (insideRepo(root)) throw new Error('run root must be outside the repo')
  return root
}

async function recordElection (root: string, relay: LoopbackRelay, name: string, party: string, extra: readonly string[]): Promise<RecordedRun> {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stateDir = join(dir, 'state')
  const exitPath = join(dir, 'run.exit')
  const outPath = join(dir, 'run.out')
  const errPath = join(dir, 'run.err')
  const marksPath = join(dir, 'marks.txt')
  const outFd = openSync(outPath, 'w', 0o600)
  const errFd = openSync(errPath, 'w', 0o600)
  const sink = (fd: number) => (chunk: Buffer): void => {
    try { writeSync(fd, chunk) } catch {}
  }
  const child = spawn(
    process.execPath,
    [VT_DIST_BIN, 'run', 'election', '--relay', relay.relayEnvPath, '--state', stateDir, '--party', party, '--marks-file', marksPath, ...extra],
    { env: daemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout?.on('data', sink(outFd))
  child.stderr?.on('data', sink(errFd))
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_500_000)
  const code = await new Promise<number | null>((resolveCode) => {
    child.once('close', (c) => { resolveCode(c) })
    child.once('error', () => { resolveCode(null) })
  })
  clearTimeout(timer)
  try { closeSync(outFd) } catch {}
  try { closeSync(errFd) } catch {}
  writeFileSync(exitPath, String(code) + '\n', { mode: 0o600, flag: 'wx' })
  return { dir, stateDir, exitPath, outPath, code }
}

function expectCtl (reply: CtlReply, what: string): void {
  expect(reply.status, `${what} status`).to.equal(200)
  expect(Object.keys(reply.body), `${what} shape`).to.deep.equal(['ok', 'result', 'ms'])
  expect(reply.body.ok, `${what} ok`).to.equal(true)
  expect(reply.body.result, `${what} result`).to.be.an('object')
  expect(Number.isInteger(reply.body.ms), `${what} ms`).to.equal(true)
}

async function expectProbe (dir: string): Promise<void> {
  interface ProbeView { installed: boolean, calls: number }
  const read = (): ProbeView => {
    try {
      const p = JSON.parse(readFileSync(join(dir, 'size-probe.json'), 'utf8')) as Partial<ProbeView>
      return { installed: p.installed === true, calls: typeof p.calls === 'number' ? p.calls : 0 }
    } catch {
      return { installed: false, calls: 0 }
    }
  }
  const deadline = Date.now() + 60_000
  let probe = read()
  while (!(probe.installed && probe.calls > 0) && Date.now() < deadline) {
    await sleep(500)
    probe = read()
  }
  expect(probe.installed, 'size-probe installed').to.equal(true)
  expect(probe.calls, 'size-probe calls').to.be.greaterThan(0)
}

async function startInstrumentedOfficer (root: string, relay: LoopbackRelay, party: string): Promise<InstrumentDaemon> {
  const runDir = join(root, `instruments-${party}`)
  const peerDir = join(runDir, 'state', party, 'officer')
  const instrDir = join(peerDir, 'instruments')
  const logDir = join(runDir, 'logs')
  const secretsDir = join(runDir, 'secrets')
  mkdirSync(peerDir, { recursive: true, mode: 0o700 })
  mkdirSync(instrDir, { recursive: true, mode: 0o700 })
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
  const outFd = openSync(join(logDir, 'officer.out.log'), 'w', 0o600)
  const errFd = openSync(join(logDir, 'officer.err.log'), 'w', 0o600)
  const env = daemonEnv()
  env.VT_INSTR_DIR = instrDir
  const child = spawn('nice', [
    '-n', '10', process.execPath, '--import', PRELOAD, VT_DIST_BIN,
    'officer', 'start', '--state', peerDir, '--relay', relay.relayEnvPath, '--party', party
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false
  let stdout = ''
  const closeFds = (): void => {
    try { closeSync(outFd) } catch {}
    try { closeSync(errFd) } catch {}
  }
  const closed = new Promise<number | null>((resolveExit) => {
    child.once('close', (code) => { exited = true; closeFds(); resolveExit(code) })
    child.once('error', () => { exited = true; closeFds(); resolveExit(null) })
  })
  const sink = (fd: number) => (chunk: Buffer): void => {
    try { writeSync(fd, chunk) } catch {}
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    sink(outFd)(chunk)
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', sink(errFd))
  const waitExit = async (ms: number): Promise<number | null> => {
    const deadline = Date.now() + ms
    while (!exited && Date.now() < deadline) await sleep(100)
    return exited ? await closed : null
  }
  const deadline = Date.now() + 300_000
  let ready = false
  for (;;) {
    if (existsSync(join(peerDir, 'ctl.port'))) { ready = true; break }
    if (/^VT-DAEMON-BOOT-FAILED /m.test(stdout) || exited || Date.now() > deadline) break
    await sleep(100)
  }
  const stop = async (): Promise<void> => {
    if (exited) return
    await callCtl({ dir: peerDir, role: 'officer', verb: 'stop', args: {}, timeoutMs: 10_000 })
    if ((await waitExit(15_000)) !== null || exited) return
    child.kill('SIGTERM')
    if ((await waitExit(10_000)) !== null || exited) return
    child.kill('SIGKILL')
    await closed
  }
  return { runDir, peerDir, instrDir, ready, stop }
}

function expectPassRun (run: RecordedRun): ResultsView {
  expect(run.code, 'run exit code').to.equal(0)
  expect(readFileSync(run.exitPath, 'utf8').trim(), 'run.exit').to.equal('0')
  const outLines = linesOf(run.outPath)
  expect(outLines.at(-1), 'last run.out line').to.equal('SUMMARY PASS')
  const marks = outLines.filter((l) => l.startsWith('RUN-MARK '))
  const marksInFile = linesOf(join(run.dir, 'marks.txt')).filter((l) => l.startsWith('RUN-MARK '))
  expect(marks, 'RUN-MARK count').to.have.length(4)
  expect(marksInFile, 'marks.txt').to.deep.equal(marks)
  const resultsPath = join(run.stateDir, 'ev', 'results.json')
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as ResultsView
  expect(Object.keys(results), 'results.json keys').to.deep.equal([...RESULTS_KEYS])
  expect(modeOf(resultsPath), 'results.json mode').to.equal(0o600)
  expect(results.legs, 'leg count').to.have.length(6)
  for (const [i, leg] of results.legs.entries()) expect(leg.status, `leg ${i}`).to.equal('PASS')
  expect(Object.keys(results.durations), 'durations keys').to.deep.equal([...DURATION_KEYS])
  const stepNames = results.steps.map((s) => s.name)
  for (const name of ['h9-voters-active', 'release', 'tally', 'approve3-publish']) {
    expect(stepNames, `step ${name}`).to.include(name)
  }
  expect(results.secretScan.whole, 'secretScan whole').to.equal(0)
  expect(results.secretScan.windows, 'secretScan windows').to.equal(0)
  expect(results.secretScan.files, 'secretScan files').to.be.greaterThan(0)
  const identityNames = Object.keys(results.keys).filter((k) => k.startsWith('RESULTS-') && k !== 'RESULTS-IDENTICAL')
  expect(identityNames, 'RESULTS peer keys').to.have.length(6)
  const tags = identityNames.map((k) => /tag=([a-z0-9]+)/.exec(results.keys[k] ?? '')?.[1])
  expect(new Set(tags).size, 'RESULTS tag').to.equal(1)
  expect(results.keys['RESULTS-IDENTICAL'] ?? '', 'RESULTS-IDENTICAL').to.match(/equal=true$/)
  const coverage = checkCommandsLogCoverage(parseCommandsLog(readFileSync(join(run.stateDir, 'ev', 'commands.log'), 'utf8')))
  expect(coverage.missing, 'commands missing').to.deep.equal([])
  expect(coverage.unexpectedOk, 'commands unexpectedOk').to.deep.equal([])
  for (const label of ['v1', 'v2', 'v3']) {
    const text = readFileSync(join(run.stateDir, 'ev', `${label}.log`), 'utf8')
    expect(text, `${label} committed`).to.include('STAGE committed')
    expect(text, `${label} results-read`).to.include('STAGE results-read')
  }
  return results
}

describe('run: election on the loopback relay', function () {
  this.timeout(10_800_000)
  let root = ''
  let relay: LoopbackRelay | undefined

  before(async function () {
    if (!hostTierEnabled()) this.skip()
    this.timeout(600_000)
    assertFreshBuild()
    root = makeRoot()
    relay = await startLoopbackRelay()
  })

  after(async function () {
    this.timeout(60_000)
    if (relay !== undefined) await relay.stop()
  })

  it('instruments smoke: an officer daemon with the preload records cluster sends and a readable control leaf after found', async () => {
    const party = partyOf('vt31i')
    const daemon = await startInstrumentedOfficer(root, relay!, party)
    try {
      expect(daemon.ready, 'officer boot').to.equal(true)
      const before = await callCtl({ dir: daemon.peerDir, role: 'officer', verb: 'readback', args: {}, timeoutMs: 30_000 })
      expectCtl(before, 'readback before')
      writeApprovalTokenFile(join(daemon.runDir, 'secrets', 'officer.token'))
      const found = await callCtl({
        dir: daemon.peerDir,
        role: 'officer',
        verb: 'found',
        args: { name: NETWORK_NAME, tokenFile: join(daemon.runDir, 'secrets', 'officer.token') },
        timeoutMs: 600_000
      })
      expectCtl(found, 'found')
      const after = await callCtl({ dir: daemon.peerDir, role: 'officer', verb: 'readback', args: {}, timeoutMs: 30_000 })
      expectCtl(after, 'readback after')
      const peerId8 = String((after.body.result ?? {}).peerId8 ?? '')
      expect(peerId8, 'readback peerId8').to.match(/^[A-Za-z0-9_-]{8}$/)
      writeControlLeafRequest(daemon.instrDir, 1, peerId8)
      const reply = await readControlLeafReply({ dir: daemon.instrDir, seq: 1, peerId8, timeoutMs: 30_000 })
      expect(reply.read, 'control leaf').to.not.have.property('unreadable')
      expect(Number.isInteger((reply.read as { leafRev?: unknown }).leafRev), 'leafRev integer').to.equal(true)
      expect(Number.isInteger((reply.read as { tailRev?: unknown }).tailRev), 'tailRev integer').to.equal(true)
      await expectProbe(daemon.instrDir)
    } finally {
      await daemon.stop()
    }
    await expectProbe(daemon.instrDir)
  })

  it('vt run election passes with one daemon per role: SUMMARY PASS, exit 0, results.json, identical results, clean scan', async () => {
    // 67-28-SUMMARY calls the 90/60 s timeline usable for a KEYHOLDER-ONLY flow but says a run that
    // also drives voters (h9) must re-measure, so this election keeps the committed default 600000/480000.
    const party = partyOf('vt31a')
    const run = await recordElection(root, relay!, `election-a-${party}`, party, [])
    expectPassRun(run)
  })

  it('vt run election passes with --colocate officer,kh-a,kh-b', async () => {
    const party = partyOf('vt31b')
    const run = await recordElection(root, relay!, `election-b-${party}`, party, ['--colocate', 'officer,kh-a,kh-b', '--debug', DEBUG_NAMESPACES])
    expectPassRun(run)
    const debugText = readFileSync(join(run.stateDir, 'ev', 'debug.log'), 'utf8')
    const debugLines = debugText.split('\n').filter((l) => l.length > 0)
    for (const line of debugLines) {
      if (ISO_START_RE.test(line)) expect(line, 'debug line').to.match(ISO_LINE_RE)
    }
    expect(debugText, 'protocol-client debug line').to.include('optimystic:db-p2p:protocol-client')
    const commands = parseCommandsLog(readFileSync(join(run.stateDir, 'ev', 'commands.log'), 'utf8'))
    const pids = new Set<unknown>()
    for (const label of ['officer', 'kh-a', 'kh-b']) {
      expect(commands.some((l) => l.label === label && l.verb === 'readback' && l.ok), `${label} readback reply`).to.equal(true)
      const peerDir = join(run.stateDir, party, label)
      const daemon = JSON.parse(readFileSync(join(peerDir, 'daemon.json'), 'utf8')) as { pid?: unknown }
      expect(typeof daemon.pid, `${label} daemon pid`).to.equal('number')
      pids.add(daemon.pid)
    }
    expect(pids.size, 'one colocated pid').to.equal(1)
  })

  it('no vt daemon survives the runs', () => {
    const ps = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
    const rows = ps.split('\n').filter((line) => line.includes(`--state ${root}`))
    expect(rows, 'surviving vt daemons').to.deep.equal([])
  })
})
