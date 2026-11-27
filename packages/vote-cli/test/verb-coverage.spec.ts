import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_VERBS_VERB } from '../src/ctl/protocol.js'
import { LEG_VERBS } from '../src/run/leg-verbs.js'
import {
  CLI01_VERB_INVENTORY,
  NOT_IN_RUN,
  SUPPORT_VERBS,
  checkCommandsLogCoverage,
  parseCommandsLog
} from '../src/run/verb-inventory.js'
import { OFFICER_VERB_ENTRIES } from '../src/verbs/officer/registry.js'
import { KEYHOLDER_VERB_ENTRIES } from '../src/verbs/keyholder/registry.js'
import { VOTER_VERB_ENTRIES } from '../src/verbs/voter/registry.js'
import { hostTierEnabled } from './support/host-tier.js'
import { runScriptedElection } from './support/scripted-launcher.js'

const REGISTRIES = {
  officer: OFFICER_VERB_ENTRIES,
  keyholder: KEYHOLDER_VERB_ENTRIES,
  voter: VOTER_VERB_ENTRIES
} as const

describe('run: verb coverage', function () {
  this.timeout(60000)
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const scripted = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-coverage-'))
    dirs.push(dir)
    return runScriptedElection({ stateDir: join(dir, 'state') })
  }

  it('the CLI-01 inventory names every workflow from REQUIREMENTS CLI-01 and CONTEXT workflow coverage', () => {
    const counts: Record<string, number> = { officer: 0, keyholder: 0, voter: 0 }
    for (const e of CLI01_VERB_INVENTORY) counts[e.role] = (counts[e.role] ?? 0) + 1
    expect(counts).to.deep.equal({ officer: 20, keyholder: 5, voter: 8 })
    const pairs = CLI01_VERB_INVENTORY.map((e) => `${e.role} ${e.verb}`)
    expect(new Set(pairs).size).to.equal(pairs.length)
    // the inventory is derived from the landed registries: every registered verb except the daemon support verbs
    const support = (role: string, verb: string): boolean => verb === 'readback' || verb === 'stop' || verb === 'capability'
    const registered = (['officer', 'keyholder', 'voter'] as const)
      .flatMap((role) => Object.keys(REGISTRIES[role]).filter((v) => !support(role, v)).map((v) => `${role} ${v}`))
    expect(pairs).to.have.members(registered)
    // the CONTEXT workflow-coverage list, by name
    for (const pair of [
      'officer found', 'officer mint', 'officer create-election', 'officer keyholder-policy', 'officer invite-keyholder',
      'officer ballot-submit', 'officer task-sign', 'officer enable-intake', 'officer approve', 'officer refuse',
      'officer peer-sync', 'officer release-window', 'officer tally', 'officer publish', 'officer results',
      'officer dashboard-code', 'keyholder join', 'keyholder accept', 'keyholder dkg', 'keyholder release',
      'voter join', 'voter register', 'voter stage-association', 'voter answer-challenge', 'voter read-decision',
      'voter cast', 'voter send', 'voter results'
    ]) expect(pairs).to.include(pair)
    expect(CLI01_VERB_INVENTORY.find((e) => e.verb === 'refuse')?.runUse).to.equal('negative-control')
    for (const e of CLI01_VERB_INVENTORY) expect(e.source).to.include('REQUIREMENTS CLI-01')
  })

  it('every inventory verb is registered in its role\'s registry', () => {
    for (const e of CLI01_VERB_INVENTORY) {
      expect(REGISTRIES[e.role], `${e.role} ${e.verb}`).to.have.property(e.verb)
    }
  })

  it('every registered verb is in the inventory, the support list or the reasoned not-in-run list', () => {
    for (const role of ['officer', 'keyholder', 'voter'] as const) {
      for (const verb of Object.keys(REGISTRIES[role])) {
        const classified =
          CLI01_VERB_INVENTORY.some((e) => e.role === role && e.verb === verb) ||
          SUPPORT_VERBS.some((e) => e.role === role && e.verb === verb) ||
          NOT_IN_RUN.some((e) => e.role === role && e.verb === verb)
        expect(classified, `${role} ${verb}`).to.equal(true)
      }
    }
    expect(SUPPORT_VERBS.some((e) => e.verb === BUILTIN_VERBS_VERB)).to.equal(true)
    expect(NOT_IN_RUN.find((e) => e.role === 'officer' && e.verb === 'join')?.reason).to.include('one-officer')
    // only a verb listed not-in-run may be excused from coverage, and it is never called by the run
    const excused = CLI01_VERB_INVENTORY.filter((e) => e.runUse === 'not-in-run').map((e) => `${e.role} ${e.verb}`)
    expect(excused).to.deep.equal(['officer join'])
    for (const e of excused) expect(NOT_IN_RUN.map((n) => `${n.role} ${n.verb}`)).to.include(e)
    expect(Object.values(LEG_VERBS).some((e) => NOT_IN_RUN.some((n) => n.role === e.role && n.verb === e.verb))).to.equal(false)
  })

  it('the leg-verb adapter uses only registered verbs', () => {
    for (const [key, e] of Object.entries(LEG_VERBS)) {
      expect(REGISTRIES[e.role], key).to.have.property(e.verb)
    }
  })

  it('checkCommandsLogCoverage reports every inventory verb missing from a command log', async () => {
    const r = await scripted()
    const log = parseCommandsLog(readFileSync(join(r.evDir, 'commands.log'), 'utf8')).filter((l) => l.verb !== 'send')
    const result = checkCommandsLogCoverage(log)
    expect(result.missing).to.deep.equal(['voter send'])
    expect(result.unexpectedOk).to.deep.equal([])
  })

  it('the scripted run\'s command log exercises every inventory verb', async () => {
    const r = await scripted()
    const log = parseCommandsLog(readFileSync(join(r.evDir, 'commands.log'), 'utf8'))
    const covered = checkCommandsLogCoverage(log)
    expect(covered.missing).to.deep.equal([])
    expect(covered.unexpectedOk).to.deep.equal([])
    expect(log.some((l) => l.verb === 'refuse' && !l.ok)).to.equal(true)
  })

  it('the recorded loopback run\'s command log exercises every inventory verb', async function () {
    const dir = process.env.VT_COVERAGE_RUN_DIR
    if (!hostTierEnabled() || dir === undefined || !dir.startsWith('/')) this.skip()
    const log = parseCommandsLog(readFileSync(join(dir, 'ev', 'commands.log'), 'utf8'))
    const covered = checkCommandsLogCoverage(log)
    expect(covered.missing).to.deep.equal([])
    expect(covered.unexpectedOk).to.deep.equal([])
  })
})
