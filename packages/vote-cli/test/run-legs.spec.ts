import { expect } from 'chai'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LegFail, RUN_TOKENS, SOFT_TOKENS, TOKEN_RE, createLegRunner, type LegRunner } from '../src/run/legs.js'
import { LINE_GRAMMAR, createRunOutput, type RunOutput } from '../src/run/output.js'
import { SecretRegistry, createLineMasker } from '../src/run/secret-scan.js'

// A fixture secret made at runtime: never a real code.
const PLANTED = 'planted-value-' + 'ABCDEFGHJKLMNPQR'

interface Rig {
  lines: string[]
  out: RunOutput
  runner: LegRunner
  evDir: string
  flagsDir: string
  abort: (reason: string) => void
}

function rig (dir: string): Rig {
  const lines: string[] = []
  const registry = new SecretRegistry()
  registry.register(PLANTED, { windows: true })
  const mask = createLineMasker({ registry, stateDir: dir })
  let now = 1700000000000
  const nowMs = (): number => (now += 10)
  const out = createRunOutput({ write: (l) => { lines.push(l) }, mask, nowMs })
  const evDir = join(dir, 'ev')
  const flagsDir = join(dir, 'flags')
  mkdirSync(evDir)
  mkdirSync(flagsDir)
  let abort!: (reason: string) => void
  const abortPromise = new Promise<string>((resolve) => { abort = resolve })
  const runner = createLegRunner({ evDir, flagsDir, out, mask, nowMs, abort: abortPromise })
  return { lines, out, runner, evDir, flagsDir, abort }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('run: legs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-run-legs-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a passing leg writes leg.log and leg-status.json with wx and records its step window', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('network', async (L) => {
      expect(L.name).to.equal('network')
      expect(L.dir).to.equal(join(r.evDir, 'network'))
      expect(L.check('N1', 'the officer founded', true)).to.equal(true)
      const v = await L.step('found', async () => 7)
      expect(v).to.equal(7)
      L.duration('reopenMs', 12.4)
    })
    expect(st).to.include({ leg: 'network', status: 'PASS', token: '', inScriptD14: 'OFF', reason: 'instruments-off' })
    expect(st.checks).to.deep.equal(['N1'])
    const legLog = join(r.evDir, 'network', 'leg.log')
    expect(statSync(legLog).mode & 0o777).to.equal(0o600)
    expect(statSync(join(r.evDir, 'network')).mode & 0o777).to.equal(0o700)
    const log = readFileSync(legLog, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(log[0]).to.equal('LEG-START {"schema":"vt-run-leg/1","leg":"network"}')
    expect(log[1]).to.match(/^\[ *\d+ms\] PASS N1 the officer founded$/)
    const last = JSON.parse(log.at(-1)!.replace(/^RESULT /, ''))
    expect(last).to.include({ schema: 'vt-run-leg/1', leg: 'network', status: 'PASS', token: '' })
    expect(last.totalMs).to.be.a('number')
    const statusPath = join(r.evDir, 'network', 'leg-status.json')
    expect(statSync(statusPath).mode & 0o777).to.equal(0o600)
    expect(JSON.parse(readFileSync(statusPath, 'utf8'))).to.deep.equal({ status: 'PASS', token: '', inScriptD14: 'OFF', reason: 'instruments-off', checks: ['N1'] })
    expect(r.runner.steps.map((s) => s.name)).to.deep.equal(['network/found', 'network'])
    for (const s of r.runner.steps) {
      expect(Number.isInteger(s.startMs)).to.equal(true)
      expect(s.endMs).to.be.at.least(s.startMs)
      expect(Object.keys(s)).to.deep.equal(['name', 'startMs', 'endMs'])
    }
    expect(r.runner.durations).to.deep.equal({ reopenMs: 12 })
    expect(r.runner.statuses).to.deep.equal([st])
    expect(r.runner.firstNonPass()).to.equal(null)
    expect(r.lines.some((l) => /^\[ *\d+ms\] LEG {6}network start$/.test(l))).to.equal(true)
    expect(r.lines.some((l) => /^\[ *\d+ms\] PASS {5}network N1 the officer founded$/.test(l))).to.equal(true)
    expect(r.lines.at(-1)).to.match(/^\[ *\d+ms\] LEG {6}network PASS$/)
    for (const l of r.lines) expect(LINE_GRAMMAR.say.test(l), l).to.equal(true)
  })

  it('need with a hard token stops the leg with FAIL <token>', async () => {
    const r = rig(dir)
    let after = false
    const st = await r.runner.runLeg('h6-election', async (L) => {
      L.need('election', 'E1', `created ${PLANTED}`, false, { detail: PLANTED })
      after = true
    })
    expect(after).to.equal(false)
    expect(st).to.include({ leg: 'h6-election', status: 'FAIL', token: 'election' })
    expect(r.runner.firstNonPass()).to.equal(st)
    expect(r.lines.some((l) => /^\[ *\d+ms\] FAIL {5}h6-election E1 created <secret> {2}- \{"detail":"<secret>"\}$/.test(l))).to.equal(true)
    expect(r.lines.at(-1)).to.match(/^\[ *\d+ms\] LEG {6}h6-election FAIL election$/)
    expect(r.lines.join('\n')).to.not.include(PLANTED)
    expect(readFileSync(join(r.evDir, 'h6-election', 'leg.log'), 'utf8')).to.not.include(PLANTED)
    expect(JSON.parse(readFileSync(join(r.evDir, 'h6-election', 'leg-status.json'), 'utf8'))).to.include({ status: 'FAIL', token: 'election' })
  })

  it('need with a soft token records the failure and the leg continues to FAIL with the first token', async () => {
    const r = rig(dir)
    let after = false
    const st = await r.runner.runLeg('h9-voters', async (L) => {
      L.need('officer-loop', 'O1', 'approved in time', false)
      after = true
      L.need('join-outcome', 'O2', 'joined', false)
      L.check('O3', 'later check', true)
    })
    expect(after).to.equal(true)
    expect(st).to.include({ status: 'FAIL', token: 'officer-loop' })
    expect(st.checks).to.deep.equal(['O1', 'O2', 'O3'])
    expect(r.lines.filter((l) => / SOFT-FAIL h9-voters O[12] recorded, continuing$/.test(l))).to.have.length(2)
    expect(r.lines.at(-1)).to.match(/ LEG {6}h9-voters FAIL officer-loop$/)
    expect(SOFT_TOKENS.size).to.equal(8)
    for (const t of ['officer-loop', 'join-outcome', 'cid-disagree', 'entry-hash', 'block', 'pre-release', 'needle-control', 'voter-results']) {
      expect(SOFT_TOKENS.has(t), t).to.equal(true)
    }
    for (const t of RUN_TOKENS) expect(TOKEN_RE.test(t), t).to.equal(true)
    expect(RUN_TOKENS).to.include.members(['leg-unwired', 'leg-dir-exists', 'daemon-boot', 'daemon-timeout', 'secret-leak', 'alarm', 'interrupted', 'results-write', 'no-result', 'crash', 'bad-token'])
  })

  it('a thrown error becomes FAIL crash-<leg> and the message is masked', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('h6-election', async () => {
      throw Object.assign(new Error(`boom ${PLANTED} at ${'x'.repeat(400)}`), { name: 'BoomError' })
    })
    expect(st).to.include({ status: 'FAIL', token: 'crash-h6-election' })
    expect(TOKEN_RE.test(st.token)).to.equal(true)
    const crash = r.lines.find((l) => / CRASH {4}h6-election /.test(l))
    expect(crash).to.not.equal(undefined)
    expect(crash).to.include('BoomError')
    expect(crash).to.include('<secret>')
    expect(crash).to.not.include(PLANTED)
    expect(crash!.length).to.be.lessThan(260)
    expect(crash).to.not.include('    at ')
    const log = readFileSync(join(r.evDir, 'h6-election', 'leg.log'), 'utf8')
    expect(log).to.not.include(PLANTED)
    expect(log).to.include('crash BoomError')
    const st2 = await r.runner.runLeg('h7-accept', async () => {
      throw 'a string'
    })
    expect(st2).to.include({ status: 'FAIL', token: 'crash-h7-accept' })
  })

  it('an existing leg dir is VOID leg-dir-exists and nothing is overwritten', async () => {
    const r = rig(dir)
    mkdirSync(join(r.evDir, 'network'))
    writeFileSync(join(r.evDir, 'network', 'planted.txt'), 'before')
    let ran = false
    const st = await r.runner.runLeg('network', async () => {
      ran = true
    })
    expect(ran).to.equal(false)
    expect(st).to.include({ leg: 'network', status: 'VOID', token: 'leg-dir-exists' })
    expect(readdirSync(join(r.evDir, 'network'))).to.deep.equal(['planted.txt'])
    expect(readFileSync(join(r.evDir, 'network', 'planted.txt'), 'utf8')).to.equal('before')
    expect(r.runner.firstNonPass()).to.equal(st)
    expect(r.lines.at(-1)).to.match(/ LEG {6}network VOID leg-dir-exists$/)
  })

  it('delegate prints LEAN-WAIT then LEAN-GO ok=true when the flag file appears', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('h9-voters', async (L) => {
      setTimeout(() => { writeFileSync(join(r.flagsDir, 'flag-phone-join'), '') }, 60)
      const res = await L.delegate('phone-join', { timeoutMs: 5000, pollMs: 10, note: `scan the code at ${PLANTED}` })
      expect(res.ok).to.equal(true)
      expect(res.waitedMs).to.be.at.least(40)
    })
    expect(st.status).to.equal('PASS')
    const lean = r.lines.filter((l) => l.startsWith('LEAN-'))
    expect(lean).to.have.length(3)
    expect(lean[0]).to.equal('LEAN-NOTE scan the code at <secret>')
    expect(LINE_GRAMMAR.leanNote.test(lean[0]!)).to.equal(true)
    expect(LINE_GRAMMAR.leanWait.test(lean[1]!)).to.equal(true)
    expect(lean[1]!.startsWith('LEAN-WAIT phone-join at=')).to.equal(true)
    expect(LINE_GRAMMAR.leanGo.test(lean[2]!)).to.equal(true)
    expect(lean[2]!.startsWith('LEAN-GO phone-join ok=true waitedMs=')).to.equal(true)
  })

  it('delegate times out with LEAN-GO ok=false', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('h9-voters', async (L) => {
      const res = await L.delegate('phone-vote', { timeoutMs: 50, pollMs: 10 })
      expect(res.ok).to.equal(false)
      expect(res.waitedMs).to.be.at.least(40)
    })
    expect(st.status).to.equal('PASS')
    const lean = r.lines.filter((l) => l.startsWith('LEAN-'))
    expect(lean).to.have.length(2)
    expect(lean[0]!.startsWith('LEAN-WAIT phone-vote at=')).to.equal(true)
    expect(lean[1]!.startsWith('LEAN-GO phone-vote ok=false waitedMs=')).to.equal(true)
  })

  it('a host-only leg prints no LEAN- line', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('h8-dkg', async (L) => {
      L.check('D1', 'bound', true)
      await L.step('dkg', async () => { await sleep(1) })
      L.duration('dkgMs', 8)
      L.approve({ n: 1, readMs: 1, decideMs: 2, publishMs: 3, publish: 'ok' })
      L.need('dkg-key', 'D2', 'key', true)
    })
    expect(st.status).to.equal('PASS')
    expect(r.lines.filter((l) => l.startsWith('LEAN-'))).to.deep.equal([])
    expect(r.lines.some((l) => LINE_GRAMMAR.approve.test(l))).to.equal(true)
    expect(existsSync(join(r.evDir, 'h8-dkg', 'leg-status.json'))).to.equal(true)
  })

  it('duration accepts only the rig duration keys', async () => {
    const r = rig(dir)
    const st = await r.runner.runLeg('h6-election', async (L) => {
      L.duration('electionMs', 100)
      L.duration('bogusMs', 1)
    })
    expect(st).to.include({ status: 'FAIL', token: 'bad-token' })
    expect(r.runner.durations).to.deep.equal({ electionMs: 100 })
    const st2 = await r.runner.runLeg('h7-accept', async (L) => {
      L.need('Bad Token', 'A1', 'x', false)
    })
    expect(st2).to.include({ status: 'FAIL', token: 'bad-token' })
    const st3 = await r.runner.runLeg('h8-dkg', async (L) => {
      await L.step('Bad Step', async () => {})
    })
    expect(st3).to.include({ status: 'FAIL', token: 'bad-token' })
    expect(new LegFail('VOID', 'leg-dir-exists')).to.include({ kind: 'VOID', token: 'leg-dir-exists', name: 'LegFail' })
  })

  it('abort ends the running leg with the abort token', async () => {
    const r = rig(dir)
    let released = false
    const pending = r.runner.runLeg('network', async (L) => {
      await L.step('wait', () => new Promise<void>((resolve) => { setTimeout(() => { released = true; resolve() }, 300) }))
      L.check('N9', 'never recorded', true)
    })
    setTimeout(() => { r.abort('alarm') }, 30)
    const st = await pending
    expect(released).to.equal(false)
    expect(st).to.include({ leg: 'network', status: 'FAIL', token: 'alarm' })
    expect(r.runner.aborted()).to.equal('alarm')
    expect(r.lines.at(-1)).to.match(/ LEG {6}network FAIL alarm$/)
    expect(JSON.parse(readFileSync(join(r.evDir, 'network', 'leg-status.json'), 'utf8'))).to.include({ status: 'FAIL', token: 'alarm' })
    await sleep(320)
    expect(released).to.equal(true)
    const st2 = await r.runner.runLeg('h6-election', async () => {})
    expect(st2).to.include({ status: 'FAIL', token: 'alarm' })
  })
})
