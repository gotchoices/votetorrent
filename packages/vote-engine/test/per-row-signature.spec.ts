// per-row-signature.spec.ts — Phase 39, Plan 39-03 (DEBT-11, D-06)
//
// Mirrors invite-r03-signature-verification.spec.ts's positive+tamper discipline.
//
// Proves that the promoted per-row Question/Option `AdminSigning('ceb')` rows
// produced by `SignatureTasksEngine.finalizeBallot` carry a REAL,
// UDF-verifiable secp256k1 signature (IsPlaceholderSignature = 0) when the
// caller supplies the new optional `SignatureResult.sign` reusable per-digest
// signing callback — and that a tampered signature is rejected by the schema's
// own `AdminSigning.SignatureValid` CHECK (negative control), not silently
// accepted.
//
// Framework: mocha + chai (vote-engine convention — register-ts-node.mjs runner).

import { expect } from 'chai'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { digestToBytes } from '../src/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedProposedBallot,
  makeTestSignCallback,
} from './fixtures/test-context.js'
import type { BallotSignatureTask, SignatureTask } from '@votetorrent/vote-core'

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  return elec
}

function makeNetworkRef () {
  return {
    hash: 'test-per-row-signature-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

// Same task-resolution helper as ballot-confirm.spec.ts (D-05/CR-01: completeSignature
// and getSignatureDigest scope by the ballot id carried on the BallotSignatureTask).
async function getBallotTask (
  engine: SignatureTasksEngine,
  ballotId: string
): Promise<BallotSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    (t: SignatureTask) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  ) as BallotSignatureTask | undefined
  if (!found) throw new Error(`getBallotTask: no BallotSignatureTask found for ballotId=${ballotId}`)
  return found
}

