// The REQUIREMENTS CLI-01 workflow inventory and the command-log coverage rule. Every workflow pair is
// tied to a REQUIREMENTS/CONTEXT name; registered verbs that are not UI workflows are SUPPORT_VERBS,
// and registered verbs the run never calls are NOT_IN_RUN with a reason (officer `join` is one).

import { BUILTIN_VERBS_VERB, type Role } from '../ctl/protocol.js'
import { roleForLabel } from './daemon-launcher.js'

export type InventorySource = 'REQUIREMENTS CLI-01 + CONTEXT workflow coverage (locked)'

export interface InventoryEntry {
  readonly workflow: string
  readonly role: Role
  readonly verb: string
  readonly source: InventorySource
  readonly runUse: string
}

export interface SupportEntry {
  readonly role: Role | 'builtin'
  readonly verb: string
  readonly source: string
}

export interface NotInRunEntry {
  readonly role: Role
  readonly verb: string
  readonly reason: string
}

const SOURCE: InventorySource = 'REQUIREMENTS CLI-01 + CONTEXT workflow coverage (locked)'

function entry (workflow: string, role: Role, verb: string, runUse = 'workflow'): InventoryEntry {
  return Object.freeze({ workflow, role, verb, source: SOURCE, runUse })
}

export const CLI01_VERB_INVENTORY: readonly InventoryEntry[] = Object.freeze([
  // officer, 16
  entry('found network', 'officer', 'found'),
  entry('mint join code', 'officer', 'mint'),
  entry('create election', 'officer', 'create-election'),
  entry('keyholder policy', 'officer', 'keyholder-policy'),
  entry('invite keyholders', 'officer', 'invite-keyholder'),
  entry('ballot submit', 'officer', 'ballot-submit'),
  entry('ballot sign', 'officer', 'task-sign'),
  entry('enable encrypted intake', 'officer', 'enable-intake'),
  entry('approve registration', 'officer', 'approve'),
  entry('refuse registration', 'officer', 'refuse', 'negative-control'),
  entry('peer sync', 'officer', 'peer-sync'),
  entry('release window', 'officer', 'release-window'),
  entry('tally', 'officer', 'tally'),
  entry('publish', 'officer', 'publish'),
  entry('read results', 'officer', 'results'),
  entry('mint dashboard code', 'officer', 'dashboard-code'),
  // keyholder, 4
  entry('join network', 'keyholder', 'join'),
  entry('accept invitation', 'keyholder', 'accept'),
  entry('drive DKG', 'keyholder', 'dkg'),
  entry('release share', 'keyholder', 'release'),
  // voter, 8
  entry('join with code', 'voter', 'join'),
  entry('register', 'voter', 'register'),
  entry('stage association', 'voter', 'stage-association'),
  entry('answer challenge', 'voter', 'answer-challenge'),
  entry('read decision', 'voter', 'read-decision'),
  entry('build and sign vote', 'voter', 'cast'),
  entry('pool and send', 'voter', 'send'),
  entry('read results', 'voter', 'results')
])

export const SUPPORT_VERBS: readonly SupportEntry[] = Object.freeze([
  Object.freeze({ role: 'builtin', verb: BUILTIN_VERBS_VERB, source: '67-12 built-in listing on every role' }),
  Object.freeze({ role: 'officer', verb: 'capability', source: '67-23 common authority verb; owner capability read in the network leg' }),
  Object.freeze({ role: 'officer', verb: 'owner-setup', source: '67-24 network setup, not a UI workflow' }),
  Object.freeze({ role: 'officer', verb: 'authority-id', source: '67-24 network read, not a UI workflow' }),
  Object.freeze({ role: 'officer', verb: 'registrations', source: '67-27 intake read feeding the officer loop' }),
  Object.freeze({ role: 'keyholder', verb: 'results', source: '67-30 keyholder results read for peer agreement' }),
  Object.freeze({ role: 'keyholder', verb: 'capability', source: '67-23 common authority verb on the keyholder role' }),
  Object.freeze({ role: 'officer', verb: 'readback', source: '67-23 common verb; peer readiness and RSS' }),
  Object.freeze({ role: 'keyholder', verb: 'readback', source: '67-23 common verb; peer readiness and RSS' }),
  Object.freeze({ role: 'voter', verb: 'readback', source: '67-23 common verb; peer readiness and RSS' }),
  Object.freeze({ role: 'officer', verb: 'stop', source: '67-23 common verb; called by the launcher' }),
  Object.freeze({ role: 'keyholder', verb: 'stop', source: '67-23 common verb; called by the launcher' }),
  Object.freeze({ role: 'voter', verb: 'stop', source: '67-23 common verb; called by the launcher' })
])

export const NOT_IN_RUN: readonly NotInRunEntry[] = Object.freeze([
  Object.freeze({ role: 'officer', verb: 'join', reason: 'a one-officer election has no second officer; proven by 67-24 ctl test' })
])

export interface CommandLogLine {
  readonly iso: string
  readonly label: string
  readonly verb: string
  readonly ok: boolean
  readonly ms: number
}

const LINE_RE = /^(\S+) ([a-z0-9-]+) ([a-z0-9-]+) ok=(true|false) ms=(\d+)$/

/** Parses the launcher's argument-free command log; a line outside the grammar throws. */
export function parseCommandsLog (text: string): CommandLogLine[] {
  const out: CommandLogLine[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const m = LINE_RE.exec(line)
    if (m === null) throw new TypeError('verb-inventory: bad-command-line')
    out.push(Object.freeze({ iso: m[1]!, label: m[2]!, verb: m[3]!, ok: m[4] === 'true', ms: Number(m[5]) }))
  }
  return out
}

export interface CoverageResult {
  readonly missing: string[]
  readonly unexpectedOk: string[]
}

/** Every inventory pair needs an ok=true line; a negative-control pair needs ok=false and never ok=true. */
export function checkCommandsLogCoverage (
  log: readonly CommandLogLine[],
  inventory: readonly InventoryEntry[] = CLI01_VERB_INVENTORY
): CoverageResult {
  const roleOf = (label: string): Role | null => {
    try {
      return roleForLabel(label)
    } catch {
      return null
    }
  }
  const missing: string[] = []
  const unexpectedOk: string[] = []
  for (const item of inventory) {
    const pair = `${item.role} ${item.verb}`
    const lines = log.filter((l) => l.verb === item.verb && roleOf(l.label) === item.role)
    const okTrue = lines.some((l) => l.ok)
    const okFalse = lines.some((l) => !l.ok)
    if (item.runUse === 'negative-control') {
      if (!okFalse) missing.push(pair)
      if (okTrue) unexpectedOk.push(pair)
    } else if (!okTrue) {
      missing.push(pair)
    }
  }
  return { missing, unexpectedOk }
}
