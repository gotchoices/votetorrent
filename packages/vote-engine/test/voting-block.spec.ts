/**
 * voting-block.spec.ts — Phase 63 Plan 03 (D-23, D-28): a mocha port of spike 098.
 *
 * The spike's DKG seed and k-of-n release are replaced by a locally generated secp256k1 joint key,
 * because `openElectionBlock` takes the secret scalar directly. The DKG, release and
 * `decryptElectionBlocks` path is already covered by key-release.spec.ts; this spec's subject is
 * the entry and payload contract.
 *
 * The spike's local `byCanon` (a JS string compare) is replaced by the shipped
 * `sortByCanonicalBytes` (UTF-8 bytes), the D-28 rule the future block builder must call.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { encryptElectionBlock, openElectionBlock, serializeElectionBlockPayload } from '../src/key-release/index.js'
import { verifySigP256 } from '../src/database/initialize.js'
import { digestToBytes } from '../src/utils.js'
import {
  buildVoteEntry, makeVoteNonce, voterEntryDigest, canonicalJson, sortByCanonicalBytes,
  p256KeyToCompressedHex, VOTE_ENTRY_KEYS, VOTER_ENTRY_KEYS,
  type TemplateBallot, type VoteEntry, type VoterEntry, type VoterEntryUnsigned
} from '../src/voting/index.js'

const REVISION = 3
const s = secp256k1.utils.randomSecretKey()
const electionKey = { electionId: 'election-098', revision: REVISION, jointPublicKey: bytesToHex(secp256k1.getPublicKey(s, true)) }

const ballot: TemplateBallot = {
  id: 'ballot-098', electionId: 'election-098', authorityId: 'authority-098', description: 'Spike 098', districts: [],
  questions: [
    { code: 'mayor', title: 'Mayor', type: 'select', optionRange: { min: 1, max: 1 }, options: [{ code: 'a', title: 'A' }, { code: 'b', title: 'B' }, { code: 'c', title: 'C' }] },
    { code: 'council', title: 'Council', type: 'select', optionRange: { min: 1, max: 2 }, options: [{ code: 'x', title: 'X' }, { code: 'y', title: 'Y' }, { code: 'z', title: 'Z' }] }
  ]
} as unknown as TemplateBallot

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!

interface Voter { vote: VoteEntry, voter: VoterEntry }

function makeVoter (i: number): Voter {
  const priv = p256.utils.randomSecretKey()
  const uncompressedHex = bytesToHex(p256.getPublicKey(priv, false))
  const compressedHex = bytesToHex(p256.getPublicKey(priv, true))
  const vote = buildVoteEntry({
    ballot, electionRevision: REVISION, nonce: makeVoteNonce(crypto.getRandomValues(new Uint8Array(32))),
    selections: { mayor: [pick(['a', 'b', 'c'])], council: Math.random() < 0.5 ? ['x', 'z'] : [pick(['x', 'y', 'z'])] }
  })
  const unsigned: VoterEntryUnsigned = {
    v: 1, electionId: electionKey.electionId, electionRevision: REVISION, registrantId: `registrant-${i}`, privateCid: `cid-private-${i}`,
    publicCid: null, deviceKey: p256KeyToCompressedHex(i % 2 === 0 ? uncompressedHex : compressedHex), attestationCid: null,
    ballots: [{ ballotId: ballot.id, templateDigest: vote.templateDigest }]
  }
  const signature = bytesToHex(p256.sign(digestToBytes(voterEntryDigest(unsigned)), priv))
  return { vote, voter: { ...unsigned, signature } }
}

/** The D-28 ordering rule: each array sorted by its own canonical bytes. */
function blockPayload (voters: Voter[]): { v: 1, votes: VoteEntry[], voterRecords: VoterEntry[] } {
  return { v: 1, votes: sortByCanonicalBytes(voters.map(v => v.vote)), voterRecords: sortByCanonicalBytes(voters.map(v => v.voter)) }
}

function linkedByPosition (votes: VoteEntry[], records: VoterEntry[], voters: Voter[]): number {
  const vi = new Map(voters.map((b, i) => [b.vote.nonce, i]))
  const ri = new Map(voters.map((b, i) => [b.voter.registrantId, i]))
  return votes.filter((v, pos) => ri.get(records[pos]!.registrantId) === vi.get(v.nonce)).length
}

const ctSize = (ct: unknown): number => new TextEncoder().encode(JSON.stringify(ct)).length

