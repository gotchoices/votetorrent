// officer-results-verbs.spec.ts: every refusal path of release-window, tally, publish and results against FAKE
// engines (recording every call), a fake established context whose `db.eval` answers the three SQL reads, an
// injected clock and sleep, and a REAL device vault holding a secp256k1 officer key provisioned under a real
// token file, plus a wrong token. Nothing here prints a token, a needle, a choice text, a share or a key; the
// last case scans every reply and refusal message for them.
import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { provisionTokenSigningKey } from '../src/approval/signer.js'
import { createApprovalContext, writeApprovalTokenFile } from '../src/approval/token.js'
import { buildCliTimeline } from '../src/election/parse-timeline.js'
import { AUTHORITY_SIGNING_ALIAS } from '../src/network/authority-user.js'
import type { OpenedSetSeams } from '../src/proof/opened-set-check.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { ensurePrivateDir } from '../src/vault/private-file.js'
import type { OpenedElectionNetwork } from '../src/verbs/officer/election-deps.js'
import { runPublish, type PublishSeams } from '../src/verbs/officer/publish.js'
import { OFFICER_VERB_ENTRIES } from '../src/verbs/officer/registry.js'
import { runReleaseWindow, type ReleaseWindowSeams } from '../src/verbs/officer/release-window.js'
import { openEstFor, runResults, type OfficerResultsDeps, type ResultsVerbSeams } from '../src/verbs/officer/results.js'
import { OFFICER_RESULTS_VERB_NAMES, OFFICER_RESULTS_VERBS } from '../src/verbs/officer/results-verbs.js'
import { runTally, type TallySeams } from '../src/verbs/officer/tally.js'
import { KEYHOLDER_VERB_ENTRIES } from '../src/verbs/keyholder/registry.js'
import { KEYHOLDER_RESULTS_VERBS } from '../src/verbs/keyholder/results-verbs.js'
import { assertNoLeak } from './support/vault-leak-check.js'

const HASH = randomBytes(16).toString('hex')
const ELECTION = 'election-1700000000000'
const AUTHORITY = 'authority-' + randomBytes(8).toString('hex')
const T0 = 1_700_000_000_000
const NEEDLE = 'vt-needle-' + randomBytes(5).toString('hex')
const OPT_B = 'vt-opt-b'

interface Coded { name?: string, code?: string, message?: string }

async function refusal (p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a refusal')
}

