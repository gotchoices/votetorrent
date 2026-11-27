// keyholder-leaf.spec.ts: the four keyholder leaf modules moved into @votetorrent/workflows (phase 67
// plan 05): the stored-key pin, the required-storage seam (no default store, refusal before any vault
// write), the public-only identity store, the session pass-through, the peer-read classifier and the
// invitation share round trip. Nothing in this file prints a key, a share or a signature.
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn'
import type { KeyVaultStorage } from '../../src/platform/storage.js'
import {
  KEYHOLDER_IDENTITY_STORAGE_KEY,
  InviteShareError,
  classifyPeerReadFailure,
  discardKeyholderIdentity,
  getKeyholderIdentity,
  keyholderSigningKeyAlias,
  listKeyholderIdentities,
  parseInviteShare,
  provisionKeyholderIdentity,
  serializeInviteShare,
  withKeyholderSession,
} from '../../src/authority/keyholder.js'
import type { InviteShareFields } from '../../src/authority/keyholder.js'

const RECORD_KEYS = ['v', 'userId', 'inviteSlotCid', 'signingPublicKey', 'signingKeyType', 'dkgReceivingPublicKey', 'createdAt']
const HEX64_RUN = /[0-9a-f]{64}/i

function mapStorage(): KeyVaultStorage & { readonly raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    async getItem(key) {
      return raw.has(key) ? (raw.get(key) as string) : null
    },
    async setItem(key, value) {
      raw.set(key, value)
    },
    async removeItem(key) {
      raw.delete(key)
    },
  }
}

