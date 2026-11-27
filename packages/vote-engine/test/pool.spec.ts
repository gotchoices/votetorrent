/**
 * pool.spec.ts — vote pools (spike 102, applied): sealed envelopes, the rendezvous, the v2 block a
 * pool forms, the checks a member runs before it signs, and the agent's negotiation over an
 * in-process rendezvous. The same agent runs on real CadreNodes in
 * .planning/spikes/102-pool-negotiation/product-pool.ts.
 */

import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { registerDbPlugins } from '../src/database/initialize.js'
import { encryptVoteEntry, openElectionBlock, openVoteEntries } from '../src/key-release/index.js'
import {
  PoolAgent,
  PoolRendezvous,
  checkFormedPoolBlock,
  commitPoolBlock,
  consentDigest,
  createInMemoryRendezvousClient,
  ed25519PublicKeyFromPeerId,
  formPoolBlock,
  openPoolEnvelope,
  peerIdFromEd25519PublicKey,
  poolBlockCid,
  poolBlockId,
  poolIdentityFromRawKey,
  poolRequests,
  sealPoolEnvelope,
  createPoolIdentity,
  type ConsentSignature,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolContribution,
  poolTopic,
  type PoolDiscovery,
  type RendezvousRequest,
  type RendezvousReply,
  type PoolIdentity,
  type PoolAgentOptions,
  type PoolOutcome
} from '../src/pool/index.js'
import * as poolBlock from '../src/pool/pool-block.js'
import {
  POOL_LADDER_DWELL_PRESENTS,
  POOL_LADDER_MAX_MS,
  POOL_LADDER_RUNG_BITS,
  POOL_TOPIC_MAX_CHARS,
  ladderBucket,
  ladderTopic,
  rendezvousDiscovery
} from '../src/pool/pool-discovery.js'
import { matchmakingDiscovery, mergedDiscovery, type PoolMatchEntry, type PoolMatchmakingPorts } from '../src/pool/pool-matchmaking.js'
import { fromBase64url, toBase64url } from '../src/pool/pool-codec.js'
import type { VoterEntry } from '../src/voting/index.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const electionSecret = secp256k1.utils.randomSecretKey()
const ballot: PoolBallot = {
  electionKey: { electionId: 'election-pool-1', revision: 1, jointPublicKey: bytesToHex(secp256k1.getPublicKey(electionSecret, true)) },
  ballotId: 'ballot-pool-1',
  templateDigest: 'template-digest-1'
}

interface TestVoter { identity: PoolIdentity, contribution: PoolContribution, voteJson: string, priv: Uint8Array }

function makeVoter (i: number): TestVoter {
  const identity = poolIdentityFromRawKey(ed25519.utils.randomSecretKey())
  const { privBytes, pubHex } = makeP256TestKey()
  const voteJson = JSON.stringify({ v: 1, ballotId: ballot.ballotId, answers: [{ questionCode: 'q1', optionCodes: [i % 2 === 0 ? 'a' : 'b'] }], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
  const voterEntry: VoterEntry = {
    v: 1, electionId: ballot.electionKey.electionId, electionRevision: ballot.electionKey.revision, registrantId: `registrant-${i}-${Math.random().toString(36).slice(2, 8)}`,
    privateCid: `private-${i}`, publicCid: null, deviceKey: pubHex, attestationCid: null,
    ballots: [{ ballotId: ballot.ballotId, templateDigest: ballot.templateDigest }], signature: 'ab'.repeat(32)
  }
  return {
    identity,
    voteJson,
    priv: privBytes,
    contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(ballot.electionKey, ballot.ballotId, voteJson), voterEntry }
  }
}

describe('pool (spike 102): codec and peer ids', () => {
  it('base64url round-trips every length and refuses padding, foreign characters and non-canonical tails', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n))
      expect(Array.from(fromBase64url(toBase64url(bytes))!)).to.deep.equal(Array.from(bytes))
    }
    expect(fromBase64url('AA==')).to.equal(null)
    expect(fromBase64url('A+B/')).to.equal(null)
    expect(fromBase64url('AB')).to.equal(null) // 'B' leaves non-zero spare bits: not the canonical encoding of 0x00
    expect(fromBase64url('A')).to.equal(null)
  })

  it('a peer id is the Ed25519 public key, both ways, and matches libp2p', async () => {
    const { generateKeyPair } = await import('@libp2p/crypto/keys') as { generateKeyPair: (t: string) => Promise<{ raw: Uint8Array }> }
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id') as { peerIdFromPrivateKey: (k: unknown) => { toString: () => string } }
    const key = await generateKeyPair('Ed25519')
    const libp2pPeerId = peerIdFromPrivateKey(key).toString()
    const identity = poolIdentityFromRawKey(key.raw)
    expect(identity.peerId).to.equal(libp2pPeerId)
    expect(peerIdFromEd25519PublicKey(ed25519PublicKeyFromPeerId(libp2pPeerId))).to.equal(libp2pPeerId)
    expect(() => ed25519PublicKeyFromPeerId('QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N')).to.throw().with.property('code', 'bad-peer-id')
  })
})

describe('pool (spike 102): sealed envelopes', () => {
  const a = makeVoter(0).identity
  const b = makeVoter(1).identity
  const c = makeVoter(2).identity

  it('only the recipient opens it, and it names the real sender', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'hello', n: 1 })
    const opened = openPoolEnvelope<{ t: string, n: number }>(b, env)
    expect(opened.from).to.equal(a.peerId)
    expect(opened.body).to.deep.equal({ t: 'hello', n: 1 })
    expect(() => openPoolEnvelope(c, env)).to.throw().with.property('code', 'not-for-me')
    expect(() => openPoolEnvelope(c, { ...env, to: c.peerId })).to.throw().with.property('code', 'auth-failed')
  })

  it('a flipped ciphertext byte is refused', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'x' })
    const ct = fromBase64url(env.ct)!
    ct[0] = ct[0]! ^ 1
    expect(() => openPoolEnvelope(b, { ...env, ct: toBase64url(ct) })).to.throw().with.property('code', 'auth-failed')
  })

  it('a sender claiming another peer id fails the signature check', () => {
    const forger: PoolIdentity = { peerId: c.peerId, secretKey: a.secretKey }
    const env = sealPoolEnvelope(forger, b.peerId, { t: 'x' })
    expect(() => openPoolEnvelope(b, env)).to.throw().with.property('code', 'bad-signature')
  })

  it('a stale envelope is refused', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'x' }, Date.now() - 11 * 60_000)
    expect(() => openPoolEnvelope(b, env)).to.throw().with.property('code', 'stale')
  })

  it('the rendezvous-visible envelope carries no body text', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'merge', registrantId: 'registrant-secret-xyz' })
    expect(JSON.stringify(env)).to.not.contain('registrant-secret-xyz')
    expect(JSON.stringify(env)).to.not.contain('merge')
  })
})

