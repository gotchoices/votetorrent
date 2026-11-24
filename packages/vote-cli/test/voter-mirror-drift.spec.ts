// voter-mirror-drift.spec.ts (67-29 Task 1): pins the CLI voter's two TEMPORARY mirrors (the peer-branch
// transport composition and the four-outcome registration status read), the one-call registration-code
// mint and the attempt store's key and record fields against the Voter app's SOURCE TEXT. It reads both
// sides with readFileSync (it never imports an app file), strips comments and compares extracted shapes,
// so a change on either side goes red here until the mirror is updated or, better, replaced by the shared
// extraction 67-33's no-mirror audit requires.

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VOTER_ENGINES = join(REPO_ROOT, 'apps', 'VoteTorrentVoter', 'src', 'engines')
const CLI_VOTER = join(REPO_ROOT, 'packages', 'vote-cli', 'src', 'verbs', 'voter')

const APP_TRANSPORTS = join(VOTER_ENGINES, 'voter-request-transports.ts')
const APP_STATUS = join(VOTER_ENGINES, 'registration-status.ts')
const APP_CONTINUITY = join(VOTER_ENGINES, 'continuity.ts')
const APP_ATTEMPT_STORE = join(VOTER_ENGINES, 'registration-attempt-store.ts')
const CLI_TRANSPORTS = join(CLI_VOTER, 'voter-transports.ts')
const CLI_STATUS = join(CLI_VOTER, 'registration-status.ts')
const CLI_DEPS = join(CLI_VOTER, 'voter-deps.ts')
const CLI_ATTEMPT_STORE = join(CLI_VOTER, 'voter-attempt-store.ts')

/** Drops block comments, full-line comments and trailing ` // ...` (a `//` inside a path string is kept). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/[^\n]*$/, ''))
    .join('\n')
}

function source(path: string): string {
  return stripComments(readFileSync(path, 'utf8'))
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()

/** The text between the `(` that follows `marker` and its matching `)`. */
function callBody(text: string, marker: string): string {
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`${marker} not found`)
  let i = text.indexOf('(', at + marker.length - 1)
  if (text[at + marker.length - 1] === '(') i = at + marker.length - 1
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(i + 1, j)
    }
  }
  throw new Error(`${marker} never closes`)
}

/** The sorted top-level keys of the object literal passed to `new <Ctor>({ ... })`. */
function constructorOptionKeys(text: string, ctor: string): string[] {
  const body = callBody(text, `new ${ctor}(`).trim()
  if (!body.startsWith('{') || !body.endsWith('}')) throw new Error(`${ctor} is not given one object literal`)
  const inner = body.slice(1, -1)
  const keys: string[] = []
  let depth = 0
  let current = ''
  const push = (): void => {
    const entry = current.trim()
    if (entry.length === 0) return
    const colon = entry.indexOf(':')
    keys.push((colon < 0 ? entry : entry.slice(0, colon)).trim())
    current = ''
  }
  for (const ch of inner) {
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      push()
      continue
    }
    current += ch
  }
  push()
  return keys.sort()
}

function restCondition(text: string): string {
  const m = /if\s*\(([^\n]*isValidRestBridgeUrl[^\n]*)\)\s*\{/.exec(text)
  if (m === null) throw new Error('REST condition not found')
  return squash(m[1]!)
}

function orderedCalls(text: string, names: readonly string[]): string[] {
  const re = new RegExp(`\\b(${names.join('|')})\\b`, 'g')
  const out: string[] = []
  for (const m of text.matchAll(re)) out.push(m[1]!)
  return out
}

function statusLiterals(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const m of text.matchAll(/status\s*===\s*'([a-z])'/g)) counts[m[1]!] = (counts[m[1]!] ?? 0) + 1
  return counts
}

/** The body of a top-level `function <name>` (sync or async). */
function functionBody(text: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = re.exec(text)
  if (m === null) throw new Error(`function ${name} not found`)
  const open = text.indexOf('{', m.index + m[0].length)
  // skip the parameter list and the return type: find the first `{` after the matching `)` of the params
  let depth = 0
  let paramsEnd = -1
  for (let j = m.index + m[0].length - 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        paramsEnd = j
        break
      }
    }
  }
  const bodyOpen = text.indexOf('{', Math.max(open, paramsEnd))
  depth = 0
  for (let j = bodyOpen; j < text.length; j++) {
    const ch = text[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(bodyOpen + 1, j)
    }
  }
  throw new Error(`function ${name} never closes`)
}

/** The depth-0 entries of an object literal's inner text (between its braces). */
function topLevelEntries(inner: string): string[] {
  const entries: string[] = []
  let depth = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      if (current.trim().length > 0) entries.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim().length > 0) entries.push(current.trim())
  return entries
}

/** The text between the first `{` at or after `from` and its matching `}`. */
function braceBody(text: string, from: number): string {
  const open = text.indexOf('{', from)
  let depth = 0
  for (let j = open; j < text.length; j++) {
    const ch = text[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(open + 1, j)
    }
  }
  throw new Error('object literal never closes')
}

