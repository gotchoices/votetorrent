// cli-05-concurrency.spec.ts: CLI-05, two reduced `vt run election` processes on ONE loopback relay.
//  - `cli-05 leg set (offline)` (7, ungated): the frozen reduced leg-set contract against synthetic views.
//  - `cli-05 concurrency on the loopback relay` (14, gated on VT_HOST_TIER=1 AND VT_CLI05=1): the live
//    proof of overlap, isolation, secret scans, live max-peers refusals, relay limits and RSS cap.
// No chai assertion takes a secret, token, multiaddr, full peer id or file content as an argument.

import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { hostTierEnabled } from './support/host-tier.js'
import {
  CLI05_LEAD_MS,
  CLI05_WINDOW_MS,
  cli05Enabled,
  cli05OverBudgetVoters,
  collectRunSecrets,
  ctlStatus,
  firstSecretFile,
  positiveControl,
  postRunRelease,
  quietHostCheck,
  readRelayLog,
  runLogFiles,
  runRefusal,
  scanFiles,
  startElectionRun,
  startRunMonitor,
  survivorCount,
  writeCli05Report,
  type ElectionRunHandle,
  type MonitorReport,
  type RelayLogView,
  type RefusalResult
} from './support/cli05-harness.js'
import {
  HARD_STOP_TOKENS,
  POOL_TOKENS,
  REDUCED_TOPOLOGY,
  RELEASE_STEP_NAMES,
  REQUIRED_PASS_LEGS,
  REQUIRED_VOTER_STAGES,
  evaluateReducedLegSet,
  type ReducedLegSetVerdict
} from './support/cli05-legset.js'
import { defaultMaxPeers } from '../src/run/peer-budget.js'
import { SecretRegistry } from '../src/run/secret-scan.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'
import { VT_DIST_BIN } from './support/daemon-fixture.js'