describe('pool (spike 102): per-vote ciphertexts and the v2 block', () => {
  const voters = [0, 1, 2, 3].map(makeVoter)
  const contributions = voters.map(v => v.contribution)

  it('a formed block passes every member\'s check and reopens to the same votes after release', () => {
    const block = formPoolBlock(contributions, ballot)
    for (const v of voters) expect(checkFormedPoolBlock(block, v.contribution, ballot)).to.deep.equal({ ok: true })
    const opened = openElectionBlock(electionSecret, ballot.electionKey, { blockId: block.blockId, ciphertext: block.ciphertext })
    expect(opened.ok).to.equal(true)
    if (!opened.ok) return
    expect(opened.payload.v).to.equal(2)
    const votes = openVoteEntries(electionSecret, ballot.electionKey, ballot.ballotId, opened.payload)
    expect(votes.every(v => v.ok)).to.equal(true)
    expect(votes.map(v => (v as { voteEntryJson: string }).voteEntryJson).sort()).to.deep.equal(voters.map(v => v.voteJson).sort())
  })

  it('the block lists votes in canonical order, not pool order', () => {
    const a = formPoolBlock(contributions, ballot)
    const b = formPoolBlock([...contributions].reverse(), ballot)
    expect(a.payload.votes).to.deep.equal(b.payload.votes)
    expect(a.payload.voterRecords).to.deep.equal(b.payload.voterRecords)
    expect(a.blockId).to.equal(b.blockId)
  })

  it('a vote cannot be opened under another ballot\'s binding', () => {
    const block = formPoolBlock(contributions, ballot)
    const opened = openElectionBlock(electionSecret, ballot.electionKey, { blockId: block.blockId, ciphertext: block.ciphertext })
    if (!opened.ok) throw new Error('block did not open')
    expect(openVoteEntries(electionSecret, ballot.electionKey, 'other-ballot', opened.payload).every(v => !v.ok)).to.equal(true)
  })

  const refusal = (block: FormedPoolBlock, who = voters[0]!.contribution) => checkFormedPoolBlock(block, who, ballot)

  it('a member refuses a block missing, altering or duplicating its vote', () => {
    const block = formPoolBlock(contributions, ballot)
    const withoutMine = formPoolBlock(contributions.slice(1), ballot)
    expect(refusal(withoutMine)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
    // The former swaps member 0's vote for another ciphertext and re-forms honestly around it.
    const swapped = formPoolBlock([{ ...contributions[0]!, voteCiphertext: encryptVoteEntry(ballot.electionKey, ballot.ballotId, '{"forged":true}') }, ...contributions.slice(1)], ballot)
    expect(refusal(swapped)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
    expect(refusal({ ...block, registrantIds: block.registrantIds.slice(1) }).ok).to.equal(false)
  })

  it('a member refuses a block whose ciphertext, id, cid, order or template does not match', () => {
    const block = formPoolBlock(contributions, ballot)
    const other = formPoolBlock(contributions, ballot)
    expect(refusal({ ...block, ciphertext: other.ciphertext })).to.deep.equal({ ok: false, reason: 'the ciphertext does not encrypt the shown payload' })
    expect(refusal({ ...block, blockId: 'x' + block.blockId.slice(1) }).ok).to.equal(false)
    expect(refusal({ ...block, cid: other.cid })).to.deep.equal({ ok: false, reason: 'the cid does not match the ciphertext' })
    expect(refusal({ ...block, payload: { ...block.payload, votes: [...block.payload.votes].reverse() } })).to.deep.equal({ ok: false, reason: 'the entries are not in canonical order' })
    expect(refusal({ ...block, templateDigest: 'other' })).to.deep.equal({ ok: false, reason: 'the block names another ballot template' })
  })

  it('the TS block id, cid and consent digest equal the SQL the schema checks', async () => {
    const db = new Database()
    await registerDbPlugins(db)
    const block = formPoolBlock(contributions, ballot)
    const json = JSON.stringify({ v: block.payload.v, votes: block.payload.votes, voterRecords: block.payload.voterRecords })
    const sqlId = (await db.prepare("select Digest('VoteBlockRecords', :p) as v").get({ p: json }))?.v
    const sqlCid = (await db.prepare('select cid(Digest(:ct)) as v').get({ ct: block.ciphertext }))?.v
    const reg = contributions[0]!.voterEntry
    const sqlConsent = (await db.prepare("select Digest('VoteBlockVoter', :e, :r, :b, :c, :i, :reg, :dk) as v").get({
      e: ballot.electionKey.electionId, r: ballot.electionKey.revision, b: ballot.ballotId, c: block.cid, i: block.blockId, reg: reg.registrantId, dk: reg.deviceKey
    }))?.v
    expect(poolBlockId(block.payload)).to.equal(sqlId)
    expect(poolBlockCid(block.ciphertext)).to.equal(sqlCid)
    expect(consentDigest(block, ballot, reg.registrantId, reg.deviceKey)).to.equal(sqlConsent)
  })
})

describe('pool (spike 102): rendezvous', () => {
  it('lists other coordinators, holds a poll until mail arrives, and drains only the caller\'s own mailbox', async () => {
    const rv = new PoolRendezvous()
    const [a, b, c] = [createPoolIdentity(), createPoolIdentity(), createPoolIdentity()]
    const now = () => Date.now()
    expect(await rv.handle('t', poolRequests.present(a, 'topic', 2, now()))).to.deep.equal({ t: 'coordinators', list: [] })
    expect(await rv.handle('t', poolRequests.present(b, 'topic', 1, now()))).to.deep.equal({ t: 'coordinators', list: [{ peerId: a.peerId, size: 2 }] })
    const held = rv.handle('t', poolRequests.poll(b, 2000, now()))
    const env = sealPoolEnvelope(a, b.peerId, { hi: 1 })
    expect(await rv.handle('t', poolRequests.send(env))).to.deep.equal({ t: 'ok' })
    expect(await held).to.deep.equal({ t: 'envelopes', list: [env] })
    await rv.handle('t', poolRequests.send(env))
    expect(await rv.handle('t', poolRequests.poll(c, 0, now()))).to.deep.equal({ t: 'envelopes', list: [] })
    expect(await rv.handle('t', poolRequests.poll(b, 0, now()))).to.deep.equal({ t: 'envelopes', list: [env] })
    await rv.handle('t', poolRequests.withdraw(a, 'topic', now()))
    expect(await rv.handle('t', poolRequests.present(c, 'topic', 1, now()))).to.deep.equal({ t: 'coordinators', list: [{ peerId: b.peerId, size: 1 }] })
    rv.close()
  })

  it('only the holder of a pool identity can present as it or drain its mailbox', async () => {
    const rv = new PoolRendezvous()
    const [a, b] = [createPoolIdentity(), createPoolIdentity()]
    await rv.handle('t', poolRequests.send(sealPoolEnvelope(a, b.peerId, { secret: true })))
    // b's request re-labelled as a: the signature no longer matches
    const forgedPoll = { ...poolRequests.poll(b, 0, Date.now()), as: a.peerId }
    expect(await rv.handle('t', forgedPoll)).to.deep.equal({ t: 'error', reason: 'bad signature' })
    const forgedPresent = { ...poolRequests.present(a, 'topic', 1, Date.now()), size: 9 }
    expect(await rv.handle('t', forgedPresent)).to.deep.equal({ t: 'error', reason: 'bad signature' })
    // a stale but correctly signed request
    expect(await rv.handle('t', poolRequests.poll(b, 0, Date.now() - 5 * 60_000))).to.deep.equal({ t: 'error', reason: 'bad signature' })
    expect(rv.stats.badSignature).to.equal(3)
    expect((await rv.handle('t', poolRequests.poll(b, 0, Date.now()))) as { list: unknown[] }).to.have.property('list').with.length(1)
  })

  it('refuses a transport peer the admission check refuses, a malformed envelope and an oversized one', async () => {
    const rv = new PoolRendezvous({ isAllowed: (p) => p !== 'stranger', maxEnvelopeChars: 200 })
    const a = createPoolIdentity()
    expect(await rv.handle('stranger', poolRequests.present(a, 'topic', 1, Date.now()))).to.deep.equal({ t: 'error', reason: 'not allowed' })
    expect(await rv.handle('member', { t: 'send', envelope: { v: 1, to: '', eph: '', nonce: '', ct: '' } })).to.deep.equal({ t: 'error', reason: 'bad envelope' })
    expect(await rv.handle('member', { t: 'send', envelope: { v: 1, to: 'b', eph: '', nonce: '', ct: 'x'.repeat(300) } })).to.deep.equal({ t: 'error', reason: 'envelope too large' })
  })
})

describe('pool (spike 102): agents negotiate through the rendezvous', function () {
  this.timeout(30_000)

  interface Run {
    hijackReplies: string[]
    outcomes: PoolOutcome[]
    commits: Array<{ block: FormedPoolBlock, signatures: ConsentSignature[] }>
    rendezvous: PoolRendezvous
    commitCalls: number
    logs: Array<{ i: number, event: string, detail?: Record<string, unknown> }>
    requests: Array<{ i: number, t: string, topic: string, at: number }>
    discoveryCalls: Array<{ i: number, t: string, topic: string, at: number }>
    startedAt: number
    deadlineAt: number
    commitAt: number[]
  }

  async function runAgents (voters: TestVoter[], opts: {
    deadlineMs?: number
    abortWhenMember?: number
    badSigner?: number
    quietMs?: number
    preVoted?: number[]
    preVotedReadable?: boolean
    /** the duplicate's earlier row becomes readable only this long after the failed commit */
    readableAfterMs?: number
    /** a dishonest former: the first commit holding this voter's signature claims it already voted */
    lieAbout?: number
    /** a peer that knows this voter's vote ciphertext keeps sending it inform + already-voted */
    hijack?: number
    /** per-agent delay before run() starts */
    startDelayMs?: number[]
    /** spread LAST into every agent's options (explicit undefined included) */
    extra?: Partial<PoolAgentOptions>
    ladder?: boolean | boolean[]
    rungDwellTicks?: number
    ladderMaxMs?: number
    formLeadMs?: number
    presentIntervalMs?: number
    injectDiscovery?: boolean
    /** replaces the agent's discovery outright (the rendezvous client still carries the mailbox) */
    discoveryFor?: (i: number, v: TestVoter, rendezvous: PoolRendezvous) => PoolDiscovery
  } = {}): Promise<Run> {
    const rendezvous = new PoolRendezvous()
    const commits: Run['commits'] = []
    const committedRegistrants = new Set<string>((opts.preVoted ?? []).map(i => voters[i]!.contribution.voterEntry.registrantId))
    const readable = new Set<string>()
    const logs: Run['logs'] = []
    let commitCalls = 0
    const requests: Run['requests'] = []
    const discoveryCalls: Run['discoveryCalls'] = []
    const commitAt: number[] = []
    const startedAt = Date.now()
    const deadlineAt = Date.now() + (opts.deadlineMs ?? 20_000)
    let lied = false
    let hijacking = opts.hijack !== undefined
    const hijacker = createPoolIdentity()
    const hijackClient = createInMemoryRendezvousClient(rendezvous, 'transport-hijacker')
    const hijackReplies: string[] = []
    const drainHijacker = async (): Promise<void> => {
      const r = await hijackClient.call(poolRequests.poll(hijacker, 0, Date.now()))
      if (r.t === 'envelopes') for (const e of r.list) hijackReplies.push(openPoolEnvelope<{ t: string }>(hijacker, e).body.t)
    }
    const hijackLoop = (async () => {
      if (opts.hijack === undefined) return
      const victim = voters[opts.hijack]!
      const hold = bytesToHex(sha256(utf8ToBytes(victim.contribution.voteCiphertext)))
      for (let n = 0; hijacking; n++) {
        const to = victim.identity.peerId
        await hijackClient.call(poolRequests.send(sealPoolEnvelope(hijacker, to, { t: 'inform', id: `hijack-${n}`, topic: poolTopic(ballot), size: 9, hold })))
        await hijackClient.call(poolRequests.send(sealPoolEnvelope(hijacker, to, { t: 'outcome', topic: poolTopic(ballot), committed: false, reason: 'already voted', code: 'already-voted' })))
        await new Promise(resolve => setTimeout(resolve, 50))
        await drainHijacker()
      }
      await drainHijacker()
    })()
    const outcomes = await Promise.all(voters.map(async (v, i) => {
      const controller = new AbortController()
      const inner = createInMemoryRendezvousClient(rendezvous, `transport-${i}`)
      const recorder = {
        async call (request: RendezvousRequest, extraWaitMs?: number): Promise<RendezvousReply> {
          if (request.t === 'present' || request.t === 'withdraw') requests.push({ i, t: request.t, topic: request.topic, at: Date.now() })
          return await inner.call(request, extraWaitMs)
        }
      }
      const plainDiscovery = rendezvousDiscovery(createInMemoryRendezvousClient(rendezvous, `transport-${i}`), v.identity)
      const discovery: PoolDiscovery = {
        async present (topic, size, now) { discoveryCalls.push({ i, t: 'present', topic, at: Date.now() }); return await plainDiscovery.present(topic, size, now) },
        async withdraw (topic, now) { discoveryCalls.push({ i, t: 'withdraw', topic, at: Date.now() }); await plainDiscovery.withdraw(topic, now) }
      }
      const ladderOpt = Array.isArray(opts.ladder) ? opts.ladder[i] : opts.ladder
      const agent = new PoolAgent({
        identity: v.identity,
        rendezvous: recorder,
        ...(opts.injectDiscovery === true ? { discovery } : {}),
        ...(opts.discoveryFor !== undefined ? { discovery: opts.discoveryFor(i, v, rendezvous) } : {}),
        ...(ladderOpt !== undefined ? { ladder: ladderOpt } : {}),
        ...(opts.rungDwellTicks !== undefined ? { rungDwellTicks: opts.rungDwellTicks } : {}),
        ...(opts.ladderMaxMs !== undefined ? { ladderMaxMs: opts.ladderMaxMs } : {}),
        ballot,
        contribution: v.contribution,
        signConsent: async (digest) => (opts.badSigner === i ? 'aa'.repeat(64) : signDigestP256(digest, v.priv)),
        commit: async (block, signatures) => {
          commitCalls++
          commitAt.push(Date.now())
          const liar = opts.lieAbout === undefined ? undefined : voters[opts.lieAbout]!.contribution.voterEntry.registrantId
          if (!lied && liar !== undefined && signatures.some(s => s.registrantId === liar)) {
            lied = true
            return { ok: false, reason: 'a voter already voted', duplicateRegistrants: [liar] }
          }
          if (signatures.some(s => committedRegistrants.has(s.registrantId))) {
            const duplicateRegistrants = signatures.map(s => s.registrantId).filter(r => committedRegistrants.has(r))
            if (opts.preVotedReadable === true) for (const r of duplicateRegistrants) readable.add(r)
            if (opts.readableAfterMs !== undefined) setTimeout(() => { for (const r of duplicateRegistrants) readable.add(r) }, opts.readableAfterMs)
            return { ok: false, reason: 'a voter already voted', duplicateRegistrants }
          }
          for (const s of signatures) committedRegistrants.add(s.registrantId)
          commits.push({ block, signatures })
          return { ok: true }
        },
        findRecordedVote: async () => readable.has(v.contribution.voterEntry.registrantId)
          ? `prevoted-cid-${v.contribution.voterEntry.registrantId}`
          : commits.find(c => c.signatures.some(s => s.registrantId === v.contribution.voterEntry.registrantId))?.block.cid ?? null,
        log: (event, detail) => { logs.push({ i, event, detail }) },
        quietMs: opts.quietMs ?? 400,
        presentIntervalMs: opts.presentIntervalMs ?? 60,
        replyTimeoutMs: 400,
        informAttempts: 2,
        signTimeoutMs: 1_500,
        memberTimeoutMs: 3_000,
        pollWaitMs: 200,
        formLeadMs: opts.formLeadMs ?? 0,
        deadlineAt,
        onStatus: (s) => { if (opts.abortWhenMember === i && s.phase === 'member') controller.abort() },
        ...opts.extra
      })
      const delay = opts.startDelayMs?.[i] ?? 0
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return await agent.run(controller.signal)
    }))
    hijacking = false
    await hijackLoop
    rendezvous.close()
    return { hijackReplies, outcomes, commits, rendezvous, commitCalls, logs, requests, discoveryCalls, startedAt, deadlineAt, commitAt }
  }

  it('five voters converge on ONE block of five; every signature verifies; each learns the cid', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    const run = await runAgents(voters)
    expect(run.commits.map(c => c.block.registrantIds.length)).to.deep.equal([5])
    const cid = run.commits[0]!.block.cid
    expect(run.outcomes.map(o => o.status)).to.deep.equal(Array(5).fill('committed'))
    expect(run.outcomes.every(o => o.status === 'committed' && o.cid === cid)).to.equal(true)
    expect(run.outcomes.filter(o => o.status === 'committed' && o.formedByMe)).to.have.length(1)
  })

  it('two voters alone never form a block (minimum 3): both stop at the deadline with nothing committed', async () => {
    const run = await runAgents([0, 1].map(makeVoter), { deadlineMs: 2_000 })
    expect(run.commits).to.deep.equal([])
    expect(run.outcomes).to.deep.equal([{ status: 'stopped', reason: 'deadline' }, { status: 'stopped', reason: 'deadline' }])
  })

  it('IN-01 minSize below the floor is clamped after the options spread: two voters with minSize 2 still never form', async () => {
    const run = await runAgents([0, 1].map(makeVoter), { deadlineMs: 2_000, extra: { minSize: 2 } })
    expect(run.commits).to.deep.equal([])
    expect(run.outcomes).to.deep.equal([{ status: 'stopped', reason: 'deadline' }, { status: 'stopped', reason: 'deadline' }])
  })

  it('IN-01 an explicit undefined ladder / rungDwellTicks takes the defaults: the lone coordinator still climbs 2-bit, 1-bit, plain', async () => {
    const v = makeVoter(0)
    const run = await runAgents([v], { quietMs: 5_000, deadlineMs: 1_500, extra: { ladder: undefined, rungDwellTicks: undefined } })
    const topics = run.requests.filter(r => r.i === 0 && r.t === 'present').map(r => r.topic)
    const plain = poolTopic(ballot)
    const hold = bytesToHex(sha256(utf8ToBytes(v.contribution.voteCiphertext)))
    expect(topics.length).to.be.at.least(8)
    expect(topics.slice(0, 3)).to.deep.equal(Array(3).fill(ladderTopic(plain, 2, [hold])))
    expect(topics.slice(3, 6)).to.deep.equal(Array(3).fill(ladderTopic(plain, 1, [hold])))
    expect(topics.slice(6)).to.deep.equal(Array(topics.length - 6).fill(plain))
  })

  it('a member that goes silent after merging is dropped after retries; the other four still commit', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    // the agent with the highest peer id always merges away (it loses every tie), so it is a member
    const silent = voters.reduce((m, v, i) => (v.identity.peerId > voters[m]!.identity.peerId ? i : m), 0)
    const run = await runAgents(voters, { abortWhenMember: silent })
    const silentId = voters[silent]!.contribution.voterEntry.registrantId
    expect(run.commits).to.have.length(1)
    expect(run.commits[0]!.block.registrantIds).to.have.length(4)
    expect(run.commits[0]!.block.registrantIds).to.not.include(silentId)
    expect(run.outcomes[silent]).to.deep.equal({ status: 'stopped', reason: 'aborted' })
  })

  it('a member whose signature does not verify is dropped at formation; the rest commit', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    const bad = voters.reduce((m, v, i) => (v.identity.peerId > voters[m]!.identity.peerId ? i : m), 0)
    const run = await runAgents(voters, { badSigner: bad, deadlineMs: 8_000 })
    const committed = run.commits.flatMap(c => c.block.registrantIds)
    expect(committed).to.not.include(voters[bad]!.contribution.voterEntry.registrantId)
    expect(committed).to.have.length(4)
  })

  it('one transport peer can run several pools at once (one per ballot) with separate pool identities', async () => {
    // three phones, two ballots each: six agents, three transport peers
    const rendezvous = new PoolRendezvous()
    const phones = [0, 1, 2]
    const ballots: PoolBallot[] = ['b-x', 'b-y'].map(id => ({ ...ballot, ballotId: id }))
    const commits: string[] = []
    const outcomes = await Promise.all(phones.flatMap(p => ballots.map(async (bal) => {
      const v = makeVoter(p)
      const identity = createPoolIdentity()
      const agent = new PoolAgent({
        identity, rendezvous: createInMemoryRendezvousClient(rendezvous, `phone-${p}`), ballot: bal,
        contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(bal.electionKey, bal.ballotId, v.voteJson), voterEntry: v.contribution.voterEntry },
        signConsent: async (digest) => signDigestP256(digest, v.priv),
        commit: async (block) => { commits.push(`${bal.ballotId}:${block.registrantIds.length}`); return { ok: true } },
        quietMs: 300, presentIntervalMs: 50, replyTimeoutMs: 400, informAttempts: 2, signTimeoutMs: 1_500, pollWaitMs: 200, formLeadMs: 0, deadlineAt: Date.now() + 15_000
      })
      return await agent.run()
    })))
    rendezvous.close()
    expect(commits.sort()).to.deep.equal(['b-x:3', 'b-y:3'])
    expect(outcomes.every(o => o.status === 'committed')).to.equal(true)
  })

  it('the rendezvous only ever handled sealed envelopes', async () => {
    const voters = [0, 1, 2].map(makeVoter)
    const run = await runAgents(voters)
    expect(run.commits).to.have.length(1)
    expect(run.rendezvous.stats.send).to.be.greaterThan(0)
  })

  describe('a duplicate voter at commit (R1)', () => {
    const highest = (vs: TestVoter[]) => vs.reduce((m, v, i) => (v.identity.peerId > vs[m]!.identity.peerId ? i : m), 0)
    const lowest = (vs: TestVoter[]) => vs.reduce((m, v, i) => (v.identity.peerId < vs[m]!.identity.peerId ? i : m), 0)
    const dropsOne = (run: Run, voters: TestVoter[], k: number): void => {
      const kReg = voters[k]!.contribution.voterEntry.registrantId
      expect(run.commits).to.have.length(1)
      expect(run.commits[0]!.block.registrantIds).to.have.length(4)
      expect(run.commits[0]!.block.registrantIds).to.not.include(kReg)
      const cid = run.commits[0]!.block.cid
      voters.forEach((_, i) => {
        if (i === k) return
        const o = run.outcomes[i]!
        expect(o.status === 'committed' && o.cid === cid, `voter ${i}`).to.equal(true)
      })
    }

    const unconfirmed = (run: Run, k: number) => run.logs.filter(l => l.i === k && l.event === 'solo' && l.detail?.why === 'already-voted claim not confirmed by the strand')

    it('a member that already voted is dropped at commit; the other four commit ONE block of four; with no row readable it keeps pooling (CR-01)', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const k = highest(voters)
      const run = await runAgents(voters, { preVoted: [k], deadlineMs: 12_000 })
      dropsOne(run, voters, k)
      // The claim is a hint: unconfirmed by its own strand read, k goes back to pooling (alone here) until voting closes.
      expect(run.outcomes[k]).to.deep.equal({ status: 'stopped', reason: 'deadline' })
      expect(unconfirmed(run, k)).to.have.length(1)
    })

    it('CR-01 (b) a dishonest former\'s already-voted with no recorded row: the member reverts to solo, refuses that former, and never rejoins it', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const k = highest(voters)
      const run = await runAgents(voters, { lieAbout: k, deadlineMs: 12_000 })
      dropsOne(run, voters, k)
      expect(run.outcomes[k]).to.deep.equal({ status: 'stopped', reason: 'deadline' })
      expect(unconfirmed(run, k)).to.have.length(1)
      const formerIndex = run.outcomes.findIndex(o => o.status === 'committed' && o.formedByMe)
      const former = voters[formerIndex]!.identity.peerId.slice(-6)
      const claim = run.logs.find(l => l.i === k && l.event === 'already-voted-unconfirmed')
      expect(claim?.detail?.from).to.equal(former)
      const after = run.logs.indexOf(unconfirmed(run, k)[0]!)
      expect(run.logs.slice(after).filter(l => l.i === k && l.event === 'member-of' && l.detail?.coordinator === former)).to.deep.equal([])
    })

    it('CR-01 (c) an honest duplicate whose row becomes readable DURING the bounded wait ends committed with that cid', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const k = highest(voters)
      const run = await runAgents(voters, { preVoted: [k], readableAfterMs: 600, deadlineMs: 12_000 })
      expect(run.outcomes[k]).to.deep.equal({
        status: 'committed', cid: 'prevoted-cid-' + voters[k]!.contribution.voterEntry.registrantId, blockId: '', size: 0, formedByMe: false
      })
      expect(unconfirmed(run, k)).to.deep.equal([])
      dropsOne(run, voters, k)
    })

    it('CR-01 (a) a peer that knows my vote ciphertext cannot re-parent me or stop me: I commit with the honest pool', async () => {
      const voters = [0, 1, 2].map(makeVoter)
      const run = await runAgents(voters, { hijack: 0, deadlineMs: 12_000 })
      expect(run.commits).to.have.length(1)
      expect(run.commits[0]!.block.registrantIds).to.include(voters[0]!.contribution.voterEntry.registrantId)
      const cid = run.commits[0]!.block.cid
      expect(run.outcomes.every(o => o.status === 'committed' && o.cid === cid)).to.equal(true)
      // the victim never joined the hijacker and never acked it (it answered with refusals, or not at all)
      expect(run.hijackReplies).to.not.include('ack')
      expect(run.logs.filter(l => l.i === 0 && l.event === 'already-voted-unconfirmed')).to.deep.equal([])
    })

    it('a former that already voted stops (its own commit is evidence, not a peer\'s claim); the rest re-pool without it', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const k = lowest(voters)
      // k (lowest peer id) presents alone on the plain topic first, so every other voter merges into it: k forms
      const run = await runAgents(voters, { preVoted: [k], deadlineMs: 12_000, ladder: false, startDelayMs: voters.map((_, i) => (i === k ? 0 : 300)) })
      expect(run.logs.some(l => l.i === k && l.event === 'forming')).to.equal(true)
      dropsOne(run, voters, k)
      expect(run.outcomes[k]).to.deep.equal({ status: 'stopped', reason: 'already-voted' })
    })

    it('three voters, one already voted: no whole-pool dissolve, the two left keep presenting to the deadline', async () => {
      const voters = [0, 1, 2].map(makeVoter)
      const k = highest(voters)
      const run = await runAgents(voters, { preVoted: [k], deadlineMs: 3_000 })
      expect(run.commits).to.deep.equal([])
      expect(run.commitCalls).to.equal(1)
      // k's claim stays unconfirmed (no row readable), so it pools on alone; nobody stops 'already-voted'
      expect(run.outcomes).to.deep.equal(Array(3).fill({ status: 'stopped', reason: 'deadline' }))
      expect(run.logs.filter(l => l.event === 'solo' && l.detail?.why === 'commit failed')).to.deep.equal([])
    })

    it('D-13: a dropped member whose row becomes readable ends committed with that cid', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const k = highest(voters)
      const run = await runAgents(voters, { preVoted: [k], preVotedReadable: true, deadlineMs: 12_000 })
      expect(run.outcomes[k]).to.deep.equal({
        status: 'committed', cid: 'prevoted-cid-' + voters[k]!.contribution.voterEntry.registrantId, blockId: '', size: 0, formedByMe: false
      })
      dropsOne(run, voters, k)
    })
  })

  describe('discovery and the topic ladder (R2)', () => {
    const plain = poolTopic(ballot)
    const holdOf1 = (v: TestVoter): string => bytesToHex(sha256(utf8ToBytes(v.contribution.voteCiphertext)))
    const presentsOf = (run: Run, i: number): string[] => run.requests.filter(r => r.i === i && r.t === 'present').map(r => r.topic)
    const withdrawsOf = (run: Run, i: number): string[] => run.requests.filter(r => r.i === i && r.t === 'withdraw').map(r => r.topic)
    const blockSizes = (run: Run): number[] => run.commits.map(c => c.block.registrantIds.length)

    function votersInBuckets (n: number, sameBucket: boolean): TestVoter[] {
      for (let tries = 0; tries < 400; tries++) {
        const out: TestVoter[] = []
        const seen = new Set<string>()
        for (let k = 0; k < n * 40 && out.length < n; k++) {
          const v = makeVoter(out.length)
          const b = ladderBucket([holdOf1(v)], 2)
          if (sameBucket ? (out.length === 0 || b === ladderBucket([holdOf1(out[0]!)], 2)) : !seen.has(b)) { out.push(v); seen.add(b) }
        }
        if (out.length === n) return out
      }
      throw new Error('could not build voters in the requested buckets')
    }

    it('R2-1 a lone coordinator climbs 2-bit, 1-bit, then plain: its 7th present is the first on the plain topic, and it never narrows', async () => {
      const v = makeVoter(0)
      const run = await runAgents([v], { quietMs: 5_000, deadlineMs: 1_500 })
      const topics = presentsOf(run, 0)
      const hold = holdOf1(v)
      expect(topics.length).to.be.at.least(8)
      expect(topics.slice(0, 3)).to.deep.equal(Array(3).fill(ladderTopic(plain, 2, [hold])))
      expect(topics.slice(3, 6)).to.deep.equal(Array(3).fill(ladderTopic(plain, 1, [hold])))
      expect(topics.slice(6)).to.deep.equal(Array(topics.length - 6).fill(plain))
      expect(run.outcomes[0]).to.deep.equal({ status: 'stopped', reason: 'deadline' })
    })

    it('R2-2 the hard cap forces the plain topic', async () => {
      const run = await runAgents([makeVoter(0)], { rungDwellTicks: 1_000, ladderMaxMs: 300, quietMs: 5_000, deadlineMs: 1_200 })
      const rows = run.requests.filter(r => r.t === 'present')
      const firstPlain = rows.findIndex(r => r.topic === plain)
      expect(firstPlain).to.be.greaterThan(0)
      const before = rows.slice(0, firstPlain).map(r => r.topic)
      expect(before.every(t => t.includes('/h/2:'))).to.equal(true)
      const wait = rows[firstPlain]!.at - run.startedAt
      expect(wait).to.be.at.least(300)
      expect(wait).to.be.below(900)
    })

    it('R2-3 the plain topic is reached by deadlineAt - 2*formLeadMs', async () => {
      const run = await runAgents([makeVoter(0)], { rungDwellTicks: 1_000, ladderMaxMs: 15_000, quietMs: 5_000, formLeadMs: 200, deadlineMs: 1_000 })
      const firstPlain = run.requests.find(r => r.t === 'present' && r.topic === plain)
      expect(firstPlain).to.not.equal(undefined)
      expect(firstPlain!.at).to.be.at.least(run.deadlineAt - 400)
      expect(firstPlain!.at).to.be.at.most(run.deadlineAt - 400 + 300)
    })

    it('R2-4 three voters with the ladder on still form ONE block of three (D-23)', async () => {
      const voters = [0, 1, 2].map(makeVoter)
      const run = await runAgents(voters)
      expect(blockSizes(run)).to.deep.equal([3])
      expect(run.outcomes.every(o => o.status === 'committed')).to.equal(true)
      voters.forEach((_, i) => expect(presentsOf(run, i)[0]).to.contain('/h/2:'))
    })

    it('R2-5 three voters in ONE 2-bit bucket merge on their rung, still reach plain before forming, and form ONE block of three', async () => {
      const voters = votersInBuckets(3, true)
      const run = await runAgents(voters)
      expect(blockSizes(run)).to.deep.equal([3])
      const former = run.outcomes.findIndex(o => o.status === 'committed' && o.formedByMe)
      expect(former).to.be.at.least(0)
      const firstPlain = run.requests.find(r => r.i === former && r.t === 'present' && r.topic === plain)
      expect(firstPlain).to.not.equal(undefined)
      expect(run.commitAt[0]!).to.be.at.least(firstPlain!.at)
    })

    it('R2-6 three voters in three different 2-bit buckets still merge into ONE block (messages carry the plain topic)', async () => {
      const voters = votersInBuckets(3, false)
      const run = await runAgents(voters)
      expect(blockSizes(run)).to.deep.equal([3])
      expect(new Set(voters.map((_, i) => presentsOf(run, i)[0])).size).to.equal(3)
    })

    it('R2-7 five voters with the ladder on converge on ONE block of five', async () => {
      const voters = [0, 1, 2, 3, 4].map(makeVoter)
      const run = await runAgents(voters)
      expect(blockSizes(run)).to.deep.equal([5])
      const cid = run.commits[0]!.block.cid
      expect(run.outcomes.every(o => o.status === 'committed' && o.cid === cid)).to.equal(true)
      voters.forEach((_, i) => expect(presentsOf(run, i)[0]).to.contain('/h/2:'))
    })

    it('R2-8 ladder:false agents (the old plain-topic behaviour) and ladder agents on one PoolRendezvous form ONE block', async () => {
      const five = [0, 1, 2, 3, 4].map(makeVoter)
      const a = await runAgents(five, { ladder: [false, true, false, true, true] })
      expect(blockSizes(a)).to.deep.equal([5])
      for (const i of [0, 2]) expect(presentsOf(a, i).every(t => t === plain)).to.equal(true)
      for (const i of [1, 3, 4]) expect(presentsOf(a, i).some(t => t.includes('/h/2:'))).to.equal(true)
      const three = [0, 1, 2].map(makeVoter)
      const b = await runAgents(three, { ladder: [false, false, true] })
      expect(blockSizes(b)).to.deep.equal([3])
    })

    it('R2-9 an injected PoolDiscovery carries every present and withdraw; the rendezvous client carries only the mailbox (D-20)', async () => {
      const run = await runAgents([0, 1, 2].map(makeVoter), { injectDiscovery: true })
      expect(blockSizes(run)).to.deep.equal([3])
      expect(run.discoveryCalls.filter(c => c.t === 'present').length).to.be.greaterThan(0)
      expect(run.requests).to.have.length(0)
    })

    /** One in-memory matchmaking cohort shared by every agent: providers by topic and registering peer. */
    function sharedCohort (): (selfPeerId: string) => PoolMatchmakingPorts {
      const table = new Map<string, Map<string, PoolMatchEntry>>()
      return (selfPeerId) => ({
        selfPeerId,
        openProvider: () => {
          let topic: string | undefined
          return {
            register: async (label, reg) => {
              topic = label
              const t = table.get(label) ?? new Map<string, PoolMatchEntry>()
              t.set(selfPeerId, { participantId: selfPeerId, capabilities: reg.capabilities, contactHint: reg.contactHint })
              table.set(label, t)
            },
            withdraw: async () => { if (topic !== undefined) table.get(topic)?.delete(selfPeerId) }
          }
        },
        query: async (label) => [...(table.get(label)?.values() ?? [])]
      })
    }

    it('R2-11 matchmaking alone finds the coordinators: three agents form one block of 3 and the rendezvous only carries the mailbox', async () => {
      const cohort = sharedCohort()
      const run = await runAgents([0, 1, 2].map(makeVoter), { discoveryFor: (i, v) => matchmakingDiscovery(cohort(`12D3KooWnode${i}`), v.identity) })
      expect(blockSizes(run)).to.deep.equal([3])
      expect(run.requests).to.have.length(0)
    })

    it('R2-12 merged discovery: a matchmaking cohort that always fails still forms one block of 3 through the rendezvous', async () => {
      const broken: PoolMatchmakingPorts = {
        selfPeerId: 'p',
        openProvider: () => ({ register: async () => { throw new Error('no cohort') }, withdraw: async () => { throw new Error('no cohort') } }),
        query: async () => { throw new Error('no cohort') }
      }
      const run = await runAgents([0, 1, 2].map(makeVoter), {
        discoveryFor: (i, v, rv) => mergedDiscovery([rendezvousDiscovery(createInMemoryRendezvousClient(rv, `transport-${i}`), v.identity), matchmakingDiscovery(broken, v.identity)])
      })
      expect(blockSizes(run)).to.deep.equal([3])
    })

    // Every agent runs the merged discovery, as the Voter does, and each source shows each agent only part of
    // the others: agent i sees agent j through the rendezvous only when i + j is even, and through matchmaking
    // only when it is odd. Neither source alone connects everyone (0 and 1 meet only through matchmaking, 0 and
    // 2 only through the rendezvous); the union does, so one block of 4 forms only if the merge keeps both
    // sources' listings. Whoever coordinates, every other agent sees it through exactly one source.
    // Deliberately NOT tested: a split network where some agents run only one source. A bridge agent that
    // joins a pool as a member stops presenting, so an agent that could see only the bridge is left alone, and
    // which pool forms first decides the outcome (no fixed block size is guaranteed).
    it('R2-13 merged discovery: each source shows each agent only half the others, and the union still forms one block of 4', async () => {
      const cohort = sharedCohort()
      const voters = [0, 1, 2, 3].map(makeVoter)
      const indexOf = new Map(voters.map((v, i) => [v.identity.peerId, i] as const))
      const showOnly = (d: PoolDiscovery, keep: (j: number) => boolean): PoolDiscovery => ({
        present: async (topic, size, now) => (await d.present(topic, size, now)).filter((l) => {
          const j = indexOf.get(l.peerId)
          return j === undefined || keep(j)
        }),
        withdraw: async (topic, now) => { await d.withdraw(topic, now) }
      })
      const run = await runAgents(voters, {
        discoveryFor: (i, v, rv) => mergedDiscovery([
          showOnly(rendezvousDiscovery(createInMemoryRendezvousClient(rv, `transport-${i}`), v.identity), (j) => (i + j) % 2 === 0),
          showOnly(matchmakingDiscovery(cohort(`12D3KooWnode${i}`), v.identity), (j) => (i + j) % 2 === 1)
        ])
      })
      expect(blockSizes(run)).to.deep.equal([4])
    })

    it('R2-10 every topic presented on is withdrawn: afterwards nobody is listed on any of them', async () => {
      const run = await runAgents([0, 1, 2, 3, 4].map(makeVoter))
      const all = new Set<string>()
      for (let i = 0; i < 5; i++) {
        const w = new Set(withdrawsOf(run, i))
        for (const t of new Set(presentsOf(run, i))) { all.add(t); expect(w.has(t), `agent ${i} withdrew ${t}`).to.equal(true) }
      }
      const probe = createInMemoryRendezvousClient(run.rendezvous, 'probe')
      for (const t of all) {
        const reply = await probe.call(poolRequests.present(createPoolIdentity(), t, 1, Date.now()))
        expect(reply).to.deep.equal({ t: 'coordinators', list: [] })
      }
    })
  })
})

