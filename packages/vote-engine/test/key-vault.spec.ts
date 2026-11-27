/**
 * key-vault.spec.ts — Phase 62 Plan 04 (D-13)
 *
 * Proves the `IKeyVault` contract in `src/crypto/vault.ts` against
 * `doc/encryption-formats.md` section 4, using the deep-path, test-only
 * `InMemoryTestKeyVault`: copy semantics, the `'alias-exists'` refusal,
 * `hasSecret` never prompting, alias helpers, and the alias-validity gate
 * uniformly applied by every method.
 */

import { expect } from 'chai'
import {
  KEY_VAULT_ALIAS_PATTERN,
  KEYHOLDER_DKG_RECEIVING_KEY_POLICY,
  KEYHOLDER_SHARE_POLICY,
  KeyVaultError,
  OFFICER_ENCRYPTION_KEY_POLICY,
  assertKeyVaultAlias,
  keyholderDkgReceivingKeyAlias,
  keyholderDkgShareAlias,
  officerEncryptionKeyAlias
} from '../src/crypto/vault.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'

describe('IKeyVault contract (62-04, D-13)', () => {
  describe('InMemoryTestKeyVault — copy semantics', () => {
    it('put then get returns equal bytes', async () => {
      const vault = new InMemoryTestKeyVault()
      const secret = new Uint8Array([1, 2, 3, 4])
      await vault.putSecret('vt.officer-enc.u1', secret, OFFICER_ENCRYPTION_KEY_POLICY)
      const got = await vault.getSecret('vt.officer-enc.u1')
      expect(got).to.not.equal(null)
      expect(Buffer.from(got!).equals(Buffer.from(secret))).to.equal(true)
    })

    it('mutating the array passed to put does not change the stored secret', async () => {
      const vault = new InMemoryTestKeyVault()
      const secret = new Uint8Array([1, 2, 3, 4])
      await vault.putSecret('vt.officer-enc.u1', secret, OFFICER_ENCRYPTION_KEY_POLICY)
      secret[0] = 0xff
      const got = await vault.getSecret('vt.officer-enc.u1')
      expect(got![0]).to.equal(1)
    })

    it('mutating the array returned by get does not change the stored secret', async () => {
      const vault = new InMemoryTestKeyVault()
      const secret = new Uint8Array([1, 2, 3, 4])
      await vault.putSecret('vt.officer-enc.u1', secret, OFFICER_ENCRYPTION_KEY_POLICY)
      const got1 = await vault.getSecret('vt.officer-enc.u1')
      got1![0] = 0xff
      const got2 = await vault.getSecret('vt.officer-enc.u1')
      expect(got2![0]).to.equal(1)
      expect(got1).to.not.equal(got2, 'two get calls must not share a backing buffer')
    })
  })

  describe('alias-exists refusal', () => {
    it('a second put on the same alias rejects alias-exists', async () => {
      const vault = new InMemoryTestKeyVault()
      await vault.putSecret('vt.officer-enc.u1', new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY)
      try {
        await vault.putSecret('vt.officer-enc.u1', new Uint8Array([2]), OFFICER_ENCRYPTION_KEY_POLICY)
        expect.fail('must reject')
      } catch (err) {
        expect(err).to.be.instanceOf(KeyVaultError)
        expect((err as KeyVaultError).code).to.equal('alias-exists')
      }
    })

    it('after deleteSecret, put on the same alias succeeds (paired positive control)', async () => {
      const vault = new InMemoryTestKeyVault()
      await vault.putSecret('vt.officer-enc.u1', new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY)
      expect(await vault.deleteSecret('vt.officer-enc.u1')).to.equal(true)
      await vault.putSecret('vt.officer-enc.u1', new Uint8Array([2]), OFFICER_ENCRYPTION_KEY_POLICY)
      const got = await vault.getSecret('vt.officer-enc.u1')
      expect(got![0]).to.equal(2)
    })
  })

  describe('absence and deletion', () => {
    it('get on an absent alias returns null', async () => {
      const vault = new InMemoryTestKeyVault()
      expect(await vault.getSecret('vt.officer-enc.nobody')).to.equal(null)
    })

    it('deleteSecret returns true then false (idempotent)', async () => {
      const vault = new InMemoryTestKeyVault()
      await vault.putSecret('vt.officer-enc.u1', new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY)
      expect(await vault.deleteSecret('vt.officer-enc.u1')).to.equal(true)
      expect(await vault.deleteSecret('vt.officer-enc.u1')).to.equal(false)
    })
  })

  describe('auth policy', () => {
    it('hasSecret never increments authPromptCount, even for a requireUserAuth alias', async () => {
      const vault = new InMemoryTestKeyVault()
      await vault.putSecret('vt.keyholder-dkg-recv.u1', new Uint8Array([1]), KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
      await vault.hasSecret('vt.keyholder-dkg-recv.u1')
      await vault.hasSecret('vt.keyholder-dkg-recv.nobody')
      expect(vault.authPromptCount).to.equal(0)
    })

    it('getSecret on a requireUserAuth:true alias increments authPromptCount and rejects auth-denied when authorize returns false', async () => {
      const vault = new InMemoryTestKeyVault({ authorize: () => false })
      await vault.putSecret('vt.keyholder-dkg-recv.u1', new Uint8Array([1]), KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
      try {
        await vault.getSecret('vt.keyholder-dkg-recv.u1')
        expect.fail('must reject')
      } catch (err) {
        expect((err as KeyVaultError).code).to.equal('auth-denied')
      }
      expect(vault.authPromptCount).to.equal(1)
    })

    it('getSecret on a requireUserAuth:true alias succeeds when authorize returns true (paired positive control)', async () => {
      const vault = new InMemoryTestKeyVault({ authorize: () => true })
      await vault.putSecret('vt.keyholder-dkg-recv.u1', new Uint8Array([9]), KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
      const got = await vault.getSecret('vt.keyholder-dkg-recv.u1')
      expect(got![0]).to.equal(9)
      expect(vault.authPromptCount).to.equal(1)
    })

    it('a requireUserAuth:false alias never prompts', async () => {
      const vault = new InMemoryTestKeyVault({ authorize: () => false })
      await vault.putSecret('vt.officer-enc.u1', new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY)
      const got = await vault.getSecret('vt.officer-enc.u1')
      expect(got![0]).to.equal(1)
      expect(vault.authPromptCount).to.equal(0)
    })
  })

  describe('alias validity — rejected uniformly by every method', () => {
    const invalidAliases = ['', 'a'.repeat(129), 'has/slash', 'has space']

    for (const alias of invalidAliases) {
      it(`invalid alias ${JSON.stringify(alias)} rejects invalid-alias on every method`, async () => {
        const vault = new InMemoryTestKeyVault()
        for (const op of [
          async () => vault.putSecret(alias, new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY),
          async () => vault.getSecret(alias),
          async () => vault.hasSecret(alias),
          async () => vault.deleteSecret(alias)
        ]) {
          try {
            await op()
            expect.fail(`must reject for alias ${JSON.stringify(alias)}`)
          } catch (err) {
            expect(err).to.be.instanceOf(KeyVaultError)
            expect((err as KeyVaultError).code).to.equal('invalid-alias')
          }
        }
      })
    }

    it('a valid 128-char alias is accepted (boundary positive control)', async () => {
      const alias = 'vt.officer-enc.' + 'u'.repeat(113)
      expect(alias.length).to.equal(128)
      const vault = new InMemoryTestKeyVault()
      await vault.putSecret(alias, new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY)
      expect(await vault.hasSecret(alias)).to.equal(true)
    })
  })

  describe('empty secret', () => {
    it('an empty secret rejects invalid-secret', async () => {
      const vault = new InMemoryTestKeyVault()
      try {
        await vault.putSecret('vt.officer-enc.u1', new Uint8Array(0), OFFICER_ENCRYPTION_KEY_POLICY)
        expect.fail('must reject')
      } catch (err) {
        expect((err as KeyVaultError).code).to.equal('invalid-secret')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Alias helpers
  // ---------------------------------------------------------------------------
  describe('alias helpers', () => {
    it('officerEncryptionKeyAlias', () => {
      expect(officerEncryptionKeyAlias('u1')).to.equal('vt.officer-enc.u1')
    })
    it('keyholderDkgReceivingKeyAlias', () => {
      expect(keyholderDkgReceivingKeyAlias('u1')).to.equal('vt.keyholder-dkg-recv.u1')
    })
    it('keyholderDkgShareAlias', () => {
      expect(keyholderDkgShareAlias('e1', 2, 'u1')).to.equal('vt.keyholder-share.e1.2.u1')
    })
    it("a userId containing '/' throws KeyVaultError invalid-alias", () => {
      try {
        officerEncryptionKeyAlias('has/slash')
        expect.fail('must throw')
      } catch (err) {
        expect(err).to.be.instanceOf(KeyVaultError)
        expect((err as KeyVaultError).code).to.equal('invalid-alias')
      }
    })

    it('assertKeyVaultAlias and KEY_VAULT_ALIAS_PATTERN agree', () => {
      expect(KEY_VAULT_ALIAS_PATTERN.test('vt.officer-enc.u1')).to.equal(true)
      expect(() => assertKeyVaultAlias('vt.officer-enc.u1')).to.not.throw()
      expect(KEY_VAULT_ALIAS_PATTERN.test('bad alias')).to.equal(false)
      expect(() => assertKeyVaultAlias('bad alias')).to.throw(KeyVaultError)
    })
  })

  describe('policy constants', () => {
    it('OFFICER_ENCRYPTION_KEY_POLICY requires no user auth (research A4: unattended intake)', () => {
      expect(OFFICER_ENCRYPTION_KEY_POLICY).to.deep.equal({ requireUserAuth: false })
    })
    it('KEYHOLDER_DKG_RECEIVING_KEY_POLICY and KEYHOLDER_SHARE_POLICY both require user auth', () => {
      expect(KEYHOLDER_DKG_RECEIVING_KEY_POLICY).to.deep.equal({ requireUserAuth: true })
      expect(KEYHOLDER_SHARE_POLICY).to.deep.equal({ requireUserAuth: true })
    })
  })
})
