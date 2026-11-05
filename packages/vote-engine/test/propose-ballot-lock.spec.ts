// propose-ballot-lock.spec.ts — CR-03 engine backstop (62-59)
//
// proposeBallot is an upsert by id. Once a ballot is out for confirmation (open
// ballot signature Task) or confirmed (finalized Ballot row) the engine itself must
// refuse an overwrite, not only the UI.

import { expect } from 'chai'
import { hexToBytes } from '@noble/curves/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedProposedBallot,
  testKeyPairFor,
} from './fixtures/test-context.js'
import type { Ballot, BallotSignatureTask } from '@votetorrent/vote-core'

function registeredPrivKey (userId: string): Uint8Array {
  return hexToBytes(testKeyPairFor(userId).privateHex)
}

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  return addTestElection(auth)
}

function makeNetworkRef () {
  return {
    hash: 'test-propose-lock-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function getBallotTask (engine: SignatureTasksEngine, ballotId: string): Promise<BallotSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    t => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  ) as BallotSignatureTask | undefined
  if (!found) throw new Error(`no pending BallotSignatureTask for ${ballotId}`)
  return found
}

type Elec = Awaited<ReturnType<typeof setupElection>>

async function readRow (elec: Elec, ballotId: string) {
  const row = await elec.ctx.db
    .prepare('select Id, ElectionId, AuthorityId, Description, Districts, Questions from ProposedBallot where Id = :id')
    .get({ id: ballotId })
  return row as Record<string, unknown>
}

/** Re-proposal of the seeded ballot (same id) with a changed description. */
async function edited (elec: Elec, ballotId: string, description: string): Promise<Ballot> {
  const row = await readRow(elec, ballotId)
  return {
    id: ballotId,
    electionId: row.ElectionId as string,
    authorityId: row.AuthorityId as string,
    description,
    districts: JSON.parse((row.Districts as string) ?? '[]'),
    questions: row.Questions ? JSON.parse(row.Questions as string) : [],
  }
}

async function expectRefusal (p: Promise<unknown>, re: RegExp) {
  let thrown: unknown
  try { await p } catch (e) { thrown = e }
  expect(thrown, 'proposeBallot must refuse').to.be.instanceOf(Error)
  expect((thrown as Error).message).to.match(re)
}

describe('proposeBallot edit lock (CR-03 engine backstop)', () => {
  it('overwrites an unlocked ballot (positive control)', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.proposeBallot(await edited(elec, ballotId, 'Changed while unlocked'))
    expect((await readRow(elec, ballotId)).Description).to.equal('Changed while unlocked')
  })

  it('still inserts a brand-new id', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec, 'lock-first')
    await elec.electionEngine.proposeBallot(await edited(elec, ballotId, 'x').then(b => ({ ...b, id: 'lock-second' })))
    expect((await readRow(elec, 'lock-second')).Id).to.equal('lock-second')
  })

  it('refuses a ballot that is out for confirmation and leaves the row unchanged', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const before = await readRow(elec, ballotId)
    await expectRefusal(
      elec.electionEngine.proposeBallot(await edited(elec, ballotId, 'Sneaky overwrite')),
      /out for confirmation/
    )
    expect(await readRow(elec, ballotId)).to.deep.equal(before)
  })

  it('accepts a proposal again after the confirmation is withdrawn (positive control)', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    await elec.electionEngine.withdrawBallotConfirmation(ballotId)
    await elec.electionEngine.proposeBallot(await edited(elec, ballotId, 'After withdraw'))
    expect((await readRow(elec, ballotId)).Description).to.equal('After withdraw')
  })

  it('refuses a confirmed ballot and leaves the row unchanged', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')
    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)
    const digest = await engine.getSignatureDigest(task)
    const privKey = registeredPrivKey(elec.user.id)
    const sigHex = bytesToHex(secp.sign(digest, privKey) as unknown as Uint8Array)
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: bytesToHex(secp.getPublicKey(privKey)), signature: sigHex },
    })
    const finalized = await elec.ctx.db.prepare('select Id from Ballot where Id = :id').get({ id: ballotId })
    expect(finalized, 'precondition: Ballot row finalized').to.not.be.undefined

    const before = await readRow(elec, ballotId)
    await expectRefusal(
      elec.electionEngine.proposeBallot(await edited(elec, ballotId, 'Post-confirm drift')),
      /already confirmed/
    )
    expect(await readRow(elec, ballotId)).to.deep.equal(before)
  })
})
