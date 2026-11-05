/**
 * intake-key-renewal.spec.ts — Phase 62 Plan 122 Task 1 (O-01; D-04, D-51)
 *
 * A signing-key replacement strands the officer's published intake encryption key (its SignerKey is
 * no longer a UserKey, so recipients.ts drops it as `signer-key-revoked`). The engine mints a NEW
 * encryption key under a new vault generation, signed by the new signing key, and keeps every older
 * secret so envelopes sealed before the replacement stay readable.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { UserKeyType } from '@votetorrent/vote-core'
import type { Signature, User } from '@votetorrent/vote-core'
import { UserEngine } from '../src/user/user-engine.js'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { IntakeError } from '../src/intake/types.js'
import { intakeQueryPortFromDb } from '../src/intake/query-port.js'
import { createIntakeSealer } from '../src/intake/sealing.js'
import { resolveIntakeRecipients } from '../src/intake/recipients.js'
import {
  ENCRYPTION_KEY_ALG,
  MAX_OFFICER_KEY_GENERATIONS,
  encryptionPublicKeyFromSecret,
  generateEncryptionKeyPair,
  officerEncryptionKeyAlias,
  officerEncryptionKeyGenerationAlias
} from '../src/crypto/index.js'
import type { IKeyVault } from '../src/crypto/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { signTestDigest, testKeyPairFor } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

const POLICY = { requireUserAuth: false }

/** Replace the holder's signing key: add a new UserKey (signed by the old), revoke the old (signed by the new). */
async function replaceSigningKey (
  ctx: EngineContext,
  user: User
): Promise<{ newPublicKey: string, sign: (digest: Uint8Array) => Promise<Signature> }> {
  const oldPair = testKeyPairFor(user.id)
  const oldKey = user.activeKeys[0]!
  const fresh = randomTestKeyPair()
  const withOld = new UserEngine({ ...user, activeKeys: [oldKey] }, ctx)
  await withOld.addKey(
    { key: fresh.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 },
    async (digest) => ({
      signature: bytesToHex(secp256k1.sign(digest, hexToBytes(oldPair.privateHex))),
      signerKey: oldKey.key,
      signerUserId: user.id
    })
  )
  const withNew = new UserEngine(
    { ...user, activeKeys: [{ key: fresh.publicHex, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }] },
    ctx
  )
  const revokeDigest = await withNew.getRevokeKeyDigest(oldKey.key)
  await withNew.revokeKey(oldKey.key, {
    signature: bytesToHex(secp256k1.sign(revokeDigest, hexToBytes(fresh.privateHex))),
    signerKey: fresh.publicHex,
    signerUserId: user.id
  })
  const sign = async (digest: Uint8Array): Promise<Signature> => ({
    signature: bytesToHex(secp256k1.sign(digest, hexToBytes(fresh.privateHex))),
    signerKey: fresh.publicHex,
    signerUserId: user.id
  })
  return { newPublicKey: fresh.publicHex, sign }
}

/** Raw UserEncryptionKey insert signed by `user`'s ORIGINAL fixture key (the one a later replacement revokes). */
async function insertRawRow (ctx: EngineContext, user: User, publicKey: string, registeredAt: string): Promise<void> {
  const digestRow = await ctx.db
    .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :registeredAt) as d")
    .get({ userId: user.id, alg: ENCRYPTION_KEY_ALG, pubKey: publicKey, registeredAt })
  const signature = signTestDigest(user, digestRow!.d as string)
  await ctx.db.exec(
    `insert into UserEncryptionKey (UserId, Alg, PubKey, RegisteredAt, SignerKey, Signature)
     values (:userId, :alg, :pubKey, :registeredAt, :signerKey, :signature)`,
    { userId: user.id, alg: ENCRYPTION_KEY_ALG, pubKey: publicKey, registeredAt, signerKey: signature.signerKey, signature: signature.signature }
  )
}

async function rowCount (ctx: EngineContext, userId: string): Promise<number> {
  const row = await ctx.db.prepare('select count(*) as n from UserEncryptionKey where UserId = :userId').get({ userId })
  return Number(row!.n)
}