// A hand-driven peer on the rendezvous: it presents, sends sealed messages and waits for replies,
// so one real PoolAgent can be tested against a coordinator that does exactly what the test says.
interface Inbound { from: string, body: { t: string, id?: string, re?: string, [k: string]: unknown } }
function scriptedPeer (rv: PoolRendezvous, name: string) {
  const identity = createPoolIdentity()
  const client = createInMemoryRendezvousClient(rv, name)
  const inbox: Inbound[] = []
  const peer = {
    identity,
    inbox,
    async present (topic: string, size: number) { return await client.call(poolRequests.present(identity, topic, size, Date.now())) },
    async send (to: string, body: unknown) { await client.call(poolRequests.send(sealPoolEnvelope(identity, to, body))) },
    async drain (waitMs: number) {
      const r = await client.call(poolRequests.poll(identity, waitMs, Date.now()))
      if (r.t === 'envelopes') for (const e of r.list) inbox.push(openPoolEnvelope(identity, e) as Inbound)
    },
    /** the next message matching `pred`, or null after `timeoutMs` */
    async next (pred: (m: Inbound) => boolean, timeoutMs = 5_000): Promise<Inbound | null> {
      const until = Date.now() + timeoutMs
      for (;;) {
        const i = inbox.findIndex(pred)
        if (i >= 0) return inbox.splice(i, 1)[0]!
        const left = until - Date.now()
        if (left <= 0) return null
        await peer.drain(Math.min(100, left))
      }
    }
  }
  return peer
}
type ScriptedPeer = ReturnType<typeof scriptedPeer>
const holdOfVoter = (v: TestVoter): string => bytesToHex(sha256(utf8ToBytes(v.contribution.voteCiphertext)))

