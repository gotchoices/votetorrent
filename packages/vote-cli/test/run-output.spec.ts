import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LINE_GRAMMAR, RUN_MARK_NAMES, RunOutputError, createRunOutput, scrubWall, type RunOutput } from '../src/run/output.js'

// A fixture secret made at runtime: never a real code.
const PLANTED = 'planted-value-' + 'ABCDEFGHJKLMNPQR'

interface Fixture {
  lines: string[]
  masked: number
  out: RunOutput
  clock: { perf: number, now: number }
}

function fixture (dir: string, marksFile = join(dir, 'marks.txt')): Fixture {
  const f: Fixture = { lines: [], masked: 0, out: undefined as unknown as RunOutput, clock: { perf: 0, now: 1700000000123 } }
  f.out = createRunOutput({
    write: (line) => { f.lines.push(line) },
    mask: (s) => { f.masked++; return s.split(PLANTED).join('<secret>') },
    marksFile,
    nowMs: () => f.clock.now,
    perfNow: () => f.clock.perf
  })
  return f
}

function refusal (fn: () => unknown): RunOutputError {
  try {
    fn()
  } catch (err) {
    expect(err).to.be.instanceOf(RunOutputError)
    expect((err as Error).name).to.equal('RunOutputError')
    return err as RunOutputError
  }
  expect.fail('did not throw')
}

