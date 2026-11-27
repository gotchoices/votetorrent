// ballot-range-roundtrip.spec.ts — a confirmed ballot's question ranges read back.
//
// A ballot proposed, submitted and finalized at ceb threshold 1 through the real
// engine must open with ElectionEngine.getBallotDetails. finalizeBallot used to
// write Question.OptionRange / ScoreRange as JSON while the only reader
// (parsePgRange) accepts the pg range form, so every confirmed ballot threw on
// reopen. Also pins the tolerant legacy-row read and addQuestion's ScoreRange write.

import { expect } from 'chai'
import { hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { parsePgRange } from '../src/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedBallot,
  seedQuestion,
  testKeyPairFor,
} from './fixtures/test-context.js'
import type { BallotSignatureTask, Question } from '@votetorrent/vote-core'

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  return addTestElection(auth)
}

function makeNetworkRef () {
  return {
    hash: 'test-ballot-range-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function electionIdOf (elec: Awaited<ReturnType<typeof setupElection>>): Promise<string> {
  const row = await elec.ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId: elec.authority.id })
  if (!row) throw new Error('Election not found')
  return row.Id as string
}

/** Propose -> submit -> sign -> finalize at threshold 1. */
async function proposeAndConfirm (
  elec: Awaited<ReturnType<typeof setupElection>>,
  ballotId: string,
  questions: Question[]
): Promise<void> {
  await elec.electionEngine.proposeBallot({
    id: ballotId,
    electionId: await electionIdOf(elec),
    authorityId: elec.authority.id,
    description: 'Range round trip',
    districts: [],
    questions,
  })
  await elec.electionEngine.submitBallotForConfirmation(ballotId)

  const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find(
    t => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  ) as BallotSignatureTask | undefined
  if (!task) throw new Error(`no pending ballot task for ${ballotId}`)

  const digest = await engine.getSignatureDigest(task)
  const privKey = hexToBytes(testKeyPairFor(elec.user.id).privateHex)
  const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
  await engine.completeSignature(task, {
    isAccepted: true,
    signature: {
      signerUserId: elec.user.id,
      signerKey: bytesToHex(secp.getPublicKey(privKey)),
      signature: bytesToHex(sigBytes),
    },
  })
}

const selectQuestion = (extra: Partial<Question> = {}): Question => ({
  code: 'SEL1',
  title: 'Pick up to two',
  instructions: 'Choose.',
  type: 'select',
  options: [
    { code: 'A', title: 'Alice' },
    { code: 'B', title: 'Bob' },
  ],
  optionRange: { min: 1, max: 2 },
  ...extra,
})

const scoreQuestion = (): Question => ({
  code: 'SCO1',
  title: 'Score it',
  instructions: 'Rate.',
  type: 'score',
  options: [{ code: 'X', title: 'Proposal' }],
  scoreRange: { min: 0, max: 10, step: 1 },
})

describe('confirmed ballot ranges round-trip through getBallotDetails', () => {
  it('R1: select question optionRange deep-equals the proposed range', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'range-r1', [selectQuestion()])
    const details = await elec.electionEngine.getBallotDetails('range-r1')
    const q = details.ballot.questions.find(x => x.code === 'SEL1')!
    expect(q.optionRange).to.deep.equal({ min: 1, max: 2 })
  })

  it('R2: score question scoreRange returns min and max; select range intact', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'range-r2', [selectQuestion(), scoreQuestion()])
    const details = await elec.electionEngine.getBallotDetails('range-r2')
    const sel = details.ballot.questions.find(x => x.code === 'SEL1')!
    const sco = details.ballot.questions.find(x => x.code === 'SCO1')!
    expect(sel.optionRange).to.deep.equal({ min: 1, max: 2 })
    expect(sco.scoreRange?.min).to.equal(0)
    expect(sco.scoreRange?.max).to.equal(10)
  })

  it('R3: raw Question.OptionRange / ScoreRange are stored in pg form', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'range-r3', [selectQuestion(), scoreQuestion()])
    const sel = await elec.ctx.db
      .prepare('select OptionRange from Question where BallotId = :b and Code = :c')
      .get({ b: 'range-r3', c: 'SEL1' })
    const sco = await elec.ctx.db
      .prepare('select ScoreRange from Question where BallotId = :b and Code = :c')
      .get({ b: 'range-r3', c: 'SCO1' })
    expect(sel?.OptionRange).to.equal('{1, 2}')
    expect(sco?.ScoreRange).to.equal('{0, 10}')
  })

  it('R4: a question with no optionRange finalizes to the default {1, 1}', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'range-r4', [selectQuestion({ optionRange: undefined })])
    const details = await elec.electionEngine.getBallotDetails('range-r4')
    const q = details.ballot.questions.find(x => x.code === 'SEL1')!
    expect(q.optionRange).to.deep.equal({ min: 1, max: 1 })
  })

  it('R5: addQuestion stores ScoreRange in pg form', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedBallot(elec, 'range-r5')
    const engine = new ElectionEngine(
      { id: 'election-1', authorityId: elec.authority.id },
      elec.ctx
    )
    await engine.addQuestion(ballotId, {
      code: 'S5',
      title: 'Score',
      instructions: 'Rate',
      options: [],
      type: 'score',
      scoreRange: { min: 1, max: 5, step: 1 },
    })
    const row = await elec.ctx.db
      .prepare('select ScoreRange from ProposedQuestion where BallotId = :b and Code = :c')
      .get({ b: ballotId, c: 'S5' })
    expect(row?.ScoreRange).to.equal('{1, 5}')
  })

  it('L1: a legacy confirmed row holding JSON OptionRange still opens', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedBallot(elec, 'range-l1')
    await seedQuestion(elec, ballotId, {
      code: 'LEG1',
      title: 'Legacy',
      instructions: 'x',
      type: 'select',
      optionRange: '{"min":1,"max":1}',
    })
    const details = await elec.electionEngine.getBallotDetails(ballotId)
    const q = details.ballot.questions.find(x => x.code === 'LEG1')!
    expect(q.optionRange).to.deep.equal({ min: 1, max: 1 })
  })
})

describe('parsePgRange', () => {
  it('U1: reads the pg form, the legacy JSON form, and null', () => {
    expect(parsePgRange('{"min":1,"max":1}', 'f')).to.deep.equal({ min: 1, max: 1 })
    expect(parsePgRange('{1, 3}', 'f')).to.deep.equal({ min: 1, max: 3 })
    expect(parsePgRange(null, 'f')).to.equal(undefined)
    expect(parsePgRange(undefined, 'f')).to.equal(undefined)
  })

  it('U2: still throws on garbage', () => {
    for (const bad of ['{"min":"a","max":1}', '{"min":1}', '[1,2]', '{1.5, 2}', 'garbage']) {
      expect(() => parsePgRange(bad, 'f'), bad).to.throw(/f has invalid range format/)
    }
  })
})
