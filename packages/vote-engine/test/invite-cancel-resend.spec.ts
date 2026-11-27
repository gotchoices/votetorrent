/**
 * invite-cancel-resend.spec.ts - AuthorityEngine.cancelInvite / resendInvite (62-104, user decision 8b).
 *  - Only the officer who sent the invitation (AdminSigning.UserId) or a current officer of THIS authority holding
 *    the scope that issues that invitation type may cancel or resend; every other actor is refused with
 *    'invite-not-authorized' before any write.
 *  - cancelInvite reads the chain and checks 'answered' inside one serialized transaction (gap7/IN-04).
 *  - Chains are read by signing nonce (gap7/WR-07 option a), one InviteSlot read per cancel.
 *  - resendInvite refuses any type but 'of'/'au' (gap7/IN-07).
 */
import { expect } from 'chai'
import type { User } from '@votetorrent/vote-core'
import { AuthorityEngine } from '../src/authority/authority-engine.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import type { EngineContext } from '../src/types.js'
import { makeChainFixture, sendInvite, markerRows, countRows } from './fixtures/invite-chain.js'
import type { ChainFixture } from './fixtures/invite-chain.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import { addSiblingAuthority, addTestElection, makeTestSignCallback } from './fixtures/test-context.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { KeyholderInvite } from '@votetorrent/vote-core'

async function codeOf (promise: Promise<unknown>): Promise<string | undefined> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  return (caught as { code?: string }).code
}

/** The same authority and database, a different signed-in user (or none). */
function engineAs (fx: ChainFixture, user: User | undefined): AuthorityEngine {
  const ctx = { ...fx.auth.ctx, user } as EngineContext
  return new AuthorityEngine(fx.auth.authority, ctx)
}

async function slotRows (fx: ChainFixture): Promise<number> {
  let n = 0
  for await (const _row of fx.auth.ctx.db.eval('select Cid from InviteSlot')) n += 1
  return n
}

async function thresholdFixture () {
  const t = await createThresholdAuthority()
  const fx: ChainFixture = {
    auth: t.elec,
    authority: t.elec.authorityEngine as unknown as AuthorityEngine,
    invitation: new InvitationEngine(t.elec.ctx),
    inviteeInvitation: new InvitationEngine(t.elec.ctx),
  }
  return { t, fx }
}