describe('O-01 — a stranded officer intake key is renewed under a new vault generation', () => {
  let fx: ThresholdAuthorityFixture
  let vault: InMemoryTestKeyVault
  let engine: IntakeEngine

  beforeEach(async () => {
    fx = await createThresholdAuthority({
      holderCount: 2,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
    })
    vault = new InMemoryTestKeyVault()
    engine = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
  })

  it('R1/R2: replacement -> renewed, new row signed by the new key, both generations open', async () => {
    const holder = fx.holders[0]!
    const ctx = fx.elec.ctx
    const first = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
    expect(first.status).to.equal('registered')
    const binding = { requestId: 'req-old', digest: 'digest-old' }
    const sealedOld = await createIntakeSealer({ port: intakeQueryPortFromDb(ctx.db), authorityId: fx.authorityId }).seal('before replacement', binding)

    const { newPublicKey, sign } = await replaceSigningKey(ctx, holder.user)

    const before = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
    expect(before.isIntakeRecipient).to.equal(false)
    expect(before.stranded).to.equal(true)

    const renewed = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, sign)
    expect(renewed.status).to.equal('renewed')
    expect(renewed.publicKey).to.not.equal(first.publicKey)
    expect(await rowCount(ctx, holder.user.id)).to.equal(2)
    const newRow = await ctx.db.prepare('select SignerKey from UserEncryptionKey where UserId = :u and PubKey = :p').get({ u: holder.user.id, p: renewed.publicKey })
    expect(newRow!.SignerKey).to.equal(newPublicKey)
    expect(await vault.hasSecret(officerEncryptionKeyAlias(holder.user.id))).to.equal(true)
    expect(await vault.hasSecret(officerEncryptionKeyGenerationAlias(holder.user.id, 1))).to.equal(true)

    const set = await resolveIntakeRecipients(intakeQueryPortFromDb(ctx.db), fx.authorityId)
    expect(set.recipients.find((r) => r.userId === holder.user.id)?.publicKey).to.equal(renewed.publicKey)
    const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
    expect(status.isIntakeRecipient).to.equal(true)
    expect(status.stranded).to.equal(false)
    expect(status.localPublicKey).to.equal(renewed.publicKey)

    const sealedNew = await engine.createSealer(fx.authorityId).seal('after replacement', { requestId: 'req-new', digest: 'digest-new' })
    const opener = engine.createOpener(vault)
    const oldResult = await opener.open(sealedOld, binding)
    expect(oldResult).to.deep.equal({ ok: true, plaintext: 'before replacement' })
    const newResult = await opener.open(sealedNew, { requestId: 'req-new', digest: 'digest-new' })
    expect(newResult).to.deep.equal({ ok: true, plaintext: 'after replacement' })
  })

  it('R3: a key merely superseded by the officer\'s other device is not re-minted', async () => {
    const holder = fx.holders[0]!
    const ctx = fx.elec.ctx
    const first = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
    const other = generateEncryptionKeyPair()
    await insertRawRow(ctx, holder.user, other.publicKey, new Date(Date.now() + 60_000).toISOString())

    const again = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
    expect(again.status).to.equal('already-registered')
    expect(again.superseded).to.equal(true)
    expect(again.publicKey).to.equal(first.publicKey)
    expect(await vault.hasSecret(officerEncryptionKeyGenerationAlias(holder.user.id, 1))).to.equal(false)
    expect(await rowCount(ctx, holder.user.id)).to.equal(2)
    const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
    expect(status.isCurrent).to.equal(false)
    expect(status.stranded).to.equal(false)
  })

  describe('R4: renewStrandedOfficerEncryptionKey', () => {
    function countingVault (inner: IKeyVault): { vault: IKeyVault, calls: () => number } {
      let n = 0
      return {
        calls: () => n,
        vault: {
          putSecret: async (a, s, p) => { n++; return inner.putSecret(a, s, p) },
          getSecret: async (a) => { n++; return inner.getSecret(a) },
          hasSecret: async (a) => { n++; return inner.hasSecret(a) },
          deleteSecret: async (a) => { n++; return inner.deleteSecret(a) }
        }
      }
    }

    it('not an officer: not-an-officer with zero vault calls', async () => {
      const outsiderEngine = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.outsider })
      const counted = countingVault(vault)
      let signed = 0
      const outcome = await outsiderEngine.renewStrandedOfficerEncryptionKey(counted.vault, async () => { signed++; throw new Error('no') })
      expect(outcome).to.equal('not-an-officer')
      expect(counted.calls()).to.equal(0)
      expect(signed).to.equal(0)
    })

    it('officer without a local key: no-local-key', async () => {
      const outcome = await engine.renewStrandedOfficerEncryptionKey(vault, fx.holders[0]!.sign)
      expect(outcome).to.equal('no-local-key')
    })

    it('usable key: not-needed and sign is never called', async () => {
      await engine.registerOfficerEncryptionKey(fx.authorityId, vault, fx.holders[0]!.sign)
      let signed = 0
      const outcome = await engine.renewStrandedOfficerEncryptionKey(vault, async (d) => { signed++; return fx.holders[0]!.sign(d) })
      expect(outcome).to.equal('not-needed')
      expect(signed).to.equal(0)
    })

    it('stranded key: renewed with exactly one sign call', async () => {
      const holder = fx.holders[0]!
      await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
      const { sign } = await replaceSigningKey(fx.elec.ctx, holder.user)
      let signed = 0
      const outcome = await engine.renewStrandedOfficerEncryptionKey(vault, async (d) => { signed++; return sign(d) })
      expect(outcome).to.equal('renewed')
      expect(signed).to.equal(1)
      expect(await vault.hasSecret(officerEncryptionKeyGenerationAlias(holder.user.id, 1))).to.equal(true)
      // a second pass finds a usable key
      expect(await engine.renewStrandedOfficerEncryptionKey(vault, sign)).to.equal('not-needed')
    })
  })

  it('R5: with MAX generations held a further renewal throws vault-error and writes nothing', async () => {
    const holder = fx.holders[0]!
    const ctx = fx.elec.ctx
    let newest = ''
    for (let g = 0; g < MAX_OFFICER_KEY_GENERATIONS; g++) {
      const pair = generateEncryptionKeyPair()
      await vault.putSecret(officerEncryptionKeyGenerationAlias(holder.user.id, g), pair.secretKey, POLICY)
      newest = encryptionPublicKeyFromSecret(await vault.getSecret(officerEncryptionKeyGenerationAlias(holder.user.id, g)) as Uint8Array)
    }
    await insertRawRow(ctx, holder.user, newest, new Date().toISOString())
    const { sign } = await replaceSigningKey(ctx, holder.user)
    const rowsBefore = await rowCount(ctx, holder.user.id)

    let caught: unknown
    try {
      await engine.registerOfficerEncryptionKey(fx.authorityId, vault, sign)
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(IntakeError)
    expect((caught as IntakeError).code).to.equal('vault-error')
    expect(await rowCount(ctx, holder.user.id)).to.equal(rowsBefore)
    expect(await vault.hasSecret(`vt.officer-enc.${holder.user.id}.g${MAX_OFFICER_KEY_GENERATIONS}`)).to.equal(false)
  })

  it('R7: a contested key (two live signers) is not stranded: no renewal, no new generation', async () => {
    const a = fx.holders[0]!
    const b = fx.holders[1]!
    const ctx = fx.elec.ctx
    const pair = generateEncryptionKeyPair()
    await vault.putSecret(officerEncryptionKeyAlias(a.user.id), pair.secretKey, POLICY)
    await insertRawRow(ctx, a.user, pair.publicKey, '2026-01-01T00:00:00.000Z')
    await insertRawRow(ctx, b.user, pair.publicKey, '2026-01-02T00:00:00.000Z')

    let signed = 0
    const counting = async (d: Uint8Array): Promise<Signature> => { signed++; return a.sign(d) }
    const reg = await engine.registerOfficerEncryptionKey(fx.authorityId, vault, counting)
    expect(reg.status).to.equal('already-registered')
    expect(await engine.renewStrandedOfficerEncryptionKey(vault, counting)).to.equal('not-needed')
    expect(signed).to.equal(0)
    expect(await vault.hasSecret(officerEncryptionKeyGenerationAlias(a.user.id, 1))).to.equal(false)
    const status = await engine.getOfficerEncryptionKeyStatus(fx.authorityId, vault)
    expect(status.stranded).to.equal(false)
    expect(status.isContested).to.equal(true)
  })

  it('R6: first registration on a fresh vault writes generation 0 under the legacy alias only', async () => {
    const holder = fx.holders[0]!
    await engine.registerOfficerEncryptionKey(fx.authorityId, vault, holder.sign)
    expect(await vault.hasSecret(`vt.officer-enc.${holder.user.id}`)).to.equal(true)
    expect(await vault.hasSecret(`vt.officer-enc.${holder.user.id}.g1`)).to.equal(false)
    expect(officerEncryptionKeyGenerationAlias(holder.user.id, 0)).to.equal(`vt.officer-enc.${holder.user.id}`)
    expect(officerEncryptionKeyGenerationAlias(holder.user.id, 3)).to.equal(`vt.officer-enc.${holder.user.id}.g3`)
    expect(() => officerEncryptionKeyGenerationAlias(holder.user.id, 1.5)).to.throw()
    expect(() => officerEncryptionKeyGenerationAlias(holder.user.id, MAX_OFFICER_KEY_GENERATIONS)).to.throw()
  })
})