/**
 * One real agent `a` (plain topic, no ladder) and a scripted coordinator `c` presenting a bigger
 * pool: `a` merges into `c`, `c` answers `merged` and informs, `a` acks. Returns with `a` a member of `c`.
 */
async function memberOfScripted (opts: Partial<ConstructorParameters<typeof PoolAgent>[0]> = {}) {
  const rv = new PoolRendezvous()
  const a = makeVoter(0)
  const c = scriptedPeer(rv, 'transport-c')
  const logs: Array<{ event: string, detail?: Record<string, unknown> }> = []
  let signCalls = 0
  const controller = new AbortController()
  const topic = poolTopic(ballot)
  await c.present(topic, 4)
  const agent = new PoolAgent({
    identity: a.identity,
    rendezvous: createInMemoryRendezvousClient(rv, 'transport-a'),
    ballot,
    contribution: a.contribution,
    signConsent: async (digest) => { signCalls++; return signDigestP256(digest, a.priv) },
    commit: async () => ({ ok: true }),
    log: (event, detail) => { logs.push({ event, detail }) },
    ladder: false,
    quietMs: 60_000,
    presentIntervalMs: 60,
    replyTimeoutMs: 400,
    informAttempts: 2,
    signTimeoutMs: 1_500,
    memberTimeoutMs: 30_000,
    pollWaitMs: 200,
    formLeadMs: 0,
    deadlineAt: Date.now() + 25_000,
    ...opts
  })
  const running = agent.run(controller.signal)
  const merge = await c.next(m => m.body.t === 'merge')
  if (merge === null) throw new Error('the agent never merged into the scripted coordinator')
  await c.send(a.identity.peerId, { t: 'merged', re: merge.body.id, size: 5 })
  await c.send(a.identity.peerId, { t: 'inform', id: 'c-inform-1', topic, size: 5, hold: holdOfVoter(a) })
  const ack = await c.next(m => m.body.t === 'ack' && m.body.re === 'c-inform-1')
  if (ack === null) throw new Error('the agent never acked the scripted coordinator')
  const stop = async (): Promise<PoolOutcome> => { controller.abort(); const o = await running; rv.close(); return o }
  return { rv, a, c, logs, agent, running, stop, topic, signCalls: () => signCalls }
}

