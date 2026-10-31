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
  createInMemoryRendezvousClient,
  openPoolEnvelope,
  poolIdentityFromRawKey,
  type PoolBallot,
  type PoolContribution,
  type PoolIdentity,
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
