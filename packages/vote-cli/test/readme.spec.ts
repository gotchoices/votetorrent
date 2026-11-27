import { expect } from 'chai'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVAL_TOKEN_ENV } from '../src/approval/token.js'
import {
  PRODUCTION_PARTY_ID,
  TOKEN_ATTESTATION_MARKER,
  TokenAttestationError,
  assertTokenAttestationPosture
} from '../src/attestation/marker.js'
import { BUILTIN_VERBS_VERB, ROLES, VERB_NAME_RE } from '../src/ctl/protocol.js'
import { DEFAULT_KEY_VAULT_STORAGE_FILE, DEFAULT_VAULT_DIR } from '../src/vault/device-vault.js'
import { DEVICE_KEY_FILES } from '../src/vault/device-keys.js'
import { CTL_PORT_FILE, CTL_TOKEN_FILE } from '../src/ctl/protocol.js'
import { RUN_MARK_NAMES } from '../src/run/output.js'
import { RESULTS_KEYS } from '../src/run/results.js'
import { RunUsageError, parseRunElectionArgs } from '../src/run/options.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import { OFFICER_VERB_ENTRIES } from '../src/verbs/officer/registry.js'
import { KEYHOLDER_VERB_ENTRIES } from '../src/verbs/keyholder/registry.js'
import { VOTER_VERB_ENTRIES } from '../src/verbs/voter/registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const README_PATH = join(HERE, '..', 'README.md')
// A scratch README can be pointed here for RED controls; no repo file is ever
// written with planted content.
const OVERRIDE = process.env.VT_README_OVERRIDE

const REGISTRIES = {
  officer: OFFICER_VERB_ENTRIES,
  keyholder: KEYHOLDER_VERB_ENTRIES,
  voter: VOTER_VERB_ENTRIES
}

const HEADINGS = [
  '## Local relay (loopback, automated tier)',
  '## Relay tiers',
  '## Roles and daemons',
  '## Verbs',
  '## vt run election',
  '## State layout',
  '## Approval token',
  '## Test postures',
  '## Parallel runs',
  '## Secrecy',
  '## Shared workflow code',
  '## Exit codes',
  '## Build freshness'
]

function readme (): string {
  return readFileSync(OVERRIDE ?? README_PATH, 'utf8')
}

function section (text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === heading)
  if (start < 0) return ''
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

// The peer marker is assembled from fragments so this spec never holds it whole.
const PEER_PREFIX = '12D' + '3Koo'