describe('cancelInvite / resendInvite authorization (62-104, decision 8b)', () => {
  it('the sending officer cancels and resends their own officer invitation (positive control)', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await fx.authority.cancelInvite(head)
    expect(await markerRows(fx, [s.cid, head])).to.equal(2)
  })

  it('another current officer holding rad may cancel and resend an officer invitation (positive control)', async () => {
    const { t, fx } = await thresholdFixture()
    const s = await sendInvite(fx, 'of')
    const other = engineAs(fx, t.holders[1]!.user)
    const head = await other.resendInvite(s.cid)
    await other.cancelInvite(head)
    expect(await markerRows(fx, [s.cid, head])).to.equal(2)
  })

  it('another current officer holding iad may cancel an authority invitation (positive control)', async () => {
    const { t, fx } = await thresholdFixture()
    const s = await sendInvite(fx, 'au')
    await engineAs(fx, t.holders[1]!.user).cancelInvite(s.cid)
    expect(await markerRows(fx, [s.cid])).to.equal(1)
  })

  it('a current officer without the issuing scope is refused, with no write', async () => {
    const { t, fx } = await thresholdFixture()
    const s = await sendInvite(fx, 'of')
    const nonHolder = engineAs(fx, t.nonHolder.user)
    const before = await slotRows(fx)
    expect(await codeOf(nonHolder.cancelInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await codeOf(nonHolder.resendInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await markerRows(fx, [s.cid])).to.equal(0)
    expect(await slotRows(fx)).to.equal(before)
  })

  it('an outsider who is not an officer is refused, with no write', async () => {
    const { t, fx } = await thresholdFixture()
    const s = await sendInvite(fx, 'of')
    const outsider = engineAs(fx, t.outsider)
    const before = await slotRows(fx)
    expect(await codeOf(outsider.cancelInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await codeOf(outsider.resendInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await markerRows(fx, [s.cid])).to.equal(0)
    expect(await slotRows(fx)).to.equal(before)
  })

  it('a context with no user is refused, with no write', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const anon = engineAs(fx, undefined)
    const before = await slotRows(fx)
    expect(await codeOf(anon.cancelInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await codeOf(anon.resendInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await markerRows(fx, [s.cid])).to.equal(0)
    expect(await slotRows(fx)).to.equal(before)
  })

  it("another authority's engine is refused even for an officer of both authorities", async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const idB = await addSiblingAuthority(fx.auth)
    const engineB = await fx.auth.networkEngine.openAuthority(idB)
    const before = await slotRows(fx)
    expect(await codeOf(engineB.cancelInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await codeOf(engineB.resendInvite(s.cid))).to.equal('invite-not-authorized')
    expect(await markerRows(fx, [s.cid])).to.equal(0)
    expect(await slotRows(fx)).to.equal(before)
  })
})

describe('cancelInvite is transactional and nonce-scoped (gap7/IN-04, WR-07)', () => {
  it('an answer that lands between the authorization and the transaction makes cancel refuse, with no marker', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const db = fx.auth.ctx.db as unknown as { exec: (sql: string, params?: unknown) => Promise<unknown> }
    const origExec = db.exec.bind(db)
    let injected = false
    db.exec = async (sql: string, params?: unknown) => {
      if (!injected && sql.trim() === 'BEGIN') {
        injected = true
        await origExec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           with context IsSigningValid = true, IsSignatureValid = true
           values (:slotCid, true, :slotCid, 'test-sig', :invokedId)`,
          { slotCid: s.cid, invokedId: crypto.randomUUID() },
        )
      }
      return origExec(sql, params)
    }
    try {
      expect(await codeOf(fx.authority.cancelInvite(s.cid))).to.equal('invite-already-answered')
    } finally {
      db.exec = origExec
    }
    expect(injected).to.equal(true)
    expect(await markerRows(fx, [s.cid])).to.equal(0)
  })

  it('two concurrent cancels both resolve and leave one marker per chain row', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const head = await fx.authority.resendInvite(s.cid)
    await Promise.all([fx.authority.cancelInvite(s.cid), fx.authority.cancelInvite(head)])
    expect(await countRows(fx, 'InviteCancellation', 'SlotCid', s.cid)).to.equal(1)
    expect(await countRows(fx, 'InviteCancellation', 'SlotCid', head)).to.equal(1)
  })

  it('a cancel issues one nonce-keyed InviteSlot read and no InviteKey scan; the pending list scans no InviteKey either', async () => {
    const fx = await makeChainFixture()
    const s = await sendInvite(fx, 'of')
    const db = fx.auth.ctx.db as unknown as {
      eval: (sql: string, ...rest: unknown[]) => AsyncIterable<unknown>
      prepare: (sql: string, ...rest: unknown[]) => unknown
    }
    const origPrepare = db.prepare.bind(db)
    const seen: string[] = []
    // db.eval prepares internally, so recording prepare sees every read exactly once.
    db.prepare = (sql: string, ...rest: unknown[]) => { seen.push(sql); return origPrepare(sql, ...rest) }
    try {
      await fx.authority.getPendingInviteCids()
      expect(seen.filter(q => /InviteKey\s*=/.test(q)), 'pending list').to.have.length(0)
      seen.length = 0
      await fx.authority.cancelInvite(s.cid)
    } finally {
      db.prepare = origPrepare
    }
    const slotReads = seen.filter(q => /from\s+InviteSlot/i.test(q))
    expect(slotReads.filter(q => /SigningNonce\s*=/.test(q)), 'nonce reads').to.have.length(1)
    expect(seen.filter(q => /InviteKey\s*=/.test(q)), 'InviteKey scans').to.have.length(0)
  })
})

describe('resendInvite type guard (gap7/IN-07)', () => {
  it("refuses a keyholder 'k' slot with invite-type-not-resendable and writes nothing", async () => {
    const fx = await makeChainFixture()
    const { electionEngine } = await addTestElection(fx.auth)
    const priv = secp256k1.utils.randomSecretKey()
    const invite: KeyholderInvite = {
      name: 'Kay', type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(),
      inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), inviteSignature: '',
    }
    const electionId = (await electionEngine.getElectionDetails()).election.id
    await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(fx.auth.user))
    const row = await fx.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = 'Kay'").get()
    const before = await slotRows(fx)
    expect(await codeOf(fx.authority.resendInvite(row!.Cid as string))).to.equal('invite-type-not-resendable')
    expect(await slotRows(fx)).to.equal(before)
  })
})

describe('getPendingInviteCids on the mock engine', () => {
  it('resolves an empty list', async () => {
    const { MockAuthorityEngine } = await import('../src/authority/mock-authority-engine.js')
    const engine = new MockAuthorityEngine({ name: 'Mock' } as never) as unknown as { getPendingInviteCids: () => Promise<string[]> }
    expect(await engine.getPendingInviteCids()).to.deep.equal([])
  })
})
