import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WALL_LEG_SCHEMA, classifyRun } from '../src/run/instruments/classify.js'
import {
  CONTROL_LEAF_SOURCE,
  FORK_CAP_MS,
  FORK_FAIL_TOKENS,
  FORK_SPACING_MS,
  forkPrecheck,
  forkPrecheckLine,
  type ControlLeafResult
} from '../src/run/instruments/control-leaf.js'
import { readControlLeafReply, controlLeafReplyShape } from '../src/run/instruments/run-instruments.js'
import { classifyErrorView, createWallCounters, d14Verdict, WALL_PATHS } from '../src/run/instruments/wall.js'

const PRELOAD_SOURCE = fileURLToPath(new URL('../src/run/instruments/daemon-preload.ts', import.meta.url))
const zeroSig = (): { superMajority: number, tornAction: number, invalidDataLength: number, transferLimit: number } => ({
  superMajority: 0, tornAction: 0, invalidDataLength: 0, transferLimit: 0
})
const snapshot = (): { paths: Record<'hidden' | 'thrown' | 'late', ReturnType<typeof zeroSig>> } => ({
  paths: { hidden: zeroSig(), thrown: zeroSig(), late: zeroSig() }
})

describe('run: instruments', function () {
  this.timeout(60000)

  it('classifyErrorView counts super-majority, torn-action, invalid-data-length and transfer-limit through the chain', () => {
    const view = {
      name: 'AggregateError',
      message: 'Failed to get super-majority: 1/2 approvals and Failed to get super-majority: 2/3 approvals',
      chain: ['Error', 'Torn' + 'Action' + 'Error', 'InvalidData' + 'LengthError', 'TransferLimit' + 'Error']
    }
    expect(classifyErrorView(view)).to.deep.equal({
      superMajority: 2, tornAction: 1, invalidDataLength: 1, transferLimit: 1
    })
    expect(classifyErrorView({ name: 'Error', message: 'clean', chain: ['Error'] })).to.deep.equal(zeroSig())
    expect(classifyErrorView(null)).to.deep.equal(zeroSig())
  })

  it('wall counters split hidden, thrown and late and a leg delta is the difference of two snapshots', () => {
    const counters = createWallCounters()
    const before = counters.snapshot()
    counters.record('hidden', { name: 'Error', message: 'Failed to get super-majority: 1/2 approvals' })
    counters.record('thrown', { name: 'Torn' + 'Action' + 'Error', chain: ['Torn' + 'Action' + 'Error'] })
    counters.record('late', { name: 'TransferLimit' + 'Error', chain: ['Error', 'TransferLimit' + 'Error'] })
    const after = counters.snapshot()
    expect(WALL_PATHS).to.deep.equal(['hidden', 'thrown', 'late'])
    expect(after.paths.hidden.superMajority).to.equal(1)
    expect(after.paths.thrown.tornAction).to.equal(1)
    expect(after.paths.late.transferLimit).to.equal(1)
    const delta = counters.delta(before, after)
    expect(delta).to.deep.equal(after.paths)
    expect(counters.delta(after, after)).to.deep.equal(snapshot().paths)
  })

  it('forkPrecheck keeps the rig line grammar: PASS on agree, FAIL fork-leaf, fork-tail, unreadable, role-missing, digest-mismatch-logged', async () => {
    expect(FORK_SPACING_MS).to.equal(5000)
    expect(FORK_CAP_MS).to.equal(120000)
    expect([...FORK_FAIL_TOKENS]).to.deep.equal(['fork-leaf', 'fork-tail', 'unreadable', 'role-missing', 'digest-mismatch-logged'])
    const at = '2026-01-01T00:00:00.000Z'
    const read = { leafRev: 3, leafAction8: 'abcd1234', tailRev: 4, tailAction8: 'efgh1234' }
    const reader = (v: ControlLeafResult) => async (): Promise<ControlLeafResult> => v
    const base = {
      spacingMs: 1,
      capMs: 10,
      now: (() => {
        let t = Date.parse(at)
        return () => t
      })(),
      sleep: async (ms: number): Promise<void> => {
        base.now()
        void ms
      },
      digestMismatch: () => 0
    }
    const pass = await forkPrecheck({ ...base, readers: { officer: reader(read), 'kh-a': reader(read) } })
    expect(pass.line).to.equal(
      `FORK-PRECHECK: PASS roles=officer,kh-a leafRev=3 leafAction8=abcd1234 tailRev=4 tailAction8=efgh1234 digestMismatch=0 reads=1 at=${at}`)
    const leaf = await forkPrecheck({ ...base, readers: { officer: reader(read), 'kh-a': reader({ ...read, leafRev: 9 }) } })
    expect(leaf.line).to.equal('FORK-PRECHECK: FAIL fork-leaf')
    const tail = await forkPrecheck({ ...base, readers: { officer: reader(read), 'kh-a': reader({ ...read, tailRev: 9 }) } })
    expect(tail.line).to.equal('FORK-PRECHECK: FAIL fork-tail')
    const unreadable = await forkPrecheck({ ...base, readers: { officer: reader({ unreadable: 'read-timeout' }), 'kh-a': reader(read) } })
    expect(unreadable.line).to.equal('FORK-PRECHECK: FAIL unreadable')
    const missing = await forkPrecheck({ ...base, readers: { officer: reader(read) } })
    expect(missing.line).to.equal('FORK-PRECHECK: FAIL role-missing')
    const digest = await forkPrecheck({ ...base, digestMismatch: () => 2, readers: { officer: reader(read), 'kh-a': reader(read) } })
    expect(digest.line).to.equal('FORK-PRECHECK: FAIL digest-mismatch-logged')
    expect(forkPrecheckLine({ roles: ['officer'], verdict: 'fork-leaf' })).to.equal('FORK-PRECHECK: FAIL role-missing')
    expect(CONTROL_LEAF_SOURCE).to.include('leafRev: leaf.rev')
  })

  it('the file reader times out to unreadable and a reply never carries a block id or a full action id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-instr-file-'))
    try {
      let clock = 0
      const now = (): number => {
        clock += 10
        return clock
      }
      const timeout = await readControlLeafReply({
        dir, seq: 1, peerId8: 'abcd1234', timeoutMs: 30, sleep: async () => {}, now
      })
      expect(timeout.read).to.deep.equal({ unreadable: 'read-timeout' })
      expect(timeout.digestMismatch).to.equal(0)
      const read = { leafRev: 1, leafAction8: 'abcd1234', tailRev: 2, tailAction8: 'efgh1234' }
      const path = join(dir, 'res-1.json')
      writeFileSync(path, JSON.stringify({ seq: 1, peerId8: 'abcd1234', read, digestMismatch: 3 }) + '\n', { flag: 'wx', mode: 0o600 })
      const reply = await readControlLeafReply({ dir, seq: 1, peerId8: 'abcd1234', timeoutMs: 100 })
      expect(reply).to.deep.equal({ read, digestMismatch: 3 })
      const text = readFileSync(path, 'utf8')
      expect(Object.keys(JSON.parse(text))).to.deep.equal([...controlLeafReplyShape()])
      expect(text).to.not.include('12D3Koo')
      expect(text).to.not.include('abcdefgh12345678')
      expect(text).to.not.include('block-')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifyRun keeps the spike-106 classes on rig-shaped leg logs', () => {
    const start = `LEG-START {"schema":"${WALL_LEG_SCHEMA}","runId":"vt-network","shape":"l1"}`
    const result = (extra: Record<string, unknown>, shape = 'l1'): string =>
      `RESULT ${JSON.stringify({
        schema: WALL_LEG_SCHEMA,
        shape,
        join: { ok: true, ms: 12 },
        join1: { ok: true },
        instrument: { probeInstalled: true, probeCalls: 2 },
        preconditions: { vAuthorizedBeforeFound: true, aConnectionsAtFound: 1 },
        ...extra
      })}`
    const log = (...lines: string[]): string => lines.join('\n') + '\n'
    expect(classifyRun(log(start, result({}))).cls).to.equal('CLEAN')
    expect(classifyRun(log(start, result({ hiddenOpenFailuresTotal: 1 }))).cls).to.equal('MASKED HIT')
    expect(classifyRun(log(start, result({ timedOut: true, stage: 'found' }))).cls).to.equal('HIT')
    const control = classifyRun(log(
      start.replace('"l1"', '"l3"'),
      result({
        oversizedTotal: 1,
        hiddenOpenFailuresTotal: 1,
        wallSignals: { hidden: { superMajority: 1 } },
        join: { ok: true, ms: 12 }
      }, 'l3')
    ))
    expect(control.cls).to.equal('CONTROL WALL SHOWN')
    expect(classifyRun(log(start)).cls).to.equal('HIT')
    expect(classifyRun('').cls).to.equal('VOID-run (instrument-never-started)')
    // a vt election leg has no two-node join precondition: its status and its own signals decide
    const vt = (extra: Record<string, unknown>): string => log(start, `RESULT ${JSON.stringify({
      shape: 'vt', instrument: { probeInstalled: true, probeCalls: 4 }, join: { ok: true, ms: 1 }, ...extra
    })}`)
    expect(classifyRun(vt({})).cls).to.equal('CLEAN')
    expect(classifyRun(vt({ join: { ok: false, ms: 1 } })).cls).to.equal('HIT')
    expect(classifyRun(vt({ wallSignals: { thrown: { superMajority: 1 } } })).cls).to.equal('HIT')
  })

  it('d14Verdict is CLEAN, HIT or INSTRUMENT from the snapshots', () => {
    const probeBefore = { installed: true, calls: 0, maxBytes: 0, oversized: 0 }
    const probeAfter = { installed: true, calls: 5, maxBytes: 900, oversized: 0 }
    const before = snapshot()
    const after = snapshot()
    expect(d14Verdict({ before, after, probeBefore, probeAfter, probeInstalled: true }))
      .to.deep.equal({ inScriptD14: 'CLEAN', reason: 'no-wall-signal' })
    expect(d14Verdict({ before, after, probeBefore, probeAfter, probeInstalled: false }))
      .to.deep.equal({ inScriptD14: 'INSTRUMENT', reason: 'probe-not-installed' })
    const hitAfter = snapshot()
    hitAfter.paths.thrown.tornAction = 1
    expect(d14Verdict({ before, after: hitAfter, probeBefore, probeAfter, probeInstalled: true }))
      .to.deep.equal({ inScriptD14: 'HIT', reason: 'tornAction' })
    expect(d14Verdict({ before, after, probeBefore, probeAfter: { ...probeAfter, oversized: 1 }, probeInstalled: true }))
      .to.deep.equal({ inScriptD14: 'HIT', reason: 'oversized' })
  })

  it('the preload applies the daemon env filter before any engine import and leaves send\'s result unchanged', async () => {
    const source = readFileSync(PRELOAD_SOURCE, 'utf8')
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    const firstImport = code.split('\n').find((l) => /^import /.test(l)) ?? ''
    expect(firstImport).to.include("'../../daemon/daemon-env.js'")
    expect(code).to.not.match(/^import .*(@optimystic|@serfab|libp2p)/m)
    expect(code.indexOf('applyDaemonEnv()')).to.be.at.least(0)
    expect(code.indexOf('await import(')).to.be.greaterThan(code.indexOf('applyDaemonEnv()'))
    const saved = {
      forceColor: process.env.FORCE_COLOR,
      debugColors: process.env.DEBUG_COLORS,
      debugHideDate: process.env.DEBUG_HIDE_DATE,
      debug: process.env.DEBUG,
      instrDir: process.env.VT_INSTR_DIR
    }
    const restore = (): void => {
      for (const [key, value] of Object.entries(saved)) {
        const envKey = { forceColor: 'FORCE_COLOR', debugColors: 'DEBUG_COLORS', debugHideDate: 'DEBUG_HIDE_DATE', debug: 'DEBUG', instrDir: 'VT_INSTR_DIR' }[key] ?? key
        if (value === undefined) delete process.env[envKey]
        else process.env[envKey] = value
      }
    }
    delete process.env.VT_INSTR_DIR
    try {
      const preload = await import('../src/run/instruments/daemon-preload.js')
      // each workspace holds its own cadre-core: the wrapped classes must be the daemon's copy
      expect(preload.DAEMON_PACKAGE_URL.pathname).to.match(/\/packages\/vote-cli\/package\.json$/)
      const state = { installed: false, calls: 0, maxBytes: 0, oversized: 0 }
      const sentinel = { handled: true }
      const proto = { send: async (_message: unknown) => sentinel }
      const restoreSend = preload.installSizeProbe(proto, state)
      const got = await proto.send({ n: 1 })
      expect(got).to.equal(sentinel)
      expect(state.installed).to.equal(true)
      expect(state.calls).to.equal(1)
      expect(state.maxBytes).to.be.at.least(2)
      expect(state.oversized).to.equal(0)
      restoreSend()
      expect(await proto.send({ n: 2 })).to.equal(sentinel)
      expect(state.calls).to.equal(1)
    } finally {
      restore()
    }
  })
})
