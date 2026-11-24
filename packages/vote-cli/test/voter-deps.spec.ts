// voter-deps.spec.ts (67-29 Task 1): the voter context adapter, the kv attempt stores, the token-gated
// identity and K_vote helpers and the two temporary mirrors, against fakes plus a REAL temp device vault
// (67-13 openDeviceVault) and 0600 token files. Nothing here prints a key, a token or a device id.

import { expect } from 'chai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { User } from '@votetorrent/vote-core'
import { AssociationEngine, ElectionsEngine, NetworkEngine, P2pAssociationTransport, P2pRegistrationTransport, RegistrationEngine } from '@votetorrent/vote-engine/rn'
import type { RegistrationCeremonyAttemptRecord, VoterStrandPort } from '@votetorrent/workflows/voter'
import { createApprovalContext, NO_APPROVAL, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { readTokenSigningPublicKey } from '../src/approval/signer.js'
import type { VerbContext } from '../src/daemon/verb-context.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { readVoterRegistrationStatus } from '../src/verbs/voter/registration-status.js'
import {
  createLastAttemptStore,
  createVoterAttemptStore,
  VOTER_ATTEMPT_KV_KEY,
  VOTER_LAST_ATTEMPT_KV_KEY,
  type VoterKv
} from '../src/verbs/voter/voter-attempt-store.js'
import {
  assertVoterTestParty,
  deviceKeyTag,
  ensureVoterDeviceId,
  ensureVoterIdentity,
  pickVoterArgs,
  readVoterIdentity,
  VOTER_DEVICE_ID_ALIAS,
  VOTER_IDENTITY_ALIAS,
  VOTER_KVOTE_ALIAS,
  voterDepsFor,
  withVoterApproval,
  type VoterDeps
} from '../src/verbs/voter/voter-deps.js'
import { createCliVoterRequestTransports } from '../src/verbs/voter/voter-transports.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown }

class MapKv implements VoterKv {
  readonly map = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key)
  }
}

const COMPRESSED_RE = /^(02|03)[0-9a-f]{64}$/

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a throw')
}

/** Counts `token()` reads of an approval context. */
function countingApproval(inner: ApprovalContext): { approval: ApprovalContext, reads: () => number } {
  let n = 0
  return {
    approval: {
      token: async () => {
        n++
        return inner.token()
      }
    },
    reads: () => n
  }
}

