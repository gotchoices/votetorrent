/**
 * admin-full-roster-digest.spec.ts — 62-03 Task 2 (D-33b).
 *
 * Proves `Admin.MutationValid` and `Officer.InsertValid`'s signing branches verify ONE
 * promotion digest built from the full `ProposedOfficer` roster (D-09's first-officer
 * shortcut is gone), with roster-membership enforcement, in lockstep with
 * `AuthorityEngine.applyAdminProposal`'s single-session collapse — end to end at
 * `rad` threshold 2, and via hand-built tier-1 negatives at threshold 1.
 */

import { expect } from 'chai'
import type { AdminInit, Proposal, Scope } from '@votetorrent/vote-core'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import {
  computeRadProposalDigest,
  computeAdminPromotionDigest,
  readProposedRosterJson,
  adminSignatureTaskExtensionInserter
} from '../src/authority/rad-roster-digest.js'
import { sortRosterEntries, type AdminRosterEntry } from '../src/authority/authority-engine.js'
import { digestToBytes, toCanonicalDatetime, nowCanonicalDatetime } from '../src/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import type { AdminSignatureTask } from '@votetorrent/vote-core'

function makeNetworkRef () {
  return { hash: 'full-roster-digest-hash', name: 'Full Roster Digest Network', relays: [], primaryAuthorityDomainName: 'full-roster-digest.example.com' }
}

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
  const officersJson = await readProposedRosterJson(fx.elec.ctx.db, fx.authorityId, effectiveAtCanon)
  const digest = await computeRadProposalDigest(fx.elec.ctx.db, {
    authorityId: fx.authorityId,
    effectiveAt: effectiveAtCanon,
    officers: officersJson,
    thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 2 }])
  })
  const nonceRow = await fx.elec.ctx.db
    .prepare(`select Nonce from AdminSigning where Scope = 'rad' and Digest = :digest`)
    .get({ digest })
  if (!nonceRow) throw new Error('setupProposal: proposal nonce not found by digest')
  return { fx, effectiveAtCanon, nonce: nonceRow.Nonce as string, officersJson }
}

