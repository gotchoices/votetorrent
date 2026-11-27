// election-setup.spec.ts: the officer's election-setup workflow bodies moved into @votetorrent/workflows
// (phase 67 plan 10): refusal order, call order, digest-parity identity, signer-call counts, the seat
// share shape, the ballot and task paths, and a no-logging self-test over the seven shared files. Fakes
// record `[method, args]` into one shared `calls` array so order is assertable. Nothing in this file
// prints a key, a share or a signature, and no fixed private-key literal exists: keys come only from
// `randomSecretKey` inside the function under test.
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { ElectionEvent, ElectionType } from '@votetorrent/vote-core'
import type { Ballot, ElectionDetails, ElectionInit, IElectionsEngine, Signature, SignatureTask } from '@votetorrent/vote-core'
import { ElectionsCreateElectionBuilder } from '@votetorrent/vote-engine'
import {
  BALLOT_DEADLINE_LEAD_MS,
  createElection,
  findBallotSignatureTask,
  inviteKeyholderSeat,
  proposeBallot,
  proposeElectionRevision,
  readBallotConfirmation,
  rejectTask,
  signTask,
  submitBallot,
  toBallotConfirmationView,
  toProposedBallot,
} from '../../src/authority/election.js'
import type { CreateElectionInput } from '../../src/authority/election.js'

const SRC_AUTHORITY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'authority')
const PLAN_FILES = [
  'keyholder-policy.ts',
  'keyholder-invite-expiry.ts',
  'resolve-election-timeline.ts',
  'election-setup.ts',
  'keyholder-seat-invite.ts',
  'ballot-confirmation.ts',
  'signature-task.ts',
]
const PLACEHOLDER_KEYS = ['name', 'type', 'expiration', 'inviteKey', 'invitePrivate', 'inviteSignature', 'digest']

type Call = [string, unknown[]]

/** A counted signer factory: the sign callback records digests and returns a fixed-shape signature. */
function countedSigner() {
  const digests: Uint8Array[] = []
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    digests.push(digest)
    return { signature: 'sig', signerKey: 'key', signerUserId: 'user-1' }
  }
  let created = 0
  const createSigner = async () => {
    created += 1
    return sign
  }
  return { createSigner, sign, digests, createdCount: () => created }
}

/** Recording engine; the builder is the REAL ElectionsCreateElectionBuilder over it, as the real engine does. */
function fakeElectionsEngine(calls: Call[]) {
  return {
    buildCreateElection() {
      calls.push(['buildCreateElection', []])
      return new ElectionsCreateElectionBuilder(this as unknown as IElectionsEngine)
    },
    async seedElectionSigning(...args: unknown[]) {
      calls.push(['seedElectionSigning', args])
      return 'n1'
    },
    async peekNextTid() {
      calls.push(['peekNextTid', []])
      return 41
    },
    async seedElectionRevisionSigning(...args: unknown[]) {
      calls.push(['seedElectionRevisionSigning', args])
      return 'n2'
    },
    async createElection(...args: unknown[]) {
      calls.push(['createElection', args])
    },
    async adjustElection(...args: unknown[]) {
      calls.push(['adjustElection', args])
    },
  }
}

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

/** The CLI short-timeline shape (the lean rig's legElection). */
function shortTimeline(now = NOW): Record<ElectionEvent, number> {
  const votingStarts = now + 600_000
  const accruing = votingStarts + 480_000
  return {
    [ElectionEvent.registrationEnds]: votingStarts - 60_000,
    [ElectionEvent.ballotsFinal]: votingStarts - 60_000,
    [ElectionEvent.votingStarts]: votingStarts,
    [ElectionEvent.accruingVotes]: accruing,
    [ElectionEvent.hashingVotes]: accruing + 60_000,
    [ElectionEvent.releasingKeys]: accruing + 120_000,
    [ElectionEvent.tallyingStarts]: accruing + 180_000,
    [ElectionEvent.validation]: accruing + 240_000,
    [ElectionEvent.certificationStarts]: accruing + 300_000,
    [ElectionEvent.closed]: accruing + 360_000,
  }
}

