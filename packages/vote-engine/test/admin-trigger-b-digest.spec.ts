/**
 * admin-trigger-b-digest.spec.ts — 62-03 Task 2 (D-33a).
 *
 * Proves `AdminSignatureTaskExtension.MutationValid` (Trigger B) recomputes the SAME
 * full-roster 'rad' proposal digest `proposeAdmin` actually persists — with NO
 * `context.Tid` — so a real co-signer Task against a genuine threshold-2 `proposeAdmin`
 * session commits, and the same insert against a stale (pre-62-03) 4-argument digest, or
 * a tampered roster, is refused.
 */

import { expect } from 'chai'
import type { AdminInit, Proposal, Scope } from '@votetorrent/vote-core'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import { computeRadProposalDigest, readProposedRosterJson, adminSignatureTaskExtensionInserter } from '../src/authority/rad-roster-digest.js'
import { fanOutSignatureTasks } from '../src/signing/fan-out.js'
import { digestToBytes, toCanonicalDatetime, nowCanonicalDatetime } from '../src/utils.js'
import { SigningEngine } from '../src/signing/signing-engine.js'

async function setupProposal () {
  const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 2 }] })
  const effectiveAt = Date.now() + 3_600_000
  const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
  const roster = fx.holders.slice(0, 3)
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers: roster.map((h, i) => ({
        existing: { userId: h.user.id, authorityId: fx.authorityId, title: `Officer ${i}`, scopes: Array.from(new Set([...h.scopes, 'rad'])) as Scope[] }
      })),
      effectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 2 }]
    },
    signers: [fx.holders[0]!.user.id]
  }
  await fx.elec.authorityEngine.proposeAdmin(proposal, fx.holders[0]!.sign)

  // Locate the proposal nonce as the 'rad' AdminSigning whose Digest equals
  // computeRadProposalDigest for this (authorityId, effectiveAt).
  const digest = await computeRadProposalDigest(fx.elec.ctx.db, {
    authorityId: fx.authorityId,
    effectiveAt: effectiveAtCanon,
    officers: await readProposedRosterJson(fx.elec.ctx.db, fx.authorityId, effectiveAtCanon),
    thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 2 }])
  })
  const nonceRow = await fx.elec.ctx.db
    .prepare(`select Nonce from AdminSigning where Scope = 'rad' and Digest = :digest`)
    .get({ digest })
  if (!nonceRow) throw new Error('setupProposal: proposal nonce not found by digest')
  return { fx, effectiveAtCanon, nonce: nonceRow.Nonce as string }
}