describe('pool: a member\'s coordinator, and already-voted as a hint (CR-01)', function () {
  this.timeout(30_000)

  it('a member re-parents only to the coordinator its own coordinator handed it over to', async () => {
    const h = await memberOfScripted()
    try {
      const d = scriptedPeer(h.rv, 'transport-d')
      // d knows my hold (it saw my ciphertext in some formation) but nobody handed me to it: no answer
      await d.send(h.a.identity.peerId, { t: 'inform', id: 'd-1', topic: h.topic, size: 9, hold: holdOfVoter(h.a) })
      expect(await d.next(m => m.body.re === 'd-1', 800)).to.equal(null)
      expect(h.logs.some(l => l.event === 'inform-not-handed-over')).to.equal(true)
      // my coordinator merges away into d and hands me over: now d's inform is acked
      await h.c.send(h.a.identity.peerId, { t: 'handover', topic: h.topic, to: d.identity.peerId })
      await d.send(h.a.identity.peerId, { t: 'inform', id: 'd-2', topic: h.topic, size: 9, hold: holdOfVoter(h.a) })
      expect((await d.next(m => m.body.re === 'd-2', 2_000))?.body.t).to.equal('ack')
      // and the old coordinator can no longer speak for me
      const e = scriptedPeer(h.rv, 'transport-e')
      await h.c.send(h.a.identity.peerId, { t: 'handover', topic: h.topic, to: e.identity.peerId })
      await e.send(h.a.identity.peerId, { t: 'inform', id: 'e-1', topic: h.topic, size: 9, hold: holdOfVoter(h.a) })
      expect(await e.next(m => m.body.re === 'e-1', 800)).to.equal(null)
    } finally {
      expect(await h.stop()).to.deep.equal({ status: 'stopped', reason: 'aborted' })
    }
  })

  it('an unconfirmed already-voted from my coordinator: I wait, revert to solo, and never merge into it again', async () => {
    const h = await memberOfScripted({ findRecordedVote: async () => null })
    try {
      const startedAt = Date.now()
      await h.c.send(h.a.identity.peerId, { t: 'outcome', topic: h.topic, committed: false, reason: 'already voted', code: 'already-voted' })
      const until = Date.now() + 5_000
      while (!h.logs.some(l => l.event === 'solo') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      const solo = h.logs.find(l => l.event === 'solo')
      expect(solo?.detail?.why).to.equal('already-voted claim not confirmed by the strand')
      // the bounded wait (4 x replyTimeoutMs) ran before giving up
      expect(Date.now() - startedAt).to.be.at.least(4 * 400 - 50)
      // c is still listed with a bigger pool, but this agent never merges into it again
      expect(await h.c.next(m => m.body.t === 'merge', 1_500)).to.equal(null)
    } finally {
      expect(await h.stop()).to.deep.equal({ status: 'stopped', reason: 'aborted' })
    }
  })

  it('an already-voted whose row shows up during the wait ends committed with that cid', async () => {
    let rowAt = Infinity
    const h = await memberOfScripted({ findRecordedVote: async () => (Date.now() >= rowAt ? 'bafy-recorded-earlier' : null) })
    rowAt = Date.now() + 700
    await h.c.send(h.a.identity.peerId, { t: 'outcome', topic: h.topic, committed: false, reason: 'already voted', code: 'already-voted' })
    const outcome = await h.running
    h.rv.close()
    expect(outcome).to.deep.equal({ status: 'committed', cid: 'bafy-recorded-earlier', blockId: '', size: 0, formedByMe: false })
    expect(h.logs.some(l => l.event === 'solo')).to.equal(false)
  })
})

describe('pool: no stale listing after a coordinator turns member mid-present (IN-06)', function () {
  this.timeout(30_000)
  const nap = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('a present that lands after the agent became a member is withdrawn again', async () => {
    const rv = new PoolRendezvous()
    const a = makeVoter(0)
    const c = scriptedPeer(rv, 'transport-c')
    const topic = poolTopic(ballot)
    await c.present(topic, 4)
    // every present reaches the rendezvous 300 ms after the agent sends it
    const real = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'transport-a-discovery'), a.identity)
    let presentStarts = 0
    const discovery: PoolDiscovery = {
      async present (t, size, now) { presentStarts++; await nap(300); return await real.present(t, size, now) },
      async withdraw (t, now) { await real.withdraw(t, now) }
    }
    const controller = new AbortController()
    const running = new PoolAgent({
      identity: a.identity,
      rendezvous: createInMemoryRendezvousClient(rv, 'transport-a'),
      discovery,
      ballot,
      contribution: a.contribution,
      signConsent: async (digest) => signDigestP256(digest, a.priv),
      commit: async () => ({ ok: true }),
      ladder: false,
      quietMs: 60_000,
      presentIntervalMs: 60,
      replyTimeoutMs: 400,
      informAttempts: 2,
      memberTimeoutMs: 30_000,
      pollWaitMs: 200,
      formLeadMs: 0,
      deadlineAt: Date.now() + 20_000
    }).run(controller.signal)
    try {
      // the agent tries to merge into c; c's `merged` reply is "lost" (never sent)
      expect(await c.next(m => m.body.t === 'merge')).to.not.equal(null)
      const startsAtMerge = presentStarts
      while (presentStarts === startsAtMerge) await nap(10)
      // c's inform reaches the agent while its next present is still on the way to the rendezvous
      await c.send(a.identity.peerId, { t: 'inform', id: 'c-1', topic, size: 5, hold: holdOfVoter(a) })
      expect((await c.next(m => m.body.re === 'c-1', 2_000))?.body.t).to.equal('ack')
      await nap(700)
      const listed = await createInMemoryRendezvousClient(rv, 'probe').call(poolRequests.present(createPoolIdentity(), topic, 1, Date.now()))
      expect(listed).to.deep.equal({ t: 'coordinators', list: [{ peerId: c.identity.peerId, size: 4 }] })
    } finally {
      controller.abort()
      await running
      rv.close()
    }
  })
})

