/**
 * officer-invite-accept.spec.ts - 66.1 (D-12): a Type 'of' (officer) ACCEPT with OfficerAcceptProvisioning
 * writes the officer's User, UserKey, 'C' UserEvent and the InviteResult (InvokedId = userId) in ONE
 * transaction, or nothing at all; the owner lists replicated accepted invitees with
 * getAcceptedOfficerInvitees and builds an { existing } selection that promotion resolves.
 *
 * D-02: the end-to-end group injects a 5 s delay as the second argument of adminChangeEffectiveAt. There is
 * no switch; the shipped one-hour constant is not touched here.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { adminChangeEffectiveAt, officerSelectionFromInvitee } from '@votetorrent/vote-core'
import type { AdminDetails, AdminInit, KeyholderInvite, OfficerAcceptProvisioning, OfficerSelection, Proposal, Scope } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { isCurrentPairingOfficer } from '../src/pairing/pairing-statement.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import type { EngineContext } from '../src/types.js'
import { makeChainFixture, sendInvite, countRows, resultRows } from './fixtures/invite-chain.js'
import type { ChainFixture } from './fixtures/invite-chain.js'
import { inviteeContext } from './fixtures/invite-keys.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { makeOfficerProvisioning } from './fixtures/officer-provisioning.js'
import { addTestElection, makeTestSignCallback } from './fixtures/test-context.js'

const CODE = 'officer-provisioning-required'
const WITHDRAWN = /withdrawn or has expired/

async function rejectionOf (promise: Promise<unknown>): Promise<Error & { code?: string }> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(caught, 'the engine must refuse').to.be.instanceOf(Error)
  return caught as Error & { code?: string }
}

async function expectCode (promise: Promise<unknown>, code: string): Promise<Error & { code?: string }> {
  const err = await rejectionOf(promise)
  expect(err.code, `expected code ${code}, got ${String(err.code)} (${err.message})`).to.equal(code)
  return err
}

async function identityRows (fx: ChainFixture, userId: string): Promise<{ user: number, key: number, event: number }> {
  return {
    user: await countRows(fx, 'User', 'Id', userId),
    key: await countRows(fx, 'UserKey', 'UserId', userId),
    event: await countRows(fx, 'UserEvent', 'UserId', userId),
  }
}

/** Row totals of every table an officer accept writes. */
async function tableTotals (fx: ChainFixture): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ['InviteResult', 'User', 'UserKey', 'UserEvent']) {
    const row = await fx.auth.ctx.db.prepare(`select count(*) as n from ${table}`).get()
    out[table] = Number(row?.n)
  }
  return out
}

async function inviteResult (fx: ChainFixture, slotCid: string) {
  return await fx.auth.ctx.db
    .prepare('select IsAccepted, InvokedId, Digest from InviteResult where SlotCid = :slotCid')
    .get({ slotCid }) as { IsAccepted: unknown, InvokedId: string | null, Digest: string | null } | undefined
}

function truthy (v: unknown): boolean {
  return v === true || v === 1
}

/** An engine whose session user is `userId`, on the same database (the officer's own device after its first accept). */
function userBoundEngine (fx: ChainFixture, userId: string): InvitationEngine {
  return new InvitationEngine({ ...inviteeContext(fx.auth.ctx), user: { id: userId } } as unknown as EngineContext)
}

async function seedKeyholder (fx: ChainFixture, name: string) {
  const { electionEngine } = await addTestElection(fx.auth)
  const priv = secp256k1.utils.randomSecretKey()
  const inviteKey = bytesToHex(secp256k1.getPublicKey(priv))
  const invite: KeyholderInvite = {
    name, type: 'k', expiration: new Date(Date.now() + 86_400_000).toISOString(), inviteKey, inviteSignature: '',
  }
  const electionId = (await electionEngine.getElectionDetails()).election.id
  await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(fx.auth.user))
  const row = await fx.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  return { cid: row!.Cid as string, inviteKey, invitePrivate: bytesToHex(priv) }
}

