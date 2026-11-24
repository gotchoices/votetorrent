// keyholder-drivers.spec.ts: the three keyholder drivers moved into @votetorrent/workflows (phase 67
// plan 14): the required vault+storage seam (refusal before any engine or vault call), the accept
// self-invite / happy / reconcile rules, the DKG row mapping and due gate, the release outcomes, and
// secrecy of every outcome and error. Nothing in this file prints a key, a share or a signature.
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { IInvitationEngine, IKeyholderDkgEngine, IKeysTasksEngine, KeyholderDkgStatus, ReleaseKeyTask } from '@votetorrent/vote-core'
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn'
import type { KeyVaultStorage } from '../../src/platform/storage.js'
import {
  acceptKeyholderInvitation,
  driveKeyholderDkg,
  keyholderDkgRowState,
  keyReleaseErrorCopyKey,
  listKeyholderIdentities,
  provisionKeyholderIdentity,
  releaseKeyholderShare,
  serializeInviteShare,
} from '../../src/authority/keyholder.js'
import type { KeyholderAcceptDeps, KeyholderDkgDriverDeps, KeyReleaseCeremonyDeps, KeyReleaseCeremonyOutcome } from '../../src/authority/keyholder.js'

const HEX64_RUN = /[0-9a-f]{64}/i
const REQUIRED_SUFFIX = 'vault and storage are required'

