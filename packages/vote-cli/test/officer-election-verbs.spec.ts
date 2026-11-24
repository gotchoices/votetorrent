// officer-election-verbs.spec.ts: every refusal path of the five officer election verbs against FAKE
// engines (recording every method into one `calls` array) and a REAL device vault holding a secp256k1
// officer key provisioned under a real approval token. "Refused before any engine call" is proven by
// `calls` being empty; "no signature" by the recording signing seams never having been reached. The
// share text and the ballot needle are read back from their 0600 files only to be registered as
// secrets for the leak checks; nothing here prints a token, share, needle, digest or signature.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectionDetails, ElectionInit, Proposal, SignatureTask } from '@votetorrent/vote-core'
import { parseInviteShare } from '@votetorrent/workflows/authority'
import { provisionTokenSigningKey } from '../src/approval/signer.js'
import { createApprovalContext, writeApprovalTokenFile } from '../src/approval/token.js'
import { buildCliTimeline } from '../src/election/parse-timeline.js'
import { AUTHORITY_SIGNING_ALIAS } from '../src/network/authority-user.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { ensurePrivateDir } from '../src/vault/private-file.js'
import { runBallotSubmit } from '../src/verbs/officer/ballot-submit.js'
import { runCreateElection } from '../src/verbs/officer/create-election.js'
import type { OfficerElectionDeps, OpenedElectionNetwork } from '../src/verbs/officer/election-deps.js'
import { OFFICER_ELECTION_VERBS, OFFICER_ELECTION_VERB_NAMES } from '../src/verbs/officer/election-verbs.js'
import { runInviteKeyholder } from '../src/verbs/officer/invite-keyholder.js'
import { runKeyholderPolicy } from '../src/verbs/officer/keyholder-policy.js'
import { runTaskSign } from '../src/verbs/officer/task-sign.js'
import { assertNoLeak, findLeak } from './support/vault-leak-check.js'

const HASH = randomBytes(16).toString('hex')
const ELECTION = 'election-1700000000000'
const AUTHORITY = 'authority-' + randomBytes(8).toString('hex')
const PARTY = 'vt-test-26'

interface Coded {
  name?: string
  code?: string
  message?: string
}

async function refusal(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a refusal')
}

