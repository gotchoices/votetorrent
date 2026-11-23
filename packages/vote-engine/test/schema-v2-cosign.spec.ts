/**
 * schema-v2-cosign.spec.ts — App schema version 2: the rows co-signing above a 'vrg' threshold of 1
 * writes, checked against the schema alone (no engine path).
 *
 *  - AuthorityIntakePolicy: a PROPOSAL row (Revision -N proposes revision N) carries the signed 'vrg'
 *    session it was proposed under and the Tid its digest binds; the effective row N is written later
 *    under that session once it has reached its threshold. The shipped reader never takes a proposal.
 *  - Task: an 'intake-policy' signature Task's extension is the proposal row (by SigningNonce); an
 *    'association' Task's extension is an AssociationSignatureTaskExtension row bound to the session
 *    digest of the decision.
 *
 * Every case here fails on schema version 1 (no such columns, codes or table).
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import type { Scope, Signature } from '@votetorrent/vote-core'
import { VOTETORRENT_SCHEMA_VERSION } from '../src/database/schema-version.js'
import { readIntakePolicyFrom } from '../src/intake/policy.js'
import { intakeQueryPortFromDb } from '../src/intake/query-port.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { AssociationEngine } from '../src/association/association-engine.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

const POLICY_DIGEST = "select Digest(:tid, 'AuthorityIntakePolicy', :rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt) as d"

async function expectRefused (p: Promise<unknown>, label: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught, label).to.be.instanceOf(Error)
}

async function count (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params as any)
  return Number(row?.n ?? 0)
}

interface Proposal { nonce: string, tid: number, revision: number, url: string | null, mode: string, setAt: string }

/** The initiator's signed 'vrg' session over the EFFECTIVE row's digest (threshold 2: it does not reach). */
async function signProposal (fx: ThresholdAuthorityFixture, revision: number, url: string | null, mode: string): Promise<Proposal> {
  const db = fx.elec.ctx.db
  const tid = await allocateTid(db, 'registration-request')
  const setAt = new Date().toISOString()
  const nonce = await seedSignedMutation(
    { db, user: fx.holders[0]!.user }, fx.authorityId, 'vrg' as Scope, tid, POLICY_DIGEST,
    { tid, rowAuthorityId: fx.authorityId, revision, restBridgeUrl: url, reassociationMode: mode, setAt }, fx.holders[0]!.sign
  )
  return { nonce, tid, revision, url, mode, setAt }
}

function insertProposal (db: Database, authorityId: string, p: Proposal, overrides: Partial<{ revision: number, url: string | null, nonce: string | null, tid: number | null }> = {}) {
  return db.exec(
    `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt, SigningNonce, SigningTid)
     with context SigningNonce = null, Tid = null
     values (:authorityId, :revision, :url, :mode, :setAt, :nonce, :tid)`,
    {
      authorityId,
      revision: overrides.revision ?? -p.revision,
      url: 'url' in overrides ? overrides.url : p.url,
      mode: p.mode,
      setAt: p.setAt,
      nonce: 'nonce' in overrides ? overrides.nonce : p.nonce,
      tid: 'tid' in overrides ? overrides.tid : p.tid
    } as any
  )
}

function insertTask (db: Database, userId: string, signatureType: string, nonce: string) {
  const id = crypto.randomUUID()
  return {
    id,
    run: () => db.exec(
      `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
       with context IsMutationValid = true, Tid = 1
       values (:id, :userId, 'signature', :signatureType, :nonce, 0)`,
      { id, userId, signatureType, nonce } as any
    )
  }
}

