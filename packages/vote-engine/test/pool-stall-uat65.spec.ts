/**
 * pool-stall-uat65.spec.ts — UAT 65 gap 1: a member whose group confirmation goes unanswered must
 * re-pool with the remaining voters and one block of 3 must commit, without the voter restarting
 * the send. Timings are the real defaults divided by 40; the peer ids sort F < phone < M (the order
 * seen on the devices), and the phone's consent goes through a Voter-style consent queue whose
 * first prompt never settles.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encryptVoteEntry } from '../src/key-release/index.js'
import {
  PoolAgent,
  PoolRendezvous,
  createConsentQueue,
  POOL_SIGN_TIMEOUT_MS,
  createInMemoryRendezvousClient,
  openPoolEnvelope,
  poolIdentityFromRawKey,
  type PoolBallot,
  type PoolContribution,
  type PoolIdentity,
  type PoolAgentOptions,
  type RendezvousRequest
} from '../src/pool/index.js'
import type { VoterEntry } from '../src/voting/index.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const electionSecret = secp256k1.utils.randomSecretKey()
const ballot: PoolBallot = {
  electionKey: { electionId: 'e-uat65', revision: 1, jointPublicKey: bytesToHex(secp256k1.getPublicKey(electionSecret, true)) },
  ballotId: 'b-uat65',
  templateDigest: 'td'
}

interface TV { identity: PoolIdentity, contribution: PoolContribution, priv: Uint8Array, name: string }

function mk (name: string, rawKey?: Uint8Array): TV {
  const identity = poolIdentityFromRawKey(rawKey ?? ed25519.utils.randomSecretKey())
  const { privBytes, pubHex } = makeP256TestKey()
  const voteJson = JSON.stringify({ v: 1, ballotId: ballot.ballotId, answers: [], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
  const voterEntry: VoterEntry = {
    v: 1, electionId: ballot.electionKey.electionId, electionRevision: 1, registrantId: `reg-${name}`,
    privateCid: `p-${name}`, publicCid: null, deviceKey: pubHex, attestationCid: null,
    ballots: [{ ballotId: ballot.ballotId, templateDigest: ballot.templateDigest }], signature: 'ab'.repeat(32)
  }
  return { identity, priv: privBytes, name, contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(ballot.electionKey, ballot.ballotId, voteJson), voterEntry } }
}

const sleep = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

// Real defaults / 40: signTimeout 120 s, memberTimeout 60 s, quiet 20 s, reply 5 s, present 1 s, poll 2 s
const S = 1 / 40
const ms = (x: number): number => Math.round(x * S)

describe('createConsentQueue', function () {
  it('runs calls one at a time, in arrival order', async () => {
    const q = createConsentQueue(async (n: number) => {
      order.push(`start ${n}`)
      await sleep(10)
      order.push(`end ${n}`)
      return n * 2
    })
    const order: string[] = []
    const results = await Promise.all([q(1), q(2), q(3)])
    expect(results).to.deep.equal([2, 4, 6])
    expect(order).to.deep.equal(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  })

  it('a rejected call does not stop later calls', async () => {
    const q = createConsentQueue(async (n: number) => {
      if (n === 1) throw new Error('declined')
      return n
    })
    const first = q(1)
    const second = q(2)
    let err: unknown
    try { await first } catch (e) { err = e }
    expect((err as Error).message).to.equal('declined')
    expect(await second).to.equal(2)
  })

  it('a call still open after holdMs no longer blocks the next call, and its late result reaches nobody else', async () => {
    let resolveFirst!: (v: string) => void
    const q = createConsentQueue(async (n: number) => {
      if (n === 1) return await new Promise<string>((resolve) => { resolveFirst = resolve })
      return `second-${n}`
    }, { holdMs: 50 })
    const first = q(1)
    const t0 = Date.now()
    const second = await q(2)
    const waited = Date.now() - t0
    expect(second).to.equal('second-2')
    expect(waited).to.be.within(30, 400)
    // the first caller still gets its own late result, and only that
    resolveFirst('late-first')
    expect(await first).to.equal('late-first')
    expect(second).to.equal('second-2')
  })
})

interface StallRun {
  commits: string[][]
  firstRefusalAt: number
  diagnostics: string
}

/** One trial: three voters, peer ids F < phone < M, the phone starts 60 scaled s late and its first prompt never settles. */
async function runStallTrial (): Promise<StallRun> {
  const rendezvous = new PoolRendezvous({ coordinatorTtlMs: ms(30_000), envelopeTtlMs: ms(120_000), maxPollWaitMs: ms(10_000) })
  const raw = [0, 1, 2].map(() => ed25519.utils.randomSecretKey())
  const ids = raw.map(k => poolIdentityFromRawKey(k)).map((id, i) => ({ id, i })).sort((a, b) => (a.id.peerId < b.id.peerId ? -1 : 1))
  const F = mk('F', raw[ids[0]!.i])
  const P = mk('phone', raw[ids[1]!.i])
  const M = mk('M', raw[ids[2]!.i])
  const voters = [F, M, P]
  const byPeer = new Map(voters.map(v => [v.identity.peerId, v]))
  const t0 = Date.now()
  const trace: string[] = []
  const at = (): string => `${((Date.now() - t0) / S / 1000).toFixed(1).padStart(6)}s`
  const refusals = new Map<string, number>()
  const commits: string[][] = []
  let phonePrompts = 0
  let dropAt = 0
  const controller = new AbortController()
  const phoneSigner = async (d: string): Promise<string> => {
    phonePrompts++
    if (phonePrompts === 1) return await new Promise<string>(() => {}) // the unanswered Face ID
    return signDigestP256(d, P.priv)
  }
  const phoneSign = createConsentQueue(phoneSigner, { holdMs: ms(120_000) })
  const runs = voters.map(async (v) => {
    if (v.name === 'phone') await sleep(ms(60_000))
    const inner = createInMemoryRendezvousClient(rendezvous, `t-${v.name}`)
    const client = {
      async call (req: RendezvousRequest, extra?: number) {
        if (req.t === 'send') {
          const to = byPeer.get(req.envelope.to)
          if (to !== undefined) {
            try {
              const body = openPoolEnvelope<any>(to.identity, req.envelope).body
              if (body.t === 'refuse') { const k = `${v.name}->${to.name} refuse "${body.reason}"`; refusals.set(k, (refusals.get(k) ?? 0) + 1) }
            } catch { /* diagnostics only */ }
          }
        }
        return await inner.call(req, extra)
      }
    }
    const agent = new PoolAgent({
      identity: v.identity,
      rendezvous: client,
      ballot,
      contribution: v.contribution,
      signConsent: v.name === 'phone' ? phoneSign : async (d) => signDigestP256(d, v.priv),
      commit: async (_block, sigs) => { commits.push(sigs.map(s => s.registrantId)); trace.push(`${at()} COMMIT ${sigs.length}`); return { ok: true } },
      findRecordedVote: async () => null,
      quietMs: ms(20_000),
      presentIntervalMs: ms(1_000),
      replyTimeoutMs: ms(5_000),
      signTimeoutMs: ms(120_000),
      memberTimeoutMs: ms(60_000),
      pollWaitMs: ms(2_000),
      formLeadMs: ms(60_000),
      ladderMaxMs: ms(15_000),
      deadlineAt: Date.now() + ms(900_000),
      log: (e, d) => {
        if (e === 'form-refused-by' && dropAt === 0) dropAt = Date.now()
        if (e !== 'ladder-widen') trace.push(`${at()} ${v.name} ${e} ${JSON.stringify(d ?? {})}`)
      }
    })
    return await agent.run(controller.signal)
  })
  // watch until a commit, or 600 scaled s after the first formation refusal (or 900 s with none), then stop
  const watch = setInterval(() => {
    if (commits.length > 0 || (dropAt > 0 && Date.now() - dropAt > ms(600_000)) || Date.now() - t0 > ms(900_000)) controller.abort()
  }, 20)
  await Promise.all(runs)
  clearInterval(watch)
  rendezvous.close()
  const diagnostics = `${trace.join('\n')}\nrefusals ${JSON.stringify([...refusals.entries()])}\nphone prompts ${phonePrompts}`
  return { commits, firstRefusalAt: dropAt, diagnostics }
}