describe('voting/block payload: spike 098 port (63-03: D-23, D-28)', function () {
  this.timeout(120000)

  let block: Voter[]
  let payload: ReturnType<typeof blockPayload>
  let ciphertext: ReturnType<typeof encryptElectionBlock>
  let opened: ReturnType<typeof openElectionBlock>
  let openedWrongRev: ReturnType<typeof openElectionBlock>
  let out: typeof payload

  before(function () {
    block = Array.from({ length: 25 }, (_, i) => makeVoter(i))
    payload = blockPayload(block)
    ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
    const wrongRev = encryptElectionBlock({ ...electionKey, revision: REVISION + 1 }, 'block-rev', payload)
    opened = openElectionBlock(s, electionKey, { blockId: 'block-1', ciphertext })
    openedWrongRev = openElectionBlock(s, electionKey, { blockId: 'block-rev', ciphertext: wrongRev })
    out = (opened.ok ? opened.payload : null) as unknown as typeof payload
  })

  it('K0 encryptElectionBlock accepts a locally generated joint key (stand-in for the spike DKG seed)', () => {
    expect(electionKey.jointPublicKey).to.match(/^0[23][0-9a-f]{64}$/)
    expect(ciphertext).to.not.equal(undefined)
  })

  it('B1 25 entries encrypt as {v:1, votes, voterRecords}', () => {
    expect(ctSize(ciphertext), `${ctSize(ciphertext)} B for 25 voters`).to.be.greaterThan(0)
  })

  it('B1b a payload without voterRecords is refused before encryption (D-18 guard)', () => {
    let code: unknown
    try {
      encryptElectionBlock(electionKey, 'block-x', { v: 1, votes: payload.votes } as never)
    } catch (e) { code = (e as { code?: string }).code }
    expect(code).to.equal('invalid-plaintext')
  })

  it('B2 the block opens with the joint secret', () => {
    expect(opened.ok, opened.ok ? '' : `${opened.reason}/${opened.detail}`).to.equal(true)
  })

  it('B2b the decrypted payload deep-equals what was encrypted', () => {
    expect(out).to.deep.equal(payload)
    expect(canonicalJson(out)).to.equal(canonicalJson(payload))
  })

  it('B2c a block bound to another election revision fails authentication', () => {
    expect(openedWrongRev.ok).to.equal(false)
    if (!openedWrongRev.ok) expect(openedWrongRev.reason).to.equal('authentication-failed')
  })

  it('B3 every voter signature re-verifies from the decrypted payload with the carried key', () => {
    let verified = 0
    for (const r of out.voterRecords) {
      expect(r.deviceKey).to.match(/^0[23][0-9a-f]{64}$/)
      const { signature, ...unsigned } = r
      if (verifySigP256(voterEntryDigest(unsigned), signature, r.deviceKey)) verified++
    }
    expect(verified, `${verified}/25`).to.equal(25)
  })

  it('B3b a voter record edited after decryption fails re-verification', () => {
    const forged = { ...out.voterRecords[0]!, registrantId: 'registrant-forged' }
    const { signature, ...unsigned } = forged
    expect(verifySigP256(voterEntryDigest(unsigned), signature, forged.deviceKey)).to.equal(false)
  })

  it('B4 vote count per ballot template equals voter count per template', () => {
    const votes = new Map<string, number>()
    const voters = new Map<string, number>()
    for (const v of out.votes) votes.set(v.templateDigest, (votes.get(v.templateDigest) ?? 0) + 1)
    for (const r of out.voterRecords) for (const b of r.ballots) voters.set(b.templateDigest, (voters.get(b.templateDigest) ?? 0) + 1)
    expect(canonicalJson([...votes])).to.equal(canonicalJson([...voters]))
  })

  it('B5a FINDING: arrays in submission order link every vote to its voter by position', () => {
    const linked = linkedByPosition(block.map(b => b.vote), block.map(b => b.voter), block)
    expect(linked, `${linked}/25 linked`).to.equal(25)
  })

  it('B5b canonical-byte ordering links about 1 vote per block by chance (baseline 1)', () => {
    let total = 0
    const trials = 200
    for (let t = 0; t < trials; t++) {
      const vs = Array.from({ length: 25 }, (_, i) => makeVoter(i))
      const pl = blockPayload(vs)
      total += linkedByPosition(pl.votes, pl.voterRecords, vs)
    }
    const mean = total / trials
    expect(mean, `mean ${mean.toFixed(2)} of 25 over ${trials} blocks`).to.be.lessThan(2)
  })

  it('B5c the serialized payload is independent of submission order (D-28)', () => {
    const base = bytesToHex(serializeElectionBlockPayload(blockPayload(block)))
    for (let k = 0; k < 10; k++) {
      const shuffled = [...block]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      expect(bytesToHex(serializeElectionBlockPayload(blockPayload(shuffled)))).to.equal(base)
    }
  })

  it('B6 ciphertext size grows with voters at roughly one kilobyte each', () => {
    const sizes: Record<number, number> = {}
    for (const n of [1, 10, 100]) {
      sizes[n] = ctSize(encryptElectionBlock(electionKey, `size-${n}`, blockPayload(Array.from({ length: n }, (_, i) => makeVoter(i)))))
    }
    const msg = JSON.stringify(sizes)
    expect(sizes[1]!, msg).to.be.lessThan(sizes[10]!)
    expect(sizes[10]!, msg).to.be.lessThan(sizes[100]!)
    const perVoter = (sizes[100]! - sizes[1]!) / 99
    expect(perVoter, `${msg} per-voter ${perVoter.toFixed(0)}`).to.be.within(500, 2500)
  })

  it('B7 decrypted entries carry exactly the D-23 key sets', () => {
    for (const v of out.votes) expect(Object.keys(v).sort()).to.deep.equal([...VOTE_ENTRY_KEYS].sort())
    for (const r of out.voterRecords) expect(Object.keys(r).sort()).to.deep.equal([...VOTER_ENTRY_KEYS].sort())
  })

  it('port completeness: every spike check id starts an it title', () => {
    const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    for (const id of ['K0', 'B1', 'B1b', 'B2', 'B2b', 'B2c', 'B3', 'B3b', 'B4', 'B5a', 'B5b', 'B5c', 'B6', 'B7']) {
      expect(text.includes(`it('${id} `), id).to.equal(true)
    }
  })
})
