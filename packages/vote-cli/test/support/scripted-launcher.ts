// The scripted launcher stand-in: a launcherFactory with the real launcher's shape that spawns nothing.
// Replies come from a table keyed <role>.<verb> (or <label>.<verb> for a per-peer override); every call
// appends one argument-free formatCommandLine line to ev/commands.log, and stage() writes STAGE lines.
// The clock is injected by the test, so timeline waits are instant and observable.

import { randomBytes } from 'node:crypto'
import { canonicalizeVerificationChecklist, isChecklistGateMet } from '@votetorrent/vote-core'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeRelayEnv } from '../../src/relay/relay-env.js'
import {
  formatCommandLine,
  roleForLabel,
  type DaemonHandle,
  type DaemonLauncher,
  type DaemonLauncherOptions,
  type DaemonSpec
} from '../../src/run/daemon-launcher.js'
import { runElection } from '../../src/run/election.js'
import type { RunOptions } from '../../src/run/options.js'
import { parseRunElectionArgs } from '../../src/run/options.js'

const RELAY_ADDR = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWSyntheticRe1ayPeerXyzABCDEFGHJKMNPQRSTUVWxyz'
const HASH = 'ab'.repeat(16)
const AUTHORITY_ID = 'cd'.repeat(4)
const JOINT_TAG = '0123456789abcdef'
const AGREEMENT = 'ef'.repeat(32)

const SERVED: Record<string, string[]> = Object.freeze({
  officer: [
    'readback', 'stop', 'capability', 'found', 'join', 'mint', 'owner-setup', 'authority-id', 'dashboard-code',
    'create-election', 'keyholder-policy', 'invite-keyholder', 'ballot-submit', 'task-sign',
    'enable-intake', 'peer-sync', 'approve', 'refuse', 'registrations',
    'release-window', 'tally', 'publish', 'results', 'verbs'
  ],
  keyholder: ['readback', 'stop', 'capability', 'join', 'accept', 'dkg', 'release', 'results', 'verbs'],
  voter: [
    'readback', 'stop', 'join', 'register', 'stage-association', 'answer-challenge', 'read-decision',
    'cast', 'send', 'results', 'verbs'
  ]
})

export interface ScriptedCall {
  readonly iso: string
  readonly label: string
  readonly role: string
  readonly verb: string
  readonly args: Record<string, unknown>
}

export interface ScriptedReply {
  readonly ok?: boolean
  readonly result?: Record<string, unknown>
  readonly error?: { name: string, code?: string, message: string }
  readonly ms?: number
}

export type ScriptedHandler = (call: ScriptedCall) => ScriptedReply | Promise<ScriptedReply>
export type ScriptedEntry = ScriptedReply | ScriptedHandler
export type ScriptedTable = Record<string, ScriptedEntry>


const reply = (result: Record<string, unknown> = {}, ms = 2): ScriptedReply => ({ ok: true, result, ms })
const refused = (code: string): ScriptedReply => ({ ok: false, error: { name: 'VerbRefusal', code, message: `intake verb refused (${code})` }, ms: 2 })