/** An entry's key: `key: value`, a shorthand `key`, or every `key:` inside a `...(spread)`. */
function entryKeys(entry: string): string[] {
  if (entry.startsWith('...')) return [...entry.matchAll(/\{\s*([A-Za-z]+)\s*:/g)].map((m) => m[1]!)
  const colon = entry.indexOf(':')
  return [(colon < 0 ? entry : entry.slice(0, colon)).trim()]
}

/** The keys of the object literal returned by `stripRecord` (top level, and the `association` sub-object). */
function stripRecordKeys(text: string): { top: string[], association: string[] } {
  const body = functionBody(text, 'stripRecord')
  const returned = braceBody(body, body.indexOf('return'))
  const entries = topLevelEntries(returned)
  const top = entries.flatMap(entryKeys)
  const assocEntry = entries.find((e) => /^association\s*:/.test(e))
  if (assocEntry === undefined) throw new Error('association entry not found')
  const association = topLevelEntries(braceBody(assocEntry, assocEntry.indexOf(':'))).flatMap(entryKeys)
  return { top: [...new Set(top)].sort(), association: [...new Set(association)].sort() }
}

function stringConstant(text: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(text)
  if (m === null) throw new Error(`${name} not found`)
  return m[1]!
}

describe('voter mirror drift', () => {
  it('the transport composition matches the Voter peer branch', () => {
    const app = source(APP_TRANSPORTS)
    const cli = source(CLI_TRANSPORTS)
    expect(readFileSync(CLI_TRANSPORTS, 'utf8')).to.include('TEMPORARY mirror')
    expect(constructorOptionKeys(cli, 'P2pAssociationTransport')).to.deep.equal(constructorOptionKeys(app, 'P2pAssociationTransport'))
    expect(constructorOptionKeys(cli, 'P2pRegistrationTransport')).to.deep.equal(constructorOptionKeys(app, 'P2pRegistrationTransport'))
    expect(constructorOptionKeys(cli, 'P2pAssociationTransport')).to.deep.equal(['computeAttestationDigest', 'computeDigest', 'openStrand', 'sealer', 'strandId'])
    expect(squash(callBody(cli, 'createIntakeSealer('))).to.equal(squash(callBody(app, 'createIntakeSealer(')))
    expect(squash(callBody(cli, 'readIntakePolicyFrom('))).to.equal(squash(callBody(app, 'readIntakePolicyFrom(')))
    expect(restCondition(cli)).to.equal(restCondition(app))
    // the app's order: query port, sealer, association transport, policy read, then the registration route
    const order = (t: string): string[] => orderedCalls(t, ['intakeQueryPortFromStrandPort', 'createIntakeSealer', 'new P2pAssociationTransport', 'readIntakePolicyFrom', 'new P2pRegistrationTransport']).filter((x, i, a) => a.indexOf(x) === i)
    const appOrder = order(app.slice(app.indexOf('async resolve(')))
    const cliOrder = order(cli.slice(cli.indexOf('export async function createCliVoterRequestTransports')))
    expect(cliOrder).to.deep.equal(appOrder)
  })

  it('the registration status read makes the Voter\'s engine calls in the Voter\'s order with the same status literals', () => {
    const names = ['getAssociationsByDeviceKey', 'getRegistrant', 'getDeviceRetirement', 'listAssociationRequestsByDeviceKey', 'ownAssociationRequestIds', 'pollDecisions']
    const app = functionBody(source(APP_STATUS), 'resolveRegistrationStatus')
    const cli = functionBody(source(CLI_STATUS), 'readVoterRegistrationStatus')
    expect(orderedCalls(cli, names)).to.deep.equal(orderedCalls(app, names))
    expect(orderedCalls(cli, names)).to.include.members(names)
    expect(statusLiterals(cli)).to.deep.equal(statusLiterals(app))
    expect(statusLiterals(cli)).to.deep.equal({ a: 2, p: 2, c: 2 })
    // the two recorded deviations, and nothing else: no console in the CLI mirror, no network name in its result
    expect(/console\./.test(cli)).to.equal(false)
    expect(/networkName/.test(cli)).to.equal(false)
    expect(readFileSync(CLI_STATUS, 'utf8')).to.include('TEMPORARY mirror')
  })

  it('the registration-code mint is the Voter\'s one call', () => {
    const app = functionBody(source(APP_CONTINUITY), 'mintRegistrationCodeForSubmit')
    const cli = functionBody(source(CLI_DEPS), 'mintVoterRegistrationCode')
    const reduce = (body: string): string[] => {
      const out: string[] = []
      for (const m of body.matchAll(/getEngine(?:<[A-Za-z]+>)?\(\s*'([a-z]+)'\s*\)|deriveRegistrationCode\(\s*(registrantId)\s*,\s*(sign)\s*\)/g)) {
        out.push(m[1] !== undefined ? `getEngine('${m[1]}')` : `deriveRegistrationCode(${m[2]}, ${m[3]})`)
      }
      return out
    }
    expect(reduce(cli)).to.deep.equal(reduce(app))
    expect(reduce(cli)).to.deep.equal(["getEngine('association')", 'deriveRegistrationCode(registrantId, sign)'])
    expect(/\bcatch\b/.test(cli)).to.equal(false)
  })

  it('the attempt store key and record fields match the Voter\'s store', () => {
    const app = source(APP_ATTEMPT_STORE)
    const cli = source(CLI_ATTEMPT_STORE)
    expect(stringConstant(cli, 'VOTER_ATTEMPT_KV_KEY')).to.equal(stringConstant(app, 'REGISTRATION_ATTEMPT_KEY'))
    const appKeys = stripRecordKeys(app)
    const cliKeys = stripRecordKeys(cli)
    expect(cliKeys.top).to.deep.equal(appKeys.top)
    expect(cliKeys.association).to.deep.equal(appKeys.association)
    expect(cliKeys.top).to.deep.equal(['association', 'authorityId', 'deviceKey', 'electionId', 'identityKey', 'registrantId', 'registrationStaged', 'registrationSubmittedAt', 'version'])
    expect(cliKeys.association).to.deep.equal(['authorityId', 'deviceKey', 'electionId', 'id', 'registrantId', 'submittedAt'])
  })
})
