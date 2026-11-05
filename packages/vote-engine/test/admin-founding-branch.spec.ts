/**
 * admin-founding-branch.spec.ts — 62-03 Task 2 (D-48, formulation A).
 *
 * On a single-Authority network, `Admin.MutationValid` branch 1 and
 * `Officer.InsertValid` branch 1 now admit ONLY the genuine founding row — at most one
 * Admin and one Officer per Authority, the Officer under the sole Admin. `NetworksEngine
 * .create()` founding and a schema-level founding-row replay still commit.
 *
 * This spec never binds the D-38 founding-replay waiver flag (62-16 owns that producer) —
 * deliberately, so a grep for that exact identifier finds zero hits in this file.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize.js'
import { toCanonicalDatetime, nowCanonicalDatetime } from '../src/utils.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'

const NO_CTX = 'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1'

describe('Admin/Officer founding-branch restriction (D-48, formulation A)', () => {
  it('G1, second Admin: an unsigned second Admin on a single-Authority network is refused (D-48 test 1)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const newEffectiveAt = toCanonicalDatetime(Date.now() + 99_000)
    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX}
         values (:authorityId, :effectiveAt, '[]')`,
        { authorityId: auth.authority.id, effectiveAt: newEffectiveAt }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'G1: a second unsigned Admin must be REFUSED').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('MutationValid')
    const row = await auth.ctx.db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: auth.authority.id })
    expect(Number(row?.n), 'G1: exactly 1 Admin row must survive').to.equal(1)
  })

  it('G2, second Officer at the founding generation: an unsigned extra Officer is refused (D-48 test 1)', async () => {
    const fx = await createThresholdAuthority()
    const foundingRow = await fx.elec.ctx.db
      .prepare('select min(EffectiveAt) as e from Admin where AuthorityId = :id')
      .get({ id: fx.authorityId })
    const foundingEffectiveAt = foundingRow!.e as string
    let caught: unknown
    try {
      await fx.elec.ctx.db.exec(
        `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${NO_CTX}
         values (:authorityId, :adminEffectiveAt, :userId, 'Interloper', '["rad"]')`,
        { authorityId: fx.authorityId, adminEffectiveAt: foundingEffectiveAt, userId: fx.outsider.id }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'G2: a second unsigned Officer at the founding generation must be REFUSED').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('InsertValid')
    const row = await fx.elec.ctx.db
      .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e and UserId = :userId')
      .get({ id: fx.authorityId, e: foundingEffectiveAt, userId: fx.outsider.id })
    expect(Number(row?.n), 'G2: no Officer row for the outsider').to.equal(0)
  })

  it('G3, Officer under a signed generation: an unsigned Officer under the PROMOTED CurrentAdmin is refused', async () => {
    const fx = await createThresholdAuthority()
    let caught: unknown
    try {
      await fx.elec.ctx.db.exec(
        `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${NO_CTX}
         values (:authorityId, :adminEffectiveAt, :userId, 'Interloper', '["rad"]')`,
        { authorityId: fx.authorityId, adminEffectiveAt: fx.adminEffectiveAt, userId: fx.outsider.id }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'G3: an unsigned Officer under a signed (promoted) generation must be REFUSED').to.be.instanceOf(Error)
  })

  describe('G4, same-transaction batching', () => {
    it('(a) one exec inserting two unsigned Admins for one Authority is rejected — never more than ONE survives', async () => {
      const db = new Database()
      await prepareDb(db)
      const authorityId = crypto.randomUUID()
      await db.exec(
        `insert into Authority (Id, Name, DomainName, ImageRef) ${NO_CTX} values (:id, 'G4a Authority', 'g4a.example.com', null)`,
        { id: authorityId }
      )
      let caught: unknown
      try {
        await db.exec(`
          insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX} values ('${authorityId}', '2027-04-01T00:00:00', '[]');
          insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX} values ('${authorityId}', '2027-04-02T00:00:00', '[]');
        `)
      } catch (err) {
        caught = err
      }
      expect(caught, 'G4(a): two Admins in one exec must be rejected').to.be.instanceOf(Error)
      // Task 1's probe (P7(b)) empirically found a bare multi-statement .exec() with no
      // explicit BEGIN is NOT atomic across its own statements (the same 57-07 class of
      // deferred-CHECK sibling-row-visibility quirk, now observed on this NEW self-
      // referential CHECK) — the FIRST insert's deferred CHECK is evaluated and passes
      // before the SECOND one fails, so it is not rolled back. The property D-48 actually
      // needs — never TWO surviving founding Admins — still holds.
      const row = await db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: authorityId })
      expect(Number(row?.n), 'G4(a): at most ONE Admin row may survive — never two').to.be.at.most(1)
    })

    it('(b) BEGIN, Admin, drain, a second Admin, drain throws on the second drain', async () => {
      const db = new Database()
      await prepareDb(db)
      const authorityId = crypto.randomUUID()
      await db.exec(
        `insert into Authority (Id, Name, DomainName, ImageRef) ${NO_CTX} values (:id, 'G4b Authority', 'g4b.example.com', null)`,
        { id: authorityId }
      )
      await db.exec('BEGIN')
      await db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX} values (:id, '2027-04-03T00:00:00', '[]')`,
        { id: authorityId }
      )
      await db.runDeferredRowConstraints()
      let caught: unknown
      try {
        await db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX} values (:id, '2027-04-04T00:00:00', '[]')`,
          { id: authorityId }
        )
        await db.runDeferredRowConstraints()
      } catch (err) {
        caught = err
      }
      expect(caught, 'G4(b): the second drain must throw').to.be.instanceOf(Error)
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    })
  })

  it('G5, founding through create() commits with exactly 1 Admin, 1 Officer and 1 Network (D-48 test 2)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const adminCount = await auth.ctx.db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: auth.authority.id })
    const officerCount = await auth.ctx.db.prepare('select count(*) as n from Officer where AuthorityId = :id').get({ id: auth.authority.id })
    const networkCount = await auth.ctx.db.prepare('select count(*) as n from Network').get({})
    expect(Number(adminCount?.n)).to.equal(1)
    expect(Number(officerCount?.n)).to.equal(1)
    expect(Number(networkCount?.n)).to.equal(1)
  })

  it('G6, founding replay: the six founding rows replay verbatim on a fresh database (D-48 test 3)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)

    const userRow = await auth.ctx.db.prepare('select Id, Name, ImageRef from User where Id = :id').get({ id: auth.user.id })
    const userKeyRow = await auth.ctx.db
      .prepare('select UserId, Type, PubKey, Expiration from UserKey where UserId = :id')
      .get({ id: auth.user.id })
    const authorityRow = await auth.ctx.db
      .prepare('select Id, Name, DomainName, ImageRef from Authority where Id = :id')
      .get({ id: auth.authority.id })
    const adminRow = await auth.ctx.db
      .prepare('select AuthorityId, EffectiveAt, ThresholdPolicies from Admin where AuthorityId = :id')
      .get({ id: auth.authority.id })
    const officerRow = await auth.ctx.db
      .prepare('select AuthorityId, AdminEffectiveAt, UserId, Title, Scopes from Officer where AuthorityId = :id')
      .get({ id: auth.authority.id })
    const networkRow = await auth.ctx.db
      .prepare('select Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType from Network')
      .get({})
    ;[userRow, userKeyRow, authorityRow, adminRow, officerRow, networkRow].forEach((row, i) => {
      if (!row) throw new Error(`G6 setup: founding row ${i} missing on device A`)
    })

    // Replay on a FRESH empty database — same statement text, contexts and three-exec
    // batching NetworksEngine.create() uses (networks-engine.ts), binding a CONSTANT
    // Tid (proving the founding branches are Tid-independent — 62-16's replay contract).
    const deviceB = new Database()
    await prepareDb(deviceB)
    const tid = 0
    const now = nowCanonicalDatetime()
    await deviceB.exec(
      `
      insert into User (Id, Name, ImageRef) ${NO_CTX.replace('Tid = 1', `Tid = ${tid}`)}
      values (:userId, :userName, :userImageRef);

      insert into UserKey (UserId, Type, PubKey, Expiration)
      with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
      values (:userId, :keyType, :pubKey, :expiration);

      insert into Authority (Id, Name, DomainName, ImageRef) ${NO_CTX.replace('Tid = 1', `Tid = ${tid}`)}
      values (:authorityId, :authorityName, :authorityDomain, :authorityImageRef);

      insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX.replace('Tid = 1', `Tid = ${tid}`)}
      values (:authorityId, :adminEffectiveAt, :thresholdPolicies);
      `,
      {
        userId: userRow!.Id, userName: userRow!.Name, userImageRef: userRow!.ImageRef,
        keyType: userKeyRow!.Type, pubKey: userKeyRow!.PubKey, expiration: userKeyRow!.Expiration, now,
        authorityId: authorityRow!.Id, authorityName: authorityRow!.Name, authorityDomain: authorityRow!.DomainName, authorityImageRef: authorityRow!.ImageRef,
        adminEffectiveAt: adminRow!.EffectiveAt, thresholdPolicies: adminRow!.ThresholdPolicies
      }
    )
    await deviceB.exec(
      `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${NO_CTX.replace('Tid = 1', `Tid = ${tid}`)}
       values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes)`,
      {
        authorityId: officerRow!.AuthorityId, adminEffectiveAt: officerRow!.AdminEffectiveAt,
        userId: officerRow!.UserId, title: officerRow!.Title, scopes: officerRow!.Scopes
      }
    )
    await deviceB.exec(
      `insert into Network (Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
       with context SigningNonce = null, Tid = ${tid}
       values (:id, :hash, :primaryAuthorityId, :name, :imageRef, :relays, :tsa, :numTSAs, :electionType)`,
      {
        id: networkRow!.Id, hash: networkRow!.Hash, primaryAuthorityId: networkRow!.PrimaryAuthorityId, name: networkRow!.Name,
        imageRef: networkRow!.ImageRef, relays: networkRow!.Relays, tsa: networkRow!.TimestampAuthorities,
        numTSAs: networkRow!.NumberRequiredTSAs, electionType: networkRow!.ElectionType
      }
    )

    const replayedAdmin = await deviceB.prepare('select AuthorityId, EffectiveAt, ThresholdPolicies from Admin where AuthorityId = :id').get({ id: authorityRow!.Id as string })
    expect(replayedAdmin?.ThresholdPolicies, 'G6: the replayed Admin row equals device A').to.equal(adminRow!.ThresholdPolicies)
    const replayedOfficer = await deviceB.prepare('select UserId from Officer where AuthorityId = :id').get({ id: authorityRow!.Id as string })
    expect(replayedOfficer?.UserId, 'G6: the replayed Officer row equals device A').to.equal(officerRow!.UserId)

    // A second unsigned Admin on the REPLAYED database must still throw.
    let caught: unknown
    try {
      await deviceB.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX}
         values (:authorityId, :effectiveAt, '[]')`,
        { authorityId: authorityRow!.Id, effectiveAt: toCanonicalDatetime(Date.now() + 999_000) }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'G6: a second unsigned Admin on the replayed database must be REFUSED').to.be.instanceOf(Error)
  })

  it('G7, seed shape without a Network row (Dashboard is-privileged.test.mjs shape) commits', async () => {
    const db = new Database()
    await prepareDb(db)
    const { publicHex } = randomTestKeyPair()
    const userId = crypto.randomUUID()
    const authorityId = crypto.randomUUID()
    const effectiveAt = toCanonicalDatetime(Date.now())
    const now = nowCanonicalDatetime()

    let caught: unknown
    try {
      await db.exec(
        `insert into User (Id, Name, ImageRef) ${NO_CTX} values (:id, 'G7 User', null)`,
        { id: userId }
      )
      await db.exec(
        `insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = null, Signature = null, Tid = 1, now = :now, IsSignatureValid = true
         values (:userId, 'M', :pubKey, :expiration)`,
        { userId, pubKey: publicHex, expiration: toCanonicalDatetime(Date.now() + 86_400_000), now }
      )
      await db.exec(
        `insert into Authority (Id, Name, DomainName, ImageRef) ${NO_CTX} values (:id, 'G7 Authority', 'g7.example.com', null)`,
        { id: authorityId }
      )
      await db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${NO_CTX} values (:authorityId, :effectiveAt, '[]')`,
        { authorityId, effectiveAt }
      )
      await db.exec(
        `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${NO_CTX}
         values (:authorityId, :effectiveAt, :userId, 'Chair', '["rad"]')`,
        { authorityId, effectiveAt, userId }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, `G7: a founding seed with no Network row must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)
  })
})