describe('pool: a duplicated form costs one consent prompt (WR-01)', function () {
  this.timeout(30_000)

  it('the same coordinator sending the same form twice gets the same signature twice from ONE signConsent call', async () => {
    let calls = 0
    let priv: Uint8Array | null = null
    const h = await memberOfScripted({
      signConsent: async (digest) => { calls++; await new Promise(resolve => setTimeout(resolve, 300)); return signDigestP256(digest, priv!) }
    })
    priv = h.a.priv
    try {
      const block = formPoolBlock([h.a.contribution, makeVoter(1).contribution, makeVoter(2).contribution], ballot)
      // the second copy arrives while the first prompt is still open (a failover resend), and a third after it answered
      await h.c.send(h.a.identity.peerId, { t: 'form', id: 'f-1', topic: h.topic, block })
      await h.c.send(h.a.identity.peerId, { t: 'form', id: 'f-2', topic: h.topic, block })
      const first = await h.c.next(m => m.body.re === 'f-1', 3_000)
      const second = await h.c.next(m => m.body.re === 'f-2', 3_000)
      await h.c.send(h.a.identity.peerId, { t: 'form', id: 'f-3', topic: h.topic, block })
      const third = await h.c.next(m => m.body.re === 'f-3', 3_000)
      expect([first?.body.t, second?.body.t, third?.body.t]).to.deep.equal(['sign', 'sign', 'sign'])
      expect(second?.body.signature).to.deep.equal(first?.body.signature)
      expect(third?.body.signature).to.deep.equal(first?.body.signature)
      expect(calls).to.equal(1)
      // a different block is a different consent: it prompts again
      const other = formPoolBlock([h.a.contribution, makeVoter(3).contribution, makeVoter(4).contribution], ballot)
      await h.c.send(h.a.identity.peerId, { t: 'form', id: 'f-4', topic: h.topic, block: other })
      expect((await h.c.next(m => m.body.re === 'f-4', 3_000))?.body.t).to.equal('sign')
      expect(calls).to.equal(2)
    } finally {
      await h.stop()
    }
  })
})

