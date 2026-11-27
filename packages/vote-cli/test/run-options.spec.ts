import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import { REPO_ROOT, RunUsageError, parseRunElectionArgs, peerLabels } from '../src/run/options.js'
import { PEER_BUDGET_FRACTION, PEER_RSS_BYTES, PeerBudgetError, assertPeerBudget, defaultMaxPeers } from '../src/run/peer-budget.js'

const ADDR = '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWFixtureFixtureFixtureFixtureFixtureFixture1'

function usage (argv: string[]): RunUsageError {
  try {
    parseRunElectionArgs(argv)
  } catch (err) {
    expect(err).to.be.instanceOf(RunUsageError)
    expect((err as Error).name).to.equal('RunUsageError')
    expect((err as Error).message).to.equal((err as RunUsageError).code)
    return err as RunUsageError
  }
  expect.fail('parseRunElectionArgs did not throw')
}

describe('run: options', () => {
  let dir: string
  let relay: string
  let state: string
  let base: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-run-options-'))
    relay = join(dir, 'relay.env')
    writeRelayEnv(relay, ADDR)
    state = join(dir, 'state')
    base = ['--relay', relay, '--state', state, '--party', 'vt-test-party']
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses a full host-only command with the documented defaults', () => {
    const opts = parseRunElectionArgs(base)
    expect(opts.relayEnvPath).to.equal(relay)
    expect(opts.relayMultiaddr).to.equal(ADDR)
    expect(opts.stateDir).to.equal(state)
    expect(opts.party).to.equal('vt-test-party')
    expect(opts.leadMs).to.equal(600000)
    expect(opts.windowMs).to.equal(480000)
    expect(opts.marksFile).to.equal(undefined)
    expect(opts.maxPeers).to.equal(undefined)
    expect(opts.keyholders).to.equal(2)
    expect(opts.voters).to.equal(3)
    expect(opts.reduced).to.equal(false)
    expect(opts.colocate).to.equal(undefined)
    expect(opts.debug).to.equal(undefined)
    expect(opts.importFile).to.equal(undefined)
    expect(opts.cpuProf).to.equal(false)
    expect(opts.instruments).to.equal(false)
    expect(opts.alarmS).to.equal(7200)
    expect(peerLabels(opts)).to.deep.equal(['officer', 'kh-a', 'kh-b', 'v1', 'v2', 'v3'])
    expect(existsSync(state)).to.equal(false)
    const full = parseRunElectionArgs([
      ...base, '--lead-ms', '90000', '--window-ms', '60000', '--marks-file', join(dir, 'marks.txt'), '--max-peers', '4',
      '--keyholders', '2', '--voters', '3', '--colocate', 'officer,kh-a,kh-b', '--debug', 'optimystic:*', '--import', join(dir, 'preload.mjs'),
      '--cpu-prof', '--instruments', '--alarm-s', '600'
    ])
    expect(full.leadMs).to.equal(90000)
    expect(full.windowMs).to.equal(60000)
    expect(full.marksFile).to.equal(join(dir, 'marks.txt'))
    expect(full.maxPeers).to.equal(4)
    expect(full.colocate).to.deep.equal(['officer', 'kh-a', 'kh-b'])
    expect(full.debug).to.equal('optimystic:*')
    expect(full.importFile).to.equal(join(dir, 'preload.mjs'))
    expect(full.cpuProf).to.equal(true)
    expect(full.instruments).to.equal(true)
    expect(full.alarmS).to.equal(600)
  })

  it('refuses missing or production party ids without echoing them', () => {
    expect(usage(['--relay', relay, '--state', state]).code).to.equal('party-missing')
    for (const id of ['votetorrent', 'votetorrent-relay']) {
      const err = usage(['--relay', relay, '--state', state, '--party', id])
      expect(err.code).to.equal('party-production')
      expect(err.message).to.not.include('votetorrent')
      expect(JSON.stringify(err)).to.not.include('votetorrent')
    }
    for (const id of ['Bad_Party', 'ab', '_abc', 'a'.repeat(64), 'has space']) {
      const err = usage(['--relay', relay, '--state', state, '--party', id])
      expect(err.code).to.equal('party-shape')
      expect(err.message).to.not.include(id)
    }
    expect(parseRunElectionArgs([...base.slice(0, 4), '--party', 'votetorrent-dev-1']).party).to.equal('votetorrent-dev-1')
  })

  it('refuses a relative state dir, a state dir inside the repo and a used state dir', () => {
    expect(usage(['--relay', relay, '--party', 'vt-test-party']).code).to.equal('state-missing')
    expect(usage(['--relay', relay, '--state', 'relative/state', '--party', 'vt-test-party']).code).to.equal('state-relative')
    const inRepo = join(REPO_ROOT, 'vt-21-never-created-' + randomBytes(4).toString('hex'), 'state')
    expect(usage(['--relay', relay, '--state', inRepo, '--party', 'vt-test-party']).code).to.equal('state-in-repo')
    expect(existsSync(inRepo)).to.equal(false)
    expect(existsSync(join(inRepo, '..'))).to.equal(false)
    mkdirSync(join(state, 'ev'), { recursive: true })
    expect(usage(base).code).to.equal('state-used')
    rmSync(join(state, 'ev'), { recursive: true })
    expect(parseRunElectionArgs(base).stateDir).to.equal(state)
  })

  it('refuses an unreadable or group-writable relay.env', () => {
    expect(usage(['--state', state, '--party', 'vt-test-party']).code).to.equal('relay-missing')
    expect(usage(['--relay', join(dir, 'absent.env'), '--state', state, '--party', 'vt-test-party']).code).to.equal('relay-unreadable')
    chmodSync(relay, 0o620)
    expect(usage(base).code).to.equal('relay-unreadable')
    chmodSync(relay, 0o600)
    expect(usage(['--relay', 'relative.env', '--state', state, '--party', 'vt-test-party']).code).to.equal('relay-unreadable')
  })

  it('refuses an unknown flag, a positional word and malformed numbers', () => {
    expect(usage([...base, '--bogus', 'x']).code).to.equal('bad-flag')
    expect(usage([...base, 'election']).code).to.equal('bad-flag')
    expect(usage([...base, '--lead-ms']).code).to.equal('bad-flag')
    expect(usage([...base, '-x']).code).to.equal('bad-flag')
    expect(usage([...base, '--lead-ms', 'abc']).code).to.equal('lead-ms')
    expect(usage([...base, '--lead-ms', '59999']).code).to.equal('lead-ms')
    expect(usage([...base, '--lead-ms', '60000.5']).code).to.equal('lead-ms')
    expect(usage([...base, '--window-ms', '5']).code).to.equal('window-ms')
    expect(usage([...base, '--max-peers', '0']).code).to.equal('max-peers-shape')
    expect(usage([...base, '--max-peers', '10000']).code).to.equal('max-peers-shape')
    expect(usage([...base, '--max-peers', 'ten']).code).to.equal('max-peers-shape')
    expect(usage([...base, '--keyholders', '1']).code).to.equal('keyholders-min')
    expect(usage([...base, '--keyholders', '0']).code).to.equal('keyholders-min')
    expect(usage([...base, '--keyholders', '3']).code).to.equal('keyholders')
    expect(usage([...base, '--keyholders', 'two']).code).to.equal('keyholders')
    expect(usage([...base, '--voters', '0']).code).to.equal('voters')
    expect(usage([...base, '--voters', '10']).code).to.equal('voters')
    expect(usage([...base, '--alarm-s', '59']).code).to.equal('alarm-s')
    expect(usage([...base, '--marks-file', 'rel/marks.txt']).code).to.equal('marks-relative')
    expect(usage([...base, '--import', 'rel/preload.mjs']).code).to.equal('import-relative')
    const reduced = parseRunElectionArgs([...base, '--voters', '2'])
    expect(reduced.voters).to.equal(2)
    expect(reduced.reduced).to.equal(true)
    expect(peerLabels(reduced)).to.deep.equal(['officer', 'kh-a', 'kh-b', 'v1', 'v2'])
    expect(parseRunElectionArgs([...base, '--voters', '3']).reduced).to.equal(false)
    expect(parseRunElectionArgs([...base, '--voters', '9']).reduced).to.equal(false)
  })

  it('validates --colocate against the authority peers', () => {
    expect(parseRunElectionArgs([...base, '--colocate', 'officer,kh-a']).colocate).to.deep.equal(['officer', 'kh-a'])
    expect(parseRunElectionArgs([...base, '--colocate', 'kh-a,kh-b']).colocate).to.deep.equal(['kh-a', 'kh-b'])
    expect(usage([...base, '--colocate', 'officer']).code).to.equal('colocate')
    expect(usage([...base, '--colocate', 'officer,v1']).code).to.equal('colocate')
    expect(usage([...base, '--colocate', 'officer,officer']).code).to.equal('colocate')
    expect(usage([...base, '--colocate', 'officer,']).code).to.equal('colocate')
    expect(usage([...base, '--colocate', '']).code).to.equal('colocate')
    expect(usage([...base, '--colocate', 'officer,kh-c']).code).to.equal('colocate')
  })
})

