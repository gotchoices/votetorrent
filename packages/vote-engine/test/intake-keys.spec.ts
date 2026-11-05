/**
 * intake-keys.spec.ts — Phase 62 Plan 14 Task 1 (D-04, D-32)
 *
 * Officer encryption-key registration (D-04) and recipient resolution
 * (D-04/D-32) over `src/intake/*`. Written TDD-first against the (at Task 1
 * start) non-existent `src/intake` module.
 */

import { expect } from 'chai'
import type { Scope, Signature, User } from '@votetorrent/vote-core'
import { digestToBytes } from '../src/utils.js'
import { UserEngine } from '../src/user/user-engine.js'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { IntakeError } from '../src/intake/types.js'
import { intakeQueryPortFromDb, intakeQueryPortFromStrandPort } from '../src/intake/query-port.js'
import { createIntakeOpener, createIntakeSealer } from '../src/intake/sealing.js'
import type { IntakeQueryPort } from '../src/intake/query-port.js'
import { resolveIntakeRecipients } from '../src/intake/recipients.js'
import { ENCRYPTION_KEY_ALG, encryptionPublicKeyFromSecret, generateEncryptionKeyPair, officerEncryptionKeyAlias } from '../src/crypto/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture
} from './fixtures/threshold-authority.js'
import {
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  signTestDigest
} from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

/** Bootstrap-add a real UserKey row for a fixture-seeded user that doesn't yet have one. */
async function giveUserKey (ctx: EngineContext, user: User): Promise<void> {
  // createThresholdAuthority now registers its officers' keys itself (signer CHECKs need them), so
  // only add one for a user that has none yet.
  const key = user.activeKeys[0]!
  const existing = await ctx.db
    .prepare('select 1 as x from UserKey where UserId = :userId and PubKey = :pubKey')
    .get({ userId: user.id, pubKey: key.key })
  if (existing) return
  await new UserEngine({ ...user, activeKeys: [] }, ctx).addKey(key)
}

interface RawRow { UserId: string, PubKey: string, Alg: string, RegisteredAt: string, SignerKey: string }

async function rowsFor (ctx: EngineContext, userId: string): Promise<RawRow[]> {
  const rows: RawRow[] = []
  for await (const row of ctx.db.eval(
    'select UserId, PubKey, Alg, RegisteredAt, SignerKey from UserEncryptionKey where UserId = :userId',
    { userId }
  )) {
    rows.push(row as unknown as RawRow)
  }
  return rows
}

/** Raw self-signed UserEncryptionKey insert — for building rows outside the engine (rotation, outsider, duplicate-key cases). */
async function insertRawEncryptionKeyRow (
  ctx: EngineContext,
  user: User,
  publicKey: string,
  registeredAt: string
): Promise<void> {
  const digestRow = await ctx.db
    .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :registeredAt) as d")
    .get({ userId: user.id, alg: ENCRYPTION_KEY_ALG, pubKey: publicKey, registeredAt })
  const digest = digestRow!.d as string
  const signature: Signature = signTestDigest(user, digest)
  await ctx.db.exec(
    `insert into UserEncryptionKey (UserId, Alg, PubKey, RegisteredAt, SignerKey, Signature)
     values (:userId, :alg, :pubKey, :registeredAt, :signerKey, :signature)`,
    {
      userId: user.id,
      alg: ENCRYPTION_KEY_ALG,
      pubKey: publicKey,
      registeredAt,
      signerKey: signature.signerKey,
      signature: signature.signature
    }
  )
}

/** A full raw User + UserKey + officer-invite-bound seed, mirroring staging-schema.spec.ts's former-officer helper. */
async function seedExtraOfficerUser (fx: ThresholdAuthorityFixture, name: string): Promise<User> {
  const user: User = { ...makeDistinctTestUser(), name }
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(fx.elec, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await fx.elec.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
  await giveUserKey(fx.elec.ctx, user)
  return user
}

async function promoteRoster (
  fx: ThresholdAuthorityFixture,
  officers: Array<{ userId: string, title: string, scopes: Scope[] }>,
  effectiveAt: number
): Promise<void> {
  const founder = fx.holders[0]!
  const proposal = {
    proposed: {
      officers: officers.map((o) => ({ existing: { userId: o.userId, authorityId: fx.authorityId, title: o.title, scopes: o.scopes } })),
      effectiveAt,
      thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 1 }]
    },
    signers: [founder.user.id]
  }
  await fx.elec.authorityEngine.proposeAdmin(proposal, founder.sign)
  const engine = fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string } }
  if (engine.lastPromotionOutcome?.status !== 'promoted') {
    throw new Error(`promoteRoster: did not auto-promote (${JSON.stringify(engine.lastPromotionOutcome)})`)
  }
}