describe('UAT 65 gap 1: the pool stall after an unanswered group confirmation', function () {
  this.timeout(120_000)
  for (let trial = 1; trial <= 3; trial++) {
    it(`trial ${trial}: the phone re-pools after an unanswered group confirmation and one block of 3 commits`, async function () {
      const run = await runStallTrial()
      try {
        expect(run.commits.length, 'blocks committed').to.equal(1)
        expect(run.commits[0], 'registrants in the block').to.have.length(3)
        expect(run.commits[0]).to.include('reg-phone')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(run.diagnostics)
        throw err
      }
    })
  }
})

describe('exported default', function () {
  it('POOL_SIGN_TIMEOUT_MS is the 120 s sign window', () => {
    expect(POOL_SIGN_TIMEOUT_MS).to.equal(120_000)
  })
})

// ---------------------------------------------------------------------------------------------
// D-90 / D-91 / D-95 at small real-time timings

// The ratios follow the real defaults (quiet 20 s : member timeout 60 s : sign window 120 s, i.e. the
// member timeout is 3x the quiet window and the sign window 2x the member timeout) with wide
// absolute margins, so scheduler jitter at normal CPU priority cannot reorder the windows. A member
// timeout close to the quiet window makes members go solo before the form arrives.
const FAST: Partial<PoolAgentOptions> = {
  quietMs: 60, presentIntervalMs: 20, replyTimeoutMs: 80, informAttempts: 2,
  signTimeoutMs: 2_400, memberTimeoutMs: 600, pollWaitMs: 30, formLeadMs: 5_000, ladder: false
}