async function expectNothingWritten (fx: ChainFixture, slotCid: string, inviteKey: string, userId: string): Promise<void> {
  expect(await resultRows(fx, [slotCid]), 'no InviteResult').to.equal(0)
  expect(await identityRows(fx, userId), 'no identity rows').to.deep.equal({ user: 0, key: 0, event: 0 })
  expect((await fx.invitation.resolveInviteSlot(inviteKey, 'of')).status, 'the slot stays answerable').to.equal('live')
}

describe('officer invite accept (66.1 D-12)', () => {
  describe('atomic accept writes identity and result together', () => {
    it('P-256 provisioning: User, UserKey P, one C UserEvent and InviteResult(InvokedId = userId)', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of', 'Officer Slot P')
      const officer = makeOfficerProvisioning({ name: 'Ana Officer' })
      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer)

      const user = await fx.auth.ctx.db.prepare('select Id, Name, ImageRef from User where Id = :userId').get({ userId: officer.userId })
      expect(user?.Name).to.equal('Ana Officer')
      expect(user?.ImageRef ?? null).to.equal(null)
      const key = await fx.auth.ctx.db.prepare('select Type, PubKey from UserKey where UserId = :userId').get({ userId: officer.userId })
      expect(key?.Type).to.equal('P')
      expect(key?.PubKey).to.equal(officer.signingKey.key)
      const events: Array<{ Event: string, Payload: string }> = []
      for await (const row of fx.auth.ctx.db.eval('select Event, Payload from UserEvent where UserId = :userId', { userId: officer.userId })) {
        events.push({ Event: row.Event as string, Payload: row.Payload as string })
      }
      expect(events).to.have.length(1)
      expect(events[0]!.Event).to.equal('C')
      expect(JSON.parse(events[0]!.Payload)).to.deep.equal({
        name: 'Ana Officer',
        imageRef: null,
        userKey: { key: officer.signingKey.key, type: 'P', expiration: officer.signingKey.expiration },
      })
      const result = await inviteResult(fx, s.cid)
      expect(truthy(result?.IsAccepted)).to.equal(true)
      expect(result?.InvokedId).to.equal(officer.userId)
      expect(result?.Digest).to.equal(s.cid)
    })

    it('secp256k1 provisioning gives UserKey Type M', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const officer = makeOfficerProvisioning({ curve: 'secp256k1' })
      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer)
      const key = await fx.auth.ctx.db.prepare('select Type from UserKey where UserId = :userId').get({ userId: officer.userId })
      expect(key?.Type).to.equal('M')
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
    })

    it('a blank provisioned name falls back to the slot Name; an equal invokedId is admitted', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of', 'Slot Named Officer')
      const officer = makeOfficerProvisioning({ name: '   ' })
      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, officer.userId, undefined, officer)
      const user = await fx.auth.ctx.db.prepare('select Name from User where Id = :userId').get({ userId: officer.userId })
      expect(user?.Name).to.equal('Slot Named Officer')
      expect((await inviteResult(fx, s.cid))?.InvokedId).to.equal(officer.userId)
    })
  })

  describe('missing provisioning is refused before any write', () => {
    it('owner ctx: officer-provisioning-required, zero rows, slot still live', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const before = await tableTotals(fx)
      await expectCode(fx.invitation.respondToInvite(s.cid, true, s.invitePrivate), CODE)
      expect(await resultRows(fx, [s.cid])).to.equal(0)
      expect(await tableTotals(fx)).to.deep.equal(before)
      expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    })

    it('invitee ctx: same code, prefixed message, zero rows', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const before = await tableTotals(fx)
      const err = await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate), CODE)
      expect(err.message).to.match(/^InvitationEngine\.respondToInvite: /)
      expect(await tableTotals(fx)).to.deep.equal(before)
      expect((await fx.invitation.resolveInviteSlot(s.inviteKey, 'of')).status).to.equal('live')
    })
  })

  describe('malformed provisioning is refused before any write', () => {
    const cases: Array<[string, (o: OfficerAcceptProvisioning) => { officer: OfficerAcceptProvisioning, invokedId?: string }]> = [
      ['empty userId', (o) => ({ officer: { ...o, userId: '' } })],
      ['key type X', (o) => ({ officer: { ...o, signingKey: { ...o.signingKey, type: 'X' as never } } })],
      ['non-hex key', (o) => ({ officer: { ...o, signingKey: { ...o.signingKey, key: 'zz' + o.signingKey.key.slice(2) } } })],
      ['short key', (o) => ({ officer: { ...o, signingKey: { ...o.signingKey, key: o.signingKey.key.slice(0, 40) } } })],
      ['expired key', (o) => ({ officer: { ...o, signingKey: { ...o.signingKey, expiration: Date.now() - 1_000 } } })],
      ['missing signing key', (o) => ({ officer: { ...o, signingKey: undefined as never } })],
      ['invokedId different from userId', (o) => ({ officer: o, invokedId: crypto.randomUUID() })],
    ]
    for (const [label, mutate] of cases) {
      it(`${label}: officer-provisioning-required and zero rows`, async () => {
        const fx = await makeChainFixture()
        const s = await sendInvite(fx, 'of')
        const base = makeOfficerProvisioning()
        const { officer, invokedId } = mutate(base)
        await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, invokedId, undefined, officer), CODE)
        await expectNothingWritten(fx, s.cid, s.inviteKey, base.userId)
      })
    }
  })

  describe('refusal precedence is unchanged', () => {
    it('a non-hex invite key still gives invite-key-required', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, 'not-a-key'), 'invite-key-required')
      expect(await resultRows(fx, [s.cid])).to.equal(0)
    })

    it('a cancelled slot accepted without provisioning still gives the withdrawn refusal', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      await fx.authority.cancelInvite(s.cid)
      const err = await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate), 'invite-no-longer-valid')
      expect(err.message).to.match(WITHDRAWN)
      expect(await resultRows(fx, [s.cid])).to.equal(0)
    })

    it('a wrong invite key still gives invite-signature-invalid', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const wrong = bytesToHex(secp256k1.utils.randomSecretKey())
      await expectCode(fx.inviteeInvitation.respondToInvite(s.cid, true, wrong), 'invite-signature-invalid')
      expect(await resultRows(fx, [s.cid])).to.equal(0)
    })
  })

  describe('a failed accept rolls back everything', () => {
    it('a failing UserEvent insert leaves no User, UserKey, UserEvent or InviteResult; the retry succeeds', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const officer = makeOfficerProvisioning()
      const db = fx.auth.ctx.db as unknown as { exec: (sql: string, params?: unknown) => Promise<unknown> }
      const original = db.exec
      let planted = 0
      db.exec = async function (sql: string, params?: unknown) {
        if (/insert into UserEvent/i.test(sql)) {
          planted += 1
          throw new Error('planted UserEvent failure')
        }
        return await original.call(this, sql, params)
      }
      try {
        const err = await rejectionOf(fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer))
        expect(err.message).to.match(/planted UserEvent failure/)
      } finally {
        db.exec = original
      }
      expect(planted, 'the failure fired on the UserEvent insert').to.equal(1)
      await expectNothingWritten(fx, s.cid, s.inviteKey, officer.userId)

      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
      expect((await inviteResult(fx, s.cid))?.InvokedId).to.equal(officer.userId)
    })
  })

  describe('decline and other invite types ignore the officer argument', () => {
    it('decline with an officer argument writes a declined result and no User', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of')
      const officer = makeOfficerProvisioning()
      await fx.inviteeInvitation.respondToInvite(s.cid, false, s.invitePrivate, undefined, undefined, undefined, officer)
      const result = await inviteResult(fx, s.cid)
      expect(truthy(result?.IsAccepted)).to.equal(false)
      expect(result?.InvokedId ?? null).to.equal(null)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 0, key: 0, event: 0 })
    })

    it("an 'au' accept with an officer argument writes no User for officer.userId", async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'au')
      const officer = makeOfficerProvisioning()
      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer)
      expect(await resultRows(fx, [s.cid])).to.equal(1)
      expect((await inviteResult(fx, s.cid))?.InvokedId ?? null).to.equal(null)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 0, key: 0, event: 0 })
    })

    it("a 'k' accept with an officer argument mints the keyholder identity, not the officer's", async () => {
      const fx = await makeChainFixture()
      const k = await seedKeyholder(fx, 'Keyholder Ignoring Officer')
      const officer = makeOfficerProvisioning()
      const keyholderUserId = crypto.randomUUID()
      await fx.inviteeInvitation.respondToInvite(k.cid, true, k.invitePrivate, undefined, keyholderUserId, makeKeyholderProvisioning(), officer)
      expect(await countRows(fx, 'User', 'Id', keyholderUserId)).to.equal(1)
      expect(await countRows(fx, 'Keyholder', 'UserId', keyholderUserId)).to.equal(1)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 0, key: 0, event: 0 })
    })
  })

  describe('existing identity', () => {
    async function firstAccept (fx: ChainFixture) {
      const officer = makeOfficerProvisioning({ name: 'Returning Officer' })
      const engine = userBoundEngine(fx, officer.userId)
      const first = await sendInvite(fx, 'of', 'First Officer Slot')
      await engine.respondToInvite(first.cid, true, first.invitePrivate, undefined, undefined, undefined, officer)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
      return { officer, engine, first }
    }

    it('the session user with its live key: a second accept writes only its InviteResult', async () => {
      const fx = await makeChainFixture()
      const { officer, engine } = await firstAccept(fx)
      const second = await sendInvite(fx, 'of', 'Second Officer Slot')
      await engine.respondToInvite(second.cid, true, second.invitePrivate, undefined, undefined, undefined, officer)
      expect((await inviteResult(fx, second.cid))?.InvokedId).to.equal(officer.userId)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
    })

    it('the same second accept on a ctx without a user is refused and writes nothing', async () => {
      const fx = await makeChainFixture()
      const { officer } = await firstAccept(fx)
      const second = await sendInvite(fx, 'of')
      await expectCode(fx.inviteeInvitation.respondToInvite(second.cid, true, second.invitePrivate, undefined, undefined, undefined, officer), CODE)
      expect(await resultRows(fx, [second.cid])).to.equal(0)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
    })

    it('the session user with a different key is refused and writes nothing', async () => {
      const fx = await makeChainFixture()
      const { officer, engine } = await firstAccept(fx)
      const second = await sendInvite(fx, 'of')
      const otherKey = makeOfficerProvisioning({ userId: officer.userId, name: officer.name })
      await expectCode(engine.respondToInvite(second.cid, true, second.invitePrivate, undefined, undefined, undefined, otherKey), CODE)
      expect(await resultRows(fx, [second.cid])).to.equal(0)
      expect(await identityRows(fx, officer.userId)).to.deep.equal({ user: 1, key: 1, event: 1 })
    })

    it('another session user cannot bind a slot to an existing id', async () => {
      const fx = await makeChainFixture()
      const { officer } = await firstAccept(fx)
      const second = await sendInvite(fx, 'of')
      const intruder = userBoundEngine(fx, crypto.randomUUID())
      await expectCode(intruder.respondToInvite(second.cid, true, second.invitePrivate, undefined, undefined, undefined, officer), CODE)
      expect(await resultRows(fx, [second.cid])).to.equal(0)
    })
  })

  describe('getAcceptedOfficerInvitees', () => {
    it('is empty on a fresh fixture', async () => {
      const fx = await makeChainFixture()
      expect(await fx.invitation.getAcceptedOfficerInvitees()).to.deep.equal([])
    })

    it('lists an accepted invitee and omits pending and declined slots', async () => {
      const fx = await makeChainFixture()
      await sendInvite(fx, 'of', 'Pending Officer')
      const declined = await sendInvite(fx, 'of', 'Declined Officer')
      await fx.inviteeInvitation.respondToInvite(declined.cid, false, declined.invitePrivate)
      const accepted = await sendInvite(fx, 'of', 'Accepted Officer')
      const officer = makeOfficerProvisioning({ name: 'Device Name' })
      await fx.inviteeInvitation.respondToInvite(accepted.cid, true, accepted.invitePrivate, undefined, undefined, undefined, officer)
      expect(await fx.invitation.getAcceptedOfficerInvitees()).to.deep.equal([
        { slotCid: accepted.cid, name: 'Accepted Officer', userId: officer.userId },
      ])
    })

    it('omits an accepted result whose InvokedId has no User row on this database', async () => {
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of', 'Unreplicated Officer')
      await fx.auth.ctx.db.exec(
        `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
         with context IsSigningValid = true, IsSignatureValid = true
         values (:slotCid, true, :digest, :sig, :invoked)`,
        { slotCid: s.cid, digest: s.cid, sig: 'ab'.repeat(32), invoked: crypto.randomUUID() }
      )
      expect(await resultRows(fx, [s.cid])).to.equal(1)
      expect(await fx.invitation.getAcceptedOfficerInvitees()).to.deep.equal([])
    })

    it("omits a keyholder ('k') accept even though it writes a User and InvokedId", async () => {
      const fx = await makeChainFixture()
      const k = await seedKeyholder(fx, 'Listed Keyholder')
      const keyholderUserId = crypto.randomUUID()
      await fx.inviteeInvitation.respondToInvite(k.cid, true, k.invitePrivate, undefined, keyholderUserId, makeKeyholderProvisioning())
      expect(await countRows(fx, 'User', 'Id', keyholderUserId)).to.equal(1)
      expect(await fx.invitation.getAcceptedOfficerInvitees()).to.deep.equal([])
    })

    it('lists the existing-identity case once and sorts by name', async () => {
      const fx = await makeChainFixture()
      const officer = makeOfficerProvisioning()
      const engine = userBoundEngine(fx, officer.userId)
      const s1 = await sendInvite(fx, 'of', 'Zed Slot')
      const s2 = await sendInvite(fx, 'of', 'Mid Slot')
      await engine.respondToInvite(s1.cid, true, s1.invitePrivate, undefined, undefined, undefined, officer)
      await engine.respondToInvite(s2.cid, true, s2.invitePrivate, undefined, undefined, undefined, officer)
      const other = makeOfficerProvisioning()
      const s3 = await sendInvite(fx, 'of', 'Alpha Slot')
      await fx.inviteeInvitation.respondToInvite(s3.cid, true, s3.invitePrivate, undefined, undefined, undefined, other)
      expect(await fx.invitation.getAcceptedOfficerInvitees()).to.deep.equal([
        { slotCid: s3.cid, name: 'Alpha Slot', userId: other.userId },
        { slotCid: s2.cid, name: 'Mid Slot', userId: officer.userId },
      ])
    })
  })

  describe('officerSelectionFromInvitee', () => {
    it('refuses an invitee that has not accepted with admin-invitee-not-accepted', () => {
      let caught: (Error & { code?: string }) | undefined
      try { officerSelectionFromInvitee(undefined, 'authority-id', 'Officer', ['iad'] as Scope[]) } catch (err) { caught = err as Error & { code?: string } }
      expect(caught?.code).to.equal('admin-invitee-not-accepted')
    })
  })

  describe('end to end: accept -> { existing } -> promoted -> current after the injected 5 s (D-12, D-02)', () => {
    it('the accepted invitee becomes a current officer only after effectiveAt', async function () {
      this.timeout(30_000)
      const fx = await makeChainFixture()
      const s = await sendInvite(fx, 'of', 'New Officer')
      const officer = makeOfficerProvisioning({ name: 'New Officer Device' })
      await fx.inviteeInvitation.respondToInvite(s.cid, true, s.invitePrivate, undefined, undefined, undefined, officer)

      const invitees = await fx.invitation.getAcceptedOfficerInvitees()
      const invitee = invitees.find((i) => i.userId === officer.userId)
      expect(invitee, 'the owner lists the accepted invitee').to.not.equal(undefined)
      const selection = officerSelectionFromInvitee(invitee, fx.auth.authority.id, 'Officer', ['iad'] as Scope[])
      expect(selection.existing?.userId).to.equal(officer.userId)
      expect(selection.init).to.equal(undefined)

      const current = (await fx.authority.getAdminDetails()).admin
      const roster: OfficerSelection[] = current.officers.map((o) => ({
        existing: { userId: o.userId, authorityId: o.authorityId, title: o.title, scopes: o.scopes },
      }))
      const t0 = Date.now()
      const effectiveAt = adminChangeEffectiveAt(t0, 5_000)
      const proposal: Proposal<AdminInit> = {
        proposed: { officers: [...roster, selection], effectiveAt, thresholdPolicies: current.thresholdPolicies },
        signers: [fx.auth.user.id],
      }
      await fx.authority.proposeAdmin(proposal, makeTestSignCallback(fx.auth.user))
      const outcome = (fx.authority as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } }).lastPromotionOutcome
      expect(outcome?.status, `expected 'promoted', got status=${outcome?.status} reason=${outcome?.reason}`).to.equal('promoted')

      const row = await fx.auth.ctx.db
        .prepare('select 1 as x from Officer where UserId = :userId and AdminEffectiveAt = :eff')
        .get({ userId: officer.userId, eff: effectiveAt })
      expect(row, 'an Officer row for the invitee at effectiveAt').to.not.equal(undefined)

      const db = fx.auth.ctx.db
      const t0Canonical = new Date(t0).toISOString().slice(0, 19)
      expect(await isCurrentPairingOfficer(db, { userId: officer.userId, nowCanonical: t0Canonical }), 'not current before effectiveAt').to.equal(false)
      expect(await isCurrentPairingOfficer(db, { userId: officer.userId, nowCanonical: effectiveAt }), 'current at effectiveAt').to.equal(true)

      const deadline = Date.now() + 15_000
      let isCurrent = false
      while (Date.now() < deadline) {
        isCurrent = await isCurrentPairingOfficer(db, { userId: officer.userId, nowCanonical: nowCanonicalDatetime() })
        if (isCurrent) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(isCurrent, 'current after the real wait').to.equal(true)
      const officers = (await fx.authority.getAdminDetails()).admin.officers.map((o) => o.userId)
      expect(officers).to.include(officer.userId)
    })
  })
})

