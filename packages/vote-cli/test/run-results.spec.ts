import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../src/cli/exit-codes.js'
import { createRunOutput } from '../src/run/output.js'
import {
  DURATION_KEYS,
  HANDOFF_KEYS,
  RESULTS_KEYS,
  RESULTS_TOOL,
  ResultsExistError,
  buildResults,
  exitCodeFor,
  summaryLine,
  writeResults,
  type LegStatus,
  type ResultsInput
} from '../src/run/results.js'
import { SecretRegistry, createLineMasker } from '../src/run/secret-scan.js'

// A fixture secret made at runtime: never a real code.
const PLANTED = 'planted-value-' + 'ABCDEFGHJKLMNPQR'
const LEGS = ['network', 'h6-election', 'h7-accept', 'h8-dkg', 'h9-voters', 'h10-release-decrypt']

const pass = (leg: string): LegStatus => ({ leg, status: 'PASS', token: '', inScriptD14: 'OFF', reason: 'instruments-off', checks: ['X1'] })
const fail = (leg: string, token: string): LegStatus => ({ leg, status: 'FAIL', token, inScriptD14: 'OFF', reason: 'instruments-off', checks: ['X1'] })
const clean = { whole: 0, windows: 0, files: 3 }

function input (over: Partial<ResultsInput> = {}): ResultsInput {
  return {
    summary: 'PASS',
    legs: LEGS.map(pass),
    durations: { electionMs: 1200, dkgMs: 8000.4 },
    steps: [{ name: 'network/found', startMs: 1700000000000, endMs: 1700000001000 }, { name: 'network', startMs: 1700000000000, endMs: 1700000002000 }],
    secretScan: clean,
    keys: { 'VT-START': 'at=x party=p peers=6 maxPeers=10' },
    startedAt: '2026-11-24T13:00:00.000Z',
    endedAt: '2026-11-24T13:10:00.000Z',
    ...over
  }
}

