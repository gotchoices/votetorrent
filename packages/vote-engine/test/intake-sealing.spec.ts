/**
 * intake-sealing.spec.ts — Phase 62 Plan 14 Task 2 (D-03, D-04)
 *
 * The requester-side sealer and officer-side opener over `src/intake/sealing.ts`.
 */

import { expect } from 'chai'
import type { User } from '@votetorrent/vote-core'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { IntakeError } from '../src/intake/types.js'
import { intakeQueryPortFromDb, intakeQueryPortFromStrandPort } from '../src/intake/query-port.js'
import type { IntakeQueryPort } from '../src/intake/query-port.js'
import { createIntakeOpener, createIntakeSealer } from '../src/intake/sealing.js'
import { envelopeRecipientUserIds, generateEncryptionKeyPair, KeyVaultError, officerEncryptionKeyAlias } from '../src/crypto/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { UserEngine } from '../src/user/user-engine.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { makeDistinctTestUser } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

const MARKER = 'PLAINTEXT-MARKER-62-14'

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

describe('src/intake/sealing.ts — IntakeSealer / IntakeOpener (D-03, D-04)', () => {
  describe('seal/open round trip', () => {
    let fx: ThresholdAuthorityFixture
    let vaults: InMemoryTestKeyVault[]

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 3,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      // Only the founder (holders[0]) gets a UserKey row from createTestNetwork.
      for (const holder of fx.holders.slice(1)) await giveUserKey(fx.elec.ctx, holder.user)
      vaults = fx.holders.map(() => new InMemoryTestKeyVault())
      for (let i = 0; i < fx.holders.length; i++) {
        const holder = fx.holders[i]!
        await new IntakeEngine({ db: fx.elec.ctx.db, user: holder.user }).registerOfficerEncryptionKey(fx.authorityId, vaults[i]!, holder.sign)
      }
    })

    it('seals a JSON string containing the marker PLAINTEXT-MARKER-62-14; the ciphertext never contains it', async () => {
      const plaintext = JSON.stringify({ marker: 'PLAINTEXT-MARKER-62-14', note: 'sealed payload' })
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(fx.elec.ctx.db), authorityId: fx.authorityId })
      const binding = { requestId: 'req-1', digest: 'digest-1' }
      const sealed = await sealer.seal(plaintext, binding)

      expect(sealed).to.not.include(MARKER)

      const expectedUserIds = fx.holders.map((h) => h.user.id).sort()
      expect(envelopeRecipientUserIds(sealed)).to.have.members(expectedUserIds)

      for (let i = 0; i < fx.holders.length; i++) {
        const holder = fx.holders[i]!
        const opener = createIntakeOpener({ vault: vaults[i]!, userId: holder.user.id })
        const result = await opener.open(sealed, binding)
        expect(result.ok, `holder ${i} must open`).to.equal(true)
        if (result.ok) expect(result.plaintext).to.equal(plaintext)
      }
    })

    it('D-04 hard failure: zero registered officers rejects no-recipients, and PLAINTEXT-MARKER-62-14 appears in no error property', async () => {
      const bareFx = await createThresholdAuthority({
        holderCount: 1,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(bareFx.elec.ctx.db), authorityId: bareFx.authorityId })
      const plaintext = JSON.stringify({ marker: MARKER })
      let caught: unknown
      try {
        await sealer.seal(plaintext, { requestId: 'req-2', digest: 'digest-2' })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(IntakeError)
      const intakeErr = caught as IntakeError
      expect(intakeErr.code).to.equal('no-recipients')
      expect(intakeErr.message).to.not.include(MARKER)
      expect(JSON.stringify(intakeErr)).to.not.include(MARKER)
    })

    it('fresh resolution: a holder who registers AFTER the sealer was created is a recipient of the NEXT seal', async () => {
      const laterFx = await createThresholdAuthority({
        holderCount: 2,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(laterFx.elec.ctx.db), authorityId: laterFx.authorityId })
      const binding = { requestId: 'req-3', digest: 'digest-3' }

      let caught: unknown
      try {
        await sealer.seal('{}', binding)
      } catch (err) { caught = err }
      expect((caught as IntakeError)?.code).to.equal('no-recipients')

      const vault = new InMemoryTestKeyVault()
      await new IntakeEngine({ db: laterFx.elec.ctx.db, user: laterFx.holders[0]!.user }).registerOfficerEncryptionKey(laterFx.authorityId, vault, laterFx.holders[0]!.sign)

      const sealed = await sealer.seal('{"x":1}', binding)
      expect(envelopeRecipientUserIds(sealed)).to.deep.equal([laterFx.holders[0]!.user.id])
    })

    it('arguments are validated BEFORE resolution: an empty plaintext or binding field gives invalid-argument with zero port queries', async () => {
      let queryCount = 0
      const countingPort: IntakeQueryPort = {
        async query<T> (): Promise<T[]> { queryCount++; return [] }
      }
      const sealer = createIntakeSealer({ port: countingPort, authorityId: fx.authorityId })

      for (const [plaintext, binding] of [
        ['', { requestId: 'r', digest: 'd' }],
        [null as unknown as string, { requestId: 'r', digest: 'd' }],
        ['ok', { requestId: '', digest: 'd' }],
        ['ok', { requestId: 'r', digest: '' }]
      ] as const) {
        let caught: unknown
        try {
          await sealer.seal(plaintext, binding)
        } catch (err) { caught = err }
        expect(caught).to.be.instanceOf(IntakeError)
        expect((caught as IntakeError).code).to.equal('invalid-argument')
      }
      expect(queryCount).to.equal(0)
    })

    it('too many: a fake port with 65 current officers and valid distinct keys gives too-many-recipients', async () => {
      const officers: string[] = []
      const keysByUser: Record<string, Array<{ PubKey: string, Alg: string, RegisteredAt: string, SignerKey: string }>> = {}
      const validSignersByUser: Record<string, string[]> = {}
      for (let i = 0; i < 65; i++) {
        const userId = `officer-${i}`
        const generated = generateEncryptionKeyPair()
        officers.push(userId)
        keysByUser[userId] = [{ PubKey: generated.publicKey, Alg: 'secp256k1-ecdh-hkdf-sha256-aes256gcm', RegisteredAt: '2026-01-01T00:00:00.000Z', SignerKey: 'sig' }]
        validSignersByUser[userId] = ['sig']
      }
      const fakePort: IntakeQueryPort = {
        async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
          if (sql.includes('from Officer')) return officers.map((id) => ({ UserId: id })) as unknown as T[]
          if (sql.includes('from UserEncryptionKey')) return (keysByUser[params.userId as string] ?? []) as unknown as T[]
          if (sql.includes('from UserKey')) {
            const valid = (validSignersByUser[params.userId as string] ?? []).includes(params.signerKey as string)
            return (valid ? [{ found: 1 }] : []) as unknown as T[]
          }
          throw new Error(`unexpected query: ${sql}`)
        }
      }
      const sealer = createIntakeSealer({ port: fakePort, authorityId: 'auth-many' })
      let caught: unknown
      try {
        await sealer.seal('{}', { requestId: 'r', digest: 'd' })
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(IntakeError)
      expect((caught as IntakeError).code).to.equal('too-many-recipients')
    })

    it('D-32 read-only: a strand-port-shaped object seals successfully and mutate/close are never called', async () => {
      const dbPort = intakeQueryPortFromDb(fx.elec.ctx.db)
      let mutateCalls = 0
      let closeCalls = 0
      const strandPort = {
        query: (sql: string, params: Record<string, unknown>) => dbPort.query(sql, params),
        mutate: async () => { mutateCalls++; throw new Error('must never be called') },
        close: async () => { closeCalls++; throw new Error('must never be called') }
      }
      const sealer = createIntakeSealer({ port: intakeQueryPortFromStrandPort(strandPort), authorityId: fx.authorityId })
      const sealed = await sealer.seal('{"a":1}', { requestId: 'req-4', digest: 'digest-4' })
      expect(typeof sealed).to.equal('string')
      expect(mutateCalls).to.equal(0)
      expect(closeCalls).to.equal(0)
    })

    it('rotation: an envelope sealed to a holder\'s OLDER key, opened by a vault holding the NEWER key, gives not-a-recipient', async () => {
      const holder = fx.holders[0]!
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(fx.elec.ctx.db), authorityId: fx.authorityId })
      const binding = { requestId: 'req-5', digest: 'digest-5' }
      const sealed = await sealer.seal('{"x":1}', binding)

      // Register a NEWER key for the SAME holder in a FRESH vault (a new device) —
      // this becomes the current key; the old vault's key is now stale.
      const newVault = new InMemoryTestKeyVault()
      await new IntakeEngine({ db: fx.elec.ctx.db, user: holder.user }).registerOfficerEncryptionKey(fx.authorityId, newVault, holder.sign)

      const opener = createIntakeOpener({ vault: newVault, userId: holder.user.id })
      const result = await opener.open(sealed, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('not-a-recipient')
    })
  })

  describe('opener failures — never throwing', () => {
    let fx: ThresholdAuthorityFixture
    let vault: InMemoryTestKeyVault
    let sealed: string
    const binding = { requestId: 'req-open', digest: 'digest-open' }

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 1,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      vault = new InMemoryTestKeyVault()
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user }).registerOfficerEncryptionKey(fx.authorityId, vault, fx.holders[0]!.sign)
      const sealer = createIntakeSealer({ port: intakeQueryPortFromDb(fx.elec.ctx.db), authorityId: fx.authorityId })
      sealed = await sealer.seal('{"ok":true}', binding)
    })

    it('an outsider\'s opener (not a recipient) gives not-a-recipient', async () => {
      const outsider = makeDistinctTestUser()
      const outsiderVault = new InMemoryTestKeyVault()
      const generated = generateEncryptionKeyPair()
      await outsiderVault.putSecret(officerEncryptionKeyAlias(outsider.id), generated.secretKey, { requireUserAuth: false })
      const opener = createIntakeOpener({ vault: outsiderVault, userId: outsider.id })
      const result = await opener.open(sealed, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('not-a-recipient')
    })

    it('a vault with no secret for the alias gives no-local-key', async () => {
      const emptyVault = new InMemoryTestKeyVault()
      const opener = createIntakeOpener({ vault: emptyVault, userId: fx.holders[0]!.user.id })
      const result = await opener.open(sealed, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('no-local-key')
    })

    it('a vault whose getSecret rejects KeyVaultError auth-denied gives vault-error', async () => {
      const deniedVault = {
        putSecret: () => { throw new Error('not used') },
        getSecret: async () => { throw new KeyVaultError('auth-denied', 'denied') },
        hasSecret: async () => true,
        deleteSecret: async () => false
      }
      const opener = createIntakeOpener({ vault: deniedVault, userId: fx.holders[0]!.user.id })
      const result = await opener.open(sealed, binding)
      expect(result.ok).to.equal(false)
      if (!result.ok) {
        expect(result.reason).to.equal('vault-error')
        expect(result.detail).to.include('auth-denied')
      }
    })

    it('a changed requestId or digest gives authentication-failed', async () => {
      const opener = createIntakeOpener({ vault, userId: fx.holders[0]!.user.id })
      const byRequestId = await opener.open(sealed, { requestId: 'other-req', digest: binding.digest })
      expect(byRequestId.ok).to.equal(false)
      if (!byRequestId.ok) expect(byRequestId.reason).to.equal('authentication-failed')
      const byDigest = await opener.open(sealed, { requestId: binding.requestId, digest: 'other-digest' })
      expect(byDigest.ok).to.equal(false)
      if (!byDigest.ok) expect(byDigest.reason).to.equal('authentication-failed')
    })

    it('a 10-entry hostile input table all return ok:false, never throw, and no detail leaks the marker', async () => {
      const opener = createIntakeOpener({ vault, userId: fx.holders[0]!.user.id })
      const v2Envelope = JSON.stringify({ v: 2, alg: 'vt-env-1', nonce: 'x', kc: 'x', ct: 'x', recipients: [] })
      const truncated = sealed.slice(0, Math.floor(sealed.length / 2))
      const hostileInputs: string[] = [
        'not json at all',
        '{}',
        'null',
        '[]',
        v2Envelope,
        truncated,
        '',
        'a'.repeat(1024 * 1024),
        String(12345),
        JSON.stringify({ v: 1, alg: 'vt-env-1', nonce: 'x', kc: 'x', ct: 'x', recipients: [] })
      ]
      for (const input of hostileInputs) {
        let result: Awaited<ReturnType<typeof opener.open>> | undefined
        let threw = false
        try {
          result = await opener.open(input, binding)
        } catch {
          threw = true
        }
        expect(threw, `hostile input must never throw: ${input.slice(0, 20)}`).to.equal(false)
        expect(result?.ok, `hostile input must be ok:false: ${input.slice(0, 20)}`).to.equal(false)
        if (result && !result.ok) expect(result.detail).to.not.include(MARKER)
      }
    })
  })
})