describe('Full-roster admin promotion digest (D-33b)', () => {
  it('F1, co-signer promotion end to end at rad threshold 2', async () => {
    const { fx, effectiveAtCanon, nonce } = await setupProposal()
    const db = fx.elec.ctx.db
    const tid = Date.now()
    const taskId = crypto.randomUUID()
    const insertExtension = adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, tid)
    await db.exec('BEGIN')
    await db.exec(
      `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
       with context IsMutationValid = true, Tid = :tid
       values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
      { id: taskId, userId: fx.holders[1]!.user.id, nonce, tid }
    )
    await insertExtension(taskId, fx.holders[1]!.user.id)
    await db.exec('COMMIT')

    const digestRow = await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
    const sig = await fx.holders[1]!.sign(digestToBytes(digestRow!.Digest as string))

    let signCallCount = 0
    const countingCallback = async (d: Uint8Array) => {
      signCallCount++
      return fx.holders[1]!.sign(d)
    }

    const radCountBefore = await db.prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`).get({ id: fx.authorityId })

    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), fx.elec.ctx)
    const task: AdminSignatureTask = {
      type: 'signature',
      userId: fx.holders[1]!.user.id,
      network: makeNetworkRef(),
      signatureType: 'admin',
      authority: fx.elec.authority,
      administration: { proposed: { officers: [], effectiveAt: effectiveAtCanon, thresholdPolicies: [] }, signers: [fx.holders[0]!.user.id] }
    }

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = ((...args: unknown[]) => { warnings.push(String(args[0])) }) as typeof console.warn
    try {
      await tasksEngine.completeSignature(task, { isAccepted: true, signature: sig, sign: countingCallback })
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((w) => w.includes('roster-mismatch')), `F1: no roster-mismatch warning expected. Warnings: ${warnings.join(' | ')}`).to.equal(false)
    expect(signCallCount, 'F1: countingCallback invoked exactly once').to.equal(1)

    const adminRow = await db.prepare('select 1 as x from Admin where AuthorityId = :id and EffectiveAt = :e').get({ id: fx.authorityId, e: effectiveAtCanon })
    expect(adminRow, 'F1: Admin row must exist at the proposed EffectiveAt').to.not.equal(undefined)

    const officerUserIds: string[] = []
    for await (const row of db.eval('select UserId from Officer where AuthorityId = :id and AdminEffectiveAt = :e', { id: fx.authorityId, e: effectiveAtCanon })) {
      officerUserIds.push(row.UserId as string)
    }
    const expectedUserIds = fx.holders.slice(0, 3).map((h) => h.user.id).sort()
    expect(officerUserIds.sort(), 'F1: the Officer rows must equal the roster exactly').to.deep.equal(expectedUserIds)

    const radCountAfter = await db.prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`).get({ id: fx.authorityId })
    expect(Number(radCountAfter?.n) - Number(radCountBefore?.n), "F1: exactly one new 'rad' AdminSigning (the promotion session)").to.equal(1)

    const promotionNonceRow = await db
      .prepare(`select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad' and Nonce <> :proposalNonce`)
      .get({ id: fx.authorityId, proposalNonce: nonce })
    expect(promotionNonceRow, 'F1: a second rad AdminSigning (the promotion session) must exist').to.not.equal(undefined)
    const promotionSigRow = await db
      .prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
      .get({ nonce: promotionNonceRow!.Nonce as string })
    expect(promotionSigRow, 'F1: the promotion session has an AdminSignature').to.not.equal(undefined)
  })

  it('F2, Trigger A regression at rad threshold 1', async () => {
    const fx = await createThresholdAuthority() // default rad threshold 1
    let signCallCount = 0
    const countingCallback = async (d: Uint8Array) => {
      signCallCount++
      return fx.holders[0]!.sign(d)
    }
    const effectiveAt = Date.now() + 7_200_000
    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: fx.holders.map((h, i) => ({ existing: { userId: h.user.id, authorityId: fx.authorityId, title: `Officer ${i}`, scopes: h.scopes } })),
        effectiveAt,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
      },
      signers: [fx.holders[0]!.user.id]
    }
    await fx.elec.authorityEngine.proposeAdmin(proposal, countingCallback)
    const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } }).lastPromotionOutcome
    expect(outcome?.status, `F2 setup: expected 'promoted', got status=${outcome?.status} reason=${outcome?.reason}`).to.equal('promoted')
    expect(signCallCount, 'F2: the callback was invoked exactly 2 times (1 proposal + 1 promotion, down from 3 pre-62-03)').to.equal(2)
  })

  describe('F3, tier-1 negatives (hand-built promotion, threshold 1)', () => {
    async function setupBareSignatureProposal () {
      const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 1 }] })
      const effectiveAt = Date.now() + 3_600_000
      const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
      const roster = fx.holders.slice(0, 3)
      const entries: AdminRosterEntry[] = roster.map((h, i) => ({ proposedName: h.user.name, userId: h.user.id, title: `Officer ${i}`, scopes: h.scopes }))
      const sorted = sortRosterEntries(entries)
      const officersJson = JSON.stringify(sorted)
      const thresholdPoliciesJson = JSON.stringify([{ policy: 'rad', threshold: 1 }])
      const digest = await computeRadProposalDigest(fx.elec.ctx.db, {
        authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, officers: officersJson, thresholdPolicies: thresholdPoliciesJson
      })
      const bareSig = await fx.holders[0]!.sign(digestToBytes(digest))
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: roster.map((h, i) => ({ existing: { userId: h.user.id, authorityId: fx.authorityId, title: `Officer ${i}`, scopes: h.scopes } })),
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [fx.holders[0]!.user.id]
      }
      // A BARE Signature (not a callback) — proposeAdmin's threshold-reached-but-bare-signature
      // branch, which RECORDS and WARNS rather than promoting (the proposal itself is unaffected).
      await fx.elec.authorityEngine.proposeAdmin(proposal, bareSig)
      const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string } }).lastPromotionOutcome
      if (outcome?.status !== 'skipped-non-callback-signature') {
        throw new Error(`setupBareSignatureProposal: expected 'skipped-non-callback-signature', got ${outcome?.status}`)
      }
      const proposalNonceRow = await fx.elec.ctx.db.prepare(`select Nonce from AdminSigning where Scope = 'rad' and Digest = :digest`).get({ digest })
      const proposalNonce = proposalNonceRow!.Nonce as string
      const currentAdminRow = await fx.elec.ctx.db.prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :id').get({ id: fx.authorityId })
      const currentAdminEffectiveAt = currentAdminRow!.EffectiveAt as string
      // Read the PERSISTED ProposedOfficer rows back — `sortRosterEntries` ALSO sorts each
      // officer's `scopes` array, so the stored `Scopes` text is the SORTED form, not
      // `h.scopes` (the fixture's original, unsorted order). Later Officer inserts must use
      // these exact values, or Officer.InsertValid's RosterMember clause (`PO.Scopes =
      // new.Scopes`) rejects a byte-for-byte-correct-content-but-differently-ordered value.
      const rosterRows: Array<{ userId: string, title: string, scopes: string }> = []
      for await (const row of fx.elec.ctx.db.eval(
        'select UserId, Title, Scopes from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e',
        { id: fx.authorityId, e: effectiveAtCanon }
      )) {
        rosterRows.push({ userId: row.UserId as string, title: row.Title as string, scopes: row.Scopes as string })
      }
      return { fx, effectiveAtCanon, officersJson, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt, roster, rosterRows }
    }

    /** Hand-mint a promotion AdminSigning row for the given digest and complete it via
     *  signDerived against proposalNonce — the EXACT shape applyAdminProposal uses internally. */
    async function mintPromotionSession (
      fx: Awaited<ReturnType<typeof setupBareSignatureProposal>>['fx'],
      digest: string,
      currentAdminEffectiveAt: string,
      proposalNonce: string
    ): Promise<string> {
      const sig = await fx.holders[0]!.sign(digestToBytes(digest))
      const nonce = crypto.randomUUID()
      const now = nowCanonicalDatetime()
      await fx.elec.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        { nonce, authorityId: fx.authorityId, adminEffectiveAt: currentAdminEffectiveAt, digest, userId: sig.signerUserId, signerKey: sig.signerKey, signature: sig.signature, now }
      )
      await new SigningEngine(fx.elec.ctx).signDerived(nonce, sig, proposalNonce, { ownsTransaction: true })
      return nonce
    }

    it('(a) positive control: the correct promotion digest commits (rolled back after, for isolation)', async () => {
      const { fx, effectiveAtCanon, officersJson, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt, rosterRows } = await setupBareSignatureProposal()
      const tid = Date.now()
      const digest = await computeAdminPromotionDigest(fx.elec.ctx.db, { tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officers: officersJson })
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      const sortedRows = [...rosterRows].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))

      let caught: unknown
      try {
        await fx.elec.ctx.db.exec('BEGIN')
        await fx.elec.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
        )
        await fx.elec.ctx.db.runDeferredRowConstraints()
        for (const row of sortedRows) {
          await fx.elec.ctx.db.exec(
            `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
             with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
             values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
            { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, userId: row.userId, title: row.title, scopes: row.scopes }
          )
          await fx.elec.ctx.db.runDeferredRowConstraints()
        }
      } catch (err) {
        caught = err
      } finally {
        try { await fx.elec.ctx.db.exec('ROLLBACK') } catch { /* best-effort */ }
      }
      expect(caught, `(a): the correct promotion digest must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)
    })

    it('(b) wrong roster: an empty-roster digest is rejected on the Admin insert', async () => {
      const { fx, effectiveAtCanon, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt } = await setupBareSignatureProposal()
      const tid = Date.now()
      const digest = await computeAdminPromotionDigest(fx.elec.ctx.db, { tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officers: '[]' })
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
        )
      } catch (err) { caught = err }
      expect(caught, '(b): an empty-roster digest must be REJECTED').to.be.instanceOf(Error)
    })

    it('(c) not in the roster: an Officer insert for an outsider under the correct session throws', async () => {
      const { fx, effectiveAtCanon, officersJson, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt } = await setupBareSignatureProposal()
      const tid = Date.now()
      const digest = await computeAdminPromotionDigest(fx.elec.ctx.db, { tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officers: officersJson })
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      await fx.elec.ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
         values (:authorityId, :effectiveAt, :thresholdPolicies)`,
        { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
      )
      await fx.elec.ctx.db.runDeferredRowConstraints()
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, userId: fx.outsider.id, title: 'Outsider', scopes: JSON.stringify(['rad']) }
        )
      } catch (err) { caught = err }
      expect(caught, '(c): an Officer not in the signed roster must be REJECTED').to.be.instanceOf(Error)
    })

    it('(d) wrong title: a roster member with a changed Title throws', async () => {
      const { fx, effectiveAtCanon, officersJson, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt, rosterRows } = await setupBareSignatureProposal()
      const tid = Date.now()
      const digest = await computeAdminPromotionDigest(fx.elec.ctx.db, { tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officers: officersJson })
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      await fx.elec.ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
         values (:authorityId, :effectiveAt, :thresholdPolicies)`,
        { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
      )
      await fx.elec.ctx.db.runDeferredRowConstraints()
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, userId: rosterRows[0]!.userId, title: 'TAMPERED TITLE', scopes: rosterRows[0]!.scopes }
        )
      } catch (err) { caught = err }
      expect(caught, '(d): a roster member with a changed Title must be REJECTED').to.be.instanceOf(Error)
    })

    it('(e) old shape: the pre-62 admin-side digest (no roster argument) is rejected', async () => {
      const { fx, effectiveAtCanon, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt } = await setupBareSignatureProposal()
      const tid = Date.now()
      const oldDigestRow = await fx.elec.ctx.db
        .prepare('select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officerPart) as d')
        .get({ tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officerPart: null })
      const digest = oldDigestRow!.d as string
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
        )
      } catch (err) { caught = err }
      expect(caught, '(e): the pre-62 shortcut shape must be REJECTED — it is gone').to.be.instanceOf(Error)
    })

    it('(f) unsorted: an officers JSON in reverse order is rejected', async () => {
      const { fx, effectiveAtCanon, thresholdPoliciesJson, proposalNonce, currentAdminEffectiveAt, roster } = await setupBareSignatureProposal()
      const tid = Date.now()
      const entries: AdminRosterEntry[] = roster.map((h, i) => ({ proposedName: h.user.name, userId: h.user.id, title: `Officer ${i}`, scopes: h.scopes }))
      const reversed = [...sortRosterEntries(entries)].reverse()
      const digest = await computeAdminPromotionDigest(fx.elec.ctx.db, { tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson, officers: JSON.stringify(reversed) })
      const nonce = await mintPromotionSession(fx, digest, currentAdminEffectiveAt, proposalNonce)
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson }
        )
      } catch (err) { caught = err }
      expect(caught, '(f): an unsorted roster JSON must be REJECTED').to.be.instanceOf(Error)
    })
  })

  it('F4, tampered proposal at the engine refuses with roster-mismatch and writes nothing', async () => {
    const { fx, effectiveAtCanon, nonce } = await setupProposal()
    const db = fx.elec.ctx.db

    const digestRow = await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
    const sig2 = await fx.holders[1]!.sign(digestToBytes(digestRow!.Digest as string))
    const reached = await new SigningEngine(fx.elec.ctx).sign(nonce, sig2, { ownsTransaction: true })
    expect(reached, 'F4 setup: threshold 2 must be reached').to.equal(true)

    // Tamper: add an extra ProposedOfficer row AFTER signing.
    const tid = Date.now()
    const now = nowCanonicalDatetime()
    await db.exec(
      `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes, UserId)
       with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
       values (:authorityId, :effectiveAt, :proposedName, 'Tamper', '["rad"]', :userId)`,
      { authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, proposedName: 'F4 Tampered Officer', userId: fx.outsider.id, tid, now }
    )

    const adminSigningCountBefore = await db.prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`).get({ id: fx.authorityId })
    const adminCountBefore = await db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: fx.authorityId })

    let caught: unknown
    try {
      await fx.elec.authorityEngine.applyAdminProposal(nonce, fx.holders[0]!.sign)
    } catch (err) {
      caught = err
    }
    expect((caught as { reason?: string })?.reason, 'F4: must refuse with roster-mismatch').to.equal('roster-mismatch')

    const adminSigningCountAfter = await db.prepare(`select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`).get({ id: fx.authorityId })
    const adminCountAfter = await db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: fx.authorityId })
    expect(Number(adminSigningCountAfter?.n), 'F4: no new AdminSigning rows').to.equal(Number(adminSigningCountBefore?.n))
    expect(Number(adminCountAfter?.n), 'F4: no new Admin rows').to.equal(Number(adminCountBefore?.n))
  })
})