/** Map-backed IKeyVault: records every putSecret alias plus a copy of the bytes, refuses an existing alias. */
function fakeVault() {
  const store = new Map<string, { bytes: Uint8Array; policy: KeyVaultPolicy }>()
  const puts: Array<{ alias: string; bytes: Uint8Array }> = []
  const vault: IKeyVault = {
    async putSecret(alias, secret, policy) {
      if (store.has(alias)) throw Object.assign(new Error(`alias exists: ${alias}`), { code: 'alias-exists' })
      const copy = Uint8Array.from(secret)
      store.set(alias, { bytes: copy, policy })
      puts.push({ alias, bytes: Uint8Array.from(copy) })
    },
    async getSecret(alias) {
      const entry = store.get(alias)
      return entry === undefined ? null : Uint8Array.from(entry.bytes)
    },
    async hasSecret(alias) {
      return store.has(alias)
    },
    async deleteSecret(alias) {
      return store.delete(alias)
    },
  }
  return { vault, puts, store }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

describe('keyholder leaf modules (@votetorrent/workflows/authority)', function () {
  this.timeout(20_000)

  it('K1 stored key and alias format moved verbatim', () => {
    expect(KEYHOLDER_IDENTITY_STORAGE_KEY).to.equal('vt.keyholder-identities.v1')
    expect(keyholderSigningKeyAlias('u1')).to.equal('vt.keyholder-signing.u1')
  })

  it('K2 provision, get, list, sign, discard round trip against injected storage', async () => {
    const { vault, store } = fakeVault()
    const storage = mapStorage()
    const provisioned = await provisionKeyholderIdentity({ vault, storage }, 'slot-a')
    const { userId, record } = provisioned

    expect(await getKeyholderIdentity(userId, storage)).to.deep.equal(record)
    expect(await listKeyholderIdentities(storage)).to.have.length(1)
    expect(store.size).to.equal(2)

    const digest = globalThis.crypto.getRandomValues(new Uint8Array(32))
    const sig = await provisioned.provisioning.sign(digest)
    expect(sig.signerUserId).to.equal(userId)
    expect(sig.signerKey).to.equal(record.signingPublicKey)
    expect(secp256k1.verify(hexToBytes(sig.signature), digest, hexToBytes(record.signingPublicKey))).to.equal(true)
    provisioned.release()

    await discardKeyholderIdentity({ vault, storage }, userId)
    expect(await listKeyholderIdentities(storage)).to.have.length(0)
    expect(store.size).to.equal(0)
    expect(await getKeyholderIdentity(userId, storage)).to.equal(undefined)
  })

  it('K3 the store holds public material only: exactly seven keys, no hex or base64 of any vaulted byte array', async () => {
    const { vault, puts } = fakeVault()
    const storage = mapStorage()
    const provisioned = await provisionKeyholderIdentity({ vault, storage }, 'slot-b')
    provisioned.release()

    const raw = storage.raw.get(KEYHOLDER_IDENTITY_STORAGE_KEY)
    expect(raw).to.be.a('string')
    const parsed = JSON.parse(raw as string) as { v: number; identities: Array<Record<string, unknown>> }
    expect(parsed.v).to.equal(1)
    expect(parsed.identities).to.have.length(1)
    expect(Object.keys(parsed.identities[0] as object)).to.deep.equal(RECORD_KEYS)

    expect(puts).to.have.length(2)
    for (const { bytes } of puts) {
      expect(bytes.length).to.be.greaterThan(0)
      expect(raw).to.not.include(bytesToHex(bytes))
      expect(raw).to.not.include(bytesToHex(bytes).toUpperCase())
      expect(raw).to.not.include(Buffer.from(bytes).toString('base64'))
      expect(raw).to.not.include(Buffer.from(bytes).toString('base64url'))
    }
  })

  it('K4 storage is required: every storage-taking call refuses with a TypeError before any vault write', async () => {
    const { vault, puts } = fakeVault()
    const noStorage = undefined as unknown as KeyVaultStorage
    const errors = [
      await rejection(provisionKeyholderIdentity({ vault } as unknown as Parameters<typeof provisionKeyholderIdentity>[0], 'slot-c')),
      await rejection(getKeyholderIdentity('u', noStorage)),
      await rejection(listKeyholderIdentities(noStorage)),
      await rejection(discardKeyholderIdentity({ vault } as unknown as Parameters<typeof discardKeyholderIdentity>[0], 'u')),
    ]
    expect(errors).to.have.length(4)
    for (const err of errors) {
      expect((err as Error).name).to.equal('TypeError')
      expect((err as Error).message).to.include('storage is required')
    }
    expect(puts).to.have.length(0)
  })

  it('K5 withKeyholderSession uses the vault session once when present and runs fn directly when absent', async () => {
    const { vault } = fakeVault()
    let sessions = 0
    const sessionVault = {
      ...vault,
      async withKeyholderSession<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
        sessions++
        return fn()
      },
    }
    expect(await withKeyholderSession(sessionVault, 'u1', async () => 'in-session')).to.equal('in-session')
    expect(sessions).to.equal(1)
    expect(await withKeyholderSession(vault, 'u1', async () => 42)).to.equal(42)
    expect(sessions).to.equal(1)
  })

  it('K6 classifyPeerReadFailure: name, nested message, possibly-stale, and null for anything else', () => {
    expect(classifyPeerReadFailure({ name: 'BlockUnavailableError', reason: 'unreachable' })).to.deep.equal({ reason: 'unreachable' })
    const nested = { cause: { cause: { message: 'Block abc is unavailable (no-holders)' } } }
    expect(classifyPeerReadFailure(nested)).to.deep.equal({ reason: 'no-holders' })
    expect(classifyPeerReadFailure({ name: 'BlockPossiblyStaleError' })).to.deep.equal({ reason: 'possibly-stale' })
    expect(classifyPeerReadFailure(new Error('boom'))).to.equal(null)
    expect(classifyPeerReadFailure('not an object')).to.equal(null)
    expect(classifyPeerReadFailure(undefined)).to.equal(null)
  })

  it('K7 invitation share round trip with a random key; the malformed error carries no key material', () => {
    const invitePrivate = bytesToHex(secp256k1.utils.randomSecretKey())
    const inviteKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(invitePrivate)))
    const fields: InviteShareFields = { invitePrivate, inviteKey, expiration: '2026-10-06T08:49:05.107', type: 'k', name: 'Gita' }
    const text = serializeInviteShare(fields)
    const parsed = parseInviteShare(text)
    expect(parsed).to.not.equal(undefined)
    expect(parsed?.invitePrivate).to.equal(invitePrivate)
    expect(parsed?.inviteKey).to.equal(inviteKey)
    expect(parsed?.type).to.equal('k')
    expect(parsed?.name).to.equal('Gita')
    expect(parsed?.expiration).to.equal(fields.expiration)

    const err = new InviteShareError('malformed')
    expect(err.message).to.equal('Invitation text is malformed')
    expect(HEX64_RUN.test(err.message)).to.equal(false)
    expect(err.code).to.equal('malformed')
    expect(err.name).to.equal('InviteShareError')
  })
})
