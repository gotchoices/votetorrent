// score-range-step.spec.ts — Phase 62 Plan 122 Task 2 (O-07)
//
// ScoreRange's `step` used to be dropped by the two-value pg range form. The stored string is now
// `{min, max}` when step is 1 (byte-identical to every pre-existing row, so a peer on an older build
// still reads it) and `{min, max, step}` otherwise. OptionRange never carries a step.

import { expect } from 'chai'
import { hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { parsePgRange, parseScoreRange } from '../src/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
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

const scoreQuestion = (scoreRange?: Question['scoreRange']): Question => ({
  code: 'SCO1',
  title: 'Score it',
  instructions: 'Rate.',
  type: 'score',
  options: [{ code: 'X', title: 'Proposal' }],
  ...(scoreRange !== undefined ? { scoreRange } : {}),
})

async function rawScoreRange (elec: Awaited<ReturnType<typeof setupElection>>, ballotId: string): Promise<unknown> {
  const row = await elec.ctx.db
    .prepare('select ScoreRange from Question where BallotId = :b and Code = :c')
    .get({ b: ballotId, c: 'SCO1' })
  return row?.ScoreRange
}

describe('O-07 - ScoreRange step survives propose -> submit -> finalize -> getBallotDetails', () => {
  it('S1/S5: step 2 round-trips, stored as the three-value form, and the finalized row passes Question.MutationValid', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'step-s1', [scoreQuestion({ min: 0, max: 10, step: 2 })])
    const details = await elec.electionEngine.getBallotDetails('step-s1')
    expect(details.ballot.questions.find(x => x.code === 'SCO1')!.scoreRange).to.deep.equal({ min: 0, max: 10, step: 2 })
    expect(await rawScoreRange(elec, 'step-s1')).to.equal('{0, 10, 2}')
  })

  it('S2: step 1 and an absent step both store the two-value string and read back with step 1', async () => {
    const elec = await setupElection()
    await proposeAndConfirm(elec, 'step-s2', [scoreQuestion({ min: 1, max: 5, step: 1 })])
    expect(await rawScoreRange(elec, 'step-s2')).to.equal('{1, 5}')
    const d1 = await elec.electionEngine.getBallotDetails('step-s2')
    expect(d1.ballot.questions.find(x => x.code === 'SCO1')!.scoreRange).to.deep.equal({ min: 1, max: 5, step: 1 })

    const elec2 = await setupElection()
    await proposeAndConfirm(elec2, 'step-s2b', [scoreQuestion({ min: 1, max: 5 } as unknown as Question['scoreRange'])])
    expect(await rawScoreRange(elec2, 'step-s2b')).to.equal('{1, 5}')
    const d2 = await elec2.electionEngine.getBallotDetails('step-s2b')
    expect(d2.ballot.questions.find(x => x.code === 'SCO1')!.scoreRange).to.deep.equal({ min: 1, max: 5, step: 1 })
  })

  it('S3: parseScoreRange reads both pg forms and the legacy JSON, and refuses malformed steps', () => {
    expect(parseScoreRange('{0, 10, 2}', 'f')).to.deep.equal({ min: 0, max: 10, step: 2 })
    expect(parseScoreRange('{0, 10}', 'f')).to.deep.equal({ min: 0, max: 10, step: 1 })
    expect(parseScoreRange('{"min":0,"max":10,"step":2}', 'f')).to.deep.equal({ min: 0, max: 10, step: 2 })
    expect(parseScoreRange('{"min":0,"max":10}', 'f')).to.deep.equal({ min: 0, max: 10, step: 1 })
    expect(parseScoreRange(null, 'f')).to.equal(undefined)
    for (const bad of ['{0, 10, 0}', '{0, 10, -1}', '{0, 10, 2.5}', '{0, 10, 2, 4}', '{"min":0,"max":10,"step":0}', 'garbage']) {
      expect(() => parseScoreRange(bad, 'Question.ScoreRange'), bad).to.throw(/Question\.ScoreRange/)
    }
  })

  it('S4: OptionRange still refuses a three-value form', () => {
    expect(() => parsePgRange('{1, 2, 3}', 'Question.OptionRange')).to.throw(/Question\.OptionRange/)
  })
})
