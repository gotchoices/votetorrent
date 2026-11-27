// ballot-confirmation-state.spec.ts — gap8/WR-03 + gap6/WR-02 (62-111)
//
// getBallotConfirmationState tells the caller whether THIS officer may withdraw (canWithdraw)
// and whether THIS officer has an open confirmation task for the ballot (ownTaskOpen), derived
// from the same AdminSigning.UserId the withdraw refusal uses.

import { expect } from 'chai'
import { hexToBytes, bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection, seedProposedBallot, testKeyPairFor } from './fixtures/test-context.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'

const networkRef = { hash: 'test-cstate-hash', name: 'Test Network', relays: [] as string[], primaryAuthorityDomainName: 'test.example' }

async function rejection (p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as Error).message }
  throw new Error('expected a rejection')
}

describe('getBallotConfirmationState canWithdraw / ownTaskOpen (gap8/WR-03, gap6/WR-02)', function () {
  this.timeout(60_000)

  it('C-1: threshold 1, the submitter may withdraw and owns the open task', async () => {
    const net = await createTestNetwork()
    const elec = await addTestElection(await addTestAuthority(net))
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true,
    })
  })

  it('C-2: threshold 2, the initiator may withdraw but has no task; a sibling has a task but may not withdraw', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'cs-c2')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    expect(await fx.elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: false,
    })
    const row = await fx.elec.ctx.db.prepare('select Id from Election where AuthorityId = :a limit 1').get({ a: fx.authorityId })
    const sibling = new ElectionEngine(
      { id: row!.Id as string, authorityId: fx.authorityId },
      { db: fx.elec.ctx.db, user: fx.holders[1]!.user }
    )
    expect(await sibling.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: true,
    })
    expect(await rejection(sibling.withdrawBallotConfirmation(ballotId))).to.include('Only the officer who submitted')
  })

  it('C-3: an unlocked ballot and a confirmed ballot (siblings may stay open) offer neither flag', async () => {
    const net = await createTestNetwork()
    const elec = await addTestElection(await addTestAuthority(net))
    const { ballotId } = await seedProposedBallot(elec)
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false,
    })
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const engine = new SignatureTasksEngine(networkRef, elec.ctx)
    const task = (await engine.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    const digest = await engine.getSignatureDigest(task)
    const priv = hexToBytes(testKeyPairFor(elec.user.id).privateHex)
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: bytesToHex(secp.getPublicKey(priv)), signature: bytesToHex(secp.sign(digest, priv) as unknown as Uint8Array) },
    })
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false,
    })
  })

  it('C-4: a reached-but-unfinalized session is not withdrawable even by its initiator (flag and refusal agree)', async () => {
    const net = await createTestNetwork()
    const elec = await addTestElection(await addTestAuthority(net))
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const proto = SignatureTasksEngine.prototype as unknown as { finalizeBallot: (...a: unknown[]) => Promise<void> }
    const original = proto.finalizeBallot
    proto.finalizeBallot = async () => { throw new Error('forced finalize fault') }
    try {
      const engine = new SignatureTasksEngine(networkRef, elec.ctx)
      const task = (await engine.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
      const digest = await engine.getSignatureDigest(task)
      const priv = hexToBytes(testKeyPairFor(elec.user.id).privateHex)
      const msg = await rejection(engine.completeSignature(task, {
        isAccepted: true,
        signature: { signerUserId: elec.user.id, signerKey: bytesToHex(secp.getPublicKey(priv)), signature: bytesToHex(secp.sign(digest, priv) as unknown as Uint8Array) },
      }))
      expect(msg).to.include('forced finalize fault')
    } finally {
      proto.finalizeBallot = original
    }
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({
      locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: true,
    })
    expect(await rejection(elec.electionEngine.withdrawBallotConfirmation(ballotId))).to.include('can no longer be withdrawn')
  })
})