/** three voters with the peer ids sorted so that voters[0] (F) is the lowest and becomes the former */
function sortedVoters (names: string[]): TV[] {
  const raw = names.map(() => ed25519.utils.randomSecretKey())
  const order = raw.map(k => poolIdentityFromRawKey(k)).map((id, i) => ({ id, i })).sort((a, b) => (a.id.peerId < b.id.peerId ? -1 : 1))
  return order.map((o, k) => mk(names[k]!, raw[o.i]))
}

async function until (cond: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

describe('pool agent fixes D-90, D-91, D-95', function () {
  this.timeout(30_000)

  it('D-90: a member that signed at once is still a member while the former is inside its sign window', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const controller = new AbortController()
    const events: string[] = []
    let formingAt = 0
    let mLast = ''
    const runs = [F!, M!, X!].map(async (v) => await new PoolAgent({
      ...FAST,
      identity: v.identity,
      rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}`),
      ballot,
      contribution: v.contribution,
      // X never answers: the former sits in its sign window
      signConsent: v.name === 'X' ? async () => await new Promise<string>(() => {}) : async (d) => signDigestP256(d, v.priv),
      commit: async () => ({ ok: true }),
      findRecordedVote: async () => null,
      log: (e, d) => {
        if (v.name === 'F' && e === 'forming' && formingAt === 0) formingAt = Date.now()
        if (v.name === 'M' && e === 'solo') events.push(`M solo ${JSON.stringify(d)}`)
      },
      onStatus: (st) => { if (v.name === 'M') mLast = st.phase }
    }).run(controller.signal))
    try {
      expect(await until(() => formingAt > 0, 10_000), 'the former formed a block').to.equal(true)
      await sleep(1_000) // > memberTimeoutMs (600), < signTimeoutMs (2400)
      expect(events, 'M never reverted to solo').to.deep.equal([])
      expect(mLast).to.equal('member')
    } finally {
      controller.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
  })

  it('D-91: after a drop at formation, a survivor that went silent is dropped too', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const wrongKey = makeP256TestKey().privBytes
    const controller = new AbortController()
    let mSigned = false
    const dropped: Array<Record<string, unknown>> = []
    const runs = [F!, M!, X!].map(async (v) => {
      const inner = createInMemoryRendezvousClient(rendezvous, `t-${v.name}`)
      const client = {
        async call (req: RendezvousRequest, extra?: number) {
          const reply = await inner.call(req, extra)
          if (v.name === 'M' && mSigned && reply.t === 'envelopes') {
            // M has gone silent for informs (a stale entry on the former's side)
            const list = reply.list.filter((env) => {
              try { return openPoolEnvelope<any>(M!.identity, env).body.t !== 'inform' } catch { return true }
            })
            return { ...reply, list }
          }
          return reply
        }
      }
      return await new PoolAgent({
        ...FAST,
        identity: v.identity,
        rendezvous: client,
        ballot,
        contribution: v.contribution,
        signConsent: async (d) => {
          if (v.name === 'M') mSigned = true
          // X signs with a key that is not its device key: dropped at formation and excluded for good
          return signDigestP256(d, v.name === 'X' ? wrongKey : v.priv)
        },
        commit: async () => ({ ok: true }),
        findRecordedVote: async () => null,
        log: (e, d) => { if (v.name === 'F' && e === 'dropped') dropped.push({ ...d }) }
      }).run(controller.signal)
    })
    try {
      expect(await until(() => dropped.length > 0, 10_000), 'the former dropped the silent survivor').to.equal(true)
      expect(dropped[0]!.members).to.deep.equal([M!.identity.peerId.slice(-6)])
      expect(dropped[0]!.size).to.equal(1)
    } finally {
      controller.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
  })

  it('D-95: a voter dropped at formation twice is refused by peer id, a new pool identity with the same registrant id commits', async () => {
    const rendezvous = new PoolRendezvous({ coordinatorTtlMs: 5_000, envelopeTtlMs: 20_000, maxPollWaitMs: 100 })
    const [F, M, X] = sortedVoters(['F', 'M', 'X'])
    const controller = new AbortController()
    const commits: string[][] = []
    let refusedByF = 0
    const spawn = (v: TV, decline: boolean): Promise<unknown> => new PoolAgent({
      ...FAST,
      identity: v.identity,
      rendezvous: createInMemoryRendezvousClient(rendezvous, `t-${v.name}-${v.identity.peerId.slice(-4)}`),
      ballot,
      contribution: v.contribution,
      signConsent: async (d) => {
        if (decline) throw new Error('declined')
        return signDigestP256(d, v.priv)
      },
      commit: async (_b, sigs) => { commits.push(sigs.map(x => x.registrantId)); return { ok: true } },
      findRecordedVote: async () => null,
      log: (e) => { if (v.name === 'F' && e === 'form-refused-by') refusedByF++ }
    }).run(controller.signal)
    const runs = [spawn(F!, false), spawn(M!, false), spawn(X!, true)]
    try {
      expect(await until(() => refusedByF >= 2, 15_000), 'X was dropped at formation twice').to.equal(true)
      await sleep(100)
      // the same registrant under a NEW pool identity (a restarted send)
      const X2 = mk('X')
      runs.push(spawn(X2, false))
      expect(await until(() => commits.length > 0, 15_000), 'a block committed').to.equal(true)
      expect(commits).to.have.length(1)
      expect(commits[0]).to.have.length(3)
      expect(commits[0]).to.include('reg-X')
    } finally {
      controller.abort()
      await Promise.all(runs)
      rendezvous.close()
    }
  })
})