function mapStorage(): KeyVaultStorage {
  const raw = new Map<string, string>()
  return {
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

/** Map-backed IKeyVault: records every putSecret alias plus a copy of the bytes, counts getSecret, refuses an existing alias. */
function fakeVault() {
  const store = new Map<string, { bytes: Uint8Array; policy: KeyVaultPolicy }>()
  const puts: Array<{ alias: string; bytes: Uint8Array }> = []
  const counters = { getSecret: 0 }
  const vault: IKeyVault = {
    async putSecret(alias, secret, policy) {
      if (store.has(alias)) throw Object.assign(new Error('alias exists'), { code: 'alias-exists' })
      const copy = Uint8Array.from(secret)
      store.set(alias, { bytes: copy, policy })
      puts.push({ alias, bytes: Uint8Array.from(copy) })
    },
    async getSecret(alias) {
      counters.getSecret++
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
  return { vault, puts, store, counters }
}

type Call = { name: string; args: unknown[] }

/** Recording invitation engine over the four members the accept driver reads. */
function fakeInvitationEngine(options: {
  slotCid: string
  seat?: { electionId: string; selfInvite: boolean } | undefined
  respond?: (...args: unknown[]) => Promise<void>
  invite?: (id: string) => Promise<{ result?: { isAccepted: boolean; invokedId?: string } } | undefined>
}) {
  const calls: Call[] = []
  const engine = {
    async resolveInviteSlot(inviteKey: string, type: string) {
      calls.push({ name: 'resolveInviteSlot', args: [inviteKey, type] })
      return { status: 'live', cid: options.slotCid }
    },
    async getKeyholderSlotSeat(cid: string) {
      calls.push({ name: 'getKeyholderSlotSeat', args: [cid] })
      return options.seat === undefined ? { electionId: 'e1', selfInvite: false } : options.seat
    },
    async getKeyholderInvite(id: string) {
      calls.push({ name: 'getKeyholderInvite', args: [id] })
      return options.invite ? options.invite(id) : { invite: {}, result: undefined }
    },
    async respondToInvite(...args: unknown[]) {
      calls.push({ name: 'respondToInvite', args })
      if (options.respond) await options.respond(...args)
    },
    async getOfficerInvite() {
      calls.push({ name: 'getOfficerInvite', args: [] })
      return undefined
    },
    async getAuthorityInvite() {
      calls.push({ name: 'getAuthorityInvite', args: [] })
      return undefined
    },
  }
  return { engine: engine as unknown as IInvitationEngine, calls }
}

/** A fresh keyholder share: random one-time key, type 'k', expiration one hour out. */
function freshShare() {
  const invitePrivate = bytesToHex(secp256k1.utils.randomSecretKey())
  const inviteKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(invitePrivate)))
  const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/Z$/, '')
  const text = serializeInviteShare({ invitePrivate, inviteKey, expiration, type: 'k', name: 'Kh' })
  return { text, invitePrivate, inviteKey }
}

function dkgStatus(overrides: Partial<KeyholderDkgStatus>): KeyholderDkgStatus {
  return {
    electionId: 'e1',
    revision: 1,
    threshold: 2,
    phase: 'in-progress',
    currentAttempt: 1,
    currentRound: null,
    roster: [],
    awaitingUserIds: [],
    attempts: [],
    disqualified: [],
    electionKey: null,
    ...overrides,
  } as KeyholderDkgStatus
}

function makeTask(userId: string): ReleaseKeyTask {
  return { type: 'release-key', userId, network: { name: 'Net' }, election: { election: { title: 'T' } } } as unknown as ReleaseKeyTask
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

/** Every outcome and rejected error the cases below produce, for the D7 secrecy sweep. */
const observed: unknown[] = []
/** Every secret the fakes saw: share text, invite private key hex, and the hex of every vaulted byte array. */
const secrets: string[] = []
function note<T>(value: T): T {
  observed.push(value)
  return value
}

describe('keyholder drivers (@votetorrent/workflows/authority)', function () {
  this.timeout(20_000)

  it('D1 vault and storage are required: each driver refuses with a TypeError before any engine or vault call', async () => {
    const share = freshShare()
    secrets.push(share.text, share.invitePrivate)
    const errors: unknown[] = []
    const engineCalls: Call[][] = []
    const vaults: ReturnType<typeof fakeVault>[] = []
    let getEngineCalls = 0
    const getEngine = async <T>(): Promise<T> => {
      getEngineCalls++
      throw new Error('getEngine must not be reached')
    }

    for (const drop of ['storage', 'vault'] as const) {
      const { vault, puts, counters } = fakeVault()
      vaults.push({ vault, puts, counters, store: new Map() })
      const storage = mapStorage()
      const inv = fakeInvitationEngine({ slotCid: 'slot-d1' })
      engineCalls.push(inv.calls)
      const acceptDeps: Record<string, unknown> = { invitationEngine: inv.engine, vault, storage }
      const dkgDeps: Record<string, unknown> = { getEngine, vault, storage }
      const releaseDeps: Record<string, unknown> = { getEngine, vault, storage }
      delete acceptDeps[drop]
      delete dkgDeps[drop]
      delete releaseDeps[drop]
      errors.push(await rejection(acceptKeyholderInvitation(acceptDeps as unknown as KeyholderAcceptDeps, share.text)))
      errors.push(await rejection(driveKeyholderDkg(dkgDeps as unknown as KeyholderDkgDriverDeps, 'e1', 'u1')))
      errors.push(await rejection(releaseKeyholderShare(releaseDeps as unknown as KeyReleaseCeremonyDeps, makeTask('u1'))))
    }

    expect(errors).to.have.length(6)
    for (const err of errors) {
      note(err)
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message.endsWith(REQUIRED_SUFFIX)).to.equal(true)
    }
    expect(getEngineCalls).to.equal(0)
    for (const calls of engineCalls) expect(calls).to.have.length(0)
    for (const v of vaults) {
      expect(v.puts).to.have.length(0)
      expect(v.counters.getSecret).to.equal(0)
    }
  })

  it('D2 accept refuses a self-invite before provisioning: zero vault writes, zero identities', async () => {
    const share = freshShare()
    secrets.push(share.text, share.invitePrivate)
    const { vault, puts } = fakeVault()
    const storage = mapStorage()
    const inv = fakeInvitationEngine({ slotCid: 'slot-d2', seat: { electionId: 'e1', selfInvite: true } })

    const err = note(await rejection(acceptKeyholderInvitation({ invitationEngine: inv.engine, vault, storage }, share.text)))
    expect((err as { code?: string }).code).to.equal('self-invite')
    expect(puts).to.have.length(0)
    expect(await listKeyholderIdentities(storage)).to.have.length(0)
    // The resolver reads the 'k' invite status once (refusing an answered slot) before the seat read.
    expect(inv.calls.map((c) => c.name)).to.deep.equal(['resolveInviteSlot', 'getKeyholderInvite', 'getKeyholderSlotSeat'])
  })

  it('D3 accept happy path: respondToInvite once with (slotCid, true, invitePrivate, undefined, userId, provisioning)', async () => {
    const share = freshShare()
    secrets.push(share.text, share.invitePrivate)
    const { vault, puts } = fakeVault()
    const storage = mapStorage()
    const inv = fakeInvitationEngine({ slotCid: 'slot-d3' })

    const outcome = note(await acceptKeyholderInvitation({ invitationEngine: inv.engine, vault, storage }, share.text))
    for (const { bytes } of puts) secrets.push(bytesToHex(bytes))

    expect(outcome.slotCid).to.equal('slot-d3')
    const responds = inv.calls.filter((c) => c.name === 'respondToInvite')
    expect(responds).to.have.length(1)
    const args = responds[0]!.args
    expect(args).to.have.length(6)
    expect(args[0]).to.equal('slot-d3')
    expect(args[1]).to.equal(true)
    expect(args[2]).to.equal(share.invitePrivate)
    expect(args[3]).to.equal(undefined)
    expect(args[4]).to.equal(outcome.userId)
    const provisioning = args[5] as { signingKey: { key: string }; dkgPublicKey: string; sign: unknown }
    expect(typeof provisioning.sign).to.equal('function')
    expect(provisioning.signingKey.key).to.be.a('string')
    const identities = await listKeyholderIdentities(storage)
    expect(identities).to.have.length(1)
    expect(identities[0]!.userId).to.equal(outcome.userId)
    expect(identities[0]!.signingPublicKey).to.equal(provisioning.signingKey.key)
    expect(puts).to.have.length(2)
  })

  it('D4 accept reconcile: a non-committed accept rethrows the ORIGINAL error and discards; a committed one keeps the keys', async () => {
    // Variant A: respondToInvite throws, the re-read shows no result: same error object, nothing kept.
    const shareA = freshShare()
    secrets.push(shareA.text, shareA.invitePrivate)
    const a = fakeVault()
    const storageA = mapStorage()
    const original = Object.assign(new Error('respond failed'), { code: 'respond-failed' })
    const invA = fakeInvitationEngine({
      slotCid: 'slot-d4a',
      respond: async () => {
        throw original
      },
      invite: async () => ({ result: undefined }),
    })
    const errA = note(await rejection(acceptKeyholderInvitation({ invitationEngine: invA.engine, vault: a.vault, storage: storageA }, shareA.text)))
    for (const { bytes } of a.puts) secrets.push(bytesToHex(bytes))
    expect(errA).to.equal(original)
    expect(a.puts).to.have.length(2)
    expect(a.store.size).to.equal(0)
    expect(await listKeyholderIdentities(storageA)).to.have.length(0)
    // One pre-provisioning status read by the resolver, then exactly one reconcile re-read after the throw.
    const respondAt = invA.calls.findIndex((c) => c.name === 'respondToInvite')
    expect(respondAt).to.be.greaterThan(-1)
    expect(invA.calls.slice(respondAt + 1).map((c) => c.name)).to.deep.equal(['getKeyholderInvite'])

    // Variant B: respondToInvite throws but the re-read shows THIS identity committed: resolve, keep.
    const shareB = freshShare()
    secrets.push(shareB.text, shareB.invitePrivate)
    const b = fakeVault()
    const storageB = mapStorage()
    let invoked: string | undefined
    const invB = fakeInvitationEngine({
      slotCid: 'slot-d4b',
      respond: async (...args: unknown[]) => {
        invoked = args[4] as string
        throw Object.assign(new Error('late failure'), { code: 'late-failure' })
      },
      // Unanswered until the respond ran (the resolver's pre-provisioning read must see no result).
      invite: async () => (invoked === undefined ? { result: undefined } : { result: { isAccepted: true, invokedId: invoked } }),
    })
    const outcomeB = note(await acceptKeyholderInvitation({ invitationEngine: invB.engine, vault: b.vault, storage: storageB }, shareB.text))
    for (const { bytes } of b.puts) secrets.push(bytesToHex(bytes))
    expect(outcomeB.userId).to.equal(invoked)
    expect(outcomeB.slotCid).to.equal('slot-d4b')
    expect(b.store.size).to.equal(2)
    const kept = await listKeyholderIdentities(storageB)
    expect(kept).to.have.length(1)
    expect(kept[0]!.userId).to.equal(invoked)
  })

  it('D5 DKG: the row mapping is exhaustive, and an unknown userId reads status as a bystander with zero vault reads', async () => {
    expect(keyholderDkgRowState(null)).to.equal('loading')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'in-progress', self: { userId: 'u1', isParticipant: true, isDisqualified: true, hasShare: false } }))).to.equal('failed')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'blocked', threshold: 1 }))).to.equal('thresholdTooLow')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'blocked', threshold: 3 }))).to.equal('pending')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'not-started' }))).to.equal('pending')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'in-progress' }))).to.equal('inProgress')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'restarting' }))).to.equal('complaint')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'complete' }))).to.equal('complete')
    expect(keyholderDkgRowState(dkgStatus({ phase: 'failed' }))).to.equal('failed')

    const { vault, counters } = fakeVault()
    const storage = mapStorage()
    const statusCalls: unknown[][] = []
    let advanceCalls = 0
    const dkg = {
      async getDkgStatus(electionId: string, selfUserId?: string) {
        statusCalls.push([electionId, selfUserId])
        return dkgStatus({ phase: 'in-progress' })
      },
      async advanceDkg() {
        advanceCalls++
        return { actions: [], status: dkgStatus({ phase: 'in-progress' }) }
      },
    } as unknown as IKeyholderDkgEngine
    const getEngine = async <T>(): Promise<T> => dkg as unknown as T

    const outcome = note(await driveKeyholderDkg({ getEngine, vault, storage }, 'e1', 'no-such-user'))
    expect(statusCalls).to.deep.equal([['e1', undefined]])
    expect(outcome.advanced).to.equal(false)
    expect(outcome.actions).to.deep.equal([])
    expect(outcome.error).to.equal(undefined)
    expect(outcome.status?.phase).to.equal('in-progress')
    expect(advanceCalls).to.equal(0)
    expect(counters.getSecret).to.equal(0)
  })

  it('D6 release: identity-not-found before the engine, released with the signer, auth-denied mapped, copy keys', async () => {
    const { vault, puts } = fakeVault()
    const storage = mapStorage()
    let getEngineCalls = 0
    const completions: unknown[][] = []
    let rejectWith: unknown = undefined
    const keysTasks = {
      async completeKeyRelease(task: ReleaseKeyTask, signer?: unknown) {
        completions.push([task, signer])
        if (rejectWith !== undefined) throw rejectWith
      },
    } as unknown as IKeysTasksEngine
    const getEngine = async <T>(): Promise<T> => {
      getEngineCalls++
      return keysTasks as unknown as T
    }

    const missing = note(await releaseKeyholderShare({ getEngine, vault, storage }, makeTask('nobody')))
    expect(missing).to.deep.equal({ kind: 'failed', code: 'identity-not-found', authDenied: false })
    expect(getEngineCalls).to.equal(0)
    expect(completions).to.have.length(0)

    const provisioned = await provisionKeyholderIdentity({ vault, storage }, 'slot-d6')
    provisioned.release()
    for (const { bytes } of puts) secrets.push(bytesToHex(bytes))
    const task = makeTask(provisioned.userId)

    const released = note(await releaseKeyholderShare({ getEngine, vault, storage }, task))
    expect(released).to.deep.equal({ kind: 'released' })
    expect(completions).to.have.length(1)
    expect(completions[0]![0]).to.equal(task)
    const signer = completions[0]![1] as { userId: string; signingPublicKey: string; sign: unknown }
    expect(typeof signer).to.equal('object')
    expect(typeof signer.sign).to.equal('function')
    expect(signer.userId).to.equal(provisioned.userId)
    expect(signer.signingPublicKey).to.equal(provisioned.record.signingPublicKey)

    rejectWith = { code: 'auth-denied' }
    const denied = note(await releaseKeyholderShare({ getEngine, vault, storage }, task))
    expect(denied).to.deep.equal({ kind: 'failed', code: 'auth-denied', authDenied: true })
    expect(keyReleaseErrorCopyKey(denied as Extract<KeyReleaseCeremonyOutcome, { kind: 'failed' }>)).to.equal('deviceSigningErrorGeneric')
    expect(keyReleaseErrorCopyKey({ kind: 'failed', code: 'unknown', authDenied: false })).to.equal('keyholderReleaseError')

    rejectWith = new Error('no code at all')
    const unknown = note(await releaseKeyholderShare({ getEngine, vault, storage }, task))
    expect(unknown).to.deep.equal({ kind: 'failed', code: 'unknown', authDenied: false })
  })

  it('D7 secrecy: no outcome or error from D1-D6 carries a share, an invite private key, a vaulted byte array or any 64-hex run', () => {
    expect(observed.length).to.be.greaterThan(10)
    expect(secrets.length).to.be.greaterThan(10)
    for (const value of observed) {
      const serialized =
        typeof value === 'object' && value !== null && 'message' in value
          ? JSON.stringify({ name: (value as { name?: unknown }).name, message: value.message, code: (value as { code?: unknown }).code, stack: (value as { stack?: unknown }).stack })
          : JSON.stringify(value)
      expect(serialized).to.be.a('string')
      for (const secret of secrets) {
        expect(serialized).to.not.include(secret)
        expect(serialized).to.not.include(secret.toUpperCase())
      }
      expect(HEX64_RUN.test(serialized)).to.equal(false)
    }
  })
})