/** The happy-path table, with the daemon-side file writes the leg bodies must register. */
export function happyScript (opts: {
  stateDir: string
  target: number
  nowMs: () => number
}): ScriptedTable {
  const secretsDir = join(opts.stateDir, 'secrets')
  const pending = new Set(['req-1', 'req-2', 'req-3'])
  const approved = new Set<string>()
  const sendTimes: number[] = []
  const startMs = opts.nowMs() + 600000
  const iso = (ms: number): string => new Date(ms).toISOString()
  const write = (name: string, text: string): string => {
    const path = join(secretsDir, name)
    writeFileSync(path, text + '\n', { flag: 'w', mode: 0o600 })
    return path
  }
  const associations = (): number => (approved.size >= opts.target ? opts.target : approved.size)
  // the timeline rule of the real create-election verb: releasingKeys = starts + window + 120 s
  const releaseAt = startMs + 480000 + 120000
  const windowClosed = (code: string): ScriptedReply => ({ ok: false, error: { name: 'VerbRefusal', code, message: `verb refused (${code})` }, ms: 2 })
  const results = (): ScriptedReply => reply({
    status: 'tallied', valid: 3, invalid: 0, excluded: 0, counts: [1, 2],
    blockCount: 1, openedCount: 3, agreementSha256: AGREEMENT
  }, 3)

  return {
    'officer.verbs': (c) => reply({ role: 'officer', verbs: [...(SERVED['officer'] ?? [])] }),
    'keyholder.verbs': (c) => reply({ role: 'keyholder', verbs: [...(SERVED['keyholder'] ?? [])] }),
    'voter.verbs': (c) => reply({ role: 'voter', verbs: [...(SERVED['voter'] ?? [])] }),

    'officer.found': () => reply({ networkHash: HASH, networkHash8: HASH.slice(0, 8), createMs: 8, posture: 'test' }, 8),
    'officer.owner-setup': () => reply({ capabilityBefore: 'none', capabilityAfter: 'ready', ownerCount: 1, ownerIsIdentity: true }),
    'officer.capability': () => reply({ capability: 'ready' }),
    'officer.authority-id': () => reply({ networkHash8: HASH.slice(0, 8), authorityId8: AUTHORITY_ID, count: 1 }),
    'officer.dashboard-code': (c) => {
      const codeFile = String(c.args.codeFile)
      write(basename(codeFile), 'vt-dashboard-code-script-0001')
      return reply({ codeFile, chars: 25, expiresAt: opts.nowMs() + 3600000 })
    },
    'officer.mint': (c) => {
      const codeFile = String(c.args.codeFile)
      const fingerprintFile = String(c.args.fingerprintFile)
      write(basename(codeFile), `vt-code-script-${basename(codeFile)}`)
      write(basename(fingerprintFile), 'vt-fingerprint-script')
      return reply({ codeFile, fingerprintFile, chars: 25, v: 2 })
    },
    'keyholder.join': () => reply({ outcome: 'joined', joined: true, isJoinedNetwork: true, joinMs: 5, steps: 2 }),
    'officer.enable-intake': () => reply({ state: 'enabled', changed: true }),
    'officer.create-election': () => reply({
      electionId: 'election-script-0001', authorityId8: AUTHORITY_ID, title: 'vt-election', threshold: 2, seats: 2,
      votingStartsAt: iso(startMs), closedAt: iso(startMs + 480000 + 360000),
      electionCount: 1, signatures: 2, ms: 4
    }, 4),
    'officer.keyholder-policy': () => reply({ mode: 'read', electionId: 'election-script-0001', threshold: 2, seats: 2, invitedSeats: 2 }),
    'officer.invite-keyholder': (c) => {
      const shareName = String(c.args.shareName ?? `seat-${String(c.args.name)}`)
      const shareFile = write(`${shareName}.share`, JSON.stringify({ vt: 'script-seat', name: c.args.name }))
      return reply({ electionId: 'election-script-0001', name: c.args.name, invitedSeats: 2, shareFile, signatures: 1 })
    },
    'officer.ballot-submit': () => {
      const needleFile = write('ballot-needle.txt', 'vt-needle-script-0001')
      return reply({ electionId: 'election-script-0001', ballotId: 'ballot-script-1', questions: 1, options: 2, needleFile, confirmed: false, signatures: 0 }, 3)
    },
    'officer.task-sign': () => reply({ electionId: 'election-script-0001', ballotId: 'ballot-script-1', accepted: true, confirmed: true, signatures: 1, waitMs: 0 }, 5),
    'officer.peer-sync': () => reply({
      imported: pending.size, pending: pending.size, errors: 0,
      associations: { before: associations(), after: associations() }, challenges: 3,
      attestation: { posture: 'token' }, refusals: []
    }),
    'officer.registrations': () => reply({
      posture: 'token', intake: 'enabled', attestationRows: { elections: 1, skipping: 0 },
      counts: { pending: pending.size, approved: approved.size, rejected: 0, other: 0, challenges: 3, associations: associations() },
      rows: [...pending].map((requestId) => ({ requestId, status: 'p', issuerType: 'd' })),
      truncated: false
    }),
    // the real D-07 gate: a checklist that meets it refuses the request for good
    'officer.refuse': (c) => {
      const items = canonicalizeVerificationChecklist(String(c.args.checklist).split(','))
      if (!isChecklistGateMet(items)) return refused('checklist-incomplete')
      const requestId = String(c.args.request)
      pending.delete(requestId)
      return reply({ requestId, published: 'published' })
    },
    'officer.approve': (c) => {
      const requestId = String(c.args.request)
      pending.delete(requestId)
      approved.add(requestId)
      return reply({ requestId, published: 'published', readMs: 1, decideMs: 2, publishMs: 3 })
    },
    'keyholder.accept': () => reply({ accepted: true, attempts: 1, acceptUnwraps: 0, election8: 'election', userId8: AUTHORITY_ID }),
    'keyholder.dkg': () => reply({ phase: 'complete', hasShare: true, jointKeyTag: JOINT_TAG, threshold: 2, participants: 2, drives: 3, actions: 5, dkgUnwraps: 10 }, 6),
    'officer.release-window': () => opts.nowMs() < releaseAt
      ? windowClosed('window-not-open')
      : reply({ electionId: 'election-script-0001', releasingKeysAt: iso(releaseAt), waitedMs: 0, phase: 'releasing', releasedCount: 0, rejected: 0, preRelease: { checked: true, blocks: 1 }, statusReads: 1 }, 2),
    'keyholder.release': () => opts.nowMs() < releaseAt
      ? windowClosed('window-not-open')
      : reply({ released: true, alreadyReleased: false, releasedCount: 2, rejected: 0, releaseUnwraps: 2 }, 3),
    'officer.tally': () => reply({
      electionId: 'election-script-0001', revision: 1, status: 'tallied', blockCount: 1,
      valid: 3, invalid: 0, excluded: 0, counts: [1, 2], tallyRoot8: 'aabbccdd', blockRoot8: 'ddeeffaa',
      openedCount: 3, openedFailures: 0, signatures: 0, tallyMs: 4, decryptMs: 4
    }, 4),
    'officer.publish': () => reply({ electionId: 'election-script-0001', revision: 1, outcome: 'published', publishedAt: iso(opts.nowMs()), tallyRoot8: 'aabbccdd', rows: 1, signatures: 1, publishMs: 3 }, 3),
    'officer.results': results,
    'keyholder.results': results,
    'voter.results': results,

    'voter.join': () => reply({ joined: true, outcome: 'joined', networkHash: HASH, admittedVia: 'redeemed', steps: 3 }),
    'voter.register': () => reply({ milestone: 'registration-staged', registrantId: 'req-1', deviceKeyTag: JOINT_TAG, steps: 2 }),
    'voter.stage-association': () => reply({ milestone: 'association-staged', registrantId: 'req-1', associationRequestId: 'assoc-1', steps: 2 }),
    'voter.read-decision': (c) => {
      if (c.args.waitFor === 'challenge' && approved.size >= 1) return reply({ status: 'pending', associationDecision: 'c', attempt: 'stored', polls: 1 })
      if (c.args.waitFor === 'registered' && approved.size >= opts.target) return reply({ status: 'registered', associationDecision: 'a', attempt: 'stored', polls: 1 })
      return reply({ status: 'pending', associationDecision: 'none', attempt: 'stored', polls: 1 })
    },
    'voter.answer-challenge': () => reply({ outcome: 'answered', challengeStatus: 'c', steps: 1 }),
    'voter.cast': (c) => {
      if (opts.nowMs() < startMs) return windowClosed('ineligible:window-closed')
      const name = `vote-choice-${c.label}-${String(c.args.election)}.json`
      const choiceFile = write(name, JSON.stringify([{ ballotId: 'ballot-script-1', answers: [{ questionCode: 'vt-q1', optionCodes: ['vt-opt'] }] }]))
      return reply({ electionId: 'election-script-0001', ballots: ['ballot-script-1'], choiceFile, castUnwraps: 1, tokenReads: 3, castMs: 3 }, 3)
    },
    'voter.send': () => {
      sendTimes.push(opts.nowMs())
      return reply({ electionId: 'election-script-0001', ballots: [{ ballotId: 'ballot-script-1', phase: 'sent' }], committed: 1, tokenReads: 2, sendMs: 4 }, 4)
    },

    'officer.stop': () => reply({}),
    'keyholder.stop': () => reply({}),
    'voter.stop': () => reply({})
  }
}