/**
 * R-62 (66.1-09 finding F-09-4): MIRROR of the officers mapping in
 * tools/vote-cli/src/workflows/authority.mjs adminSetScopes. vote-cli has no unit harness and that module
 * loads the built vote-engine dist and the CadreNode device, so the mapping is copied here verbatim (the
 * `const target`, `const scopes` and `return` lines are byte-identical to the shipped ones) instead of
 * calling adminSetScopes. `device` stands in for the vote-cli device so those lines stay identical.
 */
function adminSetScopesOfficers (details: AdminDetails, p: { user?: string; title?: string; scopes?: string }, deviceUserId: string): OfficerSelection[] {
  const device = { user: { id: deviceUserId } }
  return details.admin.officers.map((o) => {
    const target = p.user ? o.userId === p.user : o.userId === device.user.id
    const scopes = target && p.scopes ? String(p.scopes).split(',').map((s) => s.trim()).filter(Boolean) : o.scopes
    return { existing: { userId: o.userId, authorityId: o.authorityId, title: target && p.title ? p.title : o.title, scopes } }
  }) as OfficerSelection[]
}

type RosterProbe = { resolveAdminRoster (o: OfficerSelection[]): Promise<Array<{ userId: string | null; title: string; scopes: string[] }>> }

async function setScopesInput (fx: ChainFixture) {
  const details = await fx.authority.getAdminDetails()
  const founder = details.admin.officers.find((o) => o.userId === fx.auth.user.id)
  expect(founder, 'the founder is a current officer').to.not.equal(undefined)
  const founderScopes: string[] = [...founder!.scopes]
  const drop = founderScopes.findIndex((sc) => sc !== 'rad')
  const reduced = drop >= 0 ? founderScopes.filter((_sc, i) => i !== drop) : founderScopes
  const p = { title: 'Chair', scopes: reduced.join(',') }
  return { details, p, reduced, officers: adminSetScopesOfficers(details, p, fx.auth.user.id) }
}

