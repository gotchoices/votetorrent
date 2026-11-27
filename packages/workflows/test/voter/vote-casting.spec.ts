// vote-casting.spec.ts: plain-Node proof of the shared Voter vote casting (phase 67 plan 22). A real
// P-256 key signs through a recording producer; the record store and record vault are in-file fakes
// that record every call in one ordered list; the election read is passed through `deps.readContext`.
// Pins: the seams are REQUIRED and refused before any read; the castVote order (one sign, seal, marker,
// write); the seal / store `instanceof` classification; the device-key reject codes; and secrecy of the
// result under a hostile console.
import { expect } from 'chai'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { Ballot, Question } from '@votetorrent/vote-core'
import { verifySigP256, voterEntryDigest } from '@votetorrent/vote-engine/rn'
import type { VoterEntryUnsigned } from '@votetorrent/vote-engine/rn'
import {
  castVote,
  evaluateVoteEligibility,
  type CastVoteDeps,
  type VoteCastingSeams,
  type VoteContext,
  type VoteRecord,
  type VoteRecordEnvelope,
  type VoteRecordUnavailableReason,
  type VoteStoreWriteReason,
} from '../../src/voter/reads.js'
import type { AttestationProducer, SecretWrapPrompt, VoteSigningProducer } from '../../src/platform/index.js'

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'
const SIGN_PROMPT: SecretWrapPrompt = { title: 'Confirm your vote', subtitle: 'Sign your vote with your device key', negativeButton: 'Cancel' }
const RECORD_PROMPT: SecretWrapPrompt = { title: 'Save your vote', subtitle: 'Protect your saved vote', negativeButton: 'Cancel' }
const REGISTRANT_ID = 'registrant-R1'

function hexToU8 (hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16))
}