describe('pool: a duplicate voter at commit (R1) - classification and the commit lookup', () => {
  const LOCAL = 'UNIQUE constraint failed: VoteBlockVoter.ElectionId, VoteBlockVoter.BallotId, VoteBlockVoter.RegistrantId'
  // the spike 101 text carries the control markers as 6-character escape text
  const framed = (id: string): string => '\\u0002' + id + '\\u0000'
  const distributedMessageNaming = (id: string): string =>
    `Error during query on table 'VoteBlockVoter': Query failed: Tree collection default/app/VoteBlockVoter: key "${framed('election-1')}${framed('b-ballot-1')}${framed(id)}" is already taken`

  it('classifies both literal shapes as a duplicate voter and nothing else', () => {
    expect(poolBlock.classifyCommitFailure(LOCAL)).to.equal('duplicate-voter')
    expect(poolBlock.classifyCommitFailure(distributedMessageNaming('b-reg-5'))).to.equal('duplicate-voter')
    expect(poolBlock.classifyCommitFailure('CHECK constraint failed: WithinVotingWindow')).to.equal('other')
    expect(poolBlock.classifyCommitFailure('UNIQUE constraint failed: VoteBlock.Cid')).to.equal('other')
    expect(poolBlock.classifyCommitFailure('')).to.equal('other')
  })

  it('names a registrant only by an exact frame (b-reg-1 is not inside b-reg-15)', () => {
    const ids = ['b-reg-1', 'b-reg-15', 'b-reg-2']
    expect(poolBlock.registrantsNamedInCommitError(distributedMessageNaming('b-reg-15'), ids)).to.deep.equal(['b-reg-15'])
    const literal = `key "\u0002election-1\u0000\u0002b\u0000\u0002b-reg-15\u0000" is already taken`
    expect(poolBlock.registrantsNamedInCommitError(literal, ids)).to.deep.equal(['b-reg-15'])
    expect(poolBlock.registrantsNamedInCommitError(distributedMessageNaming('somebody-else'), ids)).to.deep.equal([])
    expect(poolBlock.registrantsNamedInCommitError('registrant b-reg-2 collided', ids)).to.deep.equal([])
  })

  const voters = [0, 1, 2].map(makeVoter)
  const block = formPoolBlock(voters.map(v => v.contribution), ballot)
  const signatures: ConsentSignature[] = block.registrantIds.map(registrantId => ({ registrantId, deviceKey: 'dk', signature: 'aa'.repeat(64) }))
  const clock = { nowMs: Date.now(), now: new Date().toISOString() }
  const dup = block.registrantIds[1]!

  function stub (failure: Error | null, found: Record<string, string>) {
    const execs: Array<{ sql: string, params?: Record<string, unknown> }> = []
    const evals: Array<{ sql: string, params?: Record<string, unknown> }> = []
    const db = {
      async exec (sql: string, params?: Record<string, unknown>) {
        execs.push({ sql, params })
        if (failure !== null && /insert into VoteBlockVoter/.test(sql) && params?.reg === dup) throw failure
      },
      async * eval (sql: string, params?: Record<string, unknown>) {
        evals.push({ sql, params })
        const cid = found[params?.reg as string]
        if (cid !== undefined) yield { BlockCid: cid }
      }
    } as unknown as Database
    return { db, execs, evals }
  }

  it('local UNIQUE: rolls back, then looks each registrant up with one point query and names the colliding one', async () => {
    const s = stub(new Error(LOCAL), { [dup]: 'bafy-earlier' })
    const r = await commitPoolBlock(s.db, block, ballot, signatures, clock)
    expect(r).to.deep.equal({ ok: false, reason: LOCAL, duplicateRegistrants: [dup] })
    const rollbackAt = s.execs.findIndex(e => e.sql === 'ROLLBACK')
    expect(rollbackAt).to.be.greaterThan(-1)
    expect(s.evals).to.have.length(block.registrantIds.length)
    for (const e of s.evals) {
      expect(e.sql).to.match(/RegistrantId = :reg/)
      expect(e.sql).to.not.match(/ in \(/i)
    }
  })

  it('distributed shape, no row readable yet: falls back to the framed key text', async () => {
    const msg = distributedMessageNaming(dup)
    const s = stub(new Error(msg), {})
    expect(await commitPoolBlock(s.db, block, ballot, signatures, clock)).to.deep.equal({ ok: false, reason: msg, duplicateRegistrants: [dup] })
  })

  it('duplicate shape, no row and nobody named: an empty list', async () => {
    const s = stub(new Error(LOCAL), {})
    expect(await commitPoolBlock(s.db, block, ballot, signatures, clock)).to.deep.equal({ ok: false, reason: LOCAL, duplicateRegistrants: [] })
  })

  it('any other failure: no duplicateRegistrants key and no lookup', async () => {
    const s = stub(new Error('CHECK constraint failed: WithinVotingWindow'), { [dup]: 'bafy-earlier' })
    const r = await commitPoolBlock(s.db, block, ballot, signatures, clock)
    expect(r).to.deep.equal({ ok: false, reason: 'CHECK constraint failed: WithinVotingWindow' })
    expect(s.evals).to.have.length(0)
  })

  it('WR-03 a distributed commit that landed but threw: the text names a member whose row holds THIS block\'s cid, so it is not a duplicate', async () => {
    const msg = distributedMessageNaming(dup)
    const s = stub(new Error(msg), Object.fromEntries(block.registrantIds.map(r => [r, block.cid])))
    expect(await commitPoolBlock(s.db, block, ballot, signatures, clock)).to.deep.equal({ ok: false, reason: msg, duplicateRegistrants: [] })
  })

  it('WR-03 the text fallback still names a member whose lookup threw (unknown), but never one proven to be in this block', async () => {
    const msg = distributedMessageNaming(dup)
    const s = stub(new Error(msg), {})
    const evalOrig = (s.db as unknown as { eval: (sql: string, p?: Record<string, unknown>) => AsyncGenerator<unknown> }).eval
    ;(s.db as unknown as { eval: unknown }).eval = async function * (sql: string, params?: Record<string, unknown>) {
      if (params?.reg === dup) throw new Error('lookup failed')
      yield * evalOrig(sql, params)
    }
    expect(await commitPoolBlock(s.db, block, ballot, signatures, clock)).to.deep.equal({ ok: false, reason: msg, duplicateRegistrants: [dup] })
  })

  it('a lookup row holding this block\'s own cid is not a duplicate', async () => {
    const s = stub(new Error(LOCAL), { [dup]: block.cid })
    const r = await commitPoolBlock(s.db, block, ballot, signatures, clock)
    expect(r).to.deep.equal({ ok: false, reason: LOCAL, duplicateRegistrants: [] })
  })
})

describe('pool: discovery interface and ladder topics (R2)', function () {
  this.timeout(10_000)
  const holdOfCt = (ct: string): string => bytesToHex(sha256(utf8ToBytes(ct)))
  const holds = [0, 1, 2].map(i => holdOfCt(makeVoter(i).contribution.voteCiphertext))
  const base = 'vt-pool/1/e/1/b/t'

  it('D-1 ladderTopic builds the 2-bit, 1-bit and plain topics', () => {
    expect(ladderTopic(base, 2, holds)).to.match(/^vt-pool\/1\/e\/1\/b\/t\/h\/2:[0-3]$/)
    expect(ladderTopic(base, 1, holds)).to.match(/^vt-pool\/1\/e\/1\/b\/t\/h\/1:[01]$/)
    expect(ladderTopic(base, 0, holds)).to.equal(base)
  })

  it('D-2 the bucket is order-independent and equals the bucket of the smallest hold', () => {
    const perms = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]]
    const topics = perms.map(p => ladderTopic(base, 2, p.map(i => holds[i]!)))
    expect(new Set(topics).size).to.equal(1)
    const min = [...holds].sort()[0]!
    expect(ladderTopic(base, 2, holds)).to.equal(ladderTopic(base, 2, [min]))
  })

  it('D-3 the bucket is the first bits of sha256(utf8(smallest hold))', () => {
    for (const h of holds) {
      const first = sha256(utf8ToBytes(h))[0]!
      expect(ladderBucket([h], 2)).to.equal((first >> 6).toString(16))
      expect(ladderBucket([h], 1)).to.equal((first >> 7).toString(16))
      expect(Number(ladderBucket([h], 1))).to.equal(Number(ladderBucket([h], 2)) >> 1)
    }
    expect(() => ladderBucket(holds, 0)).to.throw(RangeError)
    expect(() => ladderBucket(holds, 5)).to.throw(RangeError)
  })

  it('D-4 a topic that would pass 512 characters, or an empty hold list, gives the plain topic', () => {
    const long = 'x'.repeat(POOL_TOPIC_MAX_CHARS - 3)
    expect(ladderTopic(long, 2, holds)).to.equal(long)
    expect(ladderTopic(base, 2, [])).to.equal(base)
  })

  it('D-5 the adapter lists the OTHER coordinators on the exact topic only', async () => {
    const rv = new PoolRendezvous()
    try {
      const [a, b, c] = [createPoolIdentity(), createPoolIdentity(), createPoolIdentity()]
      const da = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'ta'), a)
      const db = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'tb'), b)
      const dc = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'tc'), c)
      const topicA = ladderTopic(base, 2, holds)
      expect(await da.present(topicA, 2, Date.now())).to.deep.equal([])
      await db.present(base, 1, Date.now())
      expect(await dc.present(topicA, 1, Date.now())).to.deep.equal([{ peerId: a.peerId, size: 2 }])
    } finally { rv.close() }
  })

  it('D-6 present throws the reply reason on an error reply', async () => {
    const rv = new PoolRendezvous({ isAllowed: () => false })
    try {
      const d = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'x'), createPoolIdentity())
      let message = ''
      try { await d.present(base, 1, Date.now()) } catch (e) { message = (e as Error).message }
      expect(message).to.equal('not allowed')
    } finally { rv.close() }
  })

  it('D-7 withdraw removes the caller from that topic', async () => {
    const rv = new PoolRendezvous()
    try {
      const [a, c] = [createPoolIdentity(), createPoolIdentity()]
      const da = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'ta'), a)
      const dc = rendezvousDiscovery(createInMemoryRendezvousClient(rv, 'tc'), c)
      const topicA = ladderTopic(base, 2, holds)
      await da.present(topicA, 1, Date.now())
      await da.withdraw(topicA, Date.now())
      expect(await dc.present(topicA, 1, Date.now())).to.deep.equal([])
    } finally { rv.close() }
  })

  it('D-8 the ladder constants', () => {
    expect([...POOL_LADDER_RUNG_BITS]).to.deep.equal([2, 1])
    expect(POOL_LADDER_DWELL_PRESENTS).to.equal(3)
    expect(POOL_LADDER_MAX_MS).to.equal(15_000)
    expect(POOL_TOPIC_MAX_CHARS).to.equal(512)
  })
})

// ---------------------------------------------------------------------------------------------
// D-92 and D-93: one real agent against hand-driven peers