describe('vote-cli adminSetScopes roster shape (R-62)', () => {
  it("maps every officer to { existing } with the admin's authorityId", async () => {
    const fx = await makeChainFixture()
    const { details, officers } = await setScopesInput(fx)
    expect(officers.length).to.equal(details.admin.officers.length)
    expect(officers.length).to.be.at.least(1)
    for (const o of officers) {
      expect(o.existing, 'every entry is an existing selection').to.not.equal(undefined)
      expect(o.init, 'no entry is an init selection').to.equal(undefined)
      expect(o.existing!.authorityId).to.equal(details.admin.authorityId)
      expect(o.existing!.authorityId).to.equal(fx.auth.authority.id)
    }
  })

  it('resolveAdminRoster keeps every officer and its scopes; the pre-fix bare shape resolves to []', async () => {
    const fx = await makeChainFixture()
    const { details, officers, reduced } = await setScopesInput(fx)
    const probe = fx.authority as unknown as RosterProbe
    const roster = await probe.resolveAdminRoster(officers)
    expect(roster.length).to.equal(officers.length)
    for (const o of officers) {
      const entry = roster.find((r) => r.userId === o.existing!.userId)
      expect(entry, `roster entry for ${o.existing!.userId}`).to.not.equal(undefined)
      expect(entry!.title).to.equal(o.existing!.title)
      expect(entry!.scopes).to.deep.equal(o.existing!.scopes)
    }
    const founderEntry = roster.find((r) => r.userId === fx.auth.user.id)
    expect(founderEntry!.title).to.equal('Chair')
    expect(founderEntry!.scopes).to.deep.equal(reduced)

    // Negative control: the pre-fix bare shape is skipped by resolveAdminRoster (the empty-roster bug).
    const bare = details.admin.officers.map((o) => ({ userId: o.userId, name: undefined, title: o.title, scopes: o.scopes })) as unknown as OfficerSelection[]
    expect(await probe.resolveAdminRoster(bare)).to.deep.equal([])
  })

  it('proposeAdmin promotes the mapped roster', async () => {
    const fx = await makeChainFixture()
    const { details, officers } = await setScopesInput(fx)
    // D-02: 5 s injected as an argument; never the founding admin's second (R-64).
    const effectiveAt = adminChangeEffectiveAt(Date.now(), 5_000)
    await fx.authority.proposeAdmin({
      proposed: { officers, effectiveAt, thresholdPolicies: details.admin.thresholdPolicies },
      signers: [fx.auth.user.id],
    }, makeTestSignCallback(fx.auth.user))
    const outcome = (fx.authority as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } }).lastPromotionOutcome
    expect(outcome?.status, `expected 'promoted', got status=${outcome?.status} reason=${outcome?.reason}`).to.equal('promoted')

    const rows: Array<{ UserId: string, Title: string, Scopes: string }> = []
    for await (const row of fx.auth.ctx.db.eval(
      'select UserId, Title, Scopes from Officer where AuthorityId = :authorityId and AdminEffectiveAt = :eff',
      { authorityId: fx.auth.authority.id, eff: effectiveAt }
    )) {
      rows.push({ UserId: row.UserId as string, Title: row.Title as string, Scopes: row.Scopes as string })
    }
    expect(rows.length).to.equal(officers.length)
    for (const o of officers) {
      const row = rows.find((r) => r.UserId === o.existing!.userId)
      expect(row, `Officer row for ${o.existing!.userId}`).to.not.equal(undefined)
      expect(row!.Title).to.equal(o.existing!.title)
      // The engine persists scopes in sorted canonical order.
      expect([...JSON.parse(row!.Scopes)].sort()).to.deep.equal([...o.existing!.scopes].sort())
    }
  })
})