type Run = (deps: OfficerResultsDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>

function entry (code: string, nonce = randomBytes(32).toString('hex')): string {
  return JSON.stringify({ v: 1, electionId: ELECTION, electionRevision: 3, ballotId: 'b-1', templateDigest: 'td', answers: [{ questionCode: 'q1', optionCodes: [code] }], nonce })
}

function tallied (counts: Record<string, number>, valid = 3): Record<string, unknown> {
  return {
    status: 'tallied',
    electionId: ELECTION,
    revision: 3,
    threshold: 2,
    keyholdersUsed: 2,
    blockCount: 1,
    totals: { blocks: 1, entries: valid, valid, invalid: 0, excluded: 0 },
    ballots: [{ ballotId: 'b-1', description: '', votes: valid, valid, invalid: 0, excluded: 0, questions: [{ code: 'q1', title: 'Q', type: 'select', counted: true, answered: valid, blank: 0, options: Object.entries(counts).map(([code, count]) => ({ code, title: code, count })) }] }],
    tallyRoot: 'r'.repeat(64),
    blockRoot: 'b'.repeat(64),
    tally: { electionId: ELECTION, electionRevision: 3, root: 'r'.repeat(64) }
  }
}

interface World {
  calls: string[]
  deps: OfficerResultsDeps
  clock: { now: number }
  sleeps: number[]
  timeline: unknown
  status: { phase: string, revision: number | null, releasedCount: number, rejectedReleases: unknown[] }
  statusSequence: Array<Partial<World['status']>>
  blocks: Array<{ Id: string, BallotId: string, Ciphertext: string, ElectionRevision: number }>
  decryptOk: boolean
  votes: string[]
  failIndex: number
  results: Record<string, unknown>
  publishOutcome: Record<string, unknown>
  publication: unknown
  signs: number
  lastSecret: Uint8Array | null
  tallyRows: number
  tokenFile: string
  wrongTokenFile: string
  secretsDir: string
  observed: unknown[]
  seams: { release: ReleaseWindowSeams, tally: TallySeams, publish: PublishSeams, results: ResultsVerbSeams }
  device: DeviceVault
  close(): void
}

async function makeWorld (opts: { party?: string } = {}): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'vt-30o-'))
  const device = openDeviceVault({ home })
  const secretsDir = join(home, 'secrets')
  ensurePrivateDir(secretsDir)
  const tokenFile = join(secretsDir, 'officer.token')
  const wrongTokenFile = join(secretsDir, 'wrong.token')
  writeApprovalTokenFile(tokenFile)
  writeApprovalTokenFile(wrongTokenFile)
  const { publicKey } = await provisionTokenSigningKey({ vault: device.vault, token: createApprovalContext({ file: tokenFile }), curve: 'secp256k1', alias: AUTHORITY_SIGNING_ALIAS })
  const calls: string[] = []
  const w = {} as World
  const timeline = buildCliTimeline({ now: T0, leadMs: 600_000, windowMs: 480_000 }).timeline
  const est = {
    db: {
      eval: async function * (sql: string, params: Record<string, unknown>): AsyncGenerator<unknown> {
        calls.push('sql:' + (/from (\w+)/.exec(sql)?.[1] ?? '?'))
        if (sql.includes('from ElectionRevision')) {
          if (w.timeline !== null) yield { tl: JSON.stringify(w.timeline) }
          return
        }
        if (sql.includes('from VoteBlock')) {
          for (const b of w.blocks) if (params.revision === undefined || b.ElectionRevision === params.revision) yield b
          return
        }
        if (sql.includes('from ElectionTally')) {
          yield { n: w.tallyRows }
          return
        }
        throw new Error('unexpected sql')
      }
    }
  } as unknown as EngineContext
  const network: OpenedElectionNetwork = {
    electionsEngine: {} as never,
    tasksEngine: {} as never,
    authorityId: AUTHORITY,
    openElection: async (id) => {
      calls.push('openElection')
      if (id !== ELECTION) throw Object.assign(new Error('officer verb refused (election-unknown)'), { name: 'VerbRefusal', code: 'election-unknown' })
      return {} as never
    },
    countKeyholderInviteSlots: async () => 2
  }
  const deps: OfficerResultsDeps = {
    partyId: opts.party ?? 'vt-test-30',
    secretsDir,
    secrets: new SecretRegistry(),
    vault: device.vault,
    officer: { userId: 'officer-' + randomBytes(4).toString('hex'), signingKeyAlias: AUTHORITY_SIGNING_ALIAS, signerKey: publicKey },
    now: () => w.clock.now,
    writeKey: {},
    openNetwork: async (hash) => {
      calls.push('openNetwork')
      if (hash !== HASH) throw Object.assign(new Error('officer verb refused (network-unknown)'), { name: 'VerbRefusal', code: 'network-unknown' })
      return network
    },
    openEst: async () => {
      calls.push('openEst')
      return est
    }
  }
  const keyRelease = () => ({
    getKeyReleaseStatus: async () => {
      calls.push('getKeyReleaseStatus')
      const next = w.statusSequence.shift()
      if (next !== undefined) w.status = { ...w.status, ...next }
      return w.status
    },
    decryptElectionBlocks: async (_id: string, blocks: ReadonlyArray<{ blockId: string }>) => {
      calls.push('decryptElectionBlocks')
      return blocks.map((b, i) => ({ ok: w.decryptOk && i === 0, blockId: b.blockId, reason: 'not-reconstructable', detail: '' }))
    },
    reconstructElectionKey: async () => {
      calls.push('reconstructElectionKey')
      w.lastSecret = new Uint8Array(32).fill(7)
      return { secretKey: w.lastSecret, revision: 3, jointPublicKey: 'jpk' }
    }
  })
  const openedSet: OpenedSetSeams = {
    keyRelease: keyRelease as never,
    openBlock: ((_sk: Uint8Array, _ek: unknown, block: { blockId: string }) => ({ ok: true, blockId: block.blockId, payload: { v: 2, votes: w.votes, voterRecords: [] } })) as never,
    openEntries: ((_sk: Uint8Array, _ek: unknown, _ballotId: string, payload: { votes: string[] }) => payload.votes.map((v, i) => (i === w.failIndex ? { ok: false, reason: 'authentication-failed', detail: 'no plaintext' } : { ok: true, voteEntryJson: v }))) as never,
    now: () => w.clock.now
  }
  const resultsEngine = () => ({ getElectionResults: async () => { calls.push('getElectionResults'); return w.results } })
  const publication = () => ({
    publishElectionTally: async (_tally: unknown, publisher: { sign: (d: Uint8Array) => Promise<unknown> }) => {
      calls.push('publishElectionTally')
      await publisher.sign(randomBytes(32))
      w.signs++
      return w.publishOutcome
    }
  })
  const engines = () => async <T>(name: string): Promise<T> => {
    calls.push('engine:' + name)
    if (name === 'elections') return { getElections: async () => [{ id: ELECTION, date: T0 }] } as T
    if (name === 'electionResults') return resultsEngine() as T
    if (name === 'tallyPublication') return { readPublishedTally: async () => w.publication } as T
    throw new Error('unexpected engine ' + name)
  }
  Object.assign(w, {
    calls,
    deps,
    clock: { now: T0 },
    sleeps: [],
    timeline,
    status: { phase: 'releasing', revision: 3, releasedCount: 0, rejectedReleases: [] },
    statusSequence: [],
    blocks: [{ Id: 'blk-1', BallotId: 'b-1', Ciphertext: JSON.stringify({ v: 1, ct: 'opaque-' + randomBytes(24).toString('hex') }), ElectionRevision: 3 }],
    decryptOk: false,
    votes: [entry(OPT_B), entry(NEEDLE), entry(OPT_B)],
    failIndex: -1,
    results: tallied({ [NEEDLE]: 1, [OPT_B]: 2 }),
    publishOutcome: { outcome: 'published', electionId: ELECTION, revision: 3, tallyRoot: 'r'.repeat(64), blockRoot: 'b'.repeat(64), publishedAt: new Date(T0).toISOString() },
    publication: null,
    signs: 0,
    lastSecret: null,
    tallyRows: 1,
    tokenFile,
    wrongTokenFile,
    secretsDir,
    observed: [],
    device,
    seams: {
      release: { keyRelease: keyRelease as never, sleep: async (ms: number) => { w.sleeps.push(ms); w.clock.now += ms }, now: () => w.clock.now, awaitBoundMs: 180_000 },
      tally: { resultsEngine, openedSet },
      publish: { resultsEngine, publication: publication as never },
      results: { engines, openedSet, sleep: async (ms: number) => { w.sleeps.push(ms); w.clock.now += ms }, now: () => w.clock.now }
    },
    close: () => {
      device.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
  return w
}

function choiceFile (dir: string, name: string, codes: string[], mode = 0o600): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify([{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: codes }] }]) + '\n', { mode })
  chmodSync(p, mode)
  return p
}