function makeKey (): { sk: Uint8Array, spki: string, compressed: string } {
  const sk = p256.utils.randomSecretKey()
  const uncompressed = p256.getPublicKey(sk, false)
  const prefix = hexToU8(SPKI_PREFIX)
  const der = new Uint8Array(prefix.length + uncompressed.length)
  der.set(prefix, 0)
  der.set(uncompressed, prefix.length)
  return { sk, spki: Buffer.from(der).toString('base64'), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

const KEY = makeKey()

function question (code: string, overrides: Partial<Question> = {}): Question {
  return {
    code,
    title: `Title ${code}`,
    instructions: '',
    type: 'select',
    options: [
      { code: 'x', title: `${code} X` },
      { code: 'y', title: `${code} Y` },
    ],
    ...overrides,
  } as Question
}

function ballot (id: string, questions: Question[]): Ballot {
  return { id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions } as Ballot
}

function ctxOf (revision = 3): VoteContext {
  return {
    electionId: 'e-1',
    revision,
    authorityId: 'a-1',
    open: true,
    lifecycleState: 'Open',
    ballots: [
      ballot('b-1', [question('q-req'), question('q-opt', { required: false })]),
      ballot('b-2', [question('q-two', { required: false })]),
    ],
    unconfirmedBallotIds: [],
    unsupportedQuestionCount: 0,
  }
}

const GOOD: Record<string, string[]> = { 'b-1:q-req': ['b-1:q-req:x'] }

interface Rig {
  calls: string[]
  seams: VoteCastingSeams
  producer: VoteSigningProducer
  sealed: VoteRecord[]
  envelopes: VoteRecordEnvelope[]
  written: Array<{ envelope: VoteRecordEnvelope, marker: unknown }>
  markers: unknown[]
  readContextCalls: number
  deps: CastVoteDeps
  resolveCalls: number
}

class FakeUnavailableError extends Error {
  readonly reason: VoteRecordUnavailableReason
  constructor (reason: VoteRecordUnavailableReason) {
    super('vote record unavailable (' + reason + ')')
    this.reason = reason
  }
}

class FakeWriteError extends Error {
  readonly reason: VoteStoreWriteReason
  constructor (reason: VoteStoreWriteReason) {
    super('vote record store write failed (' + reason + ')')
    this.reason = reason
  }
}

function rig (over: {
  deviceKeyError?: unknown
  seal?: () => Promise<VoteRecordEnvelope>
  write?: () => Promise<void>
} = {}): Rig {
  const calls: string[] = []
  const sealed: VoteRecord[] = []
  const envelopes: VoteRecordEnvelope[] = []
  const written: Array<{ envelope: VoteRecordEnvelope, marker: unknown }> = []
  const markers: unknown[] = []
  const producer: VoteSigningProducer = {
    provisionDeviceKey: async () => { throw new Error('a vote-casting lookup must never provision a device key') },
    getCurrentDeviceKey: async () => {
      calls.push('getCurrentDeviceKey')
      if (over.deviceKeyError !== undefined) throw over.deviceKeyError
      return { publicKey: KEY.spki }
    },
    produce: async () => { throw new Error('not used') },
    signDeviceKeyDigest: async (digest: Uint8Array) => {
      calls.push('signDeviceKeyDigest')
      return { signature: bytesToHex(p256.sign(digest, KEY.sk)), signerKey: KEY.spki, signerUserId: '' } as never
    },
  }
  const association = { getAssociationsByDeviceKey: async (_k: string) => [{ registrantId: REGISTRANT_ID, deviceKey: KEY.compressed, attestationCid: 'att-1' }] }
  const registration = { getRegistrant: async (id: string) => ({ id, authorityId: 'a-1', status: 'a', privateCid: `priv-${id}`, publicCid: 'pub-1' }) }
  const getEngine = (async (name: string) => {
    if (name === 'association') return association
    if (name === 'registration') return registration
    throw new Error(`unexpected engine ${name}`)
  }) as CastVoteDeps['getEngine']
  const r: Rig = {
    calls,
    sealed,
    envelopes,
    written,
    markers,
    producer,
    readContextCalls: 0,
    resolveCalls: 0,
    seams: {
      resolveVoteSigningProducer: (override?: AttestationProducer) => {
        r.resolveCalls++
        if (override === undefined || typeof override.signDeviceKeyDigest !== 'function') throw new TypeError('override cannot sign')
        return override as VoteSigningProducer
      },
      recordStore: {
        guard: async () => { calls.push('guard'); return 'ok' },
        buildVoteMarker: (record) => {
          calls.push('buildVoteMarker')
          const marker = { v: 1 as const, electionId: record.electionId, electionRevision: record.electionRevision, ballotIds: record.votes.map(v => v.ballotId), savedAt: record.savedAt, status: 'saved-not-sent' as const }
          markers.push(marker)
          return marker
        },
        writeVoteRecord: async (envelope, marker) => {
          calls.push('writeVoteRecord')
          written.push({ envelope, marker })
          if (over.write !== undefined) await over.write()
        },
        VoteStoreWriteError: FakeWriteError,
      },
      recordVault: {
        sealVoteRecord: async (record) => {
          calls.push('sealVoteRecord')
          sealed.push(record)
          if (over.seal !== undefined) return await over.seal()
          const envelope: VoteRecordEnvelope = {
            v: 1,
            wrappedKey: { v: 1, alg: 'AES-256-GCM', keyAlias: 'alias', ivBase64: 'aXY=', ciphertextBase64: 'Y3Q=', securityLevel: 'test-stub' },
            iv: 'aXY=',
            ct: 'Y3Q=',
          }
          envelopes.push(envelope)
          return envelope
        },
        VoteRecordUnavailableError: FakeUnavailableError,
      },
    },
    deps: {
      getEngine,
      fallbackElectionId: 'e-1',
      nowMs: 1234,
      selectionMap: GOOD,
      producer,
      readContext: async () => { r.readContextCalls++; return ctxOf() },
      signPrompt: SIGN_PROMPT,
      recordPrompt: RECORD_PROMPT,
    },
  }
  return r
}

async function rejectsTypeError (p: Promise<unknown>): Promise<void> {
  let caught: unknown = null
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught).to.be.instanceOf(TypeError)
}

describe('voter vote-casting (shared castVote over required seams)', () => {
  it('C1 evaluateVoteEligibility refuses a missing or malformed seams object before any read', async () => {
    const r = rig()
    await rejectsTypeError(evaluateVoteEligibility(r.deps, undefined as never))
    const noGuard = { ...r.seams, recordStore: { ...r.seams.recordStore, guard: undefined } } as unknown as VoteCastingSeams
    await rejectsTypeError(evaluateVoteEligibility(r.deps, noGuard))
    expect(r.readContextCalls).to.equal(0)
    expect(r.resolveCalls).to.equal(0)
    expect(r.calls).to.deep.equal([])
  })

  it('C2 castVote without a record vault refuses before readContext', async () => {
    const r = rig()
    const noVault = { resolveVoteSigningProducer: r.seams.resolveVoteSigningProducer, recordStore: r.seams.recordStore } as unknown as VoteCastingSeams
    await rejectsTypeError(castVote(r.deps, noVault))
    expect(r.readContextCalls).to.equal(0)
    expect(r.calls).to.deep.equal([])
  })

  it('C3 the happy path signs once, seals, builds the marker and writes, in that order, with a verifying signature', async () => {
    const r = rig()
    const result = await castVote(r.deps, r.seams)
    expect(result.ok).to.equal(true)
    expect(Object.keys(result).sort()).to.deep.equal(['ballotIds', 'electionId', 'electionRevision', 'ok', 'replacedStale', 'savedAt'])
    expect(r.calls).to.deep.equal(['getCurrentDeviceKey', 'guard', 'signDeviceKeyDigest', 'sealVoteRecord', 'buildVoteMarker', 'writeVoteRecord'])
    expect(r.resolveCalls).to.equal(1)
    expect(r.sealed).to.have.length(1)
    const record = r.sealed[0]!
    const { signature, ...unsigned } = record.voter
    expect(verifySigP256(voterEntryDigest(unsigned as VoterEntryUnsigned), signature, KEY.compressed)).to.equal(true)
    expect(record.voter.deviceKey).to.equal(KEY.compressed)
    expect(record.votes.map(v => v.ballotId)).to.deep.equal(['b-1', 'b-2'])
    expect(r.written).to.have.length(1)
    expect(r.written[0]!.envelope).to.equal(r.envelopes[0])
    expect(r.written[0]!.marker).to.equal(r.markers[0])
    if (result.ok) {
      expect(result.ballotIds).to.deep.equal(['b-1', 'b-2'])
      expect(result.electionId).to.equal('e-1')
      expect(result.electionRevision).to.equal(3)
      expect(result.replacedStale).to.equal(false)
    }
  })

  it('C4 a seal failure is classified through the injected class and nothing is written', async () => {
    const canceled = rig({ seal: async () => { throw new FakeUnavailableError('canceled') } })
    expect(await castVote(canceled.deps, canceled.seams)).to.deep.equal({ ok: false, stage: 'seal', reason: 'canceled' })
    expect(canceled.calls).to.not.include('writeVoteRecord')
    const plain = rig({ seal: async () => { throw new Error('boom') } })
    expect(await castVote(plain.deps, plain.seams)).to.deep.equal({ ok: false, stage: 'seal', reason: 'native-error' })
    expect(plain.calls).to.not.include('writeVoteRecord')
  })

  it('C5 a store failure is classified through the injected class', async () => {
    const already = rig({ write: async () => { throw new FakeWriteError('already-saved') } })
    expect(await castVote(already.deps, already.seams)).to.deep.equal({ ok: false, stage: 'store', reason: 'already-saved' })
    const plain = rig({ write: async () => { throw new Error('disk') } })
    expect(await castVote(plain.deps, plain.seams)).to.deep.equal({ ok: false, stage: 'store', reason: 'storage-failed' })
  })

  describe('C6 the read-only device-key lookup codes map to the closed reasons', () => {
    const cases: Array<[string, string]> = [
      ['DEVICE_KEY_ABSENT', 'not-registered'],
      ['DEVICE_KEY_INVALIDATED', 'device-key-rotated'],
      ['OTHER', 'device-check-failed'],
    ]
    for (const [code, reason] of cases) {
      it(`C6 ${code} gives ${reason} without a sign`, async () => {
        const r = rig({ deviceKeyError: { code } })
        const eligibility = await evaluateVoteEligibility(r.deps, r.seams)
        expect(eligibility.eligible).to.equal(false)
        if (!eligibility.eligible) expect(eligibility.reason).to.equal(reason)
        expect(r.calls).to.not.include('signDeviceKeyDigest')
      })
    }
  })

  it('C7 a cast succeeds with every console method throwing, and the result carries no secret', async () => {
    const con = globalThis.console as unknown as Record<string, unknown>
    const names = ['log', 'info', 'warn', 'error', 'debug']
    const saved = names.map(n => [n, con[n]] as const)
    for (const n of names) con[n] = () => { throw new Error('logged ' + n) }
    try {
      const r = rig()
      const result = await castVote(r.deps, r.seams)
      expect(result.ok).to.equal(true)
      const text = JSON.stringify(result)
      const record = r.sealed[0]!
      for (const vote of record.votes) expect(text).to.not.include(vote.nonce)
      expect(text).to.not.include(record.voter.signature)
      expect(text).to.not.include(REGISTRANT_ID)
      expect(text).to.not.include(KEY.compressed)
      expect(text).to.not.include(KEY.spki)
    } finally {
      for (const [n, fn] of saved) con[n] = fn
    }
  })
})