const PARTY_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
const SUMMARY_RE = /^SUMMARY (PASS|FAIL \S+ \S+)$/
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function sha256File (path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function syntheticLegs (overrides: Record<string, { status: string, token: string }> = {}): Array<{ leg: string, status: string, token: string }> {
  const names = ['network', 'h6-election', 'h7-accept', 'h8-dkg', 'h9-voters', 'h10-release-decrypt']
  return names.map((leg) => ({ leg, status: 'PASS', token: '', ...(overrides[leg] ?? {}) }))
}

const ALL_STAGES = [...REQUIRED_VOTER_STAGES].map((name) => `STAGE ${name}`).join('\n') + '\n'
const RELEASE_STEPS = [{ name: 'release', startMs: 100, endMs: 200 }]
const CLEAN_SCAN = { whole: 0, windows: 0, files: 4 }

describe('cli-05 leg set (offline)', () => {
  it('REQUIRED_PASS_LEGS is network, h6-election, h7-accept, h8-dkg and the topology is 2 keyholders and 1 voter', () => {
    expect([...REQUIRED_PASS_LEGS]).to.deep.equal(['network', 'h6-election', 'h7-accept', 'h8-dkg'])
    expect(REDUCED_TOPOLOGY.keyholders).to.equal(2)
    expect(REDUCED_TOPOLOGY.voters).to.equal(1)
    expect(REDUCED_TOPOLOGY.peers).to.equal(4)
    expect([...REDUCED_TOPOLOGY.labels]).to.deep.equal(['officer', 'kh-a', 'kh-b', 'v1'])
    expect([...REQUIRED_VOTER_STAGES]).to.deep.include('associated')
    expect(RELEASE_STEP_NAMES['kh-a']).to.equal(RELEASE_STEP_NAMES['kh-b'])
    expect(POOL_TOKENS).to.include('hv-commit')
    expect(HARD_STOP_TOKENS).to.include('secret-leak')
  })

  it('a run that passes the four legs, reaches associated and stops at h9-voters on a pool token passes with a post-run release', () => {
    const verdict = evaluateReducedLegSet({
      results: {
        summary: 'FAIL h9-voters hv-commit',
        legs: syntheticLegs({ 'h9-voters': { status: 'FAIL', token: 'hv-commit' } }).filter((l) => l.leg !== 'h10-release-decrypt'),
        steps: [],
        secretScan: CLEAN_SCAN
      },
      voterLog: ALL_STAGES,
      postRelease: { ran: true, khA: { ok: true }, khB: { ok: true } }
    })
    expect(verdict.failures).to.deep.equal([])
    expect(verdict.ok).to.equal(true)
    expect(verdict.reached.stopLeg).to.equal('h9-voters')
    expect(verdict.reached.stopToken).to.equal('hv-commit')
    expect(verdict.reached.releasePath).to.equal('post-run')
  })

  it('a run that passes every leg with an in-run release step per keyholder passes', () => {
    const verdict = evaluateReducedLegSet({
      results: { summary: 'PASS', legs: syntheticLegs(), steps: RELEASE_STEPS, secretScan: CLEAN_SCAN },
      voterLog: ALL_STAGES
    })
    expect(verdict.ok).to.equal(true)
    expect(verdict.failures).to.deep.equal([])
    expect(verdict.reached.releasePath).to.equal('in-run')
    expect(verdict.reached.stopLeg).to.equal(null)
  })

  it('a FAIL before h8-dkg fails the leg set and names the leg', () => {
    const verdict = evaluateReducedLegSet({
      results: {
        summary: 'FAIL h7-accept accept',
        legs: syntheticLegs({ 'h7-accept': { status: 'FAIL', token: 'accept' } }),
        steps: RELEASE_STEPS,
        secretScan: CLEAN_SCAN
      },
      voterLog: ALL_STAGES
    })
    expect(verdict.ok).to.equal(false)
    expect(verdict.failures.join(',')).to.include('leg:h7-accept')
  })

  it('a voter log without STAGE associated fails the leg set', () => {
    const short = [...REQUIRED_VOTER_STAGES].filter((s) => s !== 'associated').map((s) => `STAGE ${s}`).join('\n') + '\n'
    const verdict = evaluateReducedLegSet({
      results: { summary: 'PASS', legs: syntheticLegs(), steps: RELEASE_STEPS, secretScan: CLEAN_SCAN },
      voterLog: short
    })
    expect(verdict.ok).to.equal(false)
    expect(verdict.failures.join(',')).to.include('stage:associated')
  })

  it('an h9-voters FAIL on a token outside POOL_TOKENS fails the leg set', () => {
    const verdict = evaluateReducedLegSet({
      results: {
        summary: 'FAIL h9-voters hv-joined',
        legs: syntheticLegs({ 'h9-voters': { status: 'FAIL', token: 'hv-joined' } }),
        steps: RELEASE_STEPS,
        secretScan: CLEAN_SCAN
      },
      voterLog: ALL_STAGES
    })
    expect(verdict.ok).to.equal(false)
    expect(verdict.failures.join(',')).to.include('token:hv-joined')
  })

  it('a hard-stop token or a non-zero secret scan fails the leg set, and key release counts only from a passed release', () => {
    const base = { summary: 'PASS', legs: syntheticLegs(), steps: RELEASE_STEPS, secretScan: CLEAN_SCAN }
    const hard = evaluateReducedLegSet({
      results: { ...base, legs: syntheticLegs({ network: { status: 'FAIL', token: 'secret-leak' } }) },
      voterLog: ALL_STAGES
    })
    expect(hard.ok).to.equal(false)
    expect(hard.failures.join(',')).to.include('token:secret-leak')
    const scanned = evaluateReducedLegSet({
      results: { ...base, secretScan: { whole: 1, windows: 0, files: 4 } },
      voterLog: ALL_STAGES
    })
    expect(scanned.failures).to.include('secret-scan')
    const noRelease = evaluateReducedLegSet({ results: { ...base, steps: [] }, voterLog: ALL_STAGES })
    expect(noRelease.failures).to.include('key-release')
    const failedRelease = evaluateReducedLegSet({
      results: { ...base, steps: [{ name: 'release', startMs: 100, endMs: 200, ok: false }] },
      voterLog: ALL_STAGES,
      postRelease: { ran: true, khA: { ok: false }, khB: { ok: true } }
    })
    expect(failedRelease.failures).to.include('key-release')
  })
})

interface ResultsView {
  summary: string
  legs: Array<{ leg: string, status: string, token: string }>
  durations: Record<string, number>
  steps: Array<{ name: string, startMs: number, endMs: number }>
  secretScan: { whole: number, windows: number, files: number }
  keys: Record<string, string>
  startedAt: string
  endedAt: string
}

interface RunView {
  tag: 'a' | 'b'
  party: string
  stateDir: string
  startedAtMs: number
  endedAtMs: number
  code: number | null
  signal: string | null
  summaryLine: string
  results: ResultsView
  legSet: ReducedLegSetVerdict
  voterStages: string[]
  registeredSecrets: number
  logFiles: number
  resultsHashBefore: string
  resultsHashAfter: string
}

interface ScanView {
  whole: number
  windows: number
  files: number
}

interface StateUsedView {
  code: number | null
  stderrLine: string
  verdict: string
  reason: string
  identical: boolean
}

interface Cli05Report {
  root: string
  stamp: string
  parties: { a: string, b: string, r: string }
  hostLoadavg: number[]
  overBudgetVoters: number
  runs: Record<'a' | 'b', RunView>
  monitor: MonitorReport
  crossTokenStatus: number
  ownTokenStatus: number
  scans: {
    ownA: ScanView
    ownB: ScanView
    crossAB: ScanView
    crossBA: ScanView
    union: ScanView
    positiveControl: ScanView
    filesRegisteredA: number
    filesRegisteredB: number
  }
  partyCross: { aMentionsB: number, bMentionsA: number }
  refusals: { max3: RefusalResult, default: RefusalResult, stateUsed: StateUsedView }
  relay: RelayLogView
  survivors: number
  reportPath: string
  reportMode: number
}

function readView (path: string): ResultsView {
  return JSON.parse(readFileSync(path, 'utf8')) as ResultsView
}

function lastLine (path: string): string {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0).at(-1) ?? ''
}