function shortInput(overrides: Partial<CreateElectionInput> = {}): CreateElectionInput {
  const timeline = overrides.timeline ?? shortTimeline()
  return {
    authorityId: 'authority-1',
    title: 'Spec election',
    date: timeline.closed,
    revisionDeadline: timeline.votingStarts,
    type: ElectionType.adhoc,
    keyholders: ['Kay', 'Lee'],
    threshold: 2,
    tags: ['spec'],
    instructions: '# Spec',
    timeline,
    ballotDeadline: timeline.votingStarts,
    ...overrides,
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

describe('election setup (@votetorrent/workflows/authority election group)', function () {
  this.timeout(20_000)

  describe('C1 refusals before the signer', () => {
    const cases: Array<[string, Partial<CreateElectionInput>, string]> = [
      ['blank title', { title: '   ' }, 'title-required'],
      ['zero keyholders', { keyholders: [' ', ''] }, 'no-keyholders'],
      ['one keyholder', { keyholders: ['Kay'], threshold: 1 }, 'too-few-keyholders'],
      ['threshold 1 of 2', { threshold: 1 }, 'threshold-too-low'],
      ['threshold 3 of 2', { threshold: 3 }, 'threshold-above-count'],
      ['duplicate Kay / kay', { keyholders: ['Kay', ' kay '] }, 'duplicate-keyholder-name'],
    ]
    for (const [label, overrides, code] of cases) {
      it(`${label} refuses with ${code}, creates no signer and calls no engine`, async () => {
        const calls: Call[] = []
        const signer = countedSigner()
        const result = await createElection({
          electionsEngine: fakeElectionsEngine(calls),
          input: shortInput(overrides),
          createSigner: signer.createSigner,
          now: NOW,
        })
        expect(result.ok).to.equal(false)
        if (!result.ok) expect(result.refusal.code).to.equal(code)
        expect(signer.createdCount()).to.equal(0)
        expect(calls).to.deep.equal([])
      })
    }
  })

  describe('C2 refusals after the signer (order pin: one signer, no engine call)', () => {
    async function refused(overrides: Partial<CreateElectionInput>) {
      const calls: Call[] = []
      const signer = countedSigner()
      const result = await createElection({
        electionsEngine: fakeElectionsEngine(calls),
        input: shortInput(overrides),
        createSigner: signer.createSigner,
        now: NOW,
      })
      expect(result.ok).to.equal(false)
      expect(signer.createdCount()).to.equal(1)
      expect(calls).to.deep.equal([])
      return result.ok ? undefined : result.refusal
    }

    it('a NaN date gives election-date-invalid', async () => {
      const refusal = await refused({ date: Number.NaN })
      expect(refusal?.code).to.equal('election-date-invalid')
    })

    it('a NaN revision deadline gives revision-deadline-invalid', async () => {
      const refusal = await refused({ revisionDeadline: Number.NaN })
      expect(refusal?.code).to.equal('revision-deadline-invalid')
    })

    it('a revision deadline after the date gives revision-deadline-after-date', async () => {
      const timeline = shortTimeline()
      const refusal = await refused({ revisionDeadline: timeline.closed + 1 })
      expect(refusal?.code).to.equal('revision-deadline-after-date')
    })

    it('an omitted ballotDeadline whose 10-day default exceeds the date gives election-date-too-soon', async () => {
      const refusal = await refused({ ballotDeadline: undefined })
      expect(refusal?.code).to.equal('election-date-too-soon')
      expect(refusal?.ballotDeadline).to.equal(NOW + BALLOT_DEADLINE_LEAD_MS)
      expect(BALLOT_DEADLINE_LEAD_MS).to.equal(864_000_000)
    })

    it('an inverted validation / tallyingStarts pair gives timeline-order naming the pair', async () => {
      const timeline = shortTimeline()
      const inverted = { ...timeline, validation: timeline.tallyingStarts - 1 }
      const refusal = await refused({ timeline: inverted })
      expect(refusal?.code).to.equal('timeline-order')
      expect(refusal?.violation).to.deep.equal({ before: 'tallyingStarts', after: 'validation' })
    })
  })

  describe('C3 happy path', () => {
    it('runs the four engine calls in order with digest-parity identities and one signer', async () => {
      const calls: Call[] = []
      const signer = countedSigner()
      const input = shortInput()
      const result = await createElection({
        electionsEngine: fakeElectionsEngine(calls),
        input,
        createSigner: signer.createSigner,
        now: NOW,
      })
      expect(result).to.deep.equal({ ok: true, electionId: `election-${NOW}` })
      expect(signer.createdCount()).to.equal(1)
      expect(calls.map(([method]) => method)).to.deep.equal([
        'buildCreateElection',
        'seedElectionSigning',
        'peekNextTid',
        'seedElectionRevisionSigning',
        'createElection',
      ])

      const [electionFields, seamSign] = calls[1]![1] as [Record<string, unknown>, unknown]
      const [electionId, authorityId, revisionSeam, tid, revSign] = calls[3]![1] as [
        string,
        string,
        { timeline: unknown; revisionTimestamp: number; keyholderThreshold: number },
        number,
        unknown,
      ]
      const [payload, options] = calls[4]![1] as [ElectionInit, Record<string, unknown>]

      expect(seamSign).to.equal(signer.sign)
      expect(revSign).to.equal(signer.sign)
      expect(tid).to.equal(42)
      expect(electionId).to.equal(`election-${NOW}`)
      expect(authorityId).to.equal('authority-1')
      expect(revisionSeam.timeline).to.equal(input.timeline)
      expect(revisionSeam.revisionTimestamp).to.equal(NOW - 1000)
      expect(revisionSeam.keyholderThreshold).to.equal(2)
      expect(options).to.deep.equal({ signingNonce: 'n1', revisionSigningNonce: 'n2' })

      expect(payload.election).to.deep.equal(electionFields)
      expect(payload.election.id).to.equal(`election-${NOW}`)
      expect(payload.election.ballotDeadline).to.equal(input.timeline.votingStarts)
      expect(payload.revision.timeline).to.equal(input.timeline)
      expect(payload.revision.revisionTimestamp).to.equal(NOW - 1000)
      expect(payload.revision.keyholderThreshold).to.equal(2)
      expect(payload.revision.keyholders).to.have.length(2)
      for (const placeholder of payload.revision.keyholders) {
        expect(Object.keys(placeholder).sort()).to.deep.equal([...PLACEHOLDER_KEYS].sort())
      }
      expect(payload.revision.keyholders.map((k) => k.name)).to.deep.equal(['Kay', 'Lee'])
    })
  })

  describe('C4 builder refusal', () => {
    it('a ballotsFinal after the ballot deadline throws from build() before any seam call', async () => {
      const calls: Call[] = []
      const signer = countedSigner()
      const timeline = shortTimeline()
      const err = await rejection(
        createElection({
          electionsEngine: fakeElectionsEngine(calls),
          input: shortInput({ timeline: { ...timeline, ballotsFinal: timeline.votingStarts + 1 } }),
          createSigner: signer.createSigner,
          now: NOW,
        })
      )
      expect(err).to.not.equal(undefined)
      expect((err as { name?: string }).name).to.equal('BuilderValidationError')
      // The builder was taken from the engine, but no seam (and no signing) ran.
      expect(calls.map(([method]) => method)).to.deep.equal(['buildCreateElection'])
    })
  })

  describe('C5 proposeElectionRevision', () => {
    const current = {
      election: {
        id: 'election-cur',
        authorityId: 'authority-1',
        title: 'Current',
        date: NOW + 86_400_000,
        revisionDeadline: NOW + 3_600_000,
        ballotDeadline: NOW + 7_200_000,
        type: ElectionType.official,
      },
      current: { revision: 3 },
    } as unknown as ElectionDetails

    it('adjusts once with revision current + 1 and the ids from current.election, no signer parameter', async () => {
      const calls: Call[] = []
      const timeline = shortTimeline()
      const result = await proposeElectionRevision({
        electionsEngine: fakeElectionsEngine(calls),
        current,
        input: { type: ElectionType.adhoc, keyholders: ['Kay', 'Lee'], threshold: 2, tags: [], instructions: '', timeline },
        now: NOW,
      })
      expect(result).to.deep.equal({ ok: true })
      expect(calls.map(([method]) => method)).to.deep.equal(['adjustElection'])
      const args = calls[0]![1]
      expect(args).to.have.length(1)
      const init = args[0] as ElectionInit
      expect(init.election.id).to.equal('election-cur')
      expect(init.revision.electionId).to.equal('election-cur')
      expect(init.revision.revision).to.equal(4)
      expect(init.election.type).to.equal(ElectionType.adhoc)
      expect(init.election.title).to.equal('Current')
      expect(init.revision.revisionTimestamp).to.equal(NOW - 1000)
      expect(init.revision.timeline).to.equal(timeline)
      expect(init.revision.keyholders).to.have.length(2)
      for (const arg of args) expect(typeof arg).to.not.equal('function')
    })

    it('a timeline-order refusal makes no call', async () => {
      const calls: Call[] = []
      const timeline = shortTimeline()
      const result = await proposeElectionRevision({
        electionsEngine: fakeElectionsEngine(calls),
        current,
        input: {
          type: ElectionType.adhoc,
          keyholders: ['Kay', 'Lee'],
          threshold: 2,
          tags: [],
          instructions: '',
          timeline: { ...timeline, closed: timeline.certificationStarts },
        },
        now: NOW,
      })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.refusal.code).to.equal('timeline-order')
      expect(calls).to.deep.equal([])
    })
  })

  describe('C6 inviteKeyholderSeat', () => {
    function fakeElectionEngine(calls: Call[]) {
      return {
        async getElectionDetails() {
          calls.push(['getElectionDetails', []])
          return { election: { id: 'election-x' } } as unknown as ElectionDetails
        },
        async inviteKeyholder(...args: unknown[]) {
          calls.push(['inviteKeyholder', args])
        },
      }
    }

    it('invites once with a five-key invite (no invitePrivate) and returns a share whose key pair matches', async () => {
      const calls: Call[] = []
      const signer = countedSigner()
      const { electionId, share } = await inviteKeyholderSeat({
        electionEngine: fakeElectionEngine(calls),
        name: 'Kay',
        expiryHours: 24,
        createSigner: signer.createSigner,
        now: NOW,
      })
      expect(electionId).to.equal('election-x')
      expect(calls.map(([method]) => method)).to.deep.equal(['getElectionDetails', 'inviteKeyholder'])
      const [invite, inviteElectionId, sign] = calls[1]![1] as [Record<string, unknown>, string, unknown]
      expect(Object.keys(invite).sort()).to.deep.equal(['expiration', 'inviteKey', 'inviteSignature', 'name', 'type'])
      expect(invite.inviteSignature).to.equal('')
      expect(invite.type).to.equal('k')
      expect(invite.name).to.equal('Kay')
      expect(inviteElectionId).to.equal('election-x')
      expect(sign).to.equal(signer.sign)
      expect(signer.createdCount()).to.equal(1)

      expect(share.invitePrivate).to.match(/^[0-9a-f]{64}$/)
      expect(share.inviteKey).to.equal(bytesToHex(secp256k1.getPublicKey(hexToBytes(share.invitePrivate))))
      expect(share.inviteKey).to.equal(invite.inviteKey)
      expect(share.expiration).to.equal(new Date(NOW + 24 * 3_600_000).toISOString())
      expect(share.expiration).to.equal(invite.expiration)
      expect(share.type).to.equal('k')
      expect(share.name).to.equal('Kay')
    })

    it('a non-preset validity throws RangeError before any key, signer or engine call', async () => {
      const calls: Call[] = []
      const signer = countedSigner()
      const err = await rejection(
        inviteKeyholderSeat({
          electionEngine: fakeElectionEngine(calls),
          name: 'Kay',
          expiryHours: 5,
          createSigner: signer.createSigner,
          now: NOW,
        })
      )
      expect((err as { name?: string }).name).to.equal('RangeError')
      expect(signer.createdCount()).to.equal(0)
      expect(calls).to.deep.equal([])
    })
  })

  describe('C7 ballot', () => {
    it('toProposedBallot takes the draft id, else ballotId, else ballot-<electionId>-<now>', () => {
      const ctx = { ballotId: 'b-persisted', electionId: 'e1', now: NOW }
      expect(toProposedBallot({ id: 'b-draft' }, ctx).id).to.equal('b-draft')
      expect(toProposedBallot({}, ctx).id).to.equal('b-persisted')
      expect(toProposedBallot({}, { electionId: 'e1', now: NOW }).id).to.equal(`ballot-e1-${NOW}`)
    })

    it('toProposedBallot prefers authority over authorityId and fills empty defaults', () => {
      const ballot = toProposedBallot({ authority: 'a-dropdown', authorityId: 'a-stored' }, { electionId: 'e1', now: NOW })
      expect(ballot.authorityId).to.equal('a-dropdown')
      expect(toProposedBallot({ authorityId: 'a-stored' }, { electionId: 'e1', now: NOW }).authorityId).to.equal('a-stored')
      expect(ballot.electionId).to.equal('e1')
      expect(ballot.description).to.equal('')
      expect(ballot.districts).to.deep.equal([])
      expect(ballot.questions).to.deep.equal([])
      expect(toProposedBallot({ electionId: 'e-draft' }, { electionId: 'e1', now: NOW }).electionId).to.equal('e-draft')
    })

    it('proposeBallot calls the engine once with the built ballot and returns it', async () => {
      const calls: Call[] = []
      const engine = {
        async proposeBallot(...args: unknown[]) {
          calls.push(['proposeBallot', args])
        },
      }
      const ballot = await proposeBallot({
        electionEngine: engine,
        draft: { description: 'd', questions: [] },
        ballotId: 'b1',
        electionId: 'e1',
        now: NOW,
      })
      expect(calls).to.have.length(1)
      expect(calls[0]![1]).to.deep.equal([ballot])
      expect(ballot).to.deep.equal({ id: 'b1', electionId: 'e1', authorityId: '', description: 'd', districts: [], questions: [] } as Ballot)
    })

    it('submitBallot passes the identical sign function through and never calls it; the view tolerates undefined', async () => {
      const calls: Call[] = []
      const signer = countedSigner()
      const engine = {
        async submitBallotForConfirmation(...args: unknown[]) {
          calls.push(['submitBallotForConfirmation', args])
        },
        async getBallotConfirmationState(ballotId: string) {
          calls.push(['getBallotConfirmationState', [ballotId]])
          return { locked: true, confirmed: false, canWithdraw: 'yes' as unknown as boolean, ownTaskOpen: true }
        },
      }
      await submitBallot({ electionEngine: engine, ballotId: 'b1', sign: signer.sign })
      expect(calls).to.deep.equal([['submitBallotForConfirmation', ['b1', signer.sign]]])
      expect(signer.digests).to.have.length(0)
      expect(toBallotConfirmationView(undefined)).to.deep.equal({ locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false })
      expect(toBallotConfirmationView(null)).to.deep.equal({ locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false })
      const view = await readBallotConfirmation({ electionEngine: engine, ballotId: 'b1' })
      expect(view).to.deep.equal({ locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: true })
      expect(calls[1]).to.deep.equal(['getBallotConfirmationState', ['b1']])
    })
  })

  describe('C8 tasks', () => {
    const network = { hash: 'h', name: 'n', relays: [] as string[], primaryAuthorityDomainName: 'd' }
    const ballotTask = (ballotId: string): SignatureTask =>
      ({ type: 'signature', network, userId: 'u', signatureType: 'ballot', ballot: { proposed: { id: ballotId }, signers: [] } }) as unknown as SignatureTask
    const electionTask: SignatureTask = { type: 'signature', network, userId: 'u', signatureType: 'election' } as SignatureTask

    function fakeTasksEngine(calls: Call[]) {
      const digest = new Uint8Array([1, 2, 3])
      return {
        digest,
        async getSignatureDigest(...args: unknown[]) {
          calls.push(['getSignatureDigest', args])
          return digest
        },
        async completeSignature(...args: unknown[]) {
          calls.push(['completeSignature', args])
        },
      }
    }

    it('signTask on a ballot task: digest, one signer, the digest signed, completeSignature with the re-invocable signer', async () => {
      const calls: Call[] = []
      const engine = fakeTasksEngine(calls)
      const signer = countedSigner()
      const task = ballotTask('b1')
      await signTask({ tasksEngine: engine, task, createSigner: signer.createSigner })
      expect(calls.map(([method]) => method)).to.deep.equal(['getSignatureDigest', 'completeSignature'])
      expect(calls[0]![1]).to.deep.equal([task])
      expect(signer.createdCount()).to.equal(1)
      expect(signer.digests).to.deep.equal([engine.digest])
      const [completedTask, result] = calls[1]![1] as [SignatureTask, { isAccepted: boolean; signature: Signature; sign?: unknown }]
      expect(completedTask).to.equal(task)
      expect(result.isAccepted).to.equal(true)
      expect(result.signature).to.deep.equal({ signature: 'sig', signerKey: 'key', signerUserId: 'user-1' })
      expect(result.sign).to.equal(signer.sign)
    })

    it('signTask on an election task passes sign: undefined', async () => {
      const calls: Call[] = []
      const engine = fakeTasksEngine(calls)
      const signer = countedSigner()
      await signTask({ tasksEngine: engine, task: electionTask, createSigner: signer.createSigner })
      const [, result] = calls[1]![1] as [SignatureTask, { isAccepted: boolean; sign?: unknown }]
      expect(result.isAccepted).to.equal(true)
      expect(result.sign).to.equal(undefined)
      expect(signer.createdCount()).to.equal(1)
    })

    it('rejectTask never calls a signer and sends the empty signature', async () => {
      const calls: Call[] = []
      const engine = fakeTasksEngine(calls)
      const task = ballotTask('b1')
      await rejectTask({ tasksEngine: engine, task })
      expect(calls).to.deep.equal([
        ['completeSignature', [task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } }]],
      ])
      expect(rejectTask.length).to.equal(1)
    })

    it('findBallotSignatureTask picks the right one of three and returns undefined on a miss', () => {
      const tasks = [electionTask, ballotTask('b1'), ballotTask('b2')]
      expect(findBallotSignatureTask(tasks, 'b2')).to.equal(tasks[2])
      expect(findBallotSignatureTask(tasks, 'b1')).to.equal(tasks[1])
      expect(findBallotSignatureTask(tasks, 'b3')).to.equal(undefined)
      expect(findBallotSignatureTask([], 'b1')).to.equal(undefined)
    })
  })

  describe('C9 no-logging self-test', () => {
    const FORBIDDEN = /console\.|instanceof|vtDebug/

    it('none of the seven shared files logs, uses instanceof or vtDebug; the check itself can fail', () => {
      const hits: string[] = []
      for (const file of PLAN_FILES) {
        const text = readFileSync(join(SRC_AUTHORITY, file), 'utf8')
        expect(text.length).to.be.greaterThan(0)
        if (FORBIDDEN.test(text)) hits.push(file)
      }
      expect(hits).to.deep.equal([])
      expect(FORBIDDEN.test("console.warn('x')")).to.equal(true)
      expect(FORBIDDEN.test('a instanceof B')).to.equal(true)
    })
  })
})
