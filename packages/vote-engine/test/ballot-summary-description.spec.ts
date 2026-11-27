// BallotSummary.description — the Election Details ballot row names the ballot,
// never the authority's raw id (UAT gap 4 item 4).
import { expect } from 'chai'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { MockElectionEngine } from '../src/election/mock-election-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedProposedBallot,
  testKeyPairFor,
} from './fixtures/test-context.js'
import type { BallotSignatureTask } from '@votetorrent/vote-core'

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  return addTestElection(auth)
}

describe('getBallots carries the ballot description', () => {
  it('B1: a proposed ballot entry has the proposed description', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    const entry = (await elec.electionEngine.getBallots()).find(s => s.id === ballotId)
    expect(entry?.description).to.equal('Test Proposed Ballot')
  })

  it('B2: after finalize the single entry carries the finalized Ballot.Description', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const engine = new SignatureTasksEngine({
      hash: 'b65', name: 'Test Network', relays: [] as string[], primaryAuthorityDomainName: 'test.example',
    }, elec.ctx)
    const task = (await engine.getRequestedSignatures(true)).find(
      t => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
    ) as BallotSignatureTask
    const digest = await engine.getSignatureDigest(task)
    const priv = hexToBytes(testKeyPairFor(elec.user.id).privateHex)
    const sig = secp.sign(digest, priv) as unknown as Uint8Array
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: bytesToHex(secp.getPublicKey(priv)), signature: bytesToHex(sig) },
    })
    const entries = (await elec.electionEngine.getBallots()).filter(s => s.id === ballotId)
    expect(entries).to.have.length(1)
    const row = await elec.ctx.db.prepare('select Description from Ballot where Id = :id').get({ id: ballotId })
    expect(entries[0].description).to.equal(row?.['Description'])
    expect(entries[0].description).to.equal('Test Proposed Ballot')
  })

  it('B3: MockElectionEngine.getBallots carries the stored description', async () => {
    const mock = new MockElectionEngine()
    await mock.proposeBallot({
      id: 'mb1', electionId: 'e1', authorityId: 'a1', description: 'Mock ballot', districts: [], questions: [],
    } as never)
    const entry = (await mock.getBallots()).find(s => s.id === 'mb1')
    expect(entry?.description).to.equal('Mock ballot')
  })
})