function countFilesWith (files: string[], needle: string): number {
  let n = 0
  for (const f of files) if (readFileSync(f, 'utf8').includes(needle)) n++
  return n
}

function parseIds (keys: Record<string, string>, stateDir: string) {
  const network = /^networkHash=(\S+)$/.exec(keys['HANDOFF-NETWORK'] ?? '')?.[1] ?? ''
  const election = /^electionId=(\S+)$/.exec(keys['HANDOFF-ELECTION'] ?? '')?.[1] ?? ''
  const tokenText = keys['HANDOFF-TOKEN-FILES'] ?? ''
  const khAFiles = /kh-a=(\S+)/.exec(tokenText)?.[1] ?? ''
  const khBFiles = /kh-b=(\S+)/.exec(tokenText)?.[1] ?? ''
  const releasing = /releasingKeysAt=(\S+)/.exec(keys['ELECTION'] ?? '')?.[1]
  const releasingKeysAtMs = releasing === undefined ? undefined : Date.parse(releasing)
  return {
    network,
    election,
    tokenFiles: { 'kh-a': join(stateDir, khAFiles), 'kh-b': join(stateDir, khBFiles) },
    ...(releasingKeysAtMs !== undefined && Number.isFinite(releasingKeysAtMs) ? { releasingKeysAtMs } : {})
  }
}