describe('pool: merge collisions (D-92) and refusals from a merge target (D-93)', function () {
  this.timeout(30_000)
  const topic = poolTopic(ballot)
  const sleepMs = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))
  async function waitUntil (cond: () => boolean, limitMs: number): Promise<boolean> {
    const end = Date.now() + limitMs
    while (Date.now() < end) { if (cond()) return true; await sleepMs(10) }
    return cond()
  }

  /** a scripted peer whose peer id sorts above (or below) `id` */
  function peerBeside (rv: PoolRendezvous, name: string, side: 'above' | 'below', id: string): ScriptedPeer {
    for (let i = 0; i < 200; i++) {
      const p = scriptedPeer(rv, name)
      if (side === 'above' ? p.identity.peerId > id : p.identity.peerId < id) return p
    }
    throw new Error('no peer id on the requested side')
  }

  /** drain a scripted peer in the background and hand each message to `onMsg`, one at a time */
  function pump (peer: ScriptedPeer, onMsg: (m: Inbound) => Promise<void>): { stop: () => Promise<void> } {
    let live = true
    const done = (async () => {
      while (live) {
        await peer.drain(100)
        while (peer.inbox.length > 0) await onMsg(peer.inbox.shift()!)
      }
    })()
    return { stop: async () => { live = false; await done } }
  }

  const contributionOf = (peer: ScriptedPeer, v: TestVoter, registrantId?: string): PoolContribution => ({
    member: peer.identity.peerId,
    voteCiphertext: v.contribution.voteCiphertext,
    voterEntry: registrantId === undefined ? v.contribution.voterEntry : { ...v.contribution.voterEntry, registrantId }
  })

  function startAgent (rv: PoolRendezvous, a: TestVoter, extra: Partial<PoolAgentOptions> = {}) {
    const logs: Array<{ event: string, detail?: Record<string, unknown> }> = []
    const controller = new AbortController()
    const running = new PoolAgent({
      identity: a.identity,
      rendezvous: createInMemoryRendezvousClient(rv, 'transport-agent'),
      ballot,
      contribution: a.contribution,
      signConsent: async (digest) => signDigestP256(digest, a.priv),
      commit: async () => ({ ok: true }),
      log: (event, detail) => { logs.push({ event, detail }) },
      ladder: false,
      quietMs: 60_000,
      presentIntervalMs: 40,
      replyTimeoutMs: 300,
      informAttempts: 2,
      memberTimeoutMs: 30_000,
      pollWaitMs: 100,
      formLeadMs: 0,
      deadlineAt: Date.now() + 25_000,
      ...extra
    }).run(controller.signal)
    return { logs, stop: async () => { controller.abort(); await running } }
  }

  /** M1 merges into the agent; its informs are acked after `ackDelayMs` (the first `ackLimit` of them only). */
  async function joinMember (rv: PoolRendezvous, a: TestVoter, opts: { ackDelayMs: number, ackLimit: number }) {
    const m1 = peerBeside(rv, 'transport-m1', 'above', a.identity.peerId)
    const v1 = makeVoter(1)
    const seen: Inbound[] = []
    let acked = 0
    const p = pump(m1, async (m) => {
      seen.push(m)
      if (m.body.t === 'inform' && acked < opts.ackLimit) {
        await sleepMs(opts.ackDelayMs)
        await m1.send(a.identity.peerId, { t: 'ack', re: m.body.id })
        acked++
      }
    })
    await m1.send(a.identity.peerId, { t: 'merge', id: 'm1-merge', topic, contributions: [contributionOf(m1, v1)] })
    expect(await waitUntil(() => seen.some(m => m.body.re === 'm1-merge' && m.body.t === 'merged'), 5_000), 'M1 was merged').to.equal(true)
    return { m1, v1, seen, p, acked: () => acked, informs: () => seen.filter(m => m.body.t === 'inform') }
  }

  async function collider (rv: PoolRendezvous, a: TestVoter, stolenRegistrantId: string) {
    // sorts above the agent, so an equal-size merge is not refused as "your pool is bigger"
    const m2 = peerBeside(rv, 'transport-m2', 'above', a.identity.peerId)
    const v2 = makeVoter(2)
    const seen: Inbound[] = []
    const p = pump(m2, async (m) => {
      seen.push(m)
      if (m.body.t === 'inform') await m2.send(a.identity.peerId, { t: 'ack', re: m.body.id }) // once merged, M2 is a live member
    })
    const merge = async (id: string): Promise<void> => await m2.send(a.identity.peerId, { t: 'merge', id, topic, contributions: [contributionOf(m2, v2, stolenRegistrantId)] })
    return { m2, v2, seen, p, merge }
  }

  const sizeOfAgent = async (rv: PoolRendezvous, a: TestVoter): Promise<number | undefined> => {
    const probe = scriptedPeer(rv, 'transport-probe')
    const r = await probe.present(topic, 1)
    return r.t === 'coordinators' ? r.list.find(c => c.peerId === a.identity.peerId)?.size : undefined
  }

  it('D-92: a colliding merge is refused, never replaces the entry, starts exactly one re-confirm, and a live member stays', async () => {
    const rv = new PoolRendezvous({ coordinatorTtlMs: 120_000 })
    const a = makeVoter(0)
    const agent = startAgent(rv, a, { replyTimeoutMs: 1_500 })
    const j = await joinMember(rv, a, { ackDelayMs: 500, ackLimit: 99 })
    const c = await collider(rv, a, j.v1.contribution.voterEntry.registrantId)
    try {
      expect(await waitUntil(() => j.acked() >= 1, 5_000), 'the first inform was acked').to.equal(true)
      // two colliding merges while the first re-confirm is still waiting for M1's slow ack
      await c.merge('collide-1')
      await sleepMs(100)
      await c.merge('collide-2')
      expect(await waitUntil(() => c.seen.filter(m => m.body.t === 'refuse').length >= 2, 5_000), 'both merges were refused').to.equal(true)
      expect(await waitUntil(() => j.acked() >= 2, 5_000), 'the re-confirm reached M1 and was acked').to.equal(true)
      await sleepMs(700) // room for any extra re-confirm
      expect(c.seen.map(m => m.body.t)).to.deep.equal(['refuse', 'refuse'])
      expect(c.seen.map(m => m.body.reason)).to.deep.equal(['a voter is already in this pool', 'a voter is already in this pool'])
      expect(agent.logs.filter(l => l.event === 'reconfirm-on-collision')).to.have.length(1)
      // merge inform + exactly one re-confirm, both naming M1's own vote (the entry was not replaced)
      expect(j.informs()).to.have.length(2)
      expect(j.informs().map(m => m.body.hold)).to.deep.equal([holdOfVoter(j.v1), holdOfVoter(j.v1)])
      expect(agent.logs.some(l => l.event === 'dropped')).to.equal(false)
      expect(await sizeOfAgent(rv, a), 'the pool is still the agent plus M1').to.equal(2)
    } finally {
      await c.p.stop(); await j.p.stop(); await agent.stop(); rv.close()
    }
  })

  it('D-92: a stale entry is dropped by the re-confirm and the same sender\'s next merge is accepted', async () => {
    const rv = new PoolRendezvous({ coordinatorTtlMs: 120_000 })
    const a = makeVoter(0)
    const agent = startAgent(rv, a)
    const j = await joinMember(rv, a, { ackDelayMs: 0, ackLimit: 1 }) // M1 acks the merge inform, then goes silent
    const c = await collider(rv, a, j.v1.contribution.voterEntry.registrantId)
    try {
      expect(await waitUntil(() => j.acked() >= 1, 5_000)).to.equal(true)
      await c.merge('collide-1')
      expect(await waitUntil(() => c.seen.some(m => m.body.re === 'collide-1' && m.body.t === 'refuse'), 5_000), 'refused while the entry stands').to.equal(true)
      expect(await waitUntil(() => agent.logs.some(l => l.event === 'dropped'), 5_000), 'the silent entry was dropped').to.equal(true)
      await c.merge('collide-2')
      expect(await waitUntil(() => c.seen.some(m => m.body.re === 'collide-2' && m.body.t === 'merged'), 5_000), 'the next merge is accepted').to.equal(true)
      expect(agent.logs.filter(l => l.event === 'reconfirm-on-collision')).to.have.length(1)
      // the listing follows the agent's next present (every ~40 ms), so poll for it
      let size: number | undefined
      for (let i = 0; i < 100 && size !== 2; i++) { size = await sizeOfAgent(rv, a); if (size !== 2) await sleepMs(30) }
      expect(size, 'the pool is the agent plus the sender').to.equal(2)
    } finally {
      await c.p.stop(); await j.p.stop(); await agent.stop(); rv.close()
    }
  })

  /** targets T1 (size 3) and T2 (size 2) are strictly better than the solo agent; T3 (size 1, higher id) is not. */
  async function withTargets (reply: (target: 'T1' | 'T2', nth: number) => 'refuse' | 'merged', extra: Partial<PoolAgentOptions> = {}) {
    const rv = new PoolRendezvous({ coordinatorTtlMs: 120_000 })
    const a = makeVoter(0)
    const merges: string[] = []
    const counts = { T1: 0, T2: 0 }
    const mk = (name: 'T1' | 'T2' | 'T3', size: number, side: 'above' | 'below') => {
      const peer = peerBeside(rv, `transport-${name}`, side, a.identity.peerId)
      const p = pump(peer, async (m) => {
        if (m.body.t !== 'merge') return
        merges.push(name)
        if (name === 'T3') return
        counts[name]++
        const verdict = reply(name, counts[name])
        await peer.send(m.from, verdict === 'merged' ? { t: 'merged', re: m.body.id, size: 4 } : { t: 'refuse', re: m.body.id, reason: 'not coordinating' })
      })
      return { peer, p, size }
    }
    const targets = [mk('T1', 3, 'above'), mk('T2', 2, 'above'), mk('T3', 1, 'above')]
    for (const t of targets) await t.peer.present(topic, t.size)
    const agent = startAgent(rv, a, { replyTimeoutMs: 1_000, ...extra })
    return {
      merges,
      logs: agent.logs,
      stop: async () => { await agent.stop(); for (const t of targets) await t.p.stop(); rv.close() }
    }
  }

  it('D-93: after 3 refusals from the best target the next-best strictly better target is tried, never a worse one', async () => {
    const h = await withTargets((t) => (t === 'T1' ? 'refuse' : 'merged'))
    try {
      expect(await waitUntil(() => h.merges.length >= 4, 8_000), 'four merge attempts').to.equal(true)
      await sleepMs(400) // the agent is a member of T2 now: nothing more is sent
      expect(h.merges).to.deep.equal(['T1', 'T1', 'T1', 'T2'])
    } finally { await h.stop() }
  })

  it('D-93: the per-target counter resets on any merged reply', async () => {
    // T1 refuses twice, merges the third time (agent becomes its member, then reverts to solo), then refuses for good.
    const h = await withTargets((t, nth) => (t === 'T1' && nth === 3 ? 'merged' : 'refuse'), { memberTimeoutMs: 300 })
    try {
      expect(await waitUntil(() => h.merges.includes('T2'), 15_000), 'T2 is eventually tried').to.equal(true)
      // 3 before the merge, then (counter cleared) a full 3 more before T2; an uncleared counter would reach T2 after 5
      expect(h.merges.slice(0, 7)).to.deep.equal(['T1', 'T1', 'T1', 'T1', 'T1', 'T1', 'T2'])
      expect(h.logs.some(l => l.event === 'solo')).to.equal(true)
    } finally { await h.stop() }
  })

  it('D-93: with every candidate at 3+ refusals the agent falls back to the best one and keeps trying', async () => {
    const h = await withTargets(() => 'refuse')
    try {
      expect(await waitUntil(() => h.merges.length >= 10, 15_000), 'no permanent stall: attempts keep coming').to.equal(true)
      expect(h.merges.slice(0, 10)).to.deep.equal(['T1', 'T1', 'T1', 'T2', 'T2', 'T2', 'T1', 'T1', 'T1', 'T1'])
      expect(h.merges.includes('T3'), 'a target that is not strictly better is never tried').to.equal(false)
    } finally { await h.stop() }
  })
})