// ─────────────────────────────────────────────────────────────────────────

describe('src/intake/* — officer encryption-key registration (D-04) and recipient resolution (D-04, D-32)', () => {
  describe('registerOfficerEncryptionKey', () => {
    let fx: ThresholdAuthorityFixture
    let vault: InMemoryTestKeyVault
    let engine: IntakeEngine

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 1,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      vault = new InMemoryTestKeyVault()
      engine = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
    })

    it('registers: status registered, vault holds the secret, exactly one well-formed row', async () => {
      const holder = fx.holders[0]!
      const result = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      expect(result.status).to.equal('registered')
      expect(result.userId).to.equal(holder.user.id)
      expect(result.authorityId).to.equal(fx.authorityId)

      const alias = officerEncryptionKeyAlias(holder.user.id)
      expect(await vault.hasSecret(alias)).to.equal(true)
      const secret = await vault.getSecret(alias)
      expect(encryptionPublicKeyFromSecret(secret!)).to.equal(result.publicKey)

      const rows = await rowsFor(fx.elec.ctx, holder.user.id)
      expect(rows.length).to.equal(1)
      expect(rows[0]!.Alg).to.equal(ENCRYPTION_KEY_ALG)
      expect(rows[0]!.PubKey).to.equal(result.publicKey)
      expect(rows[0]!.SignerKey).to.equal(holder.user.activeKeys[0]!.key)
      expect(rows[0]!.RegisteredAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('idempotent: a second call returns already-registered, the row count stays 1, and the vault is written exactly once', async () => {
      const holder = fx.holders[0]!
      let putCount = 0
      const countingVault = {
        putSecret: async (alias: string, secret: Uint8Array, policy: { requireUserAuth: boolean }) => {
          putCount++
          return vault.putSecret(alias, secret, policy)
        },
        getSecret: (alias: string) => vault.getSecret(alias),
        hasSecret: (alias: string) => vault.hasSecret(alias),
        deleteSecret: (alias: string) => vault.deleteSecret(alias)
      }

      const first = await engine.registerOfficerEncryptionKey(fx.authorityId, countingVault, holder.sign)
      expect(first.status).to.equal('registered')
      const second = await engine.registerOfficerEncryptionKey(fx.authorityId, countingVault, holder.sign)
      expect(second.status).to.equal('already-registered')
      expect(second.publicKey).to.equal(first.publicKey)
      expect(putCount).to.equal(1)

      const rows = await rowsFor(fx.elec.ctx, holder.user.id)
      expect(rows.length).to.equal(1)
    })

    it('put-before-publish: a throwing sign callback leaves the vault holding the key and no row; a retry publishes that same key', async () => {
      const holder = fx.holders[0]!
      let caught: unknown
      try {
        await engine.registerOfficerEncryptionKey(fx.authorityId, vault, async () => { throw new Error('signer unavailable') })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(Error)
      const alias = officerEncryptionKeyAlias(holder.user.id)
      expect(await vault.hasSecret(alias)).to.equal(true)
      expect((await rowsFor(fx.elec.ctx, holder.user.id)).length).to.equal(0)
      const heldSecret = await vault.getSecret(alias)
      const heldPublicKey = encryptionPublicKeyFromSecret(heldSecret!)

      const retry = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      expect(retry.status).to.equal('registered')
      expect(retry.publicKey).to.equal(heldPublicKey)
    })

    it('reuse: a vault pre-seeded with a generated secret publishes that secret\'s public key', async () => {
      const holder = fx.holders[0]!
      const alias = officerEncryptionKeyAlias(holder.user.id)
      const generated = generateEncryptionKeyPair()
      await vault.putSecret(alias, generated.secretKey, { requireUserAuth: false })

      const result = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      expect(result.status).to.equal('registered')
      expect(result.publicKey).to.equal(generated.publicKey)
    })

    it('refuses an outsider: not-a-current-officer, and the vault stays empty', async () => {
      const outsider = fx.outsider
      const outsiderEngine = new IntakeEngine({ db: fx.elec.ctx.db, user: outsider })
      let caught: unknown
      try {
        await outsiderEngine.registerOfficerEncryptionKey(fx.authorityId, vault, makeTestSignCallback(outsider))
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).code).to.equal('not-a-current-officer')
      expect(await vault.hasSecret(officerEncryptionKeyAlias(outsider.id))).to.equal(false)
      expect((await rowsFor(fx.elec.ctx, outsider.id)).length).to.equal(0)
    })

    it('refuses a corrupt vault secret (32 zero bytes): vault-error, no row, and the vault secret is not deleted', async () => {
      const holder = fx.holders[0]!
      const alias = officerEncryptionKeyAlias(holder.user.id)
      await vault.putSecret(alias, new Uint8Array(32), { requireUserAuth: false })

      let caught: unknown
      try {
        await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).code).to.equal('vault-error')
      expect((await rowsFor(fx.elec.ctx, holder.user.id)).length).to.equal(0)
      expect(await vault.hasSecret(alias)).to.equal(true)
    })

    it('refuses with no ctx.user: invalid-argument', async () => {
      const bareEngine = new IntakeEngine({ db: fx.elec.ctx.db })
      let caught: unknown
      try {
        await bareEngine.registerOfficerEncryptionKey(fx.authorityId, vault, fx.holders[0]!.sign)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).code).to.equal('invalid-argument')
    })
  })

  describe('getOfficerEncryptionKeyStatus', () => {
    let fx: ThresholdAuthorityFixture
    let vault: InMemoryTestKeyVault
    let engine: IntakeEngine

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 1,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      vault = new InMemoryTestKeyVault()
      engine = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
    })

    it('before registration: every flag is false/null', async () => {
      const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
      expect(status).to.deep.equal({
        userId: fx.holders[0]!.user.id,
        authorityId: fx.authorityId,
        hasLocalKey: false,
        localPublicKey: null,
        published: false,
        isCurrent: false,
        isIntakeRecipient: false,
        isContested: false,
        stranded: false
      })
    })

    it('after registration: every flag is true, localPublicKey set', async () => {
      const holder = fx.holders[0]!
      const result = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
      expect(status.hasLocalKey).to.equal(true)
      expect(status.localPublicKey).to.equal(result.publicKey)
      expect(status.published).to.equal(true)
      expect(status.isCurrent).to.equal(true)
      expect(status.isIntakeRecipient).to.equal(true)
    })

    it('a raw self-signed row for a non-officer: published true, isIntakeRecipient false', async () => {
      const outsider = fx.outsider
      await giveUserKey(fx.elec.ctx, outsider)
      const outsiderVault = new InMemoryTestKeyVault()
      const generated = generateEncryptionKeyPair()
      await outsiderVault.putSecret(officerEncryptionKeyAlias(outsider.id), generated.secretKey, { requireUserAuth: false })
      await insertRawEncryptionKeyRow(fx.elec.ctx, outsider, generated.publicKey, new Date().toISOString())

      const outsiderEngine = new IntakeEngine({ db: fx.elec.ctx.db, user: outsider })
      const status = await outsiderEngine.getOfficerEncryptionKeyStatus(fx.authorityId, outsiderVault)
      expect(status.published).to.equal(true)
      expect(status.isCurrent).to.equal(true)
      expect(status.isIntakeRecipient).to.equal(false)
    })
  })

  describe('resolveIntakeRecipients / listIntakeRecipients (D-04, D-32)', () => {
    let fx: ThresholdAuthorityFixture

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 4,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      // Only the founder (holders[0]) gets a UserKey row from createTestNetwork —
      // every other fixture user needs one bootstrapped before it can self-sign
      // a UserEncryptionKey row.
      for (const holder of fx.holders.slice(1)) await giveUserKey(fx.elec.ctx, holder.user)
      await giveUserKey(fx.elec.ctx, fx.nonHolder.user)
      await giveUserKey(fx.elec.ctx, fx.outsider)
    })

    it('recipients are exactly the registered current officers, sorted; unregistered officers are reported; the outsider never appears', async () => {
      const vault0 = new InMemoryTestKeyVault()
      const vault1 = new InMemoryTestKeyVault()
      const vault2 = new InMemoryTestKeyVault()
      const vaultNonHolder = new InMemoryTestKeyVault()

      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user }).registerOfficerEncryptionKey(fx.authorityId, vault0, fx.holders[0]!.sign)
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[1]!.user }).registerOfficerEncryptionKey(fx.authorityId, vault1, fx.holders[1]!.sign)
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[2]!.user }).registerOfficerEncryptionKey(fx.authorityId, vault2, fx.holders[2]!.sign)
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.nonHolder.user }).registerOfficerEncryptionKey(fx.authorityId, vaultNonHolder, fx.nonHolder.sign)
      // holders[3] deliberately left unregistered.
      // Outsider publishes a raw, self-signed row — must never appear.
      const outsiderGenerated = generateEncryptionKeyPair()
      await insertRawEncryptionKeyRow(fx.elec.ctx, fx.outsider, outsiderGenerated.publicKey, new Date().toISOString())

      const set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      const expectedUserIds = [fx.holders[0]!.user.id, fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.nonHolder.user.id].sort()
      expect(set.recipients.map((r) => r.userId)).to.deep.equal(expectedUserIds)
      expect(set.officersWithoutKey).to.deep.equal([fx.holders[3]!.user.id])
      expect(set.recipients.some((r) => r.userId === fx.outsider.id)).to.equal(false)
    })

    it('rotation: a later raw row for the same officer becomes current; status for the vault holding the OLD key reports isCurrent false', async () => {
      const holder = fx.holders[0]!
      const vault = new InMemoryTestKeyVault()
      const engine = new IntakeEngine({ db: fx.elec.ctx.db, user: holder.user })
      const first = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)

      const newer = generateEncryptionKeyPair()
      const laterRegisteredAt = new Date(Date.parse(first.registeredAt) + 60_000).toISOString()
      await insertRawEncryptionKeyRow(fx.elec.ctx, holder.user, newer.publicKey, laterRegisteredAt)

      const set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      const entry = set.recipients.find((r) => r.userId === holder.user.id)
      expect(entry?.publicKey).to.equal(newer.publicKey)

      const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
      expect(status.localPublicKey).to.equal(first.publicKey)
      expect(status.isCurrent).to.equal(false)
    })

    it('a former officer with a registered key is excluded once a later admin drops them', async () => {
      const temp = await seedExtraOfficerUser(fx, 'Former Officer')
      const foundingRow = await fx.elec.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :id')
        .get({ id: fx.authorityId })
      void foundingRow

      await promoteRoster(
        fx,
        [
          { userId: fx.holders[0]!.user.id, title: 'Chair', scopes: ['rad'] as Scope[] },
          { userId: temp.id, title: 'Temp', scopes: ['vrg'] as Scope[] }
        ],
        Date.now() - 30_000
      )

      const vault = new InMemoryTestKeyVault()
      await new IntakeEngine({ db: fx.elec.ctx.db, user: temp }).registerOfficerEncryptionKey(fx.authorityId, vault, makeTestSignCallback(temp))

      let set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      expect(set.recipients.some((r) => r.userId === temp.id)).to.equal(true)

      await promoteRoster(fx, [{ userId: fx.holders[0]!.user.id, title: 'Chair', scopes: ['rad'] as Scope[] }], Date.now())

      set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      expect(set.recipients.some((r) => r.userId === temp.id)).to.equal(false)
    })

    it('D-32 parity: resolution through a strand-shaped port equals the engine result, and never calls mutate/close', async () => {
      const vault0 = new InMemoryTestKeyVault()
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user }).registerOfficerEncryptionKey(fx.authorityId, vault0, fx.holders[0]!.sign)

      const dbPort = intakeQueryPortFromDb(fx.elec.ctx.db)
      let mutateCalls = 0
      let closeCalls = 0
      const strandPort = {
        query: (sql: string, params: Record<string, unknown>) => dbPort.query(sql, params),
        mutate: async () => { mutateCalls++; throw new Error('mutate must never be called') },
        close: async () => { closeCalls++; throw new Error('close must never be called') }
      }
      const viaStrand = await resolveIntakeRecipients(intakeQueryPortFromStrandPort(strandPort), fx.authorityId)
      const viaEngine = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      expect(viaStrand).to.deep.equal(viaEngine)
      expect(mutateCalls).to.equal(0)
      expect(closeCalls).to.equal(0)
    })

    it('an empty authority yields no recipients and lists every current officer as officersWithoutKey', async () => {
      const set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      expect(set.recipients).to.deep.equal([])
      const expected = [fx.holders[0]!.user.id, fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id, fx.nonHolder.user.id].sort()
      expect(set.officersWithoutKey).to.deep.equal(expected)
    })

    it('a copied key (backdated by the copier) does not evict the owner: A is a recipient, opens, the copier cannot, and both statuses say contested', async () => {
      const a = fx.holders[0]!
      const b = fx.holders[1]!
      const c = fx.holders[2]!
      const vaultA = new InMemoryTestKeyVault()
      const vaultB = new InMemoryTestKeyVault()
      const vaultC = new InMemoryTestKeyVault()
      const regA = await new IntakeEngine({ db: fx.elec.ctx.db, user: a.user }).registerOfficerEncryptionKey(fx.authorityId, vaultA, a.sign)
      await new IntakeEngine({ db: fx.elec.ctx.db, user: c.user }).registerOfficerEncryptionKey(fx.authorityId, vaultC, c.sign)
      // B publishes A's public key, claiming a RegisteredAt long before A's.
      await insertRawEncryptionKeyRow(fx.elec.ctx, b.user, regA.publicKey, '2000-01-01T00:00:00.000Z')

      const set = await new IntakeEngine({ db: fx.elec.ctx.db }).listIntakeRecipients(fx.authorityId)
      const ids = set.recipients.map((r) => r.userId)
      expect(ids).to.include(a.user.id)
      expect(ids).to.include(b.user.id)
      expect(ids).to.include(c.user.id)
      expect(set.officersWithoutKey).to.not.include(a.user.id)
      expect(set.contestedKeys).to.deep.equal([{ publicKey: regA.publicKey, userIds: [a.user.id, b.user.id].sort() }])

      const binding = { requestId: 'req-contested', digest: 'digest-contested' }
      const sealed = await createIntakeSealer({ port: intakeQueryPortFromDb(fx.elec.ctx.db), authorityId: fx.authorityId }).seal('{"hello":"world"}', binding)
      const openedByA = await createIntakeOpener({ vault: vaultA, userId: a.user.id }).open(sealed, binding)
      expect(openedByA.ok).to.equal(true)
      const openedByB = await createIntakeOpener({ vault: vaultB, userId: b.user.id }).open(sealed, binding)
      expect(openedByB.ok).to.equal(false)

      const statusA = await new IntakeEngine({ db: fx.elec.ctx.db, user: a.user }).getOfficerEncryptionKeyStatus(fx.authorityId, vaultA)
      expect(statusA.isIntakeRecipient).to.equal(true)
      expect(statusA.isContested).to.equal(true)
      const statusC = await new IntakeEngine({ db: fx.elec.ctx.db, user: c.user }).getOfficerEncryptionKeyStatus(fx.authorityId, vaultC)
      expect(statusC.isContested).to.equal(false)
    })

    it('an empty authorityId throws invalid-argument', async () => {
      let caught: unknown
      try {
        await resolveIntakeRecipients(intakeQueryPortFromDb(fx.elec.ctx.db), '')
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).code).to.equal('invalid-argument')
    })
  })

  describe('resolveIntakeRecipients — fake-port filters (no real DB)', () => {
    function makeFakePort (opts: {
      officers: string[]
      keysByUser: Record<string, Array<{ PubKey: string, Alg: string, RegisteredAt: string, SignerKey: string }>>
      validSignersByUser: Record<string, string[]>
    }): IntakeQueryPort {
      return {
        async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
          if (sql.includes('from Officer')) {
            return opts.officers.map((id) => ({ UserId: id })) as unknown as T[]
          }
          if (sql.includes('from UserEncryptionKey')) {
            const userId = params.userId as string
            return (opts.keysByUser[userId] ?? []) as unknown as T[]
          }
          if (sql.includes('from UserKey')) {
            const userId = params.userId as string
            const signerKey = params.signerKey as string
            const valid = (opts.validSignersByUser[userId] ?? []).includes(signerKey)
            return (valid ? [{ found: 1 }] : []) as unknown as T[]
          }
          throw new Error(`fake port: unexpected query ${sql}`)
        }
      }
    }

    // Real generated keys — a fabricated hex string is not guaranteed to be a
    // valid curve point (`isValidEncryptionPublicKey` does real point
    // validation), so these must come from `generateEncryptionKeyPair()`.
    // HIGH/LOW are sorted by string value for the tie-break test below.
    const REAL_PUB_1 = generateEncryptionKeyPair().publicKey
    const REAL_PUB_2 = generateEncryptionKeyPair().publicKey
    const VALID_PUB_A = REAL_PUB_1
    const [PUB_LOW, PUB_HIGH] = [REAL_PUB_1, REAL_PUB_2].sort()

    it('drops a key whose SignerKey has no UserKey row: signer-key-revoked', async () => {
      const port = makeFakePort({
        officers: ['u1'],
        keysByUser: { u1: [{ PubKey: VALID_PUB_A, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }] },
        validSignersByUser: {}
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients).to.deep.equal([])
      expect(set.droppedKeys).to.deep.equal([{ userId: 'u1', publicKey: VALID_PUB_A, reason: 'signer-key-revoked' }])
    })

    it('drops a structurally invalid PubKey: invalid-public-key', async () => {
      const port = makeFakePort({
        officers: ['u1'],
        keysByUser: { u1: [{ PubKey: 'not-a-key', Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }] },
        validSignersByUser: { u1: ['sig-1'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients).to.deep.equal([])
      expect(set.droppedKeys).to.deep.equal([{ userId: 'u1', publicKey: 'not-a-key', reason: 'invalid-public-key' }])
    })

    it('two officers claiming the same PubKey: BOTH are recipients (a copied key must not evict its owner), the key is reported contested', async () => {
      const port = makeFakePort({
        officers: ['u1', 'u2'],
        keysByUser: {
          u1: [{ PubKey: VALID_PUB_A, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }],
          u2: [{ PubKey: VALID_PUB_A, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-02T00:00:00.000Z', SignerKey: 'sig-2' }]
        },
        validSignersByUser: { u1: ['sig-1'], u2: ['sig-2'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients).to.deep.equal([{ userId: 'u1', publicKey: VALID_PUB_A }, { userId: 'u2', publicKey: VALID_PUB_A }])
      expect(set.officersWithoutKey).to.deep.equal([])
      expect(set.droppedKeys).to.deep.equal([])
      expect(set.contestedKeys).to.deep.equal([{ publicKey: VALID_PUB_A, userIds: ['u1', 'u2'] }])
    })

    it('the copier backdating RegisteredAt changes nothing: the owner stays a recipient (initial/G1 WR-03)', async () => {
      const port = makeFakePort({
        officers: ['u1', 'u2'],
        keysByUser: {
          u1: [{ PubKey: VALID_PUB_A, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }],
          u2: [{ PubKey: VALID_PUB_A, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2000-01-01T00:00:00.000Z', SignerKey: 'sig-2' }]
        },
        validSignersByUser: { u1: ['sig-1'], u2: ['sig-2'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients.map((r) => r.userId)).to.deep.equal(['u1', 'u2'])
      expect(set.officersWithoutKey).to.deep.equal([])
    })

    it('a single claimant has no contested keys (negative control: no false warning)', async () => {
      const port = makeFakePort({
        officers: ['u1', 'u3'],
        keysByUser: {
          u1: [{ PubKey: REAL_PUB_1, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }],
          u3: [{ PubKey: REAL_PUB_2, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-3' }]
        },
        validSignersByUser: { u1: ['sig-1'], u3: ['sig-3'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.contestedKeys).to.deep.equal([])
      expect(set.recipients).to.have.length(2)
    })

    it('equal RegisteredAt per-user ties break by PubKey descending', async () => {
      const port = makeFakePort({
        officers: ['u1'],
        keysByUser: {
          u1: [
            { PubKey: PUB_LOW, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' },
            { PubKey: PUB_HIGH, Alg: ENCRYPTION_KEY_ALG, RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }
          ]
        },
        validSignersByUser: { u1: ['sig-1'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients).to.deep.equal([{ userId: 'u1', publicKey: PUB_HIGH }])
    })

    it('rows with a different Alg are ignored entirely', async () => {
      const port = makeFakePort({
        officers: ['u1'],
        keysByUser: { u1: [{ PubKey: VALID_PUB_A, Alg: 'some-other-alg', RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig-1' }] },
        validSignersByUser: { u1: ['sig-1'] }
      })
      const set = await resolveIntakeRecipients(port, 'auth-1')
      expect(set.recipients).to.deep.equal([])
      expect(set.officersWithoutKey).to.deep.equal(['u1'])
      expect(set.droppedKeys).to.deep.equal([])
    })
  })
})