describe('App schema version 2: co-signing rows', function () {
  this.timeout(60_000)

  let fx: ThresholdAuthorityFixture
  let db: Database

  beforeEach(async () => {
    fx = await createThresholdAuthority()
    db = fx.elec.ctx.db
  })

  it('the shipped schema declares version 2', () => {
    expect(VOTETORRENT_SCHEMA_VERSION).to.equal(2)
  })

  describe('AuthorityIntakePolicy proposals', () => {
    it('a proposal signed by a vrg officer is accepted, and the reader still reports the default policy', async () => {
      const p = await signProposal(fx, 1, 'https://bridge.example', 'automatic')
      await insertProposal(db, fx.authorityId, p)
      const view = await readIntakePolicyFrom(intakeQueryPortFromDb(db), fx.authorityId)
      expect(view.isDefault).to.equal(true)
      expect(view.revision).to.equal(0)
      expect(view.restBridgeUrl).to.equal(null)
    })

    it('a proposal whose values differ from the signed digest is refused', async () => {
      const p = await signProposal(fx, 1, 'https://bridge.example', 'automatic')
      await expectRefused(insertProposal(db, fx.authorityId, p, { url: 'https://other.example' }), 'tampered URL')
      await expectRefused(insertProposal(db, fx.authorityId, p, { revision: -2 }), 'different target revision')
      await expectRefused(insertProposal(db, fx.authorityId, p, { tid: p.tid + 1 }), 'different Tid')
    })

    it('a proposal with no session, or a session that is not vrg-signed for this row, is refused', async () => {
      const p = await signProposal(fx, 1, null, 'manual')
      await expectRefused(insertProposal(db, fx.authorityId, p, { nonce: crypto.randomUUID() }), 'unknown session')
      await expectRefused(insertProposal(db, fx.authorityId, p, { nonce: null }), 'no session')
    })

    it('a positive revision may not carry proposal columns, and Revision 0 is never valid', async () => {
      const p = await signProposal(fx, 1, null, 'manual')
      await expectRefused(insertProposal(db, fx.authorityId, p, { revision: 1 }), 'positive revision with SigningNonce')
      await expectRefused(insertProposal(db, fx.authorityId, p, { revision: 0 }), 'revision 0')
    })

    it('the effective row needs the session to reach its threshold, then carries the proposal values', async () => {
      const p = await signProposal(fx, 1, 'https://bridge.example', 'automatic')
      await insertProposal(db, fx.authorityId, p)
      const insertEffective = () => db.exec(
        `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
         with context SigningNonce = :nonce, Tid = ${p.tid}
         values (:authorityId, 1, :url, :mode, :setAt)`,
        { authorityId: fx.authorityId, nonce: p.nonce, url: p.url, mode: p.mode, setAt: p.setAt } as any
      )
      await expectRefused(insertEffective(), 'effective row before the threshold')
      await db.exec('insert into AdminSignature (SigningNonce) with context IsSignatureValid = true values (:nonce)', { nonce: p.nonce } as any)
      await insertEffective()
      const view = await readIntakePolicyFrom(intakeQueryPortFromDb(db), fx.authorityId)
      expect(view.revision).to.equal(1)
      expect(view.restBridgeUrl).to.equal('https://bridge.example')
      expect(view.reassociationMode).to.equal('automatic')
    })
  })

  describe('Task extensions', () => {
    it("an 'intake-policy' Task needs a proposal with its SigningNonce", async () => {
      const p = await signProposal(fx, 1, null, 'automatic')
      const orphan = insertTask(db, fx.holders[1]!.user.id, 'intake-policy', p.nonce)
      await expectRefused(orphan.run(), 'no proposal yet')
      await insertProposal(db, fx.authorityId, p)
      const task = insertTask(db, fx.holders[1]!.user.id, 'intake-policy', p.nonce)
      await task.run()
      expect(await count(db, "select count(*) as n from Task where SignatureType = 'intake-policy'")).to.equal(1)
    })

    it("an 'association' Task needs an extension row bound to the decision's session digest", async () => {
      const device = randomTestKeyPair()
      const priv = hexToBytes(device.privateHex)
      const deviceSign = async (digest: Uint8Array): Promise<Signature> => ({ signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: device.publicHex, signerUserId: '' })
      const requestId = await new AssociationEngine(fx.elec.ctx).submitAssociationRequest(
        { id: crypto.randomUUID(), authorityId: fx.authorityId, registrantId: 'registrant-1', deviceKey: device.publicHex, submittedAt: toIsoZDatetime(Date.now()) },
        device.publicHex,
        deviceSign
      )
      const reviewTid = await allocateTid(db, 'registration-request')
      const reviewDigest = "select Digest(:reviewTid, 'AssociationReview', :requestId, :rowAuthorityId, :deviceKey, :registrantId, :decision) as d"
      const nonce = await seedSignedMutation(
        { db, user: fx.holders[0]!.user }, fx.authorityId, 'vrg' as Scope, reviewTid, reviewDigest,
        { reviewTid, requestId, rowAuthorityId: fx.authorityId, deviceKey: device.publicHex, registrantId: 'registrant-1', decision: 'a' }, fx.holders[0]!.sign
      )
      const insertExtension = (taskId: string, registrantId: string | null, decision: string) => db.exec(
        `insert into AssociationSignatureTaskExtension (TaskId, RequestId, RegistrantId, Decision, ReviewTid)
         with context Tid = 1
         values (:taskId, :requestId, :registrantId, :decision, :reviewTid)`,
        { taskId, requestId, registrantId, decision, reviewTid } as any
      )

      const good = insertTask(db, fx.holders[1]!.user.id, 'association', nonce)
      await db.exec('BEGIN')
      await good.run()
      await insertExtension(good.id, 'registrant-1', 'a')
      await db.exec('COMMIT')

      const wrongRegistrant = insertTask(db, fx.holders[2]!.user.id, 'association', nonce)
      await db.exec('BEGIN')
      let caught: unknown
      try {
        await wrongRegistrant.run()
        await insertExtension(wrongRegistrant.id, 'someone-else', 'a')
        await db.exec('COMMIT')
      } catch (err) {
        caught = err
        try { await db.exec('ROLLBACK') } catch { /* already rolled back */ }
      }
      expect(caught, 'an extension that does not match the signed decision').to.be.instanceOf(Error)

      await expectRefused(insertExtension(crypto.randomUUID(), null, 'a'), "an approval with no registrant")
      expect(await count(db, 'select count(*) as n from AssociationSignatureTaskExtension')).to.equal(1)
    })
  })
})