describe('39-03 DEBT-11: per-row Question/Option AdminSigning real-signature (D-06)', function () {
  this.timeout(30_000)

  describe('positive control — real per-row signature, real UDF-verifiable', () => {
    it('promoted Question/Option AdminSigning(\'ceb\') rows carry IsPlaceholderSignature=0 and a SignatureValid-passing signature', async () => {
      const elec = await setupElection()
      const { ballotId } = await seedProposedBallot(elec)
      await elec.electionEngine.submitBallotForConfirmation(ballotId)

      const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
      const task = await getBallotTask(engine, ballotId)
      const digest = await engine.getSignatureDigest(task)

      // Capture the ballot HEADER signing nonce before completeSignature runs — the header's
      // own AdminSigning('ceb') row is a SEPARATE, already-documented placeholder carve-out
      // (election-engine.ts submitBallotForConfirmation's initially-unsigned header row, per
      // the schema's own SignatureValid comment) — out of THIS plan's per-row Q/O scope, so it
      // must be excluded from the per-row assertions below, not conflated with them.
      const headerRow = await elec.ctx.db
        .prepare(
          `select Task.SigningNonce as nonce from Task
             join BallotSignatureTaskExtension E on E.TaskId = Task.Id
             where E.BallotId = :ballotId and Task.IsCompleted = 0`
        )
        .get({ ballotId })
      const headerNonce = headerRow!.nonce as string

      // Reusable per-digest signing callback (the SAME contract the app-layer
      // device-signer closure satisfies — see device-signer.ts / SignatureTaskScreen.tsx).
      const signCallback = makeTestSignCallback(elec.user)
      const headerSignature = await signCallback(digest)

      await engine.completeSignature(task, {
        isAccepted: true,
        signature: headerSignature,
        sign: signCallback,
      })

      // Promoted per-question/option rows only (excludes the header row above).
      const qRows: Array<{ Nonce: string; Signature: string; Valid: unknown }> = []
      for await (const row of elec.ctx.db.eval(
        `select AS_.Nonce as Nonce, AS_.Signature as Signature,
                SignatureValid(AS_.Digest, AS_.Signature, AS_.SignerKey) as Valid
           from AdminSigning AS_
           join OfficerSignature OS on OS.SigningNonce = AS_.Nonce
           where AS_.Scope = 'ceb'
             and AS_.AuthorityId = :authorityId
             and AS_.Nonce <> :headerNonce
           order by AS_.Nonce`,
        { authorityId: elec.authority.id, headerNonce }
      )) {
        qRows.push({
          Nonce: row.Nonce as string,
          Signature: row.Signature as string,
          Valid: row.Valid,
        })
      }

      expect(qRows.length, 'expected >=3 promoted per-row (ceb) AdminSigning rows (1 question + 2 options)').to.be.greaterThanOrEqual(3)

      for (const row of qRows) {
        expect(row.Signature, 'per-row Signature must not be the legacy all-zero placeholder').to.not.equal('0'.repeat(128))
        expect(row.Valid, `SignatureValid() must accept the stored (Digest, Signature, SignerKey) tuple for nonce=${row.Nonce}`).to.equal(true)
      }

      // IsPlaceholderSignature is a context-only CHECK input, not a persisted column — assert
      // indirectly: SignatureValid() only evaluates the real UDF branch (not the
      // `IsPlaceholderSignature = true` short-circuit) when the row was inserted with
      // IsPlaceholderSignature = false, and the UDF branch PASSING on a non-zero signature
      // (asserted above) is only possible on the real-signing path — the placeholder path
      // always binds '0'.repeat(128), which SignatureValid() would reject.
    })
  })

  describe('negative control — a tampered per-row signature is rejected by AdminSigning.SignatureValid', () => {
    it('a per-row AdminSigning insert with a tampered signature (IsPlaceholderSignature=false) throws', async () => {
      const elec = await setupElection()
      const { ballotId } = await seedProposedBallot(elec)
      await elec.electionEngine.submitBallotForConfirmation(ballotId)

      const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
      const task = await getBallotTask(engine, ballotId)
      const digest = await engine.getSignatureDigest(task)
      const signCallback = makeTestSignCallback(elec.user)
      const headerSignature = await signCallback(digest)

      // Finalize for real first (proves the real path still works in this test file too).
      await engine.completeSignature(task, {
        isAccepted: true,
        signature: headerSignature,
        sign: signCallback,
      })

      // Now attempt an independent per-row-shaped AdminSigning insert mirroring finalizeBallot's
      // own Question insert, but with a REAL digest + a TAMPERED (flipped-byte) signature and
      // IsPlaceholderSignature = false — the schema CHECK must reject it.
      const adminRow = await elec.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: elec.authority.id })
      const adminEffectiveAt = adminRow!.EffectiveAt as string | number

      const digestRow = await elec.ctx.db
        .prepare(
          "select Digest(1, :ballotId, 'TAMPER-Q', 'Tamper Title', 'Tamper Instructions', null, 'select', '{1, 1}', null, null, null, 1) as d"
        )
        .get({ ballotId })
      const realDigest = digestRow!.d as string

      const genuineSig = await signCallback(digestToBytes(realDigest))
      const tamperedSignature = genuineSig.signature.replace(/^./, genuineSig.signature[0] === 'a' ? 'b' : 'a')

      let caught: unknown
      try {
        await elec.ctx.db.exec(
          `insert into AdminSigning (
            Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
          )
          with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
          values (
            :nonce, :authorityId, :adminEffectiveAt, 'ceb',
            Digest(1, :ballotId, 'TAMPER-Q', 'Tamper Title', 'Tamper Instructions', null, 'select', '{1, 1}', null, null, null, 1),
            :userId, :signerKey, :signature
          )`,
          {
            nonce: 'tamper-nonce-1',
            authorityId: elec.authority.id,
            adminEffectiveAt,
            ballotId,
            userId: elec.user.id,
            signerKey: genuineSig.signerKey,
            signature: tamperedSignature,
            now: new Date().toISOString(),
          }
        )
      } catch (err) {
        caught = err
      }

      expect(caught, 'a tampered per-row signature must be rejected by AdminSigning.SignatureValid').to.not.equal(undefined)
      expect(caught).to.be.instanceOf(Error)
      expect((caught as Error).message).to.match(/SignatureValid/)
    })
  })
})