interface Fixture {
  home: string
  device: DeviceVault
  kv: MapKv
  secrets: SecretRegistry
  tokenFile: string
  wrongTokenFile: string
  deps: VoterDeps
  userRef: { user: User | null }
  close(): void
}

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'vt-29-'))
  const device = openDeviceVault({ home })
  const kv = new MapKv()
  const secrets = new SecretRegistry()
  const tokenFile = join(home, 'secrets', 'voter.token')
  const wrongTokenFile = join(home, 'secrets', 'wrong.token')
  writeApprovalTokenFile(tokenFile)
  writeApprovalTokenFile(wrongTokenFile)
  const userRef: { user: User | null } = { user: null }
  const deps: VoterDeps = {
    partyId: 'vt29-unit',
    secrets,
    kv,
    attemptStore: createVoterAttemptStore(kv),
    lastAttemptStore: createLastAttemptStore(kv),
    node: {} as never,
    networksEngine: {} as never,
    joinBootstrapStore: { rememberJoinBootstrap: async () => undefined },
    rememberJoinedNetwork: async () => undefined,
    cadre: {} as never,
    lockKey: {},
    vault: device.vault,
    user: () => userRef.user,
    saveUser: async (u) => {
      userRef.user = u
    },
    now: () => Date.now(),
    producerForRead: async () => {
      throw new Error('not in this fixture')
    },
    openVoterNetwork: async () => {
      throw new Error('not in this fixture')
    }
  }
  return {
    home,
    device,
    kv,
    secrets,
    tokenFile,
    wrongTokenFile,
    deps,
    userRef,
    close: () => {
      device.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const record = (over: Partial<RegistrationCeremonyAttemptRecord> = {}): RegistrationCeremonyAttemptRecord => ({
  version: 1,
  identityKey: '02' + 'ab'.repeat(32),
  authorityId: 'auth-1',
  electionId: 'election-1',
  registrantId: 'reg-1',
  registrationSubmittedAt: '2026-11-24T00:00:00.000Z',
  registrationStaged: true,
  deviceKey: '03' + 'cd'.repeat(32),
  association: { id: 'assoc-1', authorityId: 'auth-1', registrantId: 'reg-1', deviceKey: '03' + 'cd'.repeat(32), electionId: 'election-1', submittedAt: '2026-11-24T00:00:01.000Z' },
  ...over
})

describe('voter deps', function () {
  this.timeout(60_000)
  const fixtures: Fixture[] = []
  const fresh = (): Fixture => {
    const f = makeFixture()
    fixtures.push(f)
    return f
  }

  after(() => {
    for (const f of fixtures) f.close()
  })

  it('pickVoterArgs refuses an unknown key with bad-arg and never echoes it', () => {
    const e = thrown(() => pickVoterArgs({ network: 'x', 'SECRET-KEY-name': 'SECRET-VALUE' }, ['network']))
    expect(e.name).to.equal('VerbRefusal')
    expect(e.code).to.equal('bad-arg')
    expect(String(e.message)).to.not.include('SECRET')
    expect(thrown(() => pickVoterArgs({ network: 7 }, ['network'])).code).to.equal('bad-arg')
    const picked = pickVoterArgs({ network: 'h', peer: 'v1', tokenFile: '/abs/t', approvalToken: 'abc', waitMs: '5' }, ['network', 'waitMs', 'tokenFile', 'approvalToken'])
    expect(picked).to.deep.equal({ network: 'h', waitMs: '5' })
  })

  it('assertVoterTestParty refuses votetorrent in any case and an empty party', () => {
    for (const p of ['votetorrent', 'VoteTorrent', '  votetorrent  ', 'VOTETORRENT']) expect(thrown(() => assertVoterTestParty(p)).code).to.equal('production-party')
    for (const p of ['', '   ', undefined, 7]) expect(thrown(() => assertVoterTestParty(p)).code).to.equal('party-missing')
    expect(() => assertVoterTestParty('vt29-abcdef01')).to.not.throw()
  })

  it('the voter identity is provisioned once, token-gated, and only the public user is saved', async () => {
    const f = fresh()
    expect(await readVoterIdentity(f.deps)).to.equal(null)
    const first = countingApproval(createApprovalContext({ file: f.tokenFile }))
    const t0 = Date.now()
    const id = await ensureVoterIdentity(f.deps, first.approval)
    expect(id.key).to.match(COMPRESSED_RE)
    expect(first.reads()).to.equal(1)
    const user = f.userRef.user
    expect(user).to.not.equal(null)
    expect(user!.id).to.match(/^[0-9a-f-]{36}$/)
    expect(user!.name).to.equal('vt voter')
    expect(user!.activeKeys).to.have.length(1)
    expect(user!.activeKeys[0]!.key).to.equal(id.key)
    expect(user!.activeKeys[0]!.type).to.equal('M')
    expect(user!.activeKeys[0]!.expiration).to.be.within(t0 + 10 * 365 * 86_400_000 - 5000, Date.now() + 10 * 365 * 86_400_000 + 5000)
    for (const k of Object.keys(user!)) expect(k).to.not.match(/priv|secret|seed/i)
    expect(await readTokenSigningPublicKey({ vault: f.device.vault, alias: VOTER_IDENTITY_ALIAS })).to.equal(id.key)
    // a second call reads no token and returns the same identity
    const second = countingApproval(createApprovalContext({ file: f.tokenFile }))
    const again = await ensureVoterIdentity(f.deps, second.approval)
    expect(again.key).to.equal(id.key)
    expect(again.userId).to.equal(id.userId)
    expect(second.reads()).to.equal(0)
    // a stored user whose key is not the vault's is identity-absent
    f.userRef.user = { ...user!, activeKeys: [{ ...user!.activeKeys[0]!, key: '02' + 'ff'.repeat(32) }] }
    expect((await rejection(readVoterIdentity(f.deps))).code).to.equal('identity-absent')
  })

  it('the voter identity without a token refuses token-absent and writes no key and no user', async () => {
    const f = fresh()
    let called = 0
    const e = await rejection(withVoterApproval(f.deps, {}, async () => { called++ }, { provisionIdentity: true }))
    expect(e.name).to.equal('ApprovalRefusal')
    expect(e.code).to.equal('token-absent')
    expect(called).to.equal(0)
    expect(await readTokenSigningPublicKey({ vault: f.device.vault, alias: VOTER_IDENTITY_ALIAS })).to.equal(null)
    expect(f.userRef.user).to.equal(null)
    // without provisioning, a token on a peer with no identity is identity-absent, before any signer
    const e2 = await rejection(withVoterApproval(f.deps, { tokenFile: f.tokenFile }, async () => { called++ }))
    expect(e2.code).to.equal('identity-absent')
    expect(called).to.equal(0)
    // a wrong token on an existing identity is token-refused (preflight), fn never runs
    await withVoterApproval(f.deps, { tokenFile: f.tokenFile }, async () => undefined, { provisionIdentity: true })
    const e3 = await rejection(withVoterApproval(f.deps, { tokenFile: f.wrongTokenFile }, async () => { called++ }))
    expect(e3.name).to.equal('VerbRefusal')
    expect(e3.code).to.equal('token-refused')
    expect(called).to.equal(0)
  })

  it('the voter producer keeps one K_vote across calls and getCurrentDeviceKey reads no token', async () => {
    const f = fresh()
    const keys: string[] = []
    const tags: string[] = []
    for (let i = 0; i < 3; i++) {
      await withVoterApproval(f.deps, { tokenFile: f.tokenFile }, async ({ producer }) => {
        const { publicKey } = await producer.provisionDeviceKey()
        keys.push(publicKey)
        tags.push(deviceKeyTag(publicKey))
      }, { provisionIdentity: true })
    }
    expect(keys[0]).to.match(COMPRESSED_RE)
    expect(new Set(keys).size).to.equal(1)
    expect(new Set(tags).size).to.equal(1)
    expect(tags[0]).to.match(/^[0-9a-f]{16}$/)
    expect(tags[0]).to.not.equal(keys[0]!.slice(0, 16))
    // the read-only producer answers with no token (NO_APPROVAL) and no prompt
    const { createTokenAttestationProducer } = await import('../src/attestation/token-attestation-producer.js')
    const before = f.device.vault.authPromptCount
    const deviceId = await ensureVoterDeviceId(f.deps)
    const ro = createTokenAttestationProducer({ vault: f.device.vault, token: NO_APPROVAL, alias: VOTER_KVOTE_ALIAS, deviceId })
    expect((await ro.getCurrentDeviceKey()).publicKey).to.equal(keys[0])
    expect(f.device.vault.authPromptCount).to.equal(before)
  })

  it('the device id is created once in the at-rest vault and registered as a secret', async () => {
    const f = fresh()
    const a = await ensureVoterDeviceId(f.deps)
    const b = await ensureVoterDeviceId(f.deps)
    expect(a).to.equal(b)
    expect(a).to.match(/^vt-voter-[0-9a-f-]{36}$/)
    expect(await f.device.vault.hasSecret(VOTER_DEVICE_ID_ALIAS)).to.equal(true)
    const raw = await f.device.vault.getSecret(VOTER_DEVICE_ID_ALIAS) // the at-rest vault: no token needed
    expect(Buffer.from(raw!).toString('utf8')).to.equal(a)
    const entries = [...f.secrets.entries()]
    expect(entries.some(([v, windowed]) => v === a && windowed)).to.equal(true)
    expect(f.secrets.hasWindow(a.slice(0, 16))).to.equal(true)
  })

  it('the attempt store round-trips a record, never throws on a corrupt value and clears', async () => {
    const kv = new MapKv()
    const store = createVoterAttemptStore(kv)
    expect(await store.read()).to.equal(null)
    const rec = record()
    await store.write({ ...rec, extra: 'SECRET-EXTRA' } as never)
    const back = await store.read()
    expect(back).to.deep.equal(rec)
    expect(kv.map.get(VOTER_ATTEMPT_KV_KEY)).to.not.include('SECRET-EXTRA')
    await kv.setItem(VOTER_ATTEMPT_KV_KEY, '{nope')
    expect(await store.read()).to.equal(null)
    await kv.setItem(VOTER_ATTEMPT_KV_KEY, JSON.stringify({ ...rec, version: 2 }))
    expect(await store.read()).to.equal(null)
    await kv.setItem(VOTER_ATTEMPT_KV_KEY, JSON.stringify({ ...rec, association: { ...rec.association, registrantId: 'other' } }))
    expect(await store.read()).to.equal(null)
    await store.write(record({ association: null }))
    expect((await store.read())!.association).to.equal(null)
    await store.clear()
    expect(await store.read()).to.equal(null)
    expect(kv.map.has(VOTER_ATTEMPT_KV_KEY)).to.equal(false)
    const broken: VoterKv = {
      getItem: async () => { throw new Error('kv down') },
      setItem: async () => { throw new Error('kv down') },
      removeItem: async () => { throw new Error('kv down') }
    }
    const brokenStore = createVoterAttemptStore(broken)
    expect(await brokenStore.read()).to.equal(null)
    await brokenStore.write(rec)
    await brokenStore.clear()
  })

  it('the last-attempt record holds ids, the authority, the election, the key tag and the milestone only', async () => {
    const kv = new MapKv()
    const store = createLastAttemptStore(kv)
    expect(await store.read()).to.equal(null)
    await store.write({ registrantId: 'reg-1', associationRequestId: 'assoc-1', authorityId: 'auth-1', electionId: 'election-1', deviceKeyTag: 'abcdef0123456789', milestone: 'registration-staged', deviceKey: 'SECRET-KEY', nonce: 'SECRET-NONCE' } as never)
    const back = await store.read()
    expect(Object.keys(back!).sort()).to.deep.equal(['associationRequestId', 'authorityId', 'deviceKeyTag', 'electionId', 'milestone', 'registrantId'])
    expect(kv.map.get(VOTER_LAST_ATTEMPT_KV_KEY)).to.not.include('SECRET')
    await kv.setItem(VOTER_LAST_ATTEMPT_KV_KEY, JSON.stringify({ registrantId: 'r', associationRequestId: null, authorityId: 'a', electionId: 'e', deviceKeyTag: null, milestone: 'Bad Token!' }))
    expect(await store.read()).to.equal(null)
    // the attempt store's clear leaves it in place
    await createVoterAttemptStore(kv).clear()
    expect((await store.read())).to.equal(null)
    await store.write({ registrantId: 'reg-1', associationRequestId: null, authorityId: 'auth-1', electionId: 'election-1', deviceKeyTag: null, milestone: 'answered' })
    await createVoterAttemptStore(kv).clear()
    expect((await store.read())!.registrantId).to.equal('reg-1')
  })

  it('voter getEngine builds the four engines once per network and refuses other names', async () => {
    const f = fresh()
    let opens = 0
    const hash = 'ab'.repeat(16)
    const est = { db: {} }
    const ref = { hash, relays: [], name: 'n', primaryAuthorityDomainName: 'd' }
    const ctx = {
      partyId: 'vt29-unit',
      secrets: f.secrets,
      kv: f.kv,
      node: {},
      engine: () => ({}),
      built: { stores: { joinBootstrap: f.deps.joinBootstrapStore, joinedNetworks: { rememberJoinedNetwork: async () => undefined } } },
      device: f.device,
      localStorage: {},
      get user() {
        return f.userRef.user
      },
      saveUser: f.deps.saveUser,
      openNetwork: async (h: string) => {
        opens++
        if (h === 'missing') throw Object.assign(new Error('x'), { name: 'NetworkOpenError', code: 'network-not-open' })
        if (h === 'nouser') throw Object.assign(new Error('x'), { name: 'NetworkOpenError', code: 'user-missing' })
        return { networksEngine: {}, est, ref }
      }
    } as unknown as VerbContext
    const deps = voterDepsFor(ctx, {})
    const a = await deps.openVoterNetwork(hash)
    const b = await deps.openVoterNetwork(hash)
    expect(opens).to.equal(1)
    expect(a.strandId).to.equal(hash)
    expect(a.port).to.equal(b.port)
    const n1 = await a.getEngine<NetworkEngine>('network')
    const n2 = await b.getEngine<NetworkEngine>('network')
    expect(n1).to.equal(n2)
    expect(n1).to.be.instanceOf(NetworkEngine)
    expect(await a.getEngine('elections')).to.be.instanceOf(ElectionsEngine)
    expect(await a.getEngine('association')).to.be.instanceOf(AssociationEngine)
    expect(await a.getEngine('registration')).to.be.instanceOf(RegistrationEngine)
    const e = await rejection(a.getEngine('intake'))
    expect(e.name).to.equal('VerbRefusal')
    expect(e.code).to.equal('unknown-engine')
    expect((await rejection(deps.openVoterNetwork('missing'))).code).to.equal('network-not-open')
    expect((await rejection(deps.openVoterNetwork('nouser'))).code).to.equal('identity-absent')
    // a second context object gets its own engine set
    const deps2 = voterDepsFor({ ...ctx, openNetwork: ctx.openNetwork } as unknown as VerbContext, {})
    expect(await (await deps2.openVoterNetwork(hash)).getEngine('network')).to.not.equal(n1)
  })

  it('voter transports refuse a configured REST bridge with rest-bridge-configured', async () => {
    let mutates = 0
    const port: VoterStrandPort = {
      query: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('from AuthorityIntakePolicy')) return [{ Revision: 1, RestBridgeUrl: 'https://bridge.example.invalid/intake', ReassociationMode: 'manual', SetAt: null } as T]
        return []
      },
      mutate: async () => {
        mutates++
      },
      close: async () => undefined
    }
    const e = await rejection(createCliVoterRequestTransports({ port, strandId: 'ab'.repeat(16), authorityId: 'auth-1' }))
    expect(e.name).to.equal('VerbRefusal')
    expect(e.code).to.equal('rest-bridge-configured')
    expect(mutates).to.equal(0)
  })

  it('voter transports stage over the peer route and list own staged ids', async () => {
    const strandId = 'cd'.repeat(16)
    const queries: Array<{ sql: string, params: Record<string, unknown> }> = []
    let mutates = 0
    const port: VoterStrandPort = {
      query: async <T>(sql: string, params: Record<string, unknown>): Promise<T[]> => {
        queries.push({ sql, params })
        if (sql.includes('from AssociationRequestStaging')) return [{ RequestId: 'assoc-1' } as T, { RequestId: 'assoc-2' } as T]
        if (sql.includes('from RegistrationRequestStaging')) return [{ RequestId: 'reg-1' } as T]
        // the strand's Digest() UDF stands in: any 32-byte base64url value lets the digest adapter proceed
        if (sql.startsWith('select Digest(')) return [{ d: Buffer.alloc(32, 7).toString('base64url') } as T]
        return []
      },
      mutate: async () => {
        mutates++
      },
      close: async () => undefined
    }
    const t = await createCliVoterRequestTransports({ port, strandId, authorityId: 'auth-1' })
    expect(t.registrationRoute).to.equal('peer')
    expect(t.registrationTransport).to.be.instanceOf(P2pRegistrationTransport)
    expect(t.associationTransport).to.be.instanceOf(P2pAssociationTransport)
    expect(await t.ownAssociationRequestIds('02' + 'ab'.repeat(32))).to.deep.equal(['assoc-1', 'assoc-2'])
    expect(await t.ownStagedRegistrationRequestIds('02' + 'ab'.repeat(32))).to.deep.equal(['reg-1'])
    const own = queries.filter((q) => q.sql.includes('RequestStaging'))
    expect(own).to.have.length(2)
    for (const q of own) expect(q.params).to.deep.equal({ strandId, requesterKey: '02' + 'ab'.repeat(32) })
    // a submit goes through the sealer (D-32): with no intake recipients nothing is written and no plaintext leaves
    const init = { id: 'reg-x', authorityId: 'auth-1', payload: { registrant: { id: 'reg-x', authorityId: 'auth-1', expiration: '1970-01-01T00:00:00.000Z' }, public: { firstName: 'SECRET-MARKER-pii', lastName: 'L' }, private: { expiration: '1970-01-01T00:00:00.000Z', details: [] } }, submittedAt: '2026-11-24T00:00:00.000Z' }
    const sealed = await rejection(t.registrationTransport.submitRequest(init as never, '02' + 'ab'.repeat(32), async () => ({ signature: 'ab'.repeat(64), signerKey: '02' + 'ab'.repeat(32), signerUserId: 'u' })))
    expect(sealed.name, String(sealed.message)).to.equal('IntakeError')
    expect(sealed.code).to.equal('no-recipients')
    expect(mutates).to.equal(0)
    // the payload reaches the strand only as a Digest() argument (the UDF stand-in above) and as sealed text, never a mutate
    expect(queries.filter((q) => q.sql.startsWith('select Digest(')).length).to.be.at.least(1)
    expect(queries.filter((q) => !q.sql.startsWith('select Digest(')).map((q) => JSON.stringify(q)).join('\n')).to.not.include('SECRET-MARKER')
  })

  it('registration status gives registered, pending, notRegistered and indeterminate from the rows the Voter reads', async () => {
    const key = '03' + 'cd'.repeat(32)
    const authorityId = 'auth-1'
    type Rows = {
      details?: () => Promise<unknown>
      associations?: unknown[]
      registrant?: (id: string) => unknown
      retirement?: unknown
      requests?: unknown[]
      notices?: Array<{ requestId: string, status: string }>
      ownIds?: string[]
      keyAbsent?: boolean
    }
    const run = (rows: Rows) => {
      const engines: Record<string, unknown> = {
        network: { getDetails: rows.details ?? (async () => ({ network: { name: 'N', primaryAuthorityId: authorityId } })) },
        association: {
          getAssociationsByDeviceKey: async () => rows.associations ?? [],
          getDeviceRetirement: async () => rows.retirement,
          listAssociationRequestsByDeviceKey: async () => rows.requests ?? []
        },
        registration: { getRegistrant: async (id: string) => (rows.registrant ?? (() => undefined))(id) }
      }
      return readVoterRegistrationStatus({
        getEngine: async <T>(name: string) => engines[name] as T,
        getCurrentDeviceKey: async () => {
          if (rows.keyAbsent) throw Object.assign(new Error('absent'), { code: 'DEVICE_KEY_ABSENT' })
          return { publicKey: key }
        },
        transports: { ownAssociationRequestIds: async () => rows.ownIds ?? [], associationTransport: { pollDecisions: async () => rows.notices ?? [] } },
        electionId: 'election-1'
      })
    }
    expect(await run({ associations: [{ registrantId: 'r1' }], registrant: () => ({ authorityId, status: 'a' }) })).to.equal('registered')
    expect(await run({ associations: [{ registrantId: 'r1' }], registrant: () => ({ authorityId, status: 's' }) })).to.equal('notRegistered')
    expect(await run({ associations: [{ registrantId: 'r1' }], registrant: () => ({ authorityId: 'other', status: 'a' }) })).to.equal('notRegistered')
    expect(await run({ associations: [{ registrantId: 'r1' }], registrant: () => undefined })).to.equal('indeterminate')
    expect(await run({ keyAbsent: true })).to.equal('notRegistered')
    expect(await run({ retirement: { at: 1 } })).to.equal('notRegistered')
    expect(await run({ requests: [{ authorityId, deviceKey: key, electionId: 'election-1', status: 'p' }] })).to.equal('pending')
    expect(await run({ requests: [{ authorityId, deviceKey: key, electionId: 'election-2', status: 'c' }] })).to.equal('notRegistered')
    expect(await run({ requests: [{ authorityId, deviceKey: key, status: 'c' }] })).to.equal('pending')
    expect(await run({ requests: [{ authorityId, deviceKey: key, status: 'a' }] })).to.equal('indeterminate')
    expect(await run({ ownIds: ['x'], notices: [{ requestId: 'x', status: 'c' }] })).to.equal('pending')
    expect(await run({ ownIds: ['x'], notices: [{ requestId: 'x', status: 'a' }] })).to.equal('notRegistered')
    expect(await run({ ownIds: [], notices: [{ requestId: 'y', status: 'c' }] })).to.equal('notRegistered')
    expect(await run({ details: async () => { throw new Error('db gone') } })).to.equal('indeterminate')
    expect(await run({ keyAbsent: false, details: async () => { throw new Error('SECRET-MARKER-failure') } })).to.equal('indeterminate')
  })
})