describe('readme', () => {
  it('the section headings appear once in order', () => {
    const text = readme()
    for (const heading of HEADINGS) {
      expect(text.split('\n').filter((line) => line === heading), heading).to.have.lengthOf(1)
    }
    const lines = text.split('\n')
    const first = lines.findIndex((line) => line.startsWith('## '))
    expect(lines[first]).to.equal(HEADINGS[0])
    expect(lines.slice(0, 12)).to.include(HEADINGS[0])
  })

  it('the verb table equals the per-role registries', () => {
    const rows = section(readme(), '## Verbs')
      .split('\n')
      .map((line) => /^\|\s*(officer|keyholder|voter)\s*\|\s*`([a-z0-9-]+)`\s*\|/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ role: m[1]!, verb: m[2]! }))
    const pairs = rows.map((r) => `${r.role} ${r.verb}`)
    expect(new Set(pairs).size, 'duplicate table rows').to.equal(pairs.length)
    for (const row of rows) expect(VERB_NAME_RE.test(row.verb), row.verb).to.equal(true)
    for (const role of ROLES) {
      const actual = rows.filter((r) => r.role === role).map((r) => r.verb).sort()
      const expected = Object.keys(REGISTRIES[role])
        .filter((name) => name !== BUILTIN_VERBS_VERB)
        .sort()
      const missing = expected.filter((name) => !actual.includes(name))
      const extra = actual.filter((name) => !expected.includes(name))
      expect(missing, `missing verbs for ${role}`).to.deep.equal([])
      expect(extra, `extra verbs for ${role}`).to.deep.equal([])
    }
  })

  it('the state layout names every file constant', () => {
    const text = section(readme(), '## State layout')
    const names = [
      CTL_PORT_FILE,
      CTL_TOKEN_FILE,
      DEFAULT_VAULT_DIR,
      DEFAULT_KEY_VAULT_STORAGE_FILE,
      ...Object.values(DEVICE_KEY_FILES),
      'results.json',
      'driver.log',
      'debug.log',
      'secrets/'
    ]
    for (const name of names) expect(text, name).to.include(name)
  })

  it('the run grammar names the results keys and marks', () => {
    const text = section(readme(), '## vt run election')
    for (const key of RESULTS_KEYS) expect(text, key).to.include(key)
    for (const name of RUN_MARK_NAMES) expect(text, name).to.include(name)
    expect(text).to.include('RUN-MARK')
    expect(text).to.include('SUMMARY PASS')
    expect(text).to.include('SUMMARY FAIL <leg> <token>')
  })

  it('the token-attestation posture claim is true', () => {
    let error: unknown
    try {
      assertTokenAttestationPosture({
        acceptTokenAttestations: true,
        partyId: PRODUCTION_PARTY_ID
      })
    } catch (err) {
      error = err
    }
    expect(error).to.be.instanceOf(TokenAttestationError)
    expect((error as TokenAttestationError).code).to.equal('production-party')
    const text = section(readme(), '## Test postures')
    expect(text).to.include('--accept-token-attestations')
    expect(text).to.include('TEST')
    expect(text).to.include(PRODUCTION_PARTY_ID)
  })

  it('the run party claim is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-readme-'))
    try {
      const relay = join(dir, 'relay.env')
      const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER_PREFIX}FixtureFixtureFixtureFixture1`
      writeRelayEnv(relay, addr)
      const argv = [
        '--relay', relay,
        '--state', join(dir, 'state'),
        '--party', PRODUCTION_PARTY_ID
      ]
      expect(() => parseRunElectionArgs(argv)).to.throw(RunUsageError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the requireSignedSchemas sentence is accurate', () => {
    const paragraphs = section(readme(), '## Test postures').split('\n').filter((line) => line.trim() !== '')
    const named = paragraphs.filter((p) => p.includes('requireSignedSchemas'))
    expect(named).to.have.lengthOf(1)
    const paragraph = named[0]
    expect(paragraph).to.not.include('no app')
    expect(paragraph).to.not.include('test-only switch')
  })

  it('no secret-shaped value appears anywhere in the README', () => {
    const text = readme()
    const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
    const homePath = /(?:\/Users|\/home)\//
    const joinCode = new RegExp('vt' + 'join' + '\\d\\.[^<]')
    const phaseNumber = new RegExp('Ph' + 'ase \\d')
    const planId = new RegExp('6' + '7-\\d{2}')
    const envAssignment = new RegExp(APPROVAL_TOKEN_ENV + '=\\s*[^<]')
    const checks: Array<[string, RegExp]> = [
      ['64-hex', /[0-9a-fA-F]{64}/],
      ['base64 run', /[A-Za-z0-9+/_=-]{43,}/],
      ['peer id', new RegExp(PEER_PREFIX)],
      ['p2p suffix', /\/p2p\//],
      ['dns address', /\/dns/],
      ['home path', homePath],
      ['url', /https?:\/\//],
      ['join code', joinCode],
      ['phase number', phaseNumber],
      ['plan id', planId],
      ['env assignment', envAssignment]
    ]
    for (const [name, re] of checks) expect(re.test(text), name).to.equal(false)
    const addresses = text.match(ipv4) ?? []
    expect(addresses.every((a) => a === '127.0.0.1'), 'non-loopback IPv4').to.equal(true)
    expect(text.includes(TOKEN_ATTESTATION_MARKER), 'whole marker').to.equal(false)
  })
})