function needleFile (dir: string, text = NEEDLE): string {
  const p = join(dir, 'needle.txt')
  writeFileSync(p, text + '\n', { mode: 0o600 })
  chmodSync(p, 0o600)
  return p
}

describe('officer results verbs', function () {
  this.timeout(60_000)
  let w: World
  const observed: unknown[] = []
  const record = <T>(v: T): T => {
    observed.push(v)
    return v
  }
  const runs: Record<string, (w: World, args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    'release-window': (w, a) => runReleaseWindow(w.deps, a, w.seams.release),
    tally: (w, a) => runTally(w.deps, a, w.seams.tally),
    publish: (w, a) => runPublish(w.deps, a, w.seams.publish),
    results: (w, a) => runResults(w.deps, a, w.seams.results)
  }
  afterEach(() => {
    w?.close()
  })

  it('each of the four verbs refuses an unknown arg bad-arg with no calls, and the groups are registered', async () => {
    w = await makeWorld()
    for (const verb of OFFICER_RESULTS_VERB_NAMES) {
      const e = record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, bogus: 'x', tokenFile: w.tokenFile })))
      expect(e.name, verb).to.equal('VerbRefusal')
      expect(e.code, verb).to.equal('bad-arg')
    }
    expect(w.calls).to.deep.equal([])
    expect(OFFICER_RESULTS_VERB_NAMES).to.deep.equal(['release-window', 'tally', 'publish', 'results'])
    for (const n of OFFICER_RESULTS_VERB_NAMES) expect(OFFICER_VERB_ENTRIES[n]).to.equal(OFFICER_RESULTS_VERBS[n])
    expect(KEYHOLDER_VERB_ENTRIES.results).to.equal(KEYHOLDER_RESULTS_VERBS.results)
    expect(KEYHOLDER_RESULTS_VERBS.results).to.equal(OFFICER_RESULTS_VERBS.results)
    for (const n of ['create-election', 'ballot-submit', 'approve', 'found']) expect(OFFICER_VERB_ENTRIES[n]).to.be.a('function')
  })

  it('tally and publish refuse the production party; release-window and results proceed to the network on it', async () => {
    w = await makeWorld({ party: 'votetorrent' })
    for (const verb of ['tally', 'publish']) expect(record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))).code, verb).to.equal('production-party')
    expect(w.calls).to.deep.equal([])
    w.clock.now = T0
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION }))).code).to.equal('window-not-open')
    expect(w.calls).to.include('openNetwork')
    w.results = { status: 'awaiting-keys', electionId: ELECTION, phase: 'releasing', revision: 3, threshold: 2, participants: 2, releasedCount: 0, releasingKeysAt: null }
    expect(record(await refusal(runs.results!(w, { network: HASH, election: ELECTION }))).code).to.equal('results-awaiting-keys')
    expect(w.calls).to.include('openEst')
  })

  it('release-window and results refuse a token key as bad-arg', async () => {
    w = await makeWorld()
    for (const verb of ['release-window', 'results']) {
      expect(record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))).code, verb).to.equal('bad-arg')
      expect(record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, approvalToken: 'x'.repeat(43) }))).code, verb).to.equal('bad-arg')
    }
    expect(w.calls).to.deep.equal([])
  })

  it('tally and publish refuse token-absent and token-ambiguous with zero engine calls', async () => {
    w = await makeWorld()
    for (const verb of ['tally', 'publish']) {
      const absent = record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION })))
      expect(absent.name, verb).to.equal('ApprovalRefusal')
      expect(absent.code, verb).to.equal('token-absent')
      expect(record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile, approvalToken: 'x'.repeat(43) }))).code, verb).to.equal('token-ambiguous')
    }
    expect(w.calls).to.deep.equal([])
  })

  it('a wrong token gives token-refused after the preflight, with zero getElectionResults calls and zero signatures', async () => {
    w = await makeWorld()
    for (const verb of ['tally', 'publish']) {
      const e = record(await refusal(runs[verb]!(w, { network: HASH, election: ELECTION, tokenFile: w.wrongTokenFile })))
      expect(e.code, verb).to.equal('token-refused')
    }
    expect(w.calls.filter((c) => c === 'getElectionResults')).to.have.length(0)
    expect(w.calls.filter((c) => c === 'publishElectionTally')).to.have.length(0)
    expect(w.signs).to.equal(0)
    expect(w.calls.filter((c) => c === 'openNetwork')).to.have.length(2)
  })

  it('release-window: no-release-time, window-not-open at waitMs 0 with zero status reads, and a wait until the open time', async () => {
    w = await makeWorld()
    const releaseAt = T0 + 600_000 + 480_000 + 120_000
    w.timeline = { votingStarts: new Date(T0 + 600_000).toISOString() }
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION }))).code).to.equal('no-release-time')
    w.timeline = buildCliTimeline({ now: T0, leadMs: 600_000, windowMs: 480_000 }).timeline
    w.clock.now = T0
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, waitMs: '0' }))).code).to.equal('window-not-open')
    expect(w.calls.filter((c) => c === 'getKeyReleaseStatus')).to.have.length(0)
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, waitMs: 'abc' }))).code).to.equal('wait-invalid')
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, awaitReleased: '17' }))).code).to.equal('await-invalid')
    w.clock.now = releaseAt - 200_000
    const r = record(await runs['release-window']!(w, { network: HASH, election: ELECTION, waitMs: '300000' }))
    expect(r.waitedMs).to.equal(200_000)
    expect(w.sleeps).to.have.length(200)
    expect(w.clock.now).to.equal(releaseAt)
    expect(r.statusReads).to.equal(1)
    expect(r.releasingKeysAt).to.equal(new Date(releaseAt).toISOString())
    expect(r.phase).to.equal('releasing')
    expect(r.releasedCount).to.equal(0)
    expect(r.rejected).to.equal(0)
    expect(r.preRelease).to.deep.equal({ checked: true, phase: 'releasing', blocks: 1, notReconstructable: 1, needlesChecked: 0, needleFound: false })
    expect(Object.keys(r).sort()).to.deep.equal(['electionId', 'ms', 'phase', 'preRelease', 'rejected', 'releasedCount', 'releasingKeysAt', 'statusReads', 'waitedMs'])
  })

  it('release-window: needle-in-ciphertext for a raw and a hex occurrence, pre-release-open for a block that opens', async () => {
    w = await makeWorld()
    w.clock.now = T0 + 1_200_000
    const nf = needleFile(w.secretsDir)
    const clean = record(await runs['release-window']!(w, { network: HASH, election: ELECTION, needleFile: nf }))
    expect(clean.preRelease).to.deep.equal({ checked: true, phase: 'releasing', blocks: 1, notReconstructable: 1, needlesChecked: 1, needleFound: false })
    w.blocks = [{ Id: 'blk-1', BallotId: 'b-1', Ciphertext: JSON.stringify({ v: 1, ct: 'x' + NEEDLE + 'y' }), ElectionRevision: 3 }]
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, needleFile: nf }))).code).to.equal('needle-in-ciphertext')
    w.blocks = [{ Id: 'blk-1', BallotId: 'b-1', Ciphertext: JSON.stringify({ v: 1, ct: Buffer.from(NEEDLE, 'utf8').toString('hex') }), ElectionRevision: 3 }]
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, needleFile: nf }))).code).to.equal('needle-in-ciphertext')
    w.blocks = [{ Id: 'blk-1', BallotId: 'b-1', Ciphertext: JSON.stringify({ v: 1, ct: 'opaque' }), ElectionRevision: 3 }]
    w.decryptOk = true
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, needleFile: nf }))).code).to.equal('pre-release-open')
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, needleFile: 'relative.txt' }))).code).to.equal('needle-file-invalid')
  })

  it('release-window: release-rejected, release-incomplete at a 3000 ms bound, and success with releasedCount 2', async () => {
    w = await makeWorld()
    w.clock.now = T0 + 1_200_000
    w.status = { phase: 'releasing', revision: 3, releasedCount: 1, rejectedReleases: [{ userId: 'u', reason: 'signature-invalid' }] }
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, awaitReleased: '2' }))).code).to.equal('release-rejected')
    w.status = { phase: 'releasing', revision: 3, releasedCount: 1, rejectedReleases: [] }
    w.seams.release.awaitBoundMs = 3000
    w.sleeps = []
    expect(record(await refusal(runs['release-window']!(w, { network: HASH, election: ELECTION, awaitReleased: '2' }))).code).to.equal('release-incomplete')
    expect(w.sleeps).to.deep.equal([1000, 1000, 1000])
    w.status = { phase: 'releasing', revision: 3, releasedCount: 1, rejectedReleases: [] }
    w.statusSequence = [{}, { phase: 'reconstructable', releasedCount: 2 }]
    const r = record(await runs['release-window']!(w, { network: HASH, election: ELECTION, awaitReleased: '2' }))
    expect(r.releasedCount).to.equal(2)
    expect(r.rejected).to.equal(0)
    expect(r.phase).to.equal('reconstructable')
    expect(r.statusReads).to.equal(2)
    expect(r.preRelease).to.not.equal(null)
  })

  it('tally refuses results-awaiting-keys and results-unavailable:<reason> without the detail', async () => {
    w = await makeWorld()
    w.results = { status: 'awaiting-keys', electionId: ELECTION, phase: 'releasing', revision: 3, threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: null }
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))).code).to.equal('results-awaiting-keys')
    w.results = { status: 'unavailable', electionId: ELECTION, reason: 'read-failed', detail: 'SECRET-DETAIL-TEXT ' + randomBytes(8).toString('hex') }
    const e = record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile })))
    expect(e.code).to.equal('results-unavailable:read-failed')
    expect(String(e.message)).to.not.include('SECRET-DETAIL')
    expect(w.calls.filter((c) => c === 'reconstructElectionKey')).to.have.length(0)
  })

  it('tally: the opened-set check passes on matching files and refuses every mismatch, and the secret key is zeroed', async () => {
    w = await makeWorld()
    const files = [choiceFile(w.secretsDir, 'c1.json', [OPT_B]), choiceFile(w.secretsDir, 'c2.json', [NEEDLE]), choiceFile(w.secretsDir, 'c3.json', [OPT_B])]
    const nf = needleFile(w.secretsDir)
    const ok = record(await runs.tally!(w, { network: HASH, election: ELECTION, expectedFiles: files.join(','), needleFile: nf, tokenFile: w.tokenFile }))
    expect(ok.valid).to.equal(3)
    expect(ok.openedCount).to.equal(3)
    expect(ok.expectedMatch).to.equal(true)
    expect(ok.needleInOpened).to.equal(true)
    expect(ok.counts).to.deep.equal([1, 2])
    expect(ok.signatures).to.equal(0)
    expect(ok.tallyRoot8).to.equal('rrrrrrrr')
    expect(Object.keys(ok).sort()).to.deep.equal(['blockCount', 'blockRoot8', 'counts', 'decryptMs', 'electionId', 'excluded', 'expectedMatch', 'invalid', 'ms', 'needleInOpened', 'openedCount', 'revision', 'signatures', 'status', 'tallyMs', 'tallyRoot8', 'valid'])
    expect(w.lastSecret!.every((b) => b === 0)).to.equal(true)
    const differing = [...files.slice(0, 2), choiceFile(w.secretsDir, 'c3x.json', [NEEDLE])]
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, expectedFiles: differing.join(','), tokenFile: w.tokenFile }))).code).to.equal('opened-set-mismatch')
    expect(w.lastSecret!.every((b) => b === 0)).to.equal(true)
    w.failIndex = 0
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))).code).to.equal('opened-set-mismatch')
    w.failIndex = -1
    w.results = tallied({ [NEEDLE]: 2, [OPT_B]: 1 })
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))).code).to.equal('opened-set-mismatch')
    w.results = tallied({ [NEEDLE]: 1, [OPT_B]: 2 })
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, needleFile: needleFile(w.secretsDir, 'vt-needle-never-there'), tokenFile: w.tokenFile }))).code).to.equal('needle-not-opened')
    expect(w.lastSecret!.every((b) => b === 0)).to.equal(true)
  })

  it('tally refuses expected-file-invalid for a relative path, a 0644 file and a non-array JSON, before any token read', async () => {
    w = await makeWorld()
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, expectedFiles: 'relative.json', tokenFile: w.tokenFile }))).code).to.equal('expected-file-invalid')
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, expectedFiles: choiceFile(w.secretsDir, 'loose.json', [OPT_B], 0o644), tokenFile: w.tokenFile }))).code).to.equal('expected-file-invalid')
    const obj = join(w.secretsDir, 'obj.json')
    writeFileSync(obj, '{}', { mode: 0o600 })
    expect(record(await refusal(runs.tally!(w, { network: HASH, election: ELECTION, expectedFiles: obj, tokenFile: w.tokenFile }))).code).to.equal('expected-file-invalid')
    expect(w.calls).to.deep.equal([])
  })

  it('publish: published and already-published succeed with one signature each; every other outcome refuses publish-<outcome>', async () => {
    w = await makeWorld()
    const first = record(await runs.publish!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))
    expect(first.outcome).to.equal('published')
    expect(first.signatures).to.equal(1)
    expect(first.rows).to.equal(1)
    expect(first.tallyRoot8).to.equal('rrrrrrrr')
    expect(Object.keys(first).sort()).to.deep.equal(['electionId', 'ms', 'outcome', 'publishMs', 'publishedAt', 'revision', 'rows', 'signatures', 'tallyRoot8'])
    w.publishOutcome = { outcome: 'already-published', electionId: ELECTION, revision: 3, tallyRoot: 'r'.repeat(64), publishedAt: new Date(T0).toISOString() }
    const again = record(await runs.publish!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile }))
    expect(again.outcome).to.equal('already-published')
    expect(again.signatures).to.equal(1)
    for (const outcome of ['conflict', 'invalid-tally', 'signer-key-mismatch', 'not-officer', 'keys-not-released']) {
      w.publishOutcome = { outcome, reason: 'SECRET-REASON-TEXT', publishedRoot: 'p'.repeat(64), ourRoot: 'o'.repeat(64) }
      const e = record(await refusal(runs.publish!(w, { network: HASH, election: ELECTION, tokenFile: w.tokenFile })))
      expect(e.code, outcome).to.equal(`publish-${outcome}`)
      expect(String(e.message)).to.not.include('SECRET-REASON')
    }
    expect(w.signs).to.equal(7)
    expect(w.calls.filter((c) => c === 'publishElectionTally')).to.have.length(7)
  })

  it('results with requirePublished and a signatureValid:false publication refuses publication-unverified; the engine object is read by identity', async () => {
    w = await makeWorld()
    let reads = 0
    const pub = { electionId: ELECTION, revision: 3, treeCheck: { ok: true }, matchesRecomputed: true, get signatureValid () { reads++; return false } }
    w.publication = pub
    expect(record(await refusal(runs.results!(w, { network: HASH, election: ELECTION, requirePublished: true, waitMs: '0' }))).code).to.equal('publication-unverified')
    expect(reads).to.be.greaterThan(0)
    const r = record(await runs.results!(w, { network: HASH, election: ELECTION }))
    expect(r.publication).to.deep.equal({ found: true, signatureValid: false, treeOk: true, matchesRecomputed: true })
    expect(r.valid).to.equal(3)
    expect(r.counts).to.deep.equal([1, 2])
    expect(r.openedCount).to.equal(3)
    expect(r.agreementSha256).to.match(/^[0-9a-f]{64}$/)
    expect(Object.keys(r).sort()).to.deep.equal(['agreementSha256', 'blockCount', 'blockRoot8', 'counts', 'electionId', 'excluded', 'expectedMatch', 'invalid', 'ms', 'needleInOpened', 'openedCount', 'polls', 'publication', 'revision', 'status', 'tallyRoot8', 'valid', 'waitedMs'])
    expect(record(await refusal(runs.results!(w, { network: HASH, election: 'election-other' }))).code).to.equal('election-mismatch')
    // the real est opener (the fake deps above skip it): the hash shape, then the daemon's NetworkOpenError codes
    const refusedOpen = { openNetwork: async () => { throw Object.assign(new Error('not open'), { name: 'NetworkOpenError', code: 'network-not-open' }) } }
    expect(record(await refusal(openEstFor(refusedOpen as never, 'zz'))).code).to.equal('bad-network-hash')
    expect(record(await refusal(openEstFor(refusedOpen as never, HASH))).code).to.equal('network-not-open')
    const noUser = { openNetwork: async () => { throw Object.assign(new Error('no user'), { name: 'NetworkOpenError', code: 'user-missing' }) } }
    expect(record(await refusal(openEstFor(noUser as never, HASH))).code).to.equal('identity-absent')
  })

  it('every result and refusal message passes the leak check against both tokens, the needle and the choice texts', async () => {
    w = await makeWorld()
    const text = JSON.stringify(observed)
    expect(observed.length).to.be.greaterThan(30)
    const tokens = [w.tokenFile, w.wrongTokenFile].map((f) => Buffer.from(readFileSync(f, 'utf8').trim(), 'base64url'))
    assertNoLeak(text, [...tokens, Buffer.from(NEEDLE, 'utf8'), Buffer.from(JSON.stringify([{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: [OPT_B] }] }]), 'utf8')])
    expect(text).to.not.include(NEEDLE)
    expect(text).to.not.include('SECRET-')
  })
})