describe('cli-05 concurrency on the loopback relay', function () {
  this.timeout(5400000)
  let report: Cli05Report

  before(async function () {
    this.timeout(1_500_000)
    if (!hostTierEnabled() || !cli05Enabled()) this.skip()
    const host = await quietHostCheck()
    if (!host.quiet) throw new Error(`host-not-quiet: ${host.reasons.join(',')}`)

    let relay: LoopbackRelay | undefined
    let liveRuns: ElectionRunHandle[] = []
    let monitor: ReturnType<typeof startRunMonitor> | undefined
    let finished = false
    const root = mkdtempSync(join(tmpdir(), 'vt-cli05-'))
    chmodSync(root, 0o700)
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const partyA = `vt-cli05-a-${stamp}`
      const partyB = `vt-cli05-b-${stamp}`
      const partyR = `vt-cli05-r-${stamp}`
      for (const party of [partyA, partyB, partyR]) {
        if (!PARTY_RE.test(party)) throw new Error(`party-shape: ${party.length}`)
        if (party === 'votetorrent') throw new Error('party-production')
      }
      relay = await startLoopbackRelay()
      const runA = startElectionRun({ tag: 'a', root, party: partyA, relayEnvPath: relay.relayEnvPath, leadMs: CLI05_LEAD_MS, windowMs: CLI05_WINDOW_MS })
      const runB = startElectionRun({ tag: 'b', root, party: partyB, relayEnvPath: relay.relayEnvPath, leadMs: CLI05_LEAD_MS, windowMs: CLI05_WINDOW_MS })
      liveRuns = [runA, runB]
      monitor = startRunMonitor({
        runs: [
          { tag: 'a', party: partyA, stateDir: runA.stateDir, pid: runA.pid },
          { tag: 'b', party: partyB, stateDir: runB.stateDir, pid: runB.pid }
        ],
        relayDir: relay.dir,
        onCapExceeded: () => {
          for (const r of liveRuns) {
            try { process.kill(r.pid, 'SIGINT') } catch { /* already gone */ }
          }
        }
      })

      const deadline = Date.now() + 20 * 60_000
      while (Date.now() < deadline) {
        const labels = ['officer', 'kh-a', 'kh-b', 'v1']
        const n = labels.filter((l) => existsSync(join(root, 'a', partyA, l, 'daemon.json'))).length +
          labels.filter((l) => existsSync(join(root, 'b', partyB, l, 'daemon.json'))).length
        if (n >= 8) break
        await sleep(5000)
      }
      const officerDirA = join(root, 'a', partyA, 'officer')
      const officerDirB = join(root, 'b', partyB, 'officer')
      const ctlDeadline = Date.now() + 90_000
      while (Date.now() < ctlDeadline) {
        const ready = [officerDirA, officerDirB].every((d) => existsSync(join(d, 'ctl.port')) && existsSync(join(d, 'ctl.token')))
        if (ready) break
        await sleep(1000)
      }
      const crossTokenStatus = await ctlStatus(officerDirA, officerDirB)
      const ownTokenStatus = await ctlStatus(officerDirA, officerDirA)
      const max3 = runRefusal({ tag: 'refuse-max3', root, party: partyR, relayEnvPath: relay.relayEnvPath, maxPeers: 3, voters: 1 })
      const overBudgetVoters = cli05OverBudgetVoters()
      const defaultRefusal = runRefusal({ tag: 'refuse-default', root, party: partyR, relayEnvPath: relay.relayEnvPath, voters: overBudgetVoters })

      const [doneA, doneB] = await Promise.all([runA.done, runB.done])
      finished = true
      const tokenRegistrar = monitor
      const monitorReport = tokenRegistrar?.stop() ?? {
        samples: 0,
        peers: {},
        peakRunRssBytes: {},
        peakTotalRssBytes: 0,
        peakCpuPct: 0,
        capBytes: 0.45 * totalmem(),
        capExceededTicks: 0
      }
      monitor = undefined

      const makeRun = (handle: ElectionRunHandle, done: { code: number | null, signal: NodeJS.Signals | null, endedAtMs: number }, tag: 'a' | 'b', party: string): RunView => {
        const results = readView(join(handle.stateDir, 'ev', 'results.json'))
        const voterLog = readFileSync(join(handle.stateDir, 'ev', 'v1.log'), 'utf8')
        return {
          tag,
          party,
          stateDir: handle.stateDir,
          startedAtMs: handle.startedAtMs,
          endedAtMs: done.endedAtMs,
          code: done.code,
          signal: done.signal,
          summaryLine: lastLine(handle.stdoutPath),
          results,
          legSet: { ok: false, failures: [], reached: { passLegs: [], voterStages: [], stopLeg: null, stopToken: null, releasePath: 'none' } },
          voterStages: [],
          registeredSecrets: 0,
          logFiles: 0,
          resultsHashBefore: '',
          resultsHashAfter: ''
        }
      }
      const viewA = makeRun(runA, doneA, 'a', partyA)
      const viewB = makeRun(runB, doneB, 'b', partyB)
      const logsA = runLogFiles(viewA.stateDir, partyA)
      const logsB = runLogFiles(viewB.stateDir, partyB)
      viewA.logFiles = logsA.length
      viewB.logFiles = logsB.length

      const relayEnvPath = relay.relayEnvPath
      const evaluateWithFallback = async (view: RunView, party: string): Promise<ReducedLegSetVerdict> => {
        const voterLog = readFileSync(join(view.stateDir, 'ev', 'v1.log'), 'utf8')
        let verdict = evaluateReducedLegSet({ results: view.results, voterLog })
        if (verdict.reached.releasePath !== 'none') return verdict
        const ids = parseIds(view.results.keys, view.stateDir)
        if (ids.network.length === 0 || ids.election.length === 0) return verdict
        const released = await postRunRelease({
          stateDir: view.stateDir,
          party,
          relayEnvPath,
          ids,
          logDir: join(root, `post-release-${view.tag}`)
        })
        return evaluateReducedLegSet({ results: view.results, voterLog, postRelease: released })
      }
      const verdictA = await evaluateWithFallback(viewA, partyA)
      const verdictB = await evaluateWithFallback(viewB, partyB)
      viewA.legSet = verdictA
      viewB.legSet = verdictB
      viewA.voterStages = verdictA.reached.voterStages
      viewB.voterStages = verdictB.reached.voterStages

      const regA = new SecretRegistry()
      const regB = new SecretRegistry()
      const regU = new SecretRegistry()
      const registeredA = collectRunSecrets(viewA.stateDir, partyA, regA)
      const registeredB = collectRunSecrets(viewB.stateDir, partyB, regB)
      collectRunSecrets(viewA.stateDir, partyA, regU)
      collectRunSecrets(viewB.stateDir, partyB, regU)
      const liveTokensA = tokenRegistrar?.registerLiveTokens(regA, 'a') ?? 0
      const liveTokensB = tokenRegistrar?.registerLiveTokens(regB, 'b') ?? 0
      tokenRegistrar?.registerLiveTokens(regU, 'a')
      tokenRegistrar?.registerLiveTokens(regU, 'b')
      viewA.registeredSecrets = registeredA + liveTokensA
      viewB.registeredSecrets = registeredB + liveTokensB
      const control = positiveControl(firstSecretFile(viewA.stateDir), join(root, 'control'), regA)
      const crossAB = scanFiles(regA, [...logsB, runB.stderrPath, runB.stdoutPath])
      const crossBA = scanFiles(regB, [...logsA, runA.stderrPath, runA.stdoutPath])
      const union = scanFiles(regU, [
        ...logsA, ...logsB,
        runA.stdoutPath, runA.stderrPath, runB.stdoutPath, runB.stderrPath,
        relay.logPath,
        join(root, 'refusal-refuse-max3.out'),
        join(root, 'refusal-refuse-default.out')
      ])

      const resultsPathA = join(viewA.stateDir, 'ev', 'results.json')
      viewA.resultsHashBefore = sha256File(resultsPathA)
      const reuse = spawnSync('nice', [
        '-n', '10', process.execPath, VT_DIST_BIN,
        'run', 'election',
        '--relay', relay.relayEnvPath,
        '--state', viewA.stateDir,
        '--party', partyB,
        '--keyholders', '2',
        '--voters', '1',
        '--alarm-s', '4800'
      ], { env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 30_000 })
      viewA.resultsHashAfter = sha256File(resultsPathA)
      const reuseText = (reuse.stdout ?? '') + '\n' + (reuse.stderr ?? '')
      const reuseResult = /RESULT (\{.*\})/.exec(reuseText)?.[1]
      const parsedReuse: Record<string, unknown> = reuseResult === undefined ? {} : JSON.parse(reuseResult) as Record<string, unknown>
      const stateUsed: StateUsedView = {
        code: typeof reuse.status === 'number' ? reuse.status : null,
        stderrLine: reuseText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('vt run: ')).at(-1) ?? '',
        verdict: typeof parsedReuse.verdict === 'string' ? parsedReuse.verdict : '',
        reason: typeof parsedReuse.reason === 'string' ? parsedReuse.reason : '',
        identical: viewA.resultsHashBefore === viewA.resultsHashAfter
      }

      await relay.stop()
      const relayLog = readRelayLog(relay.logPath)
      const survivors = survivorCount([root, relay.dir])
      const reportPath = join(root, 'cli05-report.json')
      report = {
        root,
        stamp,
        parties: { a: partyA, b: partyB, r: partyR },
        hostLoadavg: host.loadavg,
        overBudgetVoters,
        runs: { a: viewA, b: viewB },
        monitor: monitorReport,
        crossTokenStatus,
        ownTokenStatus,
        scans: {
          ownA: viewA.results.secretScan,
          ownB: viewB.results.secretScan,
          crossAB,
          crossBA,
          union,
          positiveControl: control,
          filesRegisteredA: registeredA,
          filesRegisteredB: registeredB
        },
        partyCross: {
          aMentionsB: countFilesWith(logsA, partyB),
          bMentionsA: countFilesWith(logsB, partyA)
        },
        refusals: { max3, default: defaultRefusal, stateUsed },
        relay: relayLog,
        survivors,
        reportPath,
        reportMode: 0o600
      }
      writeCli05Report(reportPath, report)
      process.stdout.write(`CLI05-REPORT ${reportPath}\n`)
    } finally {
      if (monitor !== undefined) monitor.stop()
      if (!finished) {
        for (const r of liveRuns) {
          try { process.kill(r.pid, 'SIGINT') } catch { /* already gone */ }
        }
      }
      if (relay !== undefined) await relay.stop()
    }
  })

  it('both reduced elections reach the CLI-05 leg set', () => {
    const a = report.runs.a.legSet
    const b = report.runs.b.legSet
    expect(a.ok, `A ${a.failures.join(',')}`).to.equal(true)
    expect(b.ok, `B ${b.failures.join(',')}`).to.equal(true)
  })

  it('the two runs overlap in time and each ends with its own SUMMARY line and exit code', () => {
    const a = report.runs.a
    const b = report.runs.b
    expect(Math.max(a.startedAtMs, b.startedAtMs) < Math.min(a.endedAtMs, b.endedAtMs), 'overlap').to.equal(true)
    for (const view of [a, b]) {
      expect(SUMMARY_RE.test(view.summaryLine), `${view.tag} SUMMARY shape`).to.equal(true)
      const expected = view.summaryLine === 'SUMMARY PASS' ? 0 : 1
      expect(view.code, `${view.tag} exit code`).to.equal(expected)
      expect(['h9-voters', 'h10-release-decrypt'].includes(view.legSet.reached.stopLeg ?? ''), `${view.tag} stop leg`).to.equal(view.summaryLine !== 'SUMMARY PASS')
    }
  })

  it('party ids, state roots, peer dirs, daemon pids and peer ids are distinct across the runs', () => {
    const a = report.runs.a
    const b = report.runs.b
    const labels = [...REDUCED_TOPOLOGY.labels]
    expect(Object.keys(report.monitor.peers['a'] ?? {}).length, 'A peer dirs').to.equal(labels.length)
    expect(Object.keys(report.monitor.peers['b'] ?? {}).length, 'B peer dirs').to.equal(labels.length)
    const pids: number[] = []
    const peerIds: string[] = []
    for (const tag of ['a', 'b'] as const) {
      for (const label of labels) {
        const peer = report.monitor.peers[tag]?.[label]
        expect(peer === undefined, `${tag}/${label} observed`).to.equal(false)
        expect(peer?.partyIds, `${tag}/${label} party id`).to.deep.equal([report.parties[tag]])
        pids.push(peer?.pids[0] ?? -1)
        peerIds.push(peer?.peerId8s[0] ?? '')
      }
    }
    expect(new Set(pids).size, 'distinct pids').to.equal(8)
    expect(new Set(peerIds).size, 'distinct peerId8').to.equal(8)
    const rootA = realpathSync(a.stateDir)
    const rootB = realpathSync(b.stateDir)
    expect(rootA.startsWith(rootB), 'A under B').to.equal(false)
    expect(rootB.startsWith(rootA), 'B under A').to.equal(false)
  })

  it("every peer had its own ctl port and token, and run B's officer token is refused by run A's officer", () => {
    const ports: number[] = []
    const digests: string[] = []
    for (const tag of ['a', 'b'] as const) {
      for (const label of REDUCED_TOPOLOGY.labels) {
        const peer = report.monitor.peers[tag]?.[label]
        ports.push(peer?.ports[0] ?? -1)
        digests.push(peer?.tokenDigests[0] ?? '')
      }
    }
    expect(new Set(ports).size, 'distinct ports').to.equal(8)
    expect(new Set(digests).size, 'distinct token digests').to.equal(8)
    expect(report.crossTokenStatus, 'cross-token status').to.equal(401)
    expect(report.ownTokenStatus === 401, 'own-token control').to.equal(false)
  })

  it("no log of either run names the other run's party id", () => {
    expect(report.partyCross.aMentionsB, 'A logs naming B').to.equal(0)
    expect(report.partyCross.bMentionsA, 'B logs naming A').to.equal(0)
  })

  it("each run's own secret scan is clean", () => {
    for (const tag of ['a', 'b'] as const) {
      const scan = report.runs[tag].results.secretScan
      expect(scan.whole, `${tag} whole`).to.equal(0)
      expect(scan.windows, `${tag} windows`).to.equal(0)
      expect(scan.files > 0, `${tag} files`).to.equal(true)
    }
  })

  it("the cross-run scan finds no secret of A in B's logs or of B in A's, and its positive control hits", () => {
    const { crossAB, crossBA, positiveControl: control, filesRegisteredA, filesRegisteredB } = report.scans
    expect(control.whole >= 1, 'positive control whole').to.equal(true)
    expect(crossAB.whole, 'A in B whole').to.equal(0)
    expect(crossAB.windows, 'A in B windows').to.equal(0)
    expect(crossAB.files > 0, 'A in B files').to.equal(true)
    expect(crossBA.whole, 'B in A whole').to.equal(0)
    expect(crossBA.windows, 'B in A windows').to.equal(0)
    expect(crossBA.files > 0, 'B in A files').to.equal(true)
    expect(filesRegisteredA >= 1, 'A secrets registered').to.equal(true)
    expect(filesRegisteredB >= 1, 'B secrets registered').to.equal(true)
  })

  it('the union scan over every log, the relay log and the refusal outputs is clean', () => {
    expect(report.scans.union.whole, 'union whole').to.equal(0)
    expect(report.scans.union.windows, 'union windows').to.equal(0)
    expect(report.scans.union.files > 0, 'union files').to.equal(true)
  })

  it('--max-peers 3 refused a 4-peer run live before any disk or process side effect', () => {
    const r = report.refusals.max3
    expect(r.code, 'exit code').to.equal(2)
    expect(r.stderrLine, 'stderr line').to.equal('vt run: refused max-peers requested=4 max=3')
    expect(r.result.verdict, 'verdict').to.equal('VOID')
    expect(r.result.reason, 'reason').to.equal('max-peers')
    expect(Number(r.result.requested), 'requested').to.equal(4)
    expect(Number(r.result.max), 'max').to.equal(3)
    expect(r.stateExists, 'state dir').to.equal(false)
    expect(r.marksExists, 'marks file').to.equal(false)
    expect(r.procsAfter, 'process rows').to.equal(0)
    expect(r.elapsedMs < 10000, 'elapsed ms').to.equal(true)
  })

  it('the default budget refused a run above it live, with no flag and no side effect', () => {
    const r = report.refusals.default
    expect(r.code, 'exit code').to.equal(2)
    expect(r.result.verdict, 'verdict').to.equal('VOID')
    expect(r.result.reason, 'reason').to.equal('max-peers')
    expect(Number(r.result.requested), 'requested').to.equal(report.overBudgetVoters + 3)
    expect(Number(r.result.max), 'max').to.equal(defaultMaxPeers())
    expect(r.stderrLine, 'stderr line').to.equal(`vt run: refused max-peers requested=${report.overBudgetVoters + 3} max=${defaultMaxPeers()}`)
    expect(r.stateExists, 'state dir').to.equal(false)
    expect(r.marksExists, 'marks file').to.equal(false)
    expect(r.procsAfter, 'process rows').to.equal(0)
    expect(r.elapsedMs < 10000, 'elapsed ms').to.equal(true)
  })

  it("reusing run A's state dir is refused with state-used and leaves A's results.json byte-identical", () => {
    const r = report.refusals.stateUsed
    expect(r.code, 'exit code').to.equal(2)
    expect(r.stderrLine, 'stderr line').to.equal('vt run: state-used')
    expect(r.verdict, 'verdict').to.equal('VOID')
    expect(r.reason, 'reason').to.equal('state-used')
    expect(r.identical, 'results.json unchanged').to.equal(true)
  })

  it('the relay carried both runs: limits read back, none refused, no transfer-limit error', () => {
    const relay = report.relay
    expect(relay.limits.applyDefaultLimit, 'applyDefaultLimit').to.equal(false)
    expect(Number.isInteger(relay.limits.maxReservations) && Number(relay.limits.maxReservations) > 0, 'maxReservations').to.equal(true)
    expect(relay.lastRefused, 'reservations refused').to.equal(0)
    expect(relay.lastTransferLimitErrors, 'transfer-limit errors').to.equal(0)
    expect(relay.peakActiveReservations >= 8, 'peak reservations').to.equal(true)
    expect(relay.admissionInstrument, 'admission instrument').to.equal('wrapped')
  })

  it("peak RSS stayed within 45% of host memory and every peer's peak is recorded", () => {
    const m = report.monitor
    expect(m.capExceededTicks < 3, 'cap exceeded ticks').to.equal(true)
    expect(m.peakTotalRssBytes <= m.capBytes, 'peak total RSS').to.equal(true)
    for (const tag of ['a', 'b'] as const) {
      for (const label of REDUCED_TOPOLOGY.labels) {
        expect((m.peers[tag]?.[label]?.peakRssBytes ?? 0) > 0, `${tag}/${label} peak RSS`).to.equal(true)
      }
    }
  })

  it('no daemon, run or relay process from this spec survives and the report file is 0600', () => {
    expect(report.survivors, 'survivors').to.equal(0)
    expect(statSync(report.reportPath).mode & 0o777, 'report mode').to.equal(0o600)
  })
})