function withReadbacks (table: ScriptedTable): ScriptedTable {
  const out = { ...table }
  for (const role of ['officer', 'keyholder', 'voter']) {
    out[`${role}.readback`] = (c: ScriptedCall) => reply({
      role, label: c.label, peerId8: 'deadbeef', bootN: 1, circuitReady: true,
      recentCount: 1, rssMb: 350, heapUsedMb: 120, acceptTokenAttestations: role === 'officer'
    })
  }
  return out
}

export class ScriptedLauncher implements DaemonLauncher {
  readonly calls: ScriptedCall[] = []
  readonly startedLabels: string[] = []
  readonly restarted: string[] = []
  readonly sendTimes: number[] = []
  readonly commands: string[] = []
  readonly table: ScriptedTable
  maxActiveCalls = 0
  private active = 0
  private readonly handles = new Map<string, DaemonHandle>()
  private readonly commandsPath: string

  constructor (readonly options: DaemonLauncherOptions, table: ScriptedTable) {
    this.table = withReadbacks(table)
    this.commandsPath = join(options.evDir, 'commands.log')
    mkdirSync(options.evDir, { recursive: true, mode: 0o700 })
  }

  private handlerFor (label: string, verb: string): ScriptedEntry | undefined {
    const specific = this.table[`${label}.${verb}`]
    if (specific !== undefined) return specific
    return this.table[`${roleForLabel(label)}.${verb}`]
  }