describe('run: output', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-run-output-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('say pads the elapsed ms to 7 and the category to 8', () => {
    const f = fixture(dir)
    f.clock.perf = 42
    f.out.say('LEG', 'x')
    expect(f.lines).to.deep.equal(['[     42ms] LEG      x'])
    expect(LINE_GRAMMAR.say.test(f.lines[0]!)).to.equal(true)
    f.clock.perf = 12345678
    f.out.say('SOFT-FAIL', 'network W0 recorded, continuing')
    expect(f.lines[1]).to.equal('[12345678ms] SOFT-FAIL network W0 recorded, continuing')
    expect(LINE_GRAMMAR.say.test(f.lines[1]!)).to.equal(true)
  })

  it('RUN-MARK prints the epoch ms and appends the same line to the marks file', () => {
    const marks = join(dir, 'prof', 'marks.txt')
    const f = fixture(dir, marks)
    f.out.runMark('p1-start')
    expect(f.lines).to.deep.equal(['RUN-MARK p1-start 1700000000123'])
    expect(LINE_GRAMMAR.runMark.test(f.lines[0]!)).to.equal(true)
    expect(readFileSync(marks, 'utf8')).to.equal('RUN-MARK p1-start 1700000000123\n')
    expect(statSync(marks).mode & 0o777).to.equal(0o600)
    f.clock.now = 1700000000999
    f.out.runMark('p1-end')
    expect(readFileSync(marks, 'utf8')).to.equal('RUN-MARK p1-start 1700000000123\nRUN-MARK p1-end 1700000000999\n')
    expect(f.out.hasMark('p1-start')).to.equal(true)
    expect(f.out.hasMark('p2-start')).to.equal(false)
  })

  it('each RUN-MARK name is emitted at most once and only the four profile names are accepted', () => {
    const f = fixture(dir)
    expect([...RUN_MARK_NAMES]).to.deep.equal(['p1-start', 'p1-end', 'p2-start', 'p2-end'])
    expect(Object.isFrozen(RUN_MARK_NAMES)).to.equal(true)
    f.out.runMark('p1-start')
    expect(refusal(() => f.out.runMark('p1-start')).code).to.equal('mark-repeat')
    expect(refusal(() => f.out.runMark('p3-start' as never)).code).to.equal('mark-name')
    expect(f.lines).to.have.length(1)
    expect(refusal(() => createRunOutput({ write: () => {}, mask: (s) => s, marksFile: 'relative/marks.txt' })).code).to.equal('marks-relative')
    const noMarks = createRunOutput({ write: (l) => { f.lines.push(l) }, mask: (s) => s, nowMs: () => 1700000000124 })
    noMarks.runMark('p2-start')
    expect(f.lines[1]).to.equal('RUN-MARK p2-start 1700000000124')
  })

  it('APPROVE keeps the registration readMs decideMs publishMs publish shape', () => {
    const f = fixture(dir)
    f.clock.perf = 7
    f.out.approve({ n: 2, readMs: 10, decideMs: 20, publishMs: 30, publish: 'ok' })
    expect(f.lines).to.deep.equal(['[      7ms] APPROVE  registration 2 readMs=10 decideMs=20 publishMs=30 publish=ok'])
    expect(LINE_GRAMMAR.approve.test(f.lines[0]!)).to.equal(true)
    f.out.approve({ n: 3, readMs: 1.6, decideMs: 2, publishMs: 3, publish: 'Error: Bad/Thing' })
    expect(f.lines[1]).to.equal('[      7ms] APPROVE  registration 3 readMs=2 decideMs=2 publishMs=3 publish=rror:ad' + 'hing')
    expect(LINE_GRAMMAR.approve.test(f.lines[1]!)).to.equal(true)
  })

  it('LEAN-WAIT, LEAN-GO and LEAN-NOTE keep the rig shapes', () => {
    const f = fixture(dir)
    f.out.leanWait('phone-join')
    f.out.leanGo('phone-join', true, 1234)
    f.out.leanGo('phone-vote', false, 0)
    f.out.leanNote(`scan the code at ${PLANTED}`)
    expect(f.lines).to.deep.equal([
      'LEAN-WAIT phone-join at=2023-11-14T22:13:20.123Z',
      'LEAN-GO phone-join ok=true waitedMs=1234',
      'LEAN-GO phone-vote ok=false waitedMs=0',
      'LEAN-NOTE scan the code at <secret>'
    ])
    expect(LINE_GRAMMAR.leanWait.test(f.lines[0]!)).to.equal(true)
    expect(LINE_GRAMMAR.leanGo.test(f.lines[1]!)).to.equal(true)
    expect(LINE_GRAMMAR.leanGo.test(f.lines[2]!)).to.equal(true)
    expect(LINE_GRAMMAR.leanNote.test(f.lines[3]!)).to.equal(true)
  })

  it('key lines are write-once and masked', () => {
    const f = fixture(dir)
    f.out.key('VT-START', `at=now code=${PLANTED}`)
    f.out.key('VT-START', 'second value')
    expect(f.lines).to.deep.equal(['VT-START: at=now code=<secret>'])
    expect(LINE_GRAMMAR.key.test(f.lines[0]!)).to.equal(true)
    expect(f.out.keys()).to.deep.equal({ 'VT-START': 'at=now code=<secret>' })
    expect(refusal(() => f.out.key('bad name', 'x')).code).to.equal('key-name')
    expect(refusal(() => f.out.key('lower', 'x')).code).to.equal('key-name')
    f.out.key('HANDOFF-NETWORK', '')
    expect(f.lines[1]).to.equal('HANDOFF-NETWORK: ')
    expect(LINE_GRAMMAR.key.test(f.lines[1]!)).to.equal(true)
    expect(f.out.keys()).to.have.keys(['VT-START', 'HANDOFF-NETWORK'])
  })

  it('every line passes through the masker, and nothing is written after SUMMARY', () => {
    const f = fixture(dir)
    f.out.say('LEG', `network start ${PLANTED}`)
    f.out.runMark('p1-start')
    f.out.key('K1', PLANTED)
    f.out.result({ tool: 'vt-run', summary: 'PASS', note: PLANTED })
    f.out.summary('FAIL network leg-unwired')
    expect(f.lines).to.deep.equal([
      '[      0ms] LEG      network start <secret>',
      'RUN-MARK p1-start 1700000000123',
      'K1: <secret>',
      'RESULT {"tool":"vt-run","summary":"PASS","note":"<secret>"}',
      'SUMMARY FAIL network leg-unwired'
    ])
    expect(f.masked).to.be.at.least(f.lines.length)
    expect(LINE_GRAMMAR.result.test(f.lines[3]!)).to.equal(true)
    expect(LINE_GRAMMAR.summary.test(f.lines[4]!)).to.equal(true)
    expect(LINE_GRAMMAR.summary.test('SUMMARY PASS')).to.equal(true)
    expect(LINE_GRAMMAR.summary.test('SUMMARY PASSED')).to.equal(false)
    expect(f.lines.join('\n')).to.not.include(PLANTED)
    for (const call of [
      () => f.out.say('LEG', 'x'),
      () => f.out.runMark('p1-end'),
      () => f.out.key('K2', 'x'),
      () => f.out.leanNote('x'),
      () => f.out.result({}),
      () => f.out.summary('PASS')
    ]) expect(refusal(call).code).to.equal('after-summary')
    expect(f.lines).to.have.length(5)
    expect(scrubWall('Torn' + 'Action' + 'Error at x')).to.equal('torn-refusal at x')
    expect(scrubWall('Failed to get super-majority: 3/5 approvals')).to.equal('sm-refusal 3/5')
    expect(scrubWall('InvalidData' + 'LengthError and TransferLimit' + 'Error')).to.equal('idl-refusal and tl-refusal')
  })
})
