import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_VERBS_VERB } from '../src/ctl/protocol.js'
import { EXIT } from '../src/cli/exit-codes.js'
import type { CliIo } from '../src/cli/run-cli.js'
import { createWallCounters, type ProbeSnapshot } from '../src/run/instruments/wall.js'
import type { RunInstruments } from '../src/run/instruments/run-instruments.js'
import { LEG_VERBS } from '../src/run/leg-verbs.js'
import { runVtCommand } from '../src/run/main.js'
import { classifyRun } from '../src/run/instruments/classify.js'
import { RELEASING_AFTER_ACCRUING_MS } from '../src/run/leg-bodies/election.js'
import { DURATION_KEYS } from '../src/run/results.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import { ElectionEvent } from '@votetorrent/vote-core'
import { buildCliTimeline } from '../src/election/parse-timeline.js'
import { runScriptedElection, type ScriptedRun, type ScriptedTable } from './support/scripted-launcher.js'

const COMMAND_RE = /^\S+Z [a-z0-9-]+ [a-z0-9-]+ ok=(true|false) ms=\d+$/
const LINES = ['network', 'h6-election', 'h7-accept', 'h8-dkg', 'h9-voters', 'h10-release-decrypt']

describe('run: election wiring (scripted daemons)', function () {
  this.timeout(60000)
  const dirs: string[] = []
  const state = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-wiring-'))
    dirs.push(dir)
    return join(dir, 'state')
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const commands = (r: ScriptedRun): string[] => readFileSync(join(r.evDir, 'commands.log'), 'utf8').split('\n').filter((l) => l.length > 0)

  it('the wired table runs six legs in order and passes on a scripted happy path', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    expect(r.code).to.equal(0)
    expect(r.stdout.at(-1)).to.equal('SUMMARY PASS')
    expect(r.results.summary).to.equal('PASS')
    expect(r.results.legs.map((l: any) => l.leg)).to.deep.equal(LINES)
    expect(r.results.legs.every((l: any) => l.status === 'PASS')).to.equal(true)
    expect(r.launcher.startedLabels).to.include.members(['officer', 'kh-a', 'kh-b', 'v1', 'v2', 'v3'])
    expect(r.stderr).to.equal('')
  })

  it('every leg calls only verbs from the leg-verb adapter and the command log records names and ms only', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    const allowed = new Set<string>([...Object.values(LEG_VERBS).map((e) => e.verb), BUILTIN_VERBS_VERB, 'stop'])
    const lines = commands(r)
    expect(lines.length).to.be.greaterThan(50)
    for (const line of lines) {
      expect(COMMAND_RE.test(line), line).to.equal(true)
      expect(line).to.not.include('/')
      expect(line).to.not.include('token')
      expect(allowed.has(line.split(' ')[2]!)).to.equal(true)
    }
    for (const call of r.launcher.calls) expect(allowed.has(call.verb)).to.equal(true)
  })

  it('durations carries all 13 profile keys and steps carry the profile window names', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    expect(Object.keys(r.results.durations)).to.have.members([...DURATION_KEYS])
    const names = r.results.steps.map((s: any) => s.name)
    for (const name of ['reopen', 'h6-election', 'h7-accept', 'h8-dkg', 'h9-voters-active', 'release', 'tally']) {
      expect(names, name).to.include(name)
    }
    for (const n of [1, 2, 3]) for (const part of ['read', 'decide', 'publish']) expect(names).to.include(`approve${n}-${part}`)
    expect(names.some((n: string) => n.includes('/'))).to.equal(true)
  })

  it('the officer loop approves each pending request once, prints APPROVE lines and stops at 3 approvals and 3 associations', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    const approvals = r.launcher.calls.filter((c) => c.verb === 'approve')
    expect(approvals).to.have.length(3)
    expect(new Set(approvals.map((c) => c.args.request)).size).to.equal(3)
    const approveLines = r.stdout.filter((l) => / APPROVE  registration \d+ readMs=\d+ decideMs=\d+ publishMs=\d+ publish=published$/.test(l))
    expect(approveLines).to.have.length(3)
    expect(approveLines.map((l) => l.match(/registration (\d+)/)?.[1])).to.deep.equal(['1', '2', '3'])
    expect(r.launcher.calls.filter((c) => c.verb === 'peer-sync').length).to.be.at.least(2)
  })

  it('refuse is exercised as the D-07 negative control and must come back checklist-incomplete', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    const refusals = r.launcher.calls.filter((c) => c.verb === 'refuse')
    expect(refusals).to.have.length(1)
    expect(refusals[0]!.args.checklist).to.equal('none')
    const ok = commands(r).filter((l) => l.includes(' refuse '))
    expect(ok).to.have.length(1)
    expect(ok[0]).to.include(' ok=false ')
    const override: ScriptedTable = { 'officer.refuse': () => ({ ok: true, result: { published: 'published' }, ms: 2 }) }
    const bad = await runScriptedElection({ stateDir: state(), overrides: override })
    expect(bad.code).to.equal(1)
    expect(bad.stdout.at(-1)).to.equal('SUMMARY FAIL h9-voters refuse-gate')
  })

  it('results identity writes one RESULTS key per peer and RESULTS-IDENTICAL, and a differing peer fails results-identity', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    for (const label of ['OFFICER', 'KH-A', 'KH-B', 'V1', 'V2', 'V3']) {
      expect(r.results.keys[`RESULTS-${label}`], label).to.match(/^tag=[0-9a-f]{12} status=tallied valid=3 counts=1\/2$/)
    }
    expect(r.results.keys['RESULTS-IDENTICAL']).to.match(/^peers=6 tag=[0-9a-f]{12} equal=true$/)
    // the same counts under another agreement hash (a differing root) must still fail, as must a reply without one
    const same = { status: 'tallied', valid: 3, invalid: 0, excluded: 0, counts: [1, 2] }
    for (const result of [{ ...same, agreementSha256: '12'.repeat(32) }, same]) {
      const override: ScriptedTable = { 'v2.results': () => ({ ok: true, result, ms: 3 }) }
      const bad = await runScriptedElection({ stateDir: state(), overrides: override })
      expect(bad.code).to.equal(1)
      expect(bad.stdout.at(-1)).to.equal('SUMMARY FAIL h10-release-decrypt results-identity')
      expect(bad.results.keys['RESULTS-IDENTICAL']).to.include('equal=false')
    }
    const split: ScriptedTable = {
      'officer.tally': () => ({ ok: true, result: { valid: 3, invalid: 0, excluded: 0, blockCount: 2 }, ms: 3 })
    }
    const twoBlocks = await runScriptedElection({ stateDir: state(), overrides: split })
    expect(twoBlocks.stdout.at(-1)).to.equal('SUMMARY FAIL h10-release-decrypt block')
  })

  it('a missing verb in a daemon\'s verbs listing fails the network leg with verb-missing', async () => {
    const override: ScriptedTable = {
      'kh-b.verbs': () => ({ ok: true, result: { role: 'keyholder', verbs: ['join', 'accept', 'release', 'results', 'readback', 'stop', 'capability', 'verbs'] }, ms: 2 })
    }
    const r = await runScriptedElection({ stateDir: state(), overrides: override })
    expect(r.code).to.equal(1)
    expect(r.stdout.at(-1)).to.equal('SUMMARY FAIL network verb-missing')
    expect(r.results.legs).to.have.length(1)
  })

  it('approval tokens are minted per peer into secrets and only their paths reach a daemon', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    const values: string[] = []
    for (const label of ['officer', 'kh-a', 'kh-b', 'v1', 'v2', 'v3']) {
      const path = join(r.stateDir, 'secrets', `${label}.token`)
      expect(statSync(path).mode & 0o777).to.equal(0o600)
      values.push(readFileSync(path, 'utf8').trim())
    }
    expect(new Set(values).size).to.equal(6)
    for (const call of r.launcher.calls) {
      if (typeof call.args.tokenFile === 'string') expect(call.args.tokenFile).to.match(/\/secrets\/[a-z0-9-]+\.token$/)
    }
    const logText = commands(r).join('\n')
    for (const value of values) expect(logText).to.not.include(value)
    expect(logText).to.not.include('/')
    expect(r.results.keys['HANDOFF-TOKEN-FILES']).to.equal('kh-a=secrets/kh-a.token kh-b=secrets/kh-b.token')
  })

  it('voters send only after votingStarts and all three sends run concurrently', async () => {
    const r = await runScriptedElection({ stateDir: state() })
    const electionKey = r.results.keys['ELECTION'] ?? ''
    const starts = /votingStartsAt=(\S+)/.exec(electionKey)?.[1] ?? ''
    const votingStarts = Date.parse(starts)
    expect(Number.isFinite(votingStarts)).to.equal(true)
    const sends = r.launcher.calls.filter((c) => c.verb === 'send')
    expect(sends).to.have.length(3)
    for (const t of r.launcher.sendTimes) expect(t).to.be.at.least(votingStarts)
    expect(r.launcher.maxActiveCalls).to.be.at.least(3)
    const cast = r.launcher.calls.filter((c) => c.verb === 'cast')
    // a cast before the window opens is refused by eligibility, and a release before releasingKeys by the window
    for (const c of cast) expect(Date.parse(c.iso)).to.be.at.least(votingStarts)
    const releaseAt = Date.parse(/releasingKeysAt=(\S+)/.exec(electionKey)?.[1] ?? '')
    expect(releaseAt).to.equal(votingStarts + 480000 + 120000)
    // the leg's rule is the verb's own timeline rule
    const built = buildCliTimeline({ now: 0, leadMs: 600000, windowMs: 480000 })
    expect(built.timeline[ElectionEvent.releasingKeys]).to.equal(built.votingStarts + 480000 + RELEASING_AFTER_ACCRUING_MS)
    for (const c of r.launcher.calls.filter((x) => x.verb === 'release' || x.verb === 'release-window')) {
      expect(Date.parse(c.iso)).to.be.at.least(releaseAt)
    }
    expect(Object.fromEntries(cast.map((c) => [c.label, c.args.choiceIndex]))).to.deep.equal({ v1: '0', v2: '0', v3: '1' })
  })

  it('a run without --instruments writes no wall key and keeps inScriptD14 OFF, and with --instruments writes wall and a measured reading', async () => {
    const plain = await runScriptedElection({ stateDir: state() })
    expect(plain.results).to.not.have.property('wall')
    expect(plain.results.legs.every((l: any) => l.inScriptD14 === 'OFF')).to.equal(true)
    const wall = createWallCounters()
    const probe: ProbeSnapshot = { installed: true, calls: 6, maxBytes: 128, oversized: 0 }
    const stub: RunInstruments = {
      wall,
      async forkPrecheck () { return { line: 'FORK-PRECHECK vt PASS rounds=2', pass: true, token: '' } },
      async probeSnapshot () { return probe },
      async lateFromCrashLogs () {},
      async wallForResults () {
        return { probe: { installed: true, calls: 6, maxRequestBytes: 128, oversized: 0 }, paths: { hidden: 0, thrown: 0, late: 0 }, forkPrechecks: [], classify: {} }
      },
      async writeClassify () {}
    }
    const measured = await runScriptedElection({ stateDir: state(), extra: ['--instruments'], instrumentsFactory: () => stub })
    expect(measured.code).to.equal(0)
    expect(measured.results).to.have.property('wall')
    expect(Object.keys(measured.results.wall)).to.have.members(['probe', 'paths', 'forkPrechecks', 'classify'])
    expect(measured.results.legs[0]).to.include({ inScriptD14: 'CLEAN', reason: 'no-wall-signal' })
    expect(classifyRun(readFileSync(join(measured.evDir, 'network', 'wall-leg.log'), 'utf8')).cls).to.equal('CLEAN')
  })

  it('--keyholders 1 is refused at parse time with exit 2 and never spawns a daemon', async () => {
    const dir = state()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const relayEnv = join(dir, 'relay.env')
    writeRelayEnv(relayEnv, '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWSyntheticRe1ayPeerXyzABCDEFGHJKMNPQRSTUVWxyz')
    let err = ''
    const io: CliIo = { out: () => {}, err: (t) => { err += t } }
    const before = randomBytes(4).toString('hex')
    const code = await runVtCommand(['run', 'election', '--relay', relayEnv, '--state', join(dir, 'state'), '--party', `vt-kh-${before}`, '--keyholders', '1'], io)
    expect(code).to.equal(EXIT.USAGE)
    expect(code).to.equal(2)
    expect(err).to.include('vt run: keyholders-')
    expect(existsSync(join(dir, 'state'))).to.equal(false)
  })

  it('--voters 1 runs the reduced leg set to key release: h9 stops after associated, h10 releases both shares, SUMMARY PASS, TOPOLOGY and HANDOFF keys written', async () => {
    const r = await runScriptedElection({ stateDir: state(), voters: 1 })
    expect(r.code).to.equal(0)
    expect(r.stdout.at(-1)).to.equal('SUMMARY PASS')
    expect(r.results.legs.every((l: any) => l.status === 'PASS')).to.equal(true)
    expect(r.results.keys['TOPOLOGY']).to.equal('reduced voters=1 skipped=cast,send,pool,tally,publish,results')
    expect(r.results.keys['HANDOFF-NETWORK']).to.match(/^networkHash=[0-9a-f]{32}$/)
    expect(r.results.keys['HANDOFF-ELECTION']).to.match(/^electionId=.+/)
    const lines = commands(r).join('\n')
    for (const verb of ['cast', 'send', 'tally', 'publish', 'results']) expect(lines).to.not.include(` ${verb} `)
    expect(r.launcher.calls.filter((c) => c.verb === 'release')).to.have.length(2)
    expect(Date.parse(r.launcher.calls.find((c) => c.verb === 'release')!.iso))
      .to.be.at.least(Date.parse(/releasingKeysAt=(\S+)/.exec(r.results.keys['ELECTION'] ?? '')?.[1] ?? ''))
    expect(r.results.durations).to.not.have.property('poolMs')
    expect(r.results.durations).to.not.have.property('decryptMs')
    expect(r.results.durations).to.not.have.property('voterResultsMs')
    for (const label of ['kh-a', 'kh-b']) {
      const token = readFileSync(join(r.stateDir, 'secrets', `${label}.token`), 'utf8').trim()
      expect(r.results.keys['HANDOFF-TOKEN-FILES']).to.not.include(token)
    }
    expect(r.results.keys).to.not.have.property('RESULTS-OFFICER')
  })
})