describe('run: max-peers', () => {
  it('defaultMaxPeers is floor(0.45 * totalmem / 700 MiB)', () => {
    expect(PEER_RSS_BYTES).to.equal(734003200)
    expect(PEER_BUDGET_FRACTION).to.equal(0.45)
    expect(defaultMaxPeers(17179869184)).to.equal(10)
    expect(defaultMaxPeers(8589934592)).to.equal(5)
    expect(defaultMaxPeers(1073741824)).to.equal(0)
    expect(defaultMaxPeers()).to.be.a('number')
    expect(Number.isInteger(defaultMaxPeers())).to.equal(true)
  })

  it('assertPeerBudget refuses more peers than the budget with code max-peers', () => {
    expect(() => assertPeerBudget(5, 5)).to.not.throw()
    expect(() => assertPeerBudget(0, 0)).to.not.throw()
    try {
      assertPeerBudget(6, 5)
    } catch (err) {
      expect(err).to.be.instanceOf(PeerBudgetError)
      const e = err as PeerBudgetError
      expect(e.name).to.equal('PeerBudgetError')
      expect(e.code).to.equal('max-peers')
      expect(e.requested).to.equal(6)
      expect(e.max).to.equal(5)
      expect(e.message).to.equal('max-peers: requested 6 exceeds 5')
      return
    }
    expect.fail('assertPeerBudget did not throw')
  })

  it('an explicit --max-peers overrides the default and peerLabels counts every role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-run-maxpeers-'))
    try {
      const relay = join(dir, 'relay.env')
      writeRelayEnv(relay, ADDR)
      const base = ['--relay', relay, '--state', join(dir, 'state'), '--party', 'vt-test-party']
      expect(parseRunElectionArgs([...base, '--max-peers', '7']).maxPeers).to.equal(7)
      expect(parseRunElectionArgs([...base, '--max-peers', '9999']).maxPeers).to.equal(9999)
      expect(parseRunElectionArgs(base).maxPeers).to.equal(undefined)
      expect(peerLabels(parseRunElectionArgs(base))).to.have.length(6)
      expect(peerLabels(parseRunElectionArgs([...base, '--voters', '1']))).to.deep.equal(['officer', 'kh-a', 'kh-b', 'v1'])
      expect(peerLabels(parseRunElectionArgs([...base, '--colocate', 'officer,kh-a,kh-b']))).to.have.length(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