describe('run: results', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-run-results-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('buildResults has exactly the rig key names plus steps', () => {
    expect([...RESULTS_KEYS]).to.deep.equal(['tool', 'summary', 'legs', 'durations', 'steps', 'secretScan', 'keys', 'startedAt', 'endedAt'])
    expect([...DURATION_KEYS]).to.deep.equal(['reopenMs', 'intakeMs', 'ballotMs', 'electionMs', 'acceptMs', 'dkgMs', 'hvJoinMs', 'associatedMs', 'associatedWaitMs', 'poolMs', 'releaseMs', 'decryptMs', 'voterResultsMs'])
    expect(RESULTS_TOOL).to.equal('vt-run')
    expect(HANDOFF_KEYS).to.deep.equal({ network: 'HANDOFF-NETWORK', election: 'HANDOFF-ELECTION', tokenFiles: 'HANDOFF-TOKEN-FILES' })
    const r = buildResults(input())
    expect(Object.keys(r)).to.deep.equal([...RESULTS_KEYS])
    expect(r.tool).to.equal('vt-run')
    expect(r.summary).to.equal('PASS')
    expect(r.legs).to.have.length(6)
    for (const l of r.legs) expect(Object.keys(l)).to.deep.equal(['leg', 'status', 'token', 'inScriptD14', 'reason'])
    expect(r.durations).to.deep.equal({ electionMs: 1200, dkgMs: 8000 })
    expect(r.steps).to.deep.equal([{ name: 'network/found', startMs: 1700000000000, endMs: 1700000001000 }, { name: 'network', startMs: 1700000000000, endMs: 1700000002000 }])
    for (const s of r.steps) expect(Object.keys(s)).to.deep.equal(['name', 'startMs', 'endMs'])
    expect(r.secretScan).to.deep.equal(clean)
    expect(r.keys).to.deep.equal({ 'VT-START': 'at=x party=p peers=6 maxPeers=10', 'HANDOFF-NETWORK': '', 'HANDOFF-ELECTION': '', 'HANDOFF-TOKEN-FILES': '' })
    expect(r.startedAt).to.equal('2026-11-24T13:00:00.000Z')
    expect(r.endedAt).to.equal('2026-11-24T13:10:00.000Z')
    const withWall = buildResults(input({ wall: { oversized: 0 } }))
    expect(Object.keys(withWall)).to.deep.equal([...RESULTS_KEYS, 'wall'])
    expect(() => buildResults(input({ summary: 'FAIL because of free text' }))).to.throw(TypeError)
    expect(() => buildResults(input({ durations: { bogusMs: 1 } }))).to.throw(TypeError)
    expect(() => buildResults(input({ steps: [{ name: 'Bad Step', startMs: 1, endMs: 2 }] }))).to.throw(TypeError)
    expect(() => buildResults(input({ steps: [{ name: 'ok', startMs: 1.5, endMs: 2 }] }))).to.throw(TypeError)
    expect(() => buildResults(input({ legs: [fail('network', 'free text token')] }))).to.throw(TypeError)
    expect(() => buildResults(input({ startedAt: 'yesterday' }))).to.throw(TypeError)
  })

  it('writeResults writes 0600 with wx and refuses to overwrite', () => {
    const p = join(dir, 'results.json')
    const obj = buildResults(input())
    writeResults(p, obj)
    expect(statSync(p).mode & 0o777).to.equal(0o600)
    const first = readFileSync(p, 'utf8')
    expect(first).to.equal(JSON.stringify(obj, null, 2) + '\n')
    expect(JSON.parse(first)).to.deep.equal(obj)
    try {
      writeResults(p, buildResults(input({ summary: 'FAIL network leg-unwired' })))
      expect.fail('did not throw')
    } catch (err) {
      expect(err).to.be.instanceOf(ResultsExistError)
      expect((err as ResultsExistError).name).to.equal('ResultsExistError')
      expect((err as ResultsExistError).code).to.equal('results-exist')
    }
    expect(readFileSync(p, 'utf8')).to.equal(first)
  })

  it('summaryLine is PASS only when every planned leg passed and the scan is clean', () => {
    expect(summaryLine({ statuses: LEGS.map(pass), planLength: 6, scan: clean })).to.equal('PASS')
    expect(summaryLine({ statuses: LEGS.map(pass), planLength: 6, scan: { whole: 1, windows: 0, files: 9 } })).to.equal('FAIL h10-release-decrypt secret-leak')
    expect(summaryLine({ statuses: LEGS.map(pass), planLength: 6, scan: { whole: 0, windows: 2, files: 9 } })).to.equal('FAIL h10-release-decrypt secret-leak')
    expect(summaryLine({ statuses: LEGS.map(pass), planLength: 6, scan: { whole: -1, windows: 0, files: 0 } })).to.equal('FAIL h10-release-decrypt secret-leak')
    expect(summaryLine({ statuses: LEGS.slice(0, 5).map(pass), planLength: 6, scan: clean })).to.equal('FAIL driver no-result')
    expect(summaryLine({ statuses: [], planLength: 6, scan: { whole: 1, windows: 0, files: 1 } })).to.equal('FAIL driver secret-leak')
  })

  it('summaryLine names the first non-pass leg and token, and secret-leak when the scan hit', () => {
    const soft = [pass('network'), fail('h6-election', 'officer-loop'), fail('h7-accept', 'election')]
    expect(summaryLine({ statuses: soft, planLength: 6, scan: clean })).to.equal('FAIL h6-election officer-loop')
    expect(summaryLine({ statuses: soft, planLength: 6, scan: { whole: 3, windows: 0, files: 1 } })).to.equal('FAIL h6-election officer-loop')
    const voided: LegStatus = { leg: 'network', status: 'VOID', token: 'leg-dir-exists', inScriptD14: 'OFF', reason: 'instruments-off', checks: [] }
    expect(summaryLine({ statuses: [voided], planLength: 6, scan: clean })).to.equal('FAIL network leg-dir-exists')
    expect(summaryLine({ statuses: LEGS.slice(0, 2).map(pass), planLength: 6, scan: clean, driverToken: 'results-write' })).to.equal('FAIL driver results-write')
    expect(summaryLine({ statuses: LEGS.map(pass), planLength: 6, scan: clean, driverToken: 'crash' })).to.equal('FAIL driver crash')
  })

  it('an empty plan never passes', () => {
    expect(summaryLine({ statuses: [], planLength: 0, scan: clean })).to.equal('FAIL driver no-result')
    expect(summaryLine({ statuses: [], planLength: 0, scan: clean })).to.not.equal('PASS')
    expect(summaryLine({ statuses: [], planLength: 3, scan: clean })).to.equal('FAIL driver no-result')
  })

  it('a registered secret given to key never reaches results.json', () => {
    const registry = new SecretRegistry()
    registry.register(PLANTED, { windows: true })
    const mask = createLineMasker({ registry, stateDir: dir })
    const out = createRunOutput({ write: () => {}, mask })
    out.key('HANDOFF-NETWORK', `hash=${PLANTED}`)
    out.key('CODE-PART', PLANTED.slice(2, 18))
    const p = join(dir, 'results.json')
    writeResults(p, buildResults(input({ keys: out.keys() })))
    const text = readFileSync(p, 'utf8')
    expect(text).to.not.include(PLANTED)
    expect(text).to.not.include(PLANTED.slice(2, 18))
    expect(JSON.parse(text).keys).to.deep.equal({ 'HANDOFF-NETWORK': 'hash=<secret>', 'CODE-PART': '<secret>', 'HANDOFF-ELECTION': '', 'HANDOFF-TOKEN-FILES': '' })
  })

  it('exitCodeFor maps PASS to 0 and FAIL to 1', () => {
    expect(exitCodeFor('PASS')).to.equal(EXIT.PASS)
    expect(exitCodeFor('PASS')).to.equal(0)
    expect(exitCodeFor('FAIL network leg-unwired')).to.equal(EXIT.FAIL)
    expect(exitCodeFor('FAIL driver no-result')).to.equal(1)
    expect(exitCodeFor('')).to.equal(1)
  })
})