  private makeHandle (label: string): DaemonHandle {
    return {
      label,
      role: roleForLabel(label),
      kind: roleForLabel(label) === 'voter' ? 'voter' : 'authority',
      dir: join(this.options.stateDir, this.options.party, label),
      pid: 1,
      instrDir: join(this.options.stateDir, this.options.party, label, 'instruments'),
      call: async (verb, args = {}, o = {}) => {
        const now = this.options.nowMs?.() ?? Date.now()
        const iso = new Date(now).toISOString()
        const call: ScriptedCall = { iso, label, role: roleForLabel(label), verb, args }
        this.calls.push(call)
        this.active++
        this.maxActiveCalls = Math.max(this.maxActiveCalls, this.active)
        const handler = this.handlerFor(label, verb)
        try {
          const value = typeof handler === 'function' ? await handler(call) : handler
          const out = value ?? refused('no-script')
          const ok = out.ok !== false
          const ms = out.ms ?? 2
          appendFileSync(this.commandsPath, formatCommandLine({ iso, label, verb, ok, ms }) + '\n')
          this.commands.push(formatCommandLine({ iso, label, verb, ok, ms }))
          if (ok) return { ok: true, result: out.result ?? {}, ms }
          return { ok: false, error: out.error ?? { name: 'ScriptedRefusal', code: 'no-script', message: 'no script' }, unreachable: false, ms }
        } finally {
          if (verb === 'send') this.sendTimes.push(now)
          this.active--
        }
      },
      stage: (name) => {
        appendFileSync(join(this.options.evDir, `${label}.log`), `STAGE ${name}\n`)
      }
    }
  }

  async start (spec: DaemonSpec): Promise<DaemonHandle> {
    for (const label of spec.labels) {
      if (!this.startedLabels.includes(label)) this.startedLabels.push(label)
      this.handles.set(label, this.makeHandle(label))
    }
    return this.handles.get(spec.label) as DaemonHandle
  }

  handle (label: string): DaemonHandle | undefined {
    return this.handles.get(label)
  }

  async restart (label: string): Promise<DaemonHandle> {
    this.restarted.push(label)
    return this.handles.get(label) ?? this.makeHandle(label)
  }

  async stopAll (): Promise<{ stopped: number, killed: number }> {
    for (const label of this.startedLabels) {
      const h = this.handles.get(label)
      if (h !== undefined) await h.call('stop')
    }
    return { stopped: this.startedLabels.length, killed: 0 }
  }

  startedCount (): number {
    return new Set(this.startedLabels).size
  }

  verbsFor (label: string): string[] {
    return [...(SERVED[roleForLabel(label)] ?? [])]
  }
}

export interface ScriptedRunInput {
  stateDir: string
  party?: string
  voters?: number
  extra?: string[]
  overrides?: ScriptedTable
  onLauncher?: (launcher: ScriptedLauncher) => void
  instrumentsFactory?: Parameters<typeof runElection>[1]['instrumentsFactory']
}

export interface ScriptedRun {
  code: number
  stdout: string[]
  stderr: string
  stateDir: string
  evDir: string
  launcher: ScriptedLauncher
  clock: { now: number }
  results: Record<string, any>
}

/** Runs the wired ELECTION_LEGS against the scripted launcher with an injected, instantly advancing clock. */
export async function runScriptedElection (input: ScriptedRunInput): Promise<ScriptedRun> {
  const relayEnv = join(input.stateDir, 'relay.env')
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 })
  writeRelayEnv(relayEnv, RELAY_ADDR)
  const clock = { now: 1700000000000 }
  const argv = [
    '--relay', relayEnv,
    '--state', input.stateDir,
    '--party', input.party ?? 'vt-script-' + randomBytes(3).toString('hex'),
    '--voters', String(input.voters ?? 3),
    ...(input.extra ?? [])
  ]
  const opts: RunOptions = parseRunElectionArgs(argv)
  const target = opts.voters >= 3 ? 3 : opts.voters
  let launcher: ScriptedLauncher | undefined
  let stdoutText = ''
  let stderrText = ''
  const io = {
    out: (text: string) => { stdoutText += text },
    err: (text: string) => { stderrText += text }
  }
  const code = await runElection(opts, {
    io,
    assertFresh: () => {},
    nowMs: () => clock.now,
    sleepMs: async (ms) => { clock.now += ms },
    launcherFactory: (launcherOptions) => {
      launcher = new ScriptedLauncher(launcherOptions, happyScript({ stateDir: input.stateDir, target, nowMs: () => clock.now }))
      if (input.overrides !== undefined) Object.assign(launcher.table, input.overrides)
      input.onLauncher?.(launcher)
      return launcher
    },
    ...(input.instrumentsFactory !== undefined ? { instrumentsFactory: input.instrumentsFactory } : {})
  })
  const stdout = stdoutText.split('\n')
  if (stdout.at(-1) === '') stdout.pop()
  const evDir = join(input.stateDir, 'ev')
  const results = JSON.parse(readFileSync(join(evDir, 'results.json'), 'utf8'))
  return { code, stdout, stderr: stderrText, stateDir: input.stateDir, evDir, launcher: launcher as ScriptedLauncher, clock, results }
}