describe('Trigger B digest (D-33a)', () => {
  it('T1 accept: a real co-signer Task + extension commits in one BEGIN/COMMIT', async () => {
    const { fx, effectiveAtCanon, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const taskId = crypto.randomUUID()
    const tid = Date.now()
    const insertExtension = adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, tid)

    let caught: unknown
    try {
      await db.exec('BEGIN')
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
        { id: taskId, userId: fx.holders[1]!.user.id, nonce, tid }
      )
      await insertExtension(taskId, fx.holders[1]!.user.id)
      await db.exec('COMMIT')
    } catch (err) {
      caught = err
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    }
    expect(caught, `T1: a real co-signer task must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)
  })

  it('T2 fan-out: fanOutSignatureTasks with signatureType admin creates exactly holderCount - 1 tasks', async () => {
    const { fx, effectiveAtCanon, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const tid = Date.now()
    const result = await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'rad' as Scope,
      nonce,
      initiatorUserId: fx.holders[0]!.user.id,
      signatureType: 'admin',
      taskTid: tid,
      insertExtension: adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, tid)
    })
    // fx.holders has 4 entries by default, but the roster proposed above is only
    // holders[0..2] — fan-out recipients are CURRENT scope-holders (all 4 hold 'rad'
    // via the fixture's default holderScopes), minus the initiator.
    expect(result.recipientUserIds.length, 'T2: exactly holderCount - 1 recipients').to.equal(fx.holders.length - 1)
    expect(result.taskIds.length).to.equal(fx.holders.length - 1)
  })

  it('T3 stale digest: a legacy 4-arg AdminSigning for the SAME ProposedAdmin cannot seed a co-signer task', async () => {
    const { fx, effectiveAtCanon } = await setupProposal()
    const db = fx.elec.ctx.db
    const tid = Date.now()
    const now = nowCanonicalDatetime()
    const staleNonce = crypto.randomUUID()
    const signCb = fx.holders[0]!.sign
    // AdminSigning.AdminEffectiveAt is always the SIGNER's CURRENT admin generation
    // (AdminSigning.UserIdValid requires an Officer row at that EffectiveAt), never the
    // proposed one — same as the real proposal session startSigningSession minted.
    const currentAdminRow = await db
      .prepare(
        `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
            on CurrentAdmin.AuthorityId = Officer.AuthorityId
              and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
      )
      .get({ userId: fx.holders[0]!.user.id, authorityId: fx.authorityId })
    const currentAdminEffectiveAt = currentAdminRow!.EffectiveAt as string
    const staleDigestRow = await db
      .prepare('select Digest(:tid, :authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({ tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 2 }]) })
    const staleDigest = staleDigestRow!.d as string
    const sig = await signCb(digestToBytes(staleDigest))
    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
       values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
      {
        nonce: staleNonce, authorityId: fx.authorityId, adminEffectiveAt: currentAdminEffectiveAt, digest: staleDigest,
        userId: sig.signerUserId, signerKey: sig.signerKey, signature: sig.signature, now
      }
    )

    const taskId = crypto.randomUUID()
    const insertExtension = adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, tid)
    let caught: unknown
    try {
      await db.exec('BEGIN')
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
        { id: taskId, userId: fx.holders[1]!.user.id, nonce: staleNonce, tid }
      )
      await insertExtension(taskId, fx.holders[1]!.user.id)
      await db.exec('COMMIT')
    } catch (err) {
      caught = err
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    }
    expect(caught, 'T3: a legacy 4-arg session must NOT be able to seed a co-signer task').to.be.instanceOf(Error)
  })

  it('T4 tampered roster: an extra ProposedOfficer row after signing breaks a NEW extension insert against the original nonce', async () => {
    const { fx, effectiveAtCanon, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const tid = Date.now()
    const now = nowCanonicalDatetime()
    await db.exec(
      `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes, UserId)
       with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
       values (:authorityId, :effectiveAt, :proposedName, 'Tamper', '["rad"]', :userId)`,
      { authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, proposedName: 'Tampered Officer', userId: fx.outsider.id, tid, now }
    )

    const taskId = crypto.randomUUID()
    const insertExtension = adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, tid)
    let caught: unknown
    try {
      await db.exec('BEGIN')
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
        { id: taskId, userId: fx.holders[1]!.user.id, nonce, tid }
      )
      await insertExtension(taskId, fx.holders[1]!.user.id)
      await db.exec('COMMIT')
    } catch (err) {
      caught = err
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    }
    expect(caught, 'T4: a tampered roster must break a NEW extension insert against the original nonce').to.be.instanceOf(Error)
  })

  it('T5 no proposal: an extension whose AdminEffectiveAt has no ProposedAdmin throws (AdminEffectiveAtValid)', async () => {
    const { fx, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const tid = Date.now()
    const bogusEffectiveAt = toCanonicalDatetime(Date.now() + 999_000_000)
    const taskId = crypto.randomUUID()
    let caught: unknown
    try {
      await db.exec('BEGIN')
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
        { id: taskId, userId: fx.holders[1]!.user.id, nonce, tid }
      )
      await db.exec(
        `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
         with context Tid = :tid
         values (:taskId, :authorityId, :adminEffectiveAt)`,
        { taskId, authorityId: fx.authorityId, adminEffectiveAt: bogusEffectiveAt, tid }
      )
      await db.exec('COMMIT')
    } catch (err) {
      caught = err
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    }
    expect(caught, 'T5: an extension with no matching ProposedAdmin must be refused').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('AdminEffectiveAtValid')
  })

  it('T6 co-signer signs: a second holder signing the proposal nonce reaches threshold 2', async () => {
    const { fx, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const sig = await fx.holders[1]!.sign(digestToBytes((await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce }))!.Digest as string))
    const signResult = await new SigningEngine(fx.elec.ctx).sign(nonce, sig, { ownsTransaction: true })
    expect(signResult, 'T6: the second holder signature must reach threshold 2').to.equal(true)

    const adminSigRow = await db.prepare('select SigningNonce from AdminSignature where SigningNonce = :nonce').get({ nonce })
    expect(adminSigRow?.SigningNonce, 'T6: an AdminSignature row must exist').to.equal(nonce)

    const officerSigCountRow = await db.prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce').get({ nonce })
    expect(Number(officerSigCountRow?.n), 'T6: two OfficerSignature rows (instigator + co-signer)').to.equal(2)
  })
})
