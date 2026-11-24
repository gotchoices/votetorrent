// voter-vote-verbs.spec.ts: every refusal path and the happy path of the voter vote verbs (cast, send, results)
// against fake engines and a fake node, with a REAL device vault (K_vote provisioned through the 67-20 token
// producer under a real token file), a REAL 67-13 file kv and the real shared store, vault and receipt reader
// over the CLI token wrap provider. Token reads are counted through the producer's approval and the KEK
// derivations (one per provider wrap or unwrap); prompts through the vault's counter. Nothing here prints a
// token, nonce, signature or key; the leak checks register them and scan the home.
import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ballot, Question } from '@votetorrent/vote-core'
import { voteMarkerKey, type ElectionResultsRead, type VoteContext } from '@votetorrent/workflows/voter'
import { createApprovalContext, NO_APPROVAL, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { createTokenAttestationProducer } from '../src/attestation/token-attestation-producer.js'
import { agreementOf, diffAgreement } from '../src/proof/results-agreement.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { openFileKv, type FileKvStorage } from '../src/vault/file-kv.js'
import { ensurePrivateDir } from '../src/vault/private-file.js'
import { runCast } from '../src/verbs/voter/cast.js'
import { VOTER_VERB_ENTRIES } from '../src/verbs/voter/registry.js'
import { runVoterResults } from '../src/verbs/voter/results.js'
import { VOTER_RESULTS_VERB_NAMES, VOTER_RESULTS_VERBS } from '../src/verbs/voter/results-verbs.js'
import { runSend } from '../src/verbs/voter/send.js'
import { VOTER_KVOTE_ALIAS, type VoterVoteDeps } from '../src/verbs/voter/voter-deps.js'
import {
  CLI_VOTE_PROMPT,
  CLI_VOTE_RECORD_WRAP_KEY_ALIAS,
  createCliVoteRecordPorts,
  createCliVoteRecordWrapProvider,
  createRedactingVoteSendDebug
} from '../src/voter/vote-record-seams.js'
import { assertNoLeak } from './support/vault-leak-check.js'

const HASH = randomBytes(16).toString('hex')
const ELECTION = 'election-1700000000000'
const AUTHORITY = 'authority-' + randomBytes(8).toString('hex')
const REGISTRANT = 'registrant-' + randomBytes(6).toString('hex')
const DEVICE_ID = 'vt-voter-unit-' + randomBytes(4).toString('hex')

interface Coded { name?: string, code?: string, message?: string }

async function refusal (p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a refusal')
}

function question (code: string): Question {
  return { code, title: `Title ${code}`, instructions: '', type: 'select', options: [{ code: 'x', title: 'X' }, { code: 'y', title: 'Y' }] } as Question
}

function ballot (id: string, electionId: string): Ballot {
  return { id, electionId, authorityId: AUTHORITY, description: '', districts: [], questions: [question('q1')] } as Ballot
}

function contextOf (electionId: string): VoteContext {
  return { electionId, revision: 3, authorityId: AUTHORITY, open: true, lifecycleState: 'Open', ballots: [ballot('b-1', electionId)], unconfirmedBallotIds: [], unsupportedQuestionCount: 0 }
}

type ResultsScript = (id: string) => unknown

interface Harness {
  home: string
  device: DeviceVault
  kv: FileKvStorage
  secrets: SecretRegistry
  tokenFile: string
  wrongTokenFile: string
  deps: VoterVoteDeps & { node: VoterVoteDeps['node'] }
  calls: string[]
  kvoteKey: string
  opens(): number
  dials(): number
  tokenReads(): number
  resetCounters(): void
  script: { contextElectionId: string, electionsId: string, results: ResultsScript }
  close(): void
}

async function makeHarness (opts: { partyId?: string } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'vt-30v-'))
  const device = openDeviceVault({ home })
  ensurePrivateDir(join(home, 'node'))
  ensurePrivateDir(join(home, 'secrets'))
  const kv = openFileKv({ path: join(home, 'node', 'async-storage.json') })
  const secrets = new SecretRegistry()
  const tokenFile = join(home, 'secrets', 'voter.token')
  const wrongTokenFile = join(home, 'secrets', 'wrong.token')
  writeApprovalTokenFile(tokenFile)
  writeApprovalTokenFile(wrongTokenFile)
  const calls: string[] = []
  const counters = { opens: 0, dials: 0, producerTokenReads: 0, kekDerivations: 0 }
  // K_vote through 67-20's producer under the real token (load-or-create)
  const provisioned = await createTokenAttestationProducer({ vault: device.vault, token: createApprovalContext({ file: tokenFile }), alias: VOTER_KVOTE_ALIAS, deviceId: DEVICE_ID }).provisionDeviceKey()
  const kvoteKey = provisioned.publicKey
  const script = { contextElectionId: ELECTION, electionsId: ELECTION, results: ((id: string) => ({ status: 'awaiting-keys', electionId: id, phase: 'releasing', revision: 3, threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: null })) as ResultsScript }
  const engines: Record<string, unknown> = {
    association: { getAssociationsByDeviceKey: async () => { calls.push('association.rows'); return [{ registrantId: REGISTRANT, deviceKey: kvoteKey, attestationCid: 'att-1' }] } },
    registration: { getRegistrant: async (id: string) => { calls.push('registration.getRegistrant'); return { id, authorityId: AUTHORITY, status: 'a', privateCid: `priv-${id}`, publicCid: 'pub-1' } } },
    elections: { getElections: async () => { calls.push('elections.getElections'); return [{ id: script.electionsId, date: Date.now() }] } },
    electionResults: { getElectionResults: async (id: string) => { calls.push('electionResults.get'); return script.results(id) } },
    tallyPublication: { readPublishedTally: async () => { calls.push('tallyPublication.read'); return null } }
  }
  const getEngine = async <T>(name: string): Promise<T> => {
    calls.push(name)
    const e = engines[name]
    if (e === undefined) throw new Error(`fake has no engine ${name}`)
    return e as T
  }
  const control = { dialProtocol: () => { counters.dials++; return new Promise<never>(() => {}) } }
  const deps: Harness['deps'] = {
    partyId: opts.partyId ?? 'vt30-unit',
    kv,
    keys: { deriveTokenKey: (token, info) => { counters.kekDerivations++; return device.keys.deriveTokenKey(token, info) } },
    vault: device.vault,
    secrets,
    secretsDir: join(home, 'secrets'),
    node: { getControlNode: () => control },
    now: () => Date.now(),
    redact: (t) => t,
    authPromptCount: () => device.vault.authPromptCount,
    openNetwork: async (hash) => {
      counters.opens++
      if (hash !== HASH) throw new Error('unexpected network')
      return { est: {} as never, getEngine, readRendezvousAddrs: async () => ['/dns4/a.example/tcp/1/ws'] }
    },
    producer: async (approval: ApprovalContext) => {
      const counting: ApprovalContext = { token: async () => { counters.producerTokenReads++; return approval.token() } }
      return createTokenAttestationProducer({ vault: device.vault, token: counting, alias: VOTER_KVOTE_ALIAS, deviceId: DEVICE_ID })
    },
    readContext: async () => contextOf(script.contextElectionId)
  }
  return {
    home,
    device,
    kv,
    secrets,
    tokenFile,
    wrongTokenFile,
    deps,
    calls,
    kvoteKey,
    script,
    opens: () => counters.opens,
    dials: () => counters.dials,
    tokenReads: () => counters.producerTokenReads + counters.kekDerivations,
    resetCounters: () => { counters.opens = 0; counters.dials = 0; counters.producerTokenReads = 0; counters.kekDerivations = 0; calls.length = 0 },
    close: () => {
      kv.close()
      device.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const CAST_KEYS = ['electionId', 'electionRevision', 'ballots', 'savedAt', 'replacedStale', 'choiceFile', 'castUnwraps', 'tokenReads', 'castMs', 'revealMs', 'ms']

function talliedRead (counts: Record<string, number>, publication: ElectionResultsRead['publication']): ElectionResultsRead {
  const options = Object.entries(counts).map(([code, count]) => ({ code, title: code, count }))
  const results = {
    status: 'tallied',
    electionId: ELECTION,
    revision: 3,
    threshold: 2,
    keyholdersUsed: 2,
    blockCount: 1,
    totals: { blocks: 1, entries: 3, valid: 3, invalid: 0, excluded: 0 },
    ballots: [{ ballotId: 'b-1', description: '', votes: 3, valid: 3, invalid: 0, excluded: 0, questions: [{ code: 'q1', title: 'Q', type: 'select', counted: true, answered: 3, blank: 0, options }] }],
    tallyRoot: 'r'.repeat(64),
    blockRoot: 'b'.repeat(64),
    tally: {}
  }
  return { results: results as never, publication }
}

describe('voter vote verbs', function () {
  this.timeout(60000)
  let h: Harness
  afterEach(() => {
    h?.close()
  })

  it('each verb refuses an unknown arg bad-arg with zero engine calls, and the group is registered under its three names', async () => {
    h = await makeHarness()
    for (const run of [runCast, runSend, runVoterResults]) {
      const e = await refusal(run(h.deps, { network: HASH, election: ELECTION, bogus: 'x', tokenFile: h.tokenFile }))
      expect(e.name).to.equal('VerbRefusal')
      expect(e.code).to.equal('bad-arg')
    }
    expect(h.calls).to.deep.equal([])
    expect(h.opens()).to.equal(0)
    expect(VOTER_RESULTS_VERB_NAMES).to.deep.equal(['cast', 'send', 'results'])
    for (const n of VOTER_RESULTS_VERB_NAMES) expect(VOTER_VERB_ENTRIES[n]).to.equal(VOTER_RESULTS_VERBS[n])
    for (const n of ['join', 'register', 'stage-association', 'answer-challenge', 'read-decision', 'readback', 'stop']) expect(VOTER_VERB_ENTRIES[n]).to.be.a('function')
  })

  it('cast and send refuse the production party in any case; results does not', async () => {
    for (const party of ['votetorrent', ' VoteTorrent ']) {
      h = await makeHarness({ partyId: party })
      for (const run of [runCast, runSend]) {
        const e = await refusal(run(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))
        expect(e.code).to.equal('production-party')
      }
      const r = await refusal(runVoterResults(h.deps, { network: HASH, election: ELECTION }))
      expect(r.code).to.not.equal('production-party')
      expect(r.code).to.equal('results-awaiting-keys')
      expect(h.opens()).to.equal(1)
      h.close()
    }
    h = await makeHarness()
  })

  it('cast refuses token-absent and token-ambiguous with zero engine calls and zero token reads', async () => {
    h = await makeHarness()
    const absent = await refusal(runCast(h.deps, { network: HASH, election: ELECTION }))
    expect(absent.name).to.equal('ApprovalRefusal')
    expect(absent.code).to.equal('token-absent')
    const ambiguous = await refusal(runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile, approvalToken: 'x'.repeat(43) }))
    expect(ambiguous.code).to.equal('token-ambiguous')
    expect(h.calls).to.deep.equal([])
    expect(h.opens()).to.equal(0)
    expect(h.tokenReads()).to.equal(0)
    expect(h.device.vault.authPromptCount).to.equal(0)
  })

  it('cast refuses selection-ambiguous, selections-file-invalid and choice-index-invalid before any token read', async () => {
    h = await makeHarness()
    const base = { network: HASH, election: ELECTION, tokenFile: h.tokenFile }
    expect((await refusal(runCast(h.deps, { ...base, choiceIndex: '0', selectionsFile: join(h.home, 'secrets', 'sel.json') }))).code).to.equal('selection-ambiguous')
    expect((await refusal(runCast(h.deps, { ...base, selectionsFile: 'sel.json' }))).code).to.equal('selections-file-invalid')
    const loose = join(h.home, 'secrets', 'loose.json')
    writeFileSync(loose, '{}', { mode: 0o644 })
    chmodSync(loose, 0o644)
    expect((await refusal(runCast(h.deps, { ...base, selectionsFile: loose }))).code).to.equal('selections-file-invalid')
    const big = join(h.home, 'secrets', 'big.json')
    writeFileSync(big, '{"k":"' + 'a'.repeat(17 * 1024) + '"}', { mode: 0o600 })
    expect((await refusal(runCast(h.deps, { ...base, selectionsFile: big }))).code).to.equal('selections-file-invalid')
    const arr = join(h.home, 'secrets', 'arr.json')
    writeFileSync(arr, '[]', { mode: 0o600 })
    expect((await refusal(runCast(h.deps, { ...base, selectionsFile: arr }))).code).to.equal('selections-file-invalid')
    expect((await refusal(runCast(h.deps, { ...base, choiceIndex: 'x' }))).code).to.equal('choice-index-invalid')
    expect((await refusal(runCast(h.deps, { ...base, choiceIndex: '64' }))).code).to.equal('choice-index-invalid')
    expect(h.calls).to.deep.equal([])
    expect(h.tokenReads()).to.equal(0)
  })

  it('cast refuses choice-file-exists before any token read', async () => {
    h = await makeHarness()
    const choice = join(h.home, 'secrets', 'vote-choice-' + ELECTION.slice(0, 8) + '.json')
    writeFileSync(choice, '[]', { mode: 0o600 })
    const e = await refusal(runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: '/nonexistent/dir/token' }))
    expect(e.code).to.equal('choice-file-exists')
    expect(h.opens()).to.equal(0)
    expect(h.calls).to.deep.equal([])
  })

  it('cast happy path: the documented keys, a 0600 choice file, one unwrap, three token reads, and a kv holding only ciphertext', async () => {
    h = await makeHarness()
    const result = await runCast(h.deps, { network: HASH, election: ELECTION, choiceIndex: '1', tokenFile: h.tokenFile })
    expect(Object.keys(result).sort()).to.deep.equal([...CAST_KEYS].sort())
    expect(result.electionId).to.equal(ELECTION)
    expect(result.electionRevision).to.equal(3)
    expect(result.ballots).to.deep.equal(['b-1'])
    expect(result.replacedStale).to.equal(false)
    expect(result.castUnwraps).to.equal(1)
    expect(result.tokenReads).to.equal(3)
    expect(h.tokenReads()).to.equal(3)
    const choiceFile = result.choiceFile as string
    expect(statSync(choiceFile).mode & 0o777).to.equal(0o600)
    const projection = JSON.parse(readFileSync(choiceFile, 'utf8')) as Array<{ ballotId: string, answers: Array<{ questionCode: string, optionCodes: string[] }> }>
    expect(projection).to.deep.equal([{ ballotId: 'b-1', answers: [{ questionCode: 'q1', optionCodes: ['y'] }] }])
    // open the record ourselves through the shared vault and the CLI provider, register its secrets, scan the home minus secrets/
    const ports = createCliVoteRecordPorts({ kv: h.kv, keys: h.device.keys, approval: createApprovalContext({ file: h.tokenFile }), debug: createRedactingVoteSendDebug({ redact: (t) => t }, () => undefined) })
    const load = await ports.receipt.loadVoteReceipt(ELECTION, 3)
    expect(load.kind).to.equal('saved')
    const reveal = await ports.receipt.revealVoteReceipt(ELECTION, load.kind === 'saved' ? load.envelope : (undefined as never), CLI_VOTE_PROMPT)
    expect(reveal.kind).to.equal('ok')
    const record = (reveal as { record: { votes: Array<{ nonce: string, answers: Array<{ optionCodes: string[] }> }>, voter: { signature: string } } }).record
    const reg = new SecretRegistry()
    for (const v of record.votes) {
      reg.add(v.nonce, { windows: true })
      for (const a of v.answers) for (const c of a.optionCodes) reg.add(c, { windows: true })
    }
    reg.add(record.voter.signature, { windows: true })
    const nodeScan = scanSecrets(join(h.home, 'node'), reg)
    const vaultScan = scanSecrets(join(h.home, 'vault'), reg)
    expect(nodeScan.files).to.be.greaterThan(0)
    expect({ whole: nodeScan.whole + vaultScan.whole, windows: nodeScan.windows + vaultScan.windows }).to.deep.equal({ whole: 0, windows: 0 })
    const kvText = readFileSync(join(h.home, 'node', 'async-storage.json'), 'utf8')
    expect(kvText).to.include(CLI_VOTE_RECORD_WRAP_KEY_ALIAS)
    expect(kvText).to.not.include('"optionCodes"')
  })

  it('a wrong token refuses with a sign: code and the kv holds no marker afterwards', async () => {
    h = await makeHarness()
    const e = await refusal(runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.wrongTokenFile }))
    expect(e.code).to.match(/^sign:/)
    expect(await h.kv.getItem(voteMarkerKey(ELECTION))).to.equal(null)
    expect(h.kv.keys()).to.deep.equal([])
  })

  it('cast refuses election-mismatch with zero signatures', async () => {
    h = await makeHarness()
    h.script.contextElectionId = 'election-other'
    const e = await refusal(runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))
    expect(e.code).to.equal('election-mismatch')
    expect(h.device.vault.authPromptCount).to.equal(0)
    expect(h.tokenReads()).to.equal(0)
    expect(h.kv.keys()).to.deep.equal([])
  })

  it('a second cast with the choice file removed refuses ineligible:<already-saved reason>', async () => {
    h = await makeHarness()
    const first = await runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile })
    unlinkSync(first.choiceFile as string)
    const e = await refusal(runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))
    expect(e.code).to.match(/^ineligible:/)
    expect(e.code).to.include('already')
  })

  it('the CLI wrap provider round-trips, refuses a wrong token as UNWRAP_TAG_MISMATCH, no approval as CANCELED, a swapped AAD, and leaks nothing', async () => {
    h = await makeHarness()
    const provider = createCliVoteRecordWrapProvider({ keys: h.device.keys, approval: createApprovalContext({ file: h.tokenFile }) })
    const dataKey = randomBytes(32)
    const aad = Buffer.from('votetorrent-vote-record-v1:' + ELECTION)
    const wrapped = await provider.wrap(dataKey, aad, CLI_VOTE_PROMPT)
    expect(wrapped.keyAlias).to.equal(CLI_VOTE_RECORD_WRAP_KEY_ALIAS)
    expect(wrapped.securityLevel).to.equal('software')
    expect(Buffer.from(await provider.unwrap(wrapped, aad, CLI_VOTE_PROMPT))).to.deep.equal(dataKey)
    const wrong = createCliVoteRecordWrapProvider({ keys: h.device.keys, approval: createApprovalContext({ file: h.wrongTokenFile }) })
    const mismatch = await refusal(wrong.unwrap(wrapped, aad, CLI_VOTE_PROMPT))
    expect(mismatch.name).to.equal('VoteRecordWrapError')
    expect(mismatch.code).to.equal('UNWRAP_TAG_MISMATCH')
    const none = createCliVoteRecordWrapProvider({ keys: h.device.keys, approval: NO_APPROVAL })
    expect((await refusal(none.wrap(dataKey, aad, CLI_VOTE_PROMPT))).code).to.equal('CANCELED')
    expect((await refusal(provider.unwrap(wrapped, Buffer.from('votetorrent-vote-record-v1:other'), CLI_VOTE_PROMPT))).code).to.equal('UNWRAP_TAG_MISMATCH')
    expect((await refusal(provider.unwrap({ ...wrapped, keyAlias: 'OTHER' }, aad, CLI_VOTE_PROMPT))).code).to.equal('INVALID_ARGUMENT')
    assertNoLeak(JSON.stringify(wrapped), [dataKey])
    expect(mismatch.message).to.equal('vote record wrap refused (UNWRAP_TAG_MISMATCH)')
  })

  it('send refuses token-absent before any read, and no-saved-vote with zero dials and zero token reads', async () => {
    h = await makeHarness()
    const absent = await refusal(runSend(h.deps, { network: HASH, election: ELECTION }))
    expect(absent.code).to.equal('token-absent')
    expect(h.opens()).to.equal(0)
    const none = await refusal(runSend(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))
    expect(none.code).to.equal('no-saved-vote')
    expect(h.dials()).to.equal(0)
    expect(h.tokenReads()).to.equal(0)
    expect(h.device.vault.authPromptCount).to.equal(0)
  })

  it('send with a control node whose dial never settles refuses send:rendezvous-unreachable at zero token reads and zero prompts', async () => {
    h = await makeHarness()
    await runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile })
    h.resetCounters()
    const before = h.device.vault.authPromptCount
    const started = Date.now()
    const e = await refusal(runSend(h.deps, { network: HASH, election: ELECTION, probeBudgetMs: '1000', tokenFile: h.tokenFile }))
    expect(e.code).to.equal('send:rendezvous-unreachable')
    expect(Date.now() - started).to.be.lessThan(15000)
    expect(h.dials()).to.be.greaterThan(0)
    expect(h.tokenReads()).to.equal(0)
    expect(h.device.vault.authPromptCount - before).to.equal(0)
    expect((await refusal(runSend(h.deps, { network: HASH, election: ELECTION, probeBudgetMs: '999', tokenFile: h.tokenFile }))).code).to.equal('probe-budget-invalid')
  })

  it('send with no node refuses send:no-network with zero token reads', async () => {
    h = await makeHarness()
    await runCast(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile })
    h.resetCounters()
    h.deps.node = null
    const e = await refusal(runSend(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))
    expect(e.code).to.equal('send:no-network')
    expect(h.tokenReads()).to.equal(0)
    expect(h.dials()).to.equal(0)
  })

  it('the sink drops message, stack and cause, cuts a 64-hex run to 8 characters, prefixes ids, and leaks nothing', async () => {
    h = await makeHarness()
    const lines: string[] = []
    const sink = createRedactingVoteSendDebug({ redact: (t) => t }, (line) => { lines.push(line) })
    const nonce = randomBytes(32)
    const signature = randomBytes(64)
    sink.vtDebug('pool', 'status', { message: 'the error text', stack: 'at x', cause: { message: 'inner' }, digest: nonce.toString('hex'), sig: signature.toString('base64url'), ok: true, n: 2, nested: { message: 'm2', k: 'v' } })
    expect(lines).to.have.length(1)
    const line = lines[0]!
    expect(line.startsWith('VT-DEBUG pool status ')).to.equal(true)
    const detail = JSON.parse(line.slice('VT-DEBUG pool status '.length)) as Record<string, unknown>
    expect(Object.keys(detail).sort()).to.deep.equal(['digest', 'n', 'nested', 'ok', 'sig'])
    expect(detail.digest).to.equal(nonce.toString('hex').slice(0, 8))
    // an 86-character base64url signature is longer than 64, so the length rule wins over the run cut
    expect(detail.sig).to.equal('len:86')
    expect(detail.nested).to.deep.equal({ k: 'v' })
    expect(sink.idPrefix('0123456789abcdef')).to.equal('01234567')
    expect(sink.idPrefix(5)).to.equal('number')
    assertNoLeak(lines.join('\n'), [nonce, signature])
  })

  it('results refuses wait-invalid, election-mismatch and results-awaiting-keys at waitMs 0 on a fake engine', async () => {
    h = await makeHarness()
    expect((await refusal(runVoterResults(h.deps, { network: HASH, election: ELECTION, waitMs: 'abc' }))).code).to.equal('wait-invalid')
    expect((await refusal(runVoterResults(h.deps, { network: HASH, election: ELECTION, tokenFile: h.tokenFile }))).code).to.equal('bad-arg')
    expect(h.opens()).to.equal(0)
    h.script.results = (id) => ({ status: 'awaiting-keys', electionId: 'election-other', phase: 'releasing', revision: 3, threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: null, id })
    expect((await refusal(runVoterResults(h.deps, { network: HASH, election: ELECTION }))).code).to.equal('election-mismatch')
    h.script.results = (id) => ({ status: 'awaiting-keys', electionId: id, phase: 'releasing', revision: 3, threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: null })
    const e = await refusal(runVoterResults(h.deps, { network: HASH, election: ELECTION, waitMs: '0' }))
    expect(e.name).to.equal('VerbRefusal')
    expect(e.code).to.equal('results-awaiting-keys')
    expect(h.calls.filter((c) => c === 'electionResults.get')).to.have.length(2)
  })

  it('agreementOf: equal reads hash equal, one changed count changes countsSha256, and a false signatureValid is never reported true', async () => {
    h = await makeHarness()
    const opened = { openedSetSha256: 'o'.repeat(64) }
    const a = agreementOf(talliedRead({ x: 2, y: 1 }, null), opened)
    const b = agreementOf(talliedRead({ x: 2, y: 1 }, null), opened)
    expect(a.agreementSha256).to.equal(b.agreementSha256)
    expect(diffAgreement(a, b)).to.deep.equal([])
    const c = agreementOf(talliedRead({ x: 1, y: 2 }, null), opened)
    expect(c.agreementSha256).to.not.equal(a.agreementSha256)
    expect(diffAgreement(a, c)).to.deep.equal(['countsSha256'])
    const d = agreementOf(talliedRead({ x: 2, y: 1 }, { signatureValid: false, treeCheck: { ok: true }, matchesRecomputed: true } as never), opened)
    expect(d.fields.publication).to.deep.equal({ found: true, signatureValid: false, treeOk: true, matchesRecomputed: true })
    // a's publication is null (every flag false), so signatureValid false agrees and the other three differ
    expect(diffAgreement(a, d)).to.deep.equal(['publication.found', 'publication.treeOk', 'publication.matchesRecomputed'])
    const e = agreementOf(talliedRead({ x: 2, y: 1 }, { signatureValid: true, treeCheck: { ok: true }, matchesRecomputed: true } as never), opened)
    expect(diffAgreement(d, e)).to.deep.equal(['publication.signatureValid'])
    const unknown = agreementOf(talliedRead({ x: 2, y: 1 }, 'unknown'), opened)
    expect(unknown.fields.publication.found).to.equal(false)
    expect(JSON.stringify(a.fields)).to.not.include('"x"')
  })
})