type Run = (deps: OfficerElectionDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>
const RUNS: Record<string, Run> = {
  'create-election': runCreateElection,
  'keyholder-policy': runKeyholderPolicy,
  'invite-keyholder': runInviteKeyholder,
  'ballot-submit': runBallotSubmit,
  'task-sign': runTaskSign
}

/** The minimum valid args of each verb, with the token file supplied by the caller. */
const baseArgs = (verb: string, tokenFile?: string): Record<string, unknown> => {
  const token = tokenFile === undefined ? {} : { tokenFile }
  switch (verb) {
    case 'create-election':
      return { network: HASH, ...token }
    case 'keyholder-policy':
      return { network: HASH, election: ELECTION, keyholders: 'kh-a,kh-b', threshold: '2' }
    case 'invite-keyholder':
      return { network: HASH, election: ELECTION, name: 'kh-a', ...token }
    case 'ballot-submit':
      return { network: HASH, election: ELECTION, ...token }
    default:
      return { network: HASH, election: ELECTION, ballot: 'ballot-1', ...token }
  }
}

interface FakeWorld {
  calls: string[]
  network: OpenedElectionNetwork
  details: ElectionDetails
  proposals: Array<Proposal<ElectionInit>>
  tasks: SignatureTask[]
  completions: Array<{ isAccepted: boolean, signed: boolean }>
  created: Array<{ election: Record<string, unknown>, revision: Record<string, unknown> }>
  confirmation: { locked: boolean, confirmed: boolean, canWithdraw: boolean, ownTaskOpen: boolean }
  slotCount: number
  readbackThreshold: number | null
}

function makeWorld(): FakeWorld {
  const calls: string[] = []
  const t = buildCliTimeline({ now: 1_700_000_000_000, leadMs: 600000, windowMs: 480000 })
  const details: ElectionDetails = {
    election: { id: ELECTION, authorityId: AUTHORITY, title: 'vt-election', date: t.date, revisionDeadline: t.votingStarts, ballotDeadline: t.ballotDeadline, type: 'o' as ElectionDetails['election']['type'] },
    current: {
      electionId: ELECTION,
      revision: 0,
      revisionTimestamp: [],
      tags: [],
      instructions: '# vt-election',
      keyholders: [{ invite: { name: 'kh-a' } }, { invite: { name: 'kh-b' } }],
      timeline: t.timeline,
      keyholderThreshold: 2
    }
  }
  const w: FakeWorld = {
    calls,
    details,
    proposals: [],
    tasks: [],
    completions: [],
    created: [],
    confirmation: { locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: true },
    slotCount: 0,
    readbackThreshold: null,
    network: undefined as unknown as OpenedElectionNetwork
  }
  const builder = (election: Record<string, unknown> = {}, revision: Record<string, unknown> = {}): Record<string, unknown> => ({
    setElection: (e: Record<string, unknown>) => builder(e, revision),
    setRevision: (r: Record<string, unknown>) => builder(election, r),
    build: () => ({ election, revision })
  })
  const digest = (): Uint8Array => Uint8Array.from(randomBytes(32))
  const electionsEngine = {
    buildCreateElection() {
      calls.push('buildCreateElection')
      return builder()
    },
    async seedElectionSigning(_fields: unknown, sign: (d: Uint8Array) => Promise<unknown>) {
      calls.push('seedElectionSigning')
      await sign(digest())
      return 'nonce-1'
    },
    async peekNextTid() {
      calls.push('peekNextTid')
      return 7
    },
    async seedElectionRevisionSigning(_id: unknown, _auth: unknown, _rev: unknown, _tid: unknown, sign: (d: Uint8Array) => Promise<unknown>) {
      calls.push('seedElectionRevisionSigning')
      await sign(digest())
      return 'nonce-2'
    },
    async createElection(payload: { election: Record<string, unknown>, revision: Record<string, unknown> }) {
      calls.push('createElection')
      w.created.push(payload)
    },
    async adjustElection(init: ElectionInit) {
      calls.push('adjustElection')
      const threshold = w.readbackThreshold ?? init.revision.keyholderThreshold
      w.proposals.push({ proposed: { ...init, revision: { ...init.revision, keyholderThreshold: threshold } }, signers: [] })
    },
    async getElections() {
      calls.push('getElections')
      return [...w.created.map(() => ({ id: 'created' })), { id: ELECTION }] as unknown as Awaited<ReturnType<OpenedElectionNetwork['electionsEngine']['getElections']>>
    },
    async getProposedElections() {
      calls.push('getProposedElections')
      return w.proposals
    }
  }
  const electionEngine = {
    async getElectionDetails() {
      calls.push('getElectionDetails')
      return w.details
    },
    async inviteKeyholder(_invite: unknown, _electionId: unknown, sign: (d: Uint8Array) => Promise<unknown>) {
      calls.push('inviteKeyholder')
      await sign(digest())
      w.slotCount++
    },
    async proposeBallot() {
      calls.push('proposeBallot')
    },
    async submitBallotForConfirmation() {
      calls.push('submitBallotForConfirmation')
    },
    async getBallotConfirmationState() {
      calls.push('getBallotConfirmationState')
      return w.confirmation
    }
  }
  const tasksEngine = {
    async getRequestedSignatures() {
      calls.push('getRequestedSignatures')
      return w.tasks
    },
    async getSignatureDigest() {
      calls.push('getSignatureDigest')
      return digest()
    },
    async completeSignature(_task: unknown, result: { isAccepted: boolean, sign?: unknown }) {
      calls.push('completeSignature')
      w.completions.push({ isAccepted: result.isAccepted, signed: typeof result.sign === 'function' })
      if (result.isAccepted) w.confirmation = { ...w.confirmation, confirmed: true, locked: false, ownTaskOpen: false }
    }
  }
  w.network = {
    electionsEngine: electionsEngine as unknown as OpenedElectionNetwork['electionsEngine'],
    tasksEngine: tasksEngine as unknown as OpenedElectionNetwork['tasksEngine'],
    authorityId: AUTHORITY,
    async openElection(id: unknown) {
      calls.push('openElection')
      if (id !== ELECTION) throw Object.assign(new Error('officer verb refused (election-unknown)'), { name: 'VerbRefusal', code: 'election-unknown' })
      return electionEngine as unknown as Awaited<ReturnType<OpenedElectionNetwork['openElection']>>
    },
    async countKeyholderInviteSlots() {
      calls.push('countKeyholderInviteSlots')
      return w.slotCount
    }
  }
  return w
}

describe('officer election verbs: refusals', function () {
  this.timeout(60000)
  let root: string
  let home: string
  let device: DeviceVault
  let publicKey: string
  let goodToken: string
  let wrongToken: string
  let looseToken: string
  let tokenBytes: Uint8Array[]
  let n = 0
  const outputs: string[] = []
  const texts: Uint8Array[] = []
  let worlds: FakeWorld[] = []

  const makeDeps = (opts: { partyId?: string, secretsDir?: string, world?: FakeWorld, buildTimeline?: OfficerElectionDeps['buildTimeline'] } = {}): OfficerElectionDeps & { world: FakeWorld } => {
    const world = opts.world ?? makeWorld()
    worlds.push(world)
    const secretsDir = opts.secretsDir ?? join(root, `secrets-${++n}`)
    ensurePrivateDir(secretsDir)
    return {
      partyId: opts.partyId ?? PARTY,
      secretsDir,
      secrets: new SecretRegistry(),
      vault: device.vault,
      officer: { userId: 'user-26', signingKeyAlias: AUTHORITY_SIGNING_ALIAS, signerKey: publicKey },
      now: () => 1_700_000_000_123,
      writeKey: world,
      openNetwork: async (hash) => {
        world.calls.push('openNetwork')
        if (hash !== HASH) throw Object.assign(new Error('officer verb refused (network-unknown)'), { name: 'VerbRefusal', code: 'network-unknown' })
        return world.network
      },
      ...(opts.buildTimeline === undefined ? {} : { buildTimeline: opts.buildTimeline }),
      world
    }
  }
  const run = async (verb: string, deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const out = await RUNS[verb]!(deps, args)
    outputs.push(JSON.stringify(out))
    return out
  }
  const refused = async (verb: string, deps: OfficerElectionDeps, args: Record<string, unknown>, code: string): Promise<Coded> => {
    const err = await refusal(RUNS[verb]!(deps, args))
    outputs.push(String(err.message))
    expect(err.code, `${verb}: ${String(err.name)} ${String(err.message)}`).to.equal(code)
    return err
  }
  const token = (file: string): Record<string, unknown> => ({ tokenFile: file })

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'vt-26-'))
    chmodSync(root, 0o700)
    home = join(root, 'home')
    ensurePrivateDir(home)
    device = openDeviceVault({ home })
    const tokens = join(root, 'tokens')
    mkdirSync(tokens, { mode: 0o700 })
    goodToken = join(tokens, 'good.token')
    wrongToken = join(tokens, 'wrong.token')
    looseToken = join(tokens, 'loose.token')
    writeApprovalTokenFile(goodToken)
    writeApprovalTokenFile(wrongToken)
    copyFileSync(goodToken, looseToken)
    chmodSync(looseToken, 0o640)
    tokenBytes = [goodToken, wrongToken].map((f) => Buffer.from(readFileSync(f, 'utf8').trim(), 'base64url'))
    publicKey = (await provisionTokenSigningKey({ vault: device.vault, token: createApprovalContext({ file: goodToken }), curve: 'secp256k1', alias: AUTHORITY_SIGNING_ALIAS })).publicKey
  })

  after(() => {
    device.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('each verb refuses an unknown arg as bad-arg with no engine call', async () => {
    expect(Object.keys(OFFICER_ELECTION_VERBS).sort()).to.deep.equal([...OFFICER_ELECTION_VERB_NAMES].sort())
    for (const verb of OFFICER_ELECTION_VERB_NAMES) {
      const deps = makeDeps()
      await refused(verb, deps, { ...baseArgs(verb, goodToken), bogus: 'x' }, 'bad-arg')
      expect(deps.world.calls, verb).to.deep.equal([])
    }
  })

  it('each verb refuses the production party (trimmed, any case) with no engine call', async () => {
    for (const verb of OFFICER_ELECTION_VERB_NAMES) {
      for (const party of ['votetorrent', ' VoteTorrent ']) {
        const deps = makeDeps({ partyId: party })
        await refused(verb, deps, baseArgs(verb, goodToken), 'production-party')
        expect(deps.world.calls, verb).to.deep.equal([])
      }
    }
    const empty = makeDeps({ partyId: '' })
    await refused('create-election', empty, baseArgs('create-election', goodToken), 'party-missing')
  })

  it('create-election refuses lead-too-short, window-too-short and lead-invalid with no engine call', async () => {
    const deps = makeDeps()
    await refused('create-election', deps, { ...baseArgs('create-election', goodToken), leadMs: '89999' }, 'lead-too-short')
    await refused('create-election', deps, { ...baseArgs('create-election', goodToken), windowMs: '59999' }, 'window-too-short')
    await refused('create-election', deps, { ...baseArgs('create-election', goodToken), leadMs: 'abc' }, 'lead-invalid')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('create-election refuses timeline-voter-rules for a planted bad timeline with no engine call', async () => {
    const deps = makeDeps({
      buildTimeline: (input) => {
        const t = buildCliTimeline(input)
        return { ...t, timeline: { ...t.timeline, ballotsFinal: t.ballotDeadline + 1000 } }
      }
    })
    const err = await refused('create-election', deps, baseArgs('create-election', goodToken), 'timeline-voter-rules')
    expect(err.message).to.equal('officer verb refused (timeline-voter-rules)')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('create-election refuses token-absent and token-ambiguous with no engine call', async () => {
    const deps = makeDeps()
    const absent = await refused('create-election', deps, baseArgs('create-election'), 'token-absent')
    expect(absent.name).to.equal('ApprovalRefusal')
    await refused('create-election', deps, { ...baseArgs('create-election', goodToken), approvalToken: 'x'.repeat(43) }, 'token-ambiguous')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('create-election with a wrong token refuses token-refused after opening the network, with zero signatures', async () => {
    const deps = makeDeps()
    const before = device.vault.authPromptCount
    await refused('create-election', deps, baseArgs('create-election', wrongToken), 'token-refused')
    expect(deps.world.calls).to.deep.equal(['openNetwork'])
    expect(deps.world.created).to.deep.equal([])
    expect(device.vault.authPromptCount).to.equal(before + 1)
  })

  it('create-election with a group-readable token file refuses token-refused, same assertions', async () => {
    const deps = makeDeps()
    await refused('create-election', deps, baseArgs('create-election', looseToken), 'token-refused')
    expect(deps.world.calls).to.deep.equal(['openNetwork'])
    expect(deps.world.created).to.deep.equal([])
  })

  it('create-election happy path passes ballotDeadline = votingStarts and date = closed to the shared workflow', async () => {
    const deps = makeDeps()
    const r = await run('create-election', deps, baseArgs('create-election', goodToken))
    expect(Object.keys(r).sort()).to.deep.equal(['authorityId8', 'belowProvenDefaults', 'closedAt', 'electionCount', 'electionId', 'leadMs', 'ms', 'seats', 'signatures', 'threshold', 'title', 'votingStartsAt', 'windowMs'])
    expect(r.threshold).to.equal(2)
    expect(r.seats).to.equal(2)
    expect(r.signatures).to.equal(2)
    expect(r.leadMs).to.equal(600000)
    expect(r.windowMs).to.equal(480000)
    expect(r.belowProvenDefaults).to.equal(false)
    expect(r.authorityId8).to.equal(AUTHORITY.slice(-8))
    expect(r.electionId).to.equal('election-1700000001000')
    expect(typeof r.ms).to.equal('number')
    const created = deps.world.created[0]!
    const tl = created.revision.timeline as Record<string, number>
    expect(created.election.ballotDeadline).to.equal(tl.votingStarts)
    expect(created.election.revisionDeadline).to.equal(tl.votingStarts)
    expect(created.election.date).to.equal(tl.closed)
    expect(created.revision.keyholderThreshold).to.equal(2)
    expect((created.revision.keyholders as unknown[]).length).to.equal(2)
    expect(deps.world.calls.slice(0, 2)).to.deep.equal(['openNetwork', 'buildCreateElection'])
    expect(deps.world.calls).to.include.members(['seedElectionSigning', 'peekNextTid', 'seedElectionRevisionSigning', 'createElection', 'getElections'])
  })

  it('create-election maps a workflow refusal (threshold 3 of 2 seats) before any signature', async () => {
    const deps = makeDeps()
    await refused('create-election', deps, { ...baseArgs('create-election', goodToken), threshold: '3' }, 'threshold-above-count')
    expect(deps.world.calls).to.deep.equal(['openNetwork'])
    expect(deps.world.created).to.deep.equal([])
  })

  it('keyholder-policy refuses a token key as bad-arg and check without policy as check-needs-policy', async () => {
    const deps = makeDeps()
    await refused('keyholder-policy', deps, { ...baseArgs('keyholder-policy'), tokenFile: goodToken }, 'bad-arg')
    await refused('keyholder-policy', deps, { network: HASH, election: ELECTION, check: true }, 'check-needs-policy')
    await refused('keyholder-policy', deps, { network: HASH, election: ELECTION, check: 'yes', keyholders: 'a,b', threshold: '2' }, 'bad-arg')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('keyholder-policy check mode refuses a duplicate name with its policy code and opens no network', async () => {
    const deps = makeDeps()
    await refused('keyholder-policy', deps, { check: true, keyholders: 'kh-a,kh-a', threshold: '2' }, 'duplicate-keyholder-name')
    const ok = await run('keyholder-policy', deps, { check: true, keyholders: 'kh-a,kh-b,kh-c', threshold: '2' })
    expect(ok.mode).to.equal('check')
    expect(ok.seats).to.equal(3)
    expect(ok.threshold).to.equal(2)
    expect(deps.world.calls).to.deep.equal([])
  })

  it('keyholder-policy propose refuses policy-readback-mismatch, and reads back a matching proposal', async () => {
    const bad = makeDeps()
    bad.world.readbackThreshold = 1
    await refused('keyholder-policy', bad, baseArgs('keyholder-policy'), 'policy-readback-mismatch')
    expect(bad.world.calls).to.include('adjustElection')
    const good = makeDeps()
    const r = await run('keyholder-policy', good, baseArgs('keyholder-policy'))
    expect(r.mode).to.equal('propose')
    expect(r.proposedRevision).to.equal(1)
    expect(r.threshold).to.equal(2)
    expect(r.seats).to.equal(2)
    const read = await run('keyholder-policy', good, { network: HASH, election: ELECTION })
    expect(read.mode).to.equal('read')
    expect(read.revision).to.equal(0)
    expect(read.threshold).to.equal(2)
    expect(read.seats).to.equal(2)
    expect(read.invitedSeats).to.equal(0)
  })

  it('invite-keyholder refuses expiry-not-preset for 720 and 5 with no engine call, no token read and no file', async () => {
    const deps = makeDeps()
    const before = device.vault.authPromptCount
    const missing = join(root, 'never-read.token')
    for (const hours of ['720', '5']) {
      await refused('invite-keyholder', deps, { ...baseArgs('invite-keyholder', missing), expiryHours: hours }, 'expiry-not-preset')
    }
    await refused('invite-keyholder', deps, { ...baseArgs('invite-keyholder', missing), expiryHours: 'abc' }, 'expiry-invalid')
    expect(deps.world.calls).to.deep.equal([])
    expect(device.vault.authPromptCount).to.equal(before)
    expect(readdirSync(deps.secretsDir)).to.deep.equal([])
  })

  it('invite-keyholder refuses name-invalid and share-name-invalid', async () => {
    const deps = makeDeps()
    for (const name of ['../x', '', 'a'.repeat(65), 'kh/a']) {
      await refused('invite-keyholder', deps, { ...baseArgs('invite-keyholder', goodToken), name }, 'name-invalid')
    }
    await refused('invite-keyholder', deps, { network: HASH, election: ELECTION, tokenFile: goodToken }, 'name-required')
    await refused('invite-keyholder', deps, { ...baseArgs('invite-keyholder', goodToken), shareName: 'Seat A' }, 'share-name-invalid')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('invite-keyholder refuses share-file-exists before any signature', async () => {
    const deps = makeDeps()
    writeFileSync(join(deps.secretsDir, 'seat-kh-a.share'), 'planted\n', { mode: 0o600 })
    await refused('invite-keyholder', deps, baseArgs('invite-keyholder', goodToken), 'share-file-exists')
    expect(deps.world.calls).to.deep.equal([])
    expect(readFileSync(join(deps.secretsDir, 'seat-kh-a.share'), 'utf8')).to.equal('planted\n')
  })

  it('invite-keyholder writes a 0600 share that parseInviteShare reads and returns only its path and an 8-char suffix', async () => {
    const deps = makeDeps()
    const r = await run('invite-keyholder', deps, baseArgs('invite-keyholder', goodToken))
    expect(Object.keys(r).sort()).to.deep.equal(['electionId', 'expiresAt', 'expiryHours', 'inviteKey8', 'invitedSeats', 'ms', 'name', 'shareFile', 'signatures'])
    expect(r.shareFile).to.equal(join(deps.secretsDir, 'seat-kh-a.share'))
    expect(statSync(String(r.shareFile)).mode & 0o777).to.equal(0o600)
    const text = readFileSync(String(r.shareFile), 'utf8').trim()
    const parsed = parseInviteShare(text)
    expect(parsed?.inviteKey.endsWith(String(r.inviteKey8))).to.equal(true)
    expect(String(r.inviteKey8).length).to.equal(8)
    expect(r.expiryHours).to.equal(24)
    expect(r.signatures).to.equal(1)
    expect(r.invitedSeats).to.equal(1)
    expect(typeof r.expiresAt).to.equal('number')
    const bytes = Buffer.from(text, 'utf8')
    texts.push(bytes, Buffer.from(parsed!.invitePrivate, 'hex'))
    assertNoLeak(JSON.stringify(r), [bytes])
    expect(deps.secrets.hasWindow(text.slice(0, 16))).to.equal(true)
    expect(deps.secrets.hasWindow(parsed!.invitePrivate.slice(0, 16))).to.equal(true)
    for (const v of Object.values(r)) if (typeof v === 'string' && v !== r.shareFile) expect(v.length, v.slice(0, 8)).to.be.lessThan(16 + 1 + 'election-'.length + 14)
    expect(deps.world.calls).to.deep.equal(['openNetwork', 'openElection', 'getElectionDetails', 'inviteKeyholder', 'countKeyholderInviteSlots'])
  })

  it('ballot-submit refuses ballot-file-invalid for a one-option question, a relative path and a 70 KiB file', async () => {
    const deps = makeDeps()
    const one = join(root, 'one-option.json')
    writeFileSync(one, JSON.stringify({ questions: [{ code: 'q1', title: 'q1', options: [{ code: 'a', title: 'a' }] }] }), { mode: 0o600 })
    await refused('ballot-submit', deps, { ...baseArgs('ballot-submit', goodToken), ballotFile: one }, 'ballot-file-invalid')
    await refused('ballot-submit', deps, { ...baseArgs('ballot-submit', goodToken), ballotFile: 'relative/ballot.json' }, 'ballot-file-invalid')
    const big = join(root, 'big.json')
    writeFileSync(big, JSON.stringify({ questions: [], pad: 'x'.repeat(70 * 1024) }), { mode: 0o600 })
    await refused('ballot-submit', deps, { ...baseArgs('ballot-submit', goodToken), ballotFile: big }, 'ballot-file-invalid')
    await refused('ballot-submit', deps, { ...baseArgs('ballot-submit', goodToken), ballotId: 'bad id!' }, 'ballot-id-invalid')
    expect(deps.world.calls).to.deep.equal([])
    const okFile = join(root, 'ok.json')
    writeFileSync(okFile, JSON.stringify({ questions: [{ code: 'q1', title: 'Q1', options: [{ code: 'a', title: 'A' }, { code: 'b', title: 'B' }] }], districts: ['d1'] }), { mode: 0o600 })
    const r = await run('ballot-submit', deps, { ...baseArgs('ballot-submit', goodToken), ballotFile: okFile, ballotId: 'ballot-file-1' })
    expect(r.needleFile).to.equal(null)
    expect(r.questions).to.equal(1)
    expect(r.options).to.equal(2)
    expect(r.ballotId).to.equal('ballot-file-1')
  })

  it('ballot-submit writes the 0600 needle file only after the preflight and never returns the needle', async () => {
    const wrong = makeDeps()
    await refused('ballot-submit', wrong, baseArgs('ballot-submit', wrongToken), 'token-refused')
    expect(readdirSync(wrong.secretsDir)).to.deep.equal([])
    expect(wrong.world.calls).to.deep.equal(['openNetwork', 'openElection'])
    const deps = makeDeps()
    const r = await run('ballot-submit', deps, baseArgs('ballot-submit', goodToken))
    expect(Object.keys(r).sort()).to.deep.equal(['ballotId', 'confirmed', 'electionId', 'locked', 'ms', 'needleFile', 'options', 'ownTaskOpen', 'proposeMs', 'questions', 'signatures', 'submitMs'])
    expect(String(r.needleFile).startsWith(deps.secretsDir + '/ballot-needle-')).to.equal(true)
    expect(statSync(String(r.needleFile)).mode & 0o777).to.equal(0o600)
    const needle = readFileSync(String(r.needleFile), 'utf8').trim()
    expect(needle.startsWith('vt-needle-')).to.equal(true)
    expect(needle.length).to.equal(20)
    texts.push(Buffer.from(needle, 'utf8'))
    assertNoLeak(JSON.stringify(r), [Buffer.from(needle, 'utf8')])
    expect(deps.secrets.hasWindow(needle.slice(0, 16))).to.equal(true)
    expect(r.questions).to.equal(1)
    expect(r.options).to.equal(2)
    expect(r.locked).to.equal(true)
    expect(r.ownTaskOpen).to.equal(true)
    expect(r.signatures).to.equal(0)
    expect(typeof r.proposeMs).to.equal('number')
    expect(typeof r.submitMs).to.equal('number')
    expect(deps.world.calls).to.deep.equal(['openNetwork', 'openElection', 'proposeBallot', 'submitBallotForConfirmation', 'getBallotConfirmationState'])
  })

  it('ballot-submit refuses token-absent with no engine call', async () => {
    const deps = makeDeps()
    await refused('ballot-submit', deps, baseArgs('ballot-submit'), 'token-absent')
    expect(deps.world.calls).to.deep.equal([])
    expect(readdirSync(deps.secretsDir)).to.deep.equal([])
  })

  it('task-sign refuses ballot-required, wait-invalid, and reject with a token key as bad-arg', async () => {
    const deps = makeDeps()
    await refused('task-sign', deps, { network: HASH, election: ELECTION, tokenFile: goodToken }, 'ballot-required')
    await refused('task-sign', deps, { ...baseArgs('task-sign', goodToken), waitMs: '600001' }, 'wait-invalid')
    await refused('task-sign', deps, { ...baseArgs('task-sign', goodToken), waitMs: '-1' }, 'wait-invalid')
    await refused('task-sign', deps, { ...baseArgs('task-sign', goodToken), reject: true }, 'bad-arg')
    await refused('task-sign', deps, { ...baseArgs('task-sign'), reject: 'yes' }, 'bad-arg')
    expect(deps.world.calls).to.deep.equal([])
  })

  it('task-sign refuses no-task after waitMs 0 on an empty task list', async () => {
    const deps = makeDeps()
    await refused('task-sign', deps, baseArgs('task-sign', goodToken), 'no-task')
    expect(deps.world.calls).to.deep.equal(['openNetwork', 'openElection', 'getRequestedSignatures'])
    expect(deps.world.completions).to.deep.equal([])
  })

  it('task-sign accept reads the digest, then completes with the re-invocable signer, reporting digestMs and completeMs', async () => {
    const deps = makeDeps()
    deps.world.tasks = [{ signatureType: 'ballot', ballot: { proposed: { id: 'ballot-1' } } } as unknown as SignatureTask]
    const r = await run('task-sign', deps, baseArgs('task-sign', goodToken))
    expect(Object.keys(r).sort()).to.deep.equal(['accepted', 'ballotId', 'completeMs', 'confirmed', 'digestMs', 'electionId', 'ms', 'signatures', 'waitMs'])
    expect(r.accepted).to.equal(true)
    expect(r.confirmed).to.equal(true)
    expect(r.signatures).to.equal(1)
    expect(typeof r.digestMs).to.equal('number')
    expect(typeof r.completeMs).to.equal('number')
    const order = deps.world.calls.filter((c) => c === 'getSignatureDigest' || c === 'completeSignature')
    expect(order).to.deep.equal(['getSignatureDigest', 'completeSignature'])
    expect(deps.world.completions).to.deep.equal([{ isAccepted: true, signed: true }])
  })

  it('task-sign reject completes with isAccepted false and reads no token', async () => {
    const deps = makeDeps()
    deps.world.tasks = [{ signatureType: 'ballot', ballot: { proposed: { id: 'ballot-1' } } } as unknown as SignatureTask]
    const before = device.vault.authPromptCount
    const r = await run('task-sign', deps, { ...baseArgs('task-sign'), reject: true })
    expect(r.accepted).to.equal(false)
    expect(r.signatures).to.equal(0)
    expect(r.digestMs).to.equal(null)
    expect(deps.world.completions).to.deep.equal([{ isAccepted: false, signed: false }])
    expect(deps.world.calls).to.not.include('getSignatureDigest')
    expect(device.vault.authPromptCount).to.equal(before)
  })

  it('secrecy: no result or refusal message leaks a token, share or needle, and a planted share window fails the check', () => {
    expect(outputs.length).to.be.at.least(40)
    expect(texts.length).to.be.at.least(3)
    const secrets = [...tokenBytes, ...texts]
    for (const text of outputs) assertNoLeak(text, secrets)
    // a 16-char window of the seat private key hex (no quotes, so JSON.stringify keeps it literal)
    const share = Buffer.from(texts[0]!).toString('latin1')
    const hexStart = share.indexOf('"invitePrivate":"') + '"invitePrivate":"'.length
    const planted = JSON.stringify({ electionId: ELECTION, leaked: share.slice(hexStart + 4, hexStart + 20) })
    expect(findLeak(planted, secrets)).to.be.a('string')
    expect(worlds.length).to.be.greaterThan(0)
    worlds = []
    expect(existsSync(home)).to.equal(true)
  })
})
