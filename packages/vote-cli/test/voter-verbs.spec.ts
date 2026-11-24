// voter-verbs.spec.ts (67-29 Task 2): every refusal path and call order of the five voter verbs against fakes
// (scripted engines and transports, a recording-Proxy node that throws on any read outside the eight
// VoterJoinNode members) and a REAL temp device vault with right and wrong 0600 token files. The shared join
// and the shared ceremony are the real functions. Planted markers (`SECRET-MARKER-*`) stand for the
// registration code, the challenge nonce and registrant data; the last case proves none of them, nor the
// token or the device id, reaches any result, refusal or error. Nothing here prints a secret.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssociationAttestationAnswer, AssociationRequestInit, RegistrationRequestInit, User } from '@votetorrent/vote-core'
import { decodeNetworkJoinCode, encodeNetworkJoinCode, type NetworkJoinCode } from '@votetorrent/vote-engine/rn'
import type { VoterJoinCadre, VoterJoinNode } from '@votetorrent/workflows/voter'
import { createApprovalContext, writeApprovalTokenFile } from '../src/approval/token.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import { runAnswerChallenge } from '../src/verbs/voter/answer-challenge.js'
import { VOTER_VERB_NAMES, VOTER_VERBS } from '../src/verbs/voter/index.js'
import { runJoin } from '../src/verbs/voter/join.js'
import { runReadDecision } from '../src/verbs/voter/read-decision.js'
import { runRegister } from '../src/verbs/voter/register.js'
import { VOTER_VERB_ENTRIES } from '../src/verbs/voter/registry.js'
import { runStageAssociation } from '../src/verbs/voter/stage-association.js'
import { createLastAttemptStore, createVoterAttemptStore, type VoterKv } from '../src/verbs/voter/voter-attempt-store.js'
import { ensureVoterDeviceId, ensureVoterIdentity, type VoterDeps } from '../src/verbs/voter/voter-deps.js'
import type { CliVoterRequestTransports } from '../src/verbs/voter/voter-transports.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown, failedName?: unknown }
type Run = (deps: VoterDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>

const NETWORK = 'ab'.repeat(16)
const AUTHORITY = 'auth-' + randomBytes(4).toString('hex')
const ELECTION = 'election-' + randomBytes(4).toString('hex')
const SELF = 'peer-self'
const MEMBER_ID = '12D3KooWMemberMemberMemberMemberMemberMemberMemberMemb'
const MEMBER = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${MEMBER_ID}`
const INVITATION_TEXT = 'encoded-invitation-' + randomBytes(6).toString('hex')
const JOIN_NODE_MEMBERS = new Set(['partyId', 'peerId', 'redeemCadreInvitation', 'getControlDatabase', 'getTrustedOwnerStore', 'getControlNode', 'refreshMembershipGate', 'reconcileControlCohort'])
const ADMITTED_ROW = { peerId: SELF, vouchSig: null, vouchUsage: 'usage-1' }
const CODE: NetworkJoinCode = {
  v: 1,
  invitation: INVITATION_TEXT,
  networkHash: NETWORK,
  name: 'Unit Net',
  genesis: { userId: 'u', signerKey: 'k', authorityId: 'a', adminEffectiveAt: '2026-10-12T10:00:00' },
  digest: Buffer.from(randomBytes(32)).toString('base64url')
}
const CODE_TEXT = encodeNetworkJoinCode(CODE)
const NET_REF = { hash: NETWORK, relays: [], name: CODE.name, primaryAuthorityDomainName: 'example.invalid' }
const SECRET_CODE = 'SECRET-MARKER-code-' + randomBytes(6).toString('hex')
const SECRET_NONCE = 'SECRET-MARKER-nonce-' + randomBytes(6).toString('hex')
const SECRET_PII = 'SECRET-MARKER-pii-' + randomBytes(6).toString('hex')

/** Every result and error of the spec, as text, for the final leak check. */
const captured: string[] = []
const capture = (v: unknown): void => {
  const e = v as Coded
  captured.push(JSON.stringify(v))
  if (typeof e?.message === 'string') captured.push(e.message)
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    const v = await p
    capture(v)
  } catch (e) {
    capture(e)
    return e as Coded
  }
  throw new Error('expected a rejection')
}

async function ok(p: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const v = await p
  capture(v)
  return v
}

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

interface NodeOptions {
  selfRow?: Record<string, unknown> | null
  redeem?: () => Promise<unknown>
}

/** 67-19's technique: records every property read and throws on any name outside VoterJoinNode (plus `then` and symbols). */
function recordingNode(opts: NodeOptions = {}): { node: VoterJoinNode, reads: string[] } {
  const plain = {
    partyId: 'vt29-unit',
    peerId: { toString: () => SELF },
    redeemCadreInvitation: async (invitation: unknown) => (opts.redeem === undefined ? { peerId: MEMBER_ID, invitation } : opts.redeem()),
    getControlDatabase: () => ({
      queryCadrePeers: async () => (opts.selfRow === null || opts.selfRow === undefined ? [] : [opts.selfRow]),
      queryCadreInvites: async () => [{ key: 'invite-key' }],
      queryCadreInviteUsages: async () => [{ usageStampId: 'usage-1', inviteKey: 'invite-key' }],
      querySeedPeers: async () => [{ peerId: SELF }, { peerId: MEMBER_ID }]
    }),
    getTrustedOwnerStore: () => ({ has: () => true, all: () => new Set<string>() }),
    getControlNode: () => ({ getConnections: () => [] }),
    refreshMembershipGate: async () => undefined,
    reconcileControlCohort: async () => undefined
  }
  const reads: string[] = []
  const node = new Proxy(plain, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop, receiver)
      if (!JOIN_NODE_MEMBERS.has(prop)) throw new Error(`join touched a node member outside VoterJoinNode: ${prop}`)
      reads.push(prop)
      return Reflect.get(target, prop, receiver)
    }
  })
  return { node: node as unknown as VoterJoinNode, reads }
}

function fakeCadre(decode?: (encoded: string) => unknown): VoterJoinCadre {
  return {
    decodeCadreInvitation: (encoded: string) => (decode ?? (() => ({ partyId: 'vt29-unit', members: [MEMBER], invite: { expiresAt: '2099-01-01T00:00:00' } })))(encoded),
    verifyInvitationAdmission: () => true,
    mergeSeedPeers: async () => 1
  } as unknown as VoterJoinCadre
}

interface Script {
  regDecisions: Array<{ requestId: string, status: string, cursor: string }>
  assocDecisions: Array<{ requestId: string, status: string, cursor: string, challengeNonce?: string }>
  stagedRegistrations: string[]
  associations: Array<{ registrantId: string }>
  registrant: Record<string, unknown> | undefined
  requests: Array<Record<string, unknown>>
  elections: Array<{ id: string, date: number }>
}

interface Harness {
  home: string
  device: DeviceVault
  kv: MapKv
  secrets: SecretRegistry
  tokenFile: string
  wrongTokenFile: string
  tokenBytes: Uint8Array
  deps: VoterDeps
  calls: string[]
  submitted: { registration: RegistrationRequestInit[], association: AssociationRequestInit[], attestation: AssociationAttestationAnswer[], registrationCodes: string[] }
  script: Script
  node: VoterJoinNode
  nodeReads: string[]
  opens: number
  transportBuilds: number
  remembered: string[]
  bootstrapWrites: number
  userRef: { user: User | null }
  deviceId(): Promise<string>
  close(): void
}

interface HarnessOptions {
  partyId?: string
  node?: { node: VoterJoinNode, reads: string[] }
  cadre?: VoterJoinCadre
  knownNetwork?: boolean
  attemptRead?: ReturnType<typeof createVoterAttemptStore>['read']
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'vt-29v-'))
  const device = openDeviceVault({ home })
  const kv = new MapKv()
  const secrets = new SecretRegistry()
  const tokenFile = join(home, 'secrets', 'voter.token')
  const wrongTokenFile = join(home, 'secrets', 'wrong.token')
  writeApprovalTokenFile(tokenFile)
  writeApprovalTokenFile(wrongTokenFile)
  const tokenBytes = Buffer.from(readFileSync(tokenFile, 'utf8').trim(), 'base64url')
  const calls: string[] = []
  const submitted: Harness['submitted'] = { registration: [], association: [], attestation: [], registrationCodes: [] }
  const script: Script = { regDecisions: [], assocDecisions: [], stagedRegistrations: [], associations: [], registrant: undefined, requests: [], elections: [{ id: ELECTION, date: Date.now() }] }
  const recNode = opts.node ?? recordingNode({ selfRow: ADMITTED_ROW })
  const userRef: { user: User | null } = { user: null }
  const h = { opens: 0, transportBuilds: 0, bootstrapWrites: 0 }
  const remembered: string[] = []
  const engines: Record<string, unknown> = {
    network: { getDetails: async () => { calls.push('network.getDetails'); return { network: { name: 'Unit Net', primaryAuthorityId: AUTHORITY } } } },
    elections: { getElections: async () => { calls.push('elections.getElections'); return script.elections } },
    association: {
      deriveRegistrationCode: async (registrantId: string, sign: (d: Uint8Array) => Promise<unknown>) => {
        calls.push('mint')
        const sig = await sign(randomBytes(32))
        expect((sig as { signature?: unknown }).signature).to.be.a('string')
        return `${SECRET_CODE}-${registrantId.slice(0, 4)}`
      },
      getAssociationsByDeviceKey: async () => { calls.push('association.rows'); return script.associations },
      getDeviceRetirement: async () => undefined,
      listAssociationRequestsByDeviceKey: async () => { calls.push('association.requests'); return script.requests }
    },
    registration: { getRegistrant: async () => { calls.push('registration.getRegistrant'); return script.registrant } }
  }
  const getEngine = async <T>(name: string): Promise<T> => {
    const e = engines[name]
    if (e === undefined) throw new Error(`fake has no engine ${name}`)
    return e as T
  }
  const port = { query: async () => [], mutate: async () => undefined, close: async () => undefined }
  const transports: CliVoterRequestTransports = {
    registrationRoute: 'peer',
    registrationTransport: {
      submitRequest: async (init, _key, _sign, extras) => {
        calls.push('registration.submit')
        submitted.registration.push(init)
        if (extras?.registrationCode !== undefined) submitted.registrationCodes.push(extras.registrationCode)
        return init.id
      },
      pollDecisions: async () => { calls.push('registration.poll'); return script.regDecisions }
    },
    associationTransport: {
      submitRequest: async (init) => {
        calls.push('association.submit')
        submitted.association.push(init)
        return init.id
      },
      submitAttestation: async (answer) => {
        calls.push('attestation.submit')
        submitted.attestation.push(answer)
      },
      pollDecisions: async () => { calls.push('association.poll'); return script.assocDecisions }
    },
    ownStagedRegistrationRequestIds: async () => { calls.push('own.registrations'); return script.stagedRegistrations },
    ownAssociationRequestIds: async () => { calls.push('own.associations'); return [] }
  }
  const attemptStore = createVoterAttemptStore(kv)
  const deps: VoterDeps = {
    partyId: opts.partyId ?? 'vt29-unit',
    secrets,
    kv,
    attemptStore: opts.attemptRead === undefined ? attemptStore : { ...attemptStore, read: opts.attemptRead },
    lastAttemptStore: createLastAttemptStore(kv),
    node: recNode.node,
    networksEngine: { joinFromStrand: async () => { calls.push('joinFromStrand'); return { ok: true as const, outcome: 'joined' as const, networkRef: NET_REF, fingerprint: '0000 0000 0000 0000' } } } as never,
    joinBootstrapStore: { rememberJoinBootstrap: async () => { h.bootstrapWrites++ } },
    rememberJoinedNetwork: async (hash) => { remembered.push(hash) },
    cadre: opts.cadre ?? fakeCadre(),
    lockKey: {},
    vault: device.vault,
    user: () => userRef.user,
    saveUser: async (u) => { userRef.user = u },
    now: () => Date.now(),
    producerForRead: async () => {
      const { createTokenAttestationProducer } = await import('../src/attestation/token-attestation-producer.js')
      const { NO_APPROVAL } = await import('../src/approval/token.js')
      const { VOTER_KVOTE_ALIAS } = await import('../src/verbs/voter/voter-deps.js')
      return createTokenAttestationProducer({ vault: device.vault, token: NO_APPROVAL, alias: VOTER_KVOTE_ALIAS, deviceId: await ensureVoterDeviceId({ vault: device.vault, secrets }) })
    },
    openVoterNetwork: async (hash) => {
      h.opens++
      calls.push('open')
      if (opts.knownNetwork === false || hash !== NETWORK) {
        const { VoterVerbRefusal } = await import('../src/verbs/voter/voter-deps.js')
        throw new VoterVerbRefusal('network-not-open')
      }
      return { getEngine, port, strandId: hash }
    },
    createTransports: async () => {
      h.transportBuilds++
      return transports
    }
  }
  return {
    home,
    device,
    kv,
    secrets,
    tokenFile,
    wrongTokenFile,
    tokenBytes,
    deps,
    calls,
    submitted,
    script,
    node: recNode.node,
    nodeReads: recNode.reads,
    get opens() {
      return h.opens
    },
    get transportBuilds() {
      return h.transportBuilds
    },
    remembered,
    get bootstrapWrites() {
      return h.bootstrapWrites
    },
    userRef,
    deviceId: () => ensureVoterDeviceId({ vault: device.vault, secrets }),
    close: () => {
      device.close()
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function writeRegistrantFile(h: Harness, name = 'registrant.json', body: unknown = { firstName: 'Vtcli', lastName: 'Voter', email: `${SECRET_PII}@example.invalid`, dob: '1990-01-01' }, mode = 0o600): string {
  const p = join(h.home, 'secrets', name)
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), { mode })
  chmodSync(p, mode)
  return p
}

function writeCodeFile(h: Harness, name: string, text: string, mode = 0o600): string {
  const p = join(h.home, 'secrets', name)
  writeFileSync(p, text + '\n', { mode })
  chmodSync(p, mode)
  return p
}

async function provisionIdentity(h: Harness): Promise<string> {
  return (await ensureVoterIdentity(h.deps, createApprovalContext({ file: h.tokenFile }))).key
}

const VERBS: Array<[string, Run]> = [
  ['join', runJoin],
  ['register', runRegister],
  ['stage-association', runStageAssociation],
  ['answer-challenge', runAnswerChallenge],
  ['read-decision', runReadDecision]
]

describe('voter verb units', function () {
  this.timeout(120_000)
  const harnesses: Harness[] = []
  const fresh = (opts?: HarnessOptions): Harness => {
    const h = makeHarness(opts)
    harnesses.push(h)
    return h
  }
  // the registration flow: register -> stage-association -> answer-challenge -> read-decision on ONE voter
  let flow: Harness
  let flowRegistrantId = ''
  let flowTag = ''
  let flowAssociationId = ''

  before(() => {
    flow = fresh()
  })

  after(() => {
    for (const h of harnesses) h.close()
  })

  it('every voter verb refuses an unknown arg with bad-arg before any read', async () => {
    const h = fresh()
    for (const [, run] of VERBS) {
      const e = await rejection(run(h.deps, { network: NETWORK, bogus: 'SECRET-MARKER-arg' }))
      expect(e.name).to.equal('VerbRefusal')
      expect(e.code).to.equal('bad-arg')
      expect(String(e.message)).to.not.include('SECRET')
    }
    expect(h.calls).to.deep.equal([])
    expect(h.nodeReads).to.deep.equal([])
    expect(h.opens).to.equal(0)
  })

  it('join, register, stage-association and answer-challenge refuse party votetorrent with production-party before any token read', async () => {
    const h = fresh({ partyId: 'VoteTorrent' })
    const prompts = h.device.vault.authPromptCount
    for (const [name, run] of VERBS) {
      if (name === 'read-decision') continue
      const args: Record<string, unknown> =
        name === 'join'
          ? { codeFile: '/abs/none', tokenFile: h.tokenFile }
          : name === 'register'
            ? { network: NETWORK, registrantFile: '/abs/none', tokenFile: h.tokenFile }
            : { network: NETWORK, tokenFile: h.tokenFile }
      const e = await rejection(run(h.deps, args))
      expect(e.code, name).to.equal('production-party')
    }
    const empty = fresh({ partyId: '   ' })
    expect((await rejection(runRegister(empty.deps, { network: NETWORK, tokenFile: empty.tokenFile }))).code).to.equal('party-missing')
    expect(h.device.vault.authPromptCount).to.equal(prompts)
    expect(h.userRef.user).to.equal(null)
    expect(h.calls).to.deep.equal([])
    expect(h.nodeReads).to.deep.equal([])
  })

  it('join refuses a relative or group-readable code file and a malformed code before the node is touched', async () => {
    const h = fresh()
    expect((await rejection(runJoin(h.deps, { codeFile: 'relative/code.txt' }))).code).to.equal('code-file-required')
    expect((await rejection(runJoin(h.deps, {}))).code).to.equal('code-file-required')
    expect((await rejection(runJoin(h.deps, { codeFile: join(h.home, 'secrets', 'absent.txt') }))).code).to.equal('code-file-missing')
    expect((await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'loose.txt', CODE_TEXT, 0o644) }))).code).to.equal('code-file-mode')
    expect((await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'bad.txt', 'vtjoin1.not-a-code') }))).code).to.equal('code-malformed')
    expect((await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'prose.txt', 'hello there') }))).code).to.equal('code-malformed')
    expect((await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'ok.txt', CODE_TEXT), timeoutMs: '5' }))).code).to.equal('bad-arg')
    expect(h.nodeReads).to.deep.equal([])
    expect(h.calls).to.deep.equal([])
  })

  it('join refuses preview-mismatch on a wrong expected fingerprint before the node is touched', async () => {
    const h = fresh()
    const code = writeCodeFile(h, 'code.txt', CODE_TEXT)
    const wrong = writeCodeFile(h, 'fp-wrong.txt', 'dead beef dead beef')
    const e = await rejection(runJoin(h.deps, { codeFile: code, expectFingerprintFile: wrong, tokenFile: h.tokenFile }))
    expect(e.code).to.equal('preview-mismatch')
    expect((await rejection(runJoin(h.deps, { codeFile: code, expectFingerprintFile: 'relative.txt', tokenFile: h.tokenFile }))).code).to.equal('code-file-required')
    expect(h.nodeReads).to.deep.equal([])
    expect(h.userRef.user).to.equal(null)
  })

  it('join without an identity and without a token refuses token-absent and touches no node', async () => {
    const h = fresh()
    const e = await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'code.txt', CODE_TEXT) }))
    expect(e.name).to.equal('ApprovalRefusal')
    expect(e.code).to.equal('token-absent')
    expect(h.nodeReads).to.deep.equal([])
    expect(h.calls).to.deep.equal([])
    expect(h.userRef.user).to.equal(null)
  })

  it('join hands only the eight VoterJoinNode members to the shared join', async () => {
    const node = recordingNode({ selfRow: null })
    const h = fresh({ node, cadre: fakeCadre(() => { throw new Error('decode refused') }) })
    const e = await rejection(runJoin(h.deps, { codeFile: writeCodeFile(h, 'code.txt', CODE_TEXT), tokenFile: h.tokenFile }))
    expect(e.name).to.equal('VerbRefusal')
    expect(e.code).to.equal('join-invitation-malformed')
    expect(h.userRef.user).to.not.equal(null)
    for (const read of h.nodeReads) expect(JOIN_NODE_MEMBERS.has(read), read).to.equal(true)
    expect(h.remembered).to.deep.equal([])
    expect(h.calls).to.not.include('joinFromStrand')
  })

  it('join remembers the joined network and returns no code, invitation or member address', async () => {
    const h = fresh()
    const decoded = decodeNetworkJoinCode(CODE_TEXT)
    const fp = writeCodeFile(h, 'fp.txt', decoded.ok ? decoded.fingerprint : '')
    const r = await ok(runJoin(h.deps, { codeFile: writeCodeFile(h, 'code.txt', CODE_TEXT), expectFingerprintFile: fp, tokenFile: h.tokenFile, admissionTimeoutMs: '1000' }))
    expect(Object.keys(r).sort()).to.deep.equal(['admittedVia', 'fingerprintMatch', 'joined', 'ms', 'networkHash', 'outcome', 'steps'])
    expect(r.joined).to.equal(true)
    expect(r.networkHash).to.equal(NETWORK)
    expect(r.outcome).to.equal('joined')
    expect(r.admittedVia).to.equal('already-member')
    expect(r.fingerprintMatch).to.equal(true)
    expect(r.steps).to.be.a('number').and.to.be.at.least(2)
    expect(h.remembered).to.deep.equal([NETWORK])
    expect(h.bootstrapWrites).to.equal(1)
    for (const read of h.nodeReads) expect(JOIN_NODE_MEMBERS.has(read), read).to.equal(true)
    const text = JSON.stringify(r)
    expect(text).to.not.include(INVITATION_TEXT)
    expect(text).to.not.include(MEMBER_ID)
    expect(text).to.not.include(CODE_TEXT.slice(8, 40))
    // the code text and the invitation are registered windowed
    expect(h.secrets.hasWindow(CODE_TEXT.slice(0, 16))).to.equal(true)
    expect(h.secrets.hasWindow(INVITATION_TEXT.slice(0, 16))).to.equal(true)
    // a second join on a voter with an identity needs no token
    const again = await ok(runJoin(h.deps, { codeFile: writeCodeFile(h, 'code2.txt', CODE_TEXT) }))
    expect(again.joined).to.equal(true)
    expect(again.fingerprintMatch).to.equal(false)
  })

  it('register refuses a registrant file that is relative, group-readable, malformed or carries an unknown field', async () => {
    const h = fresh()
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: 'rel.json', tokenFile: h.tokenFile }))).code).to.equal('registrant-file-required')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, tokenFile: h.tokenFile }))).code).to.equal('registrant-file-required')
    expect((await rejection(runRegister(h.deps, { registrantFile: '/abs/x.json', tokenFile: h.tokenFile }))).code).to.equal('network-required')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: join(h.home, 'secrets', 'absent.json'), tokenFile: h.tokenFile }))).code).to.equal('registrant-file-missing')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'loose.json', undefined, 0o644), tokenFile: h.tokenFile }))).code).to.equal('registrant-file-mode')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'bad.json', '{nope'), tokenFile: h.tokenFile }))).code).to.equal('registrant-invalid')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'unknown.json', { firstName: 'A', lastName: 'B', ssn: 'SECRET-MARKER-field' }), tokenFile: h.tokenFile }))).code).to.equal('registrant-invalid')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'noname.json', { firstName: '', lastName: 'B' }), tokenFile: h.tokenFile }))).code).to.equal('registrant-invalid')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'long.json', { firstName: 'A', lastName: 'x'.repeat(257) }), tokenFile: h.tokenFile }))).code).to.equal('registrant-invalid')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h, 'array.json', [1]), tokenFile: h.tokenFile }))).code).to.equal('registrant-invalid')
    expect(h.calls).to.deep.equal([])
    expect(h.transportBuilds).to.equal(0)
  })

  it('register refuses token-absent, token-ambiguous and token-refused before any transport call', async () => {
    const h = fresh()
    const file = writeRegistrantFile(h)
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: file }))).code).to.equal('token-absent')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: file, tokenFile: h.tokenFile, approvalToken: 'A'.repeat(43) }))).code).to.equal('token-ambiguous')
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: file, tokenFile: 'relative.token' }))).code).to.equal('token-file-not-absolute')
    // no identity yet: a token on a voter that never joined is identity-absent
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: file, tokenFile: h.tokenFile }))).code).to.equal('identity-absent')
    await provisionIdentity(h)
    expect((await rejection(runRegister(h.deps, { network: NETWORK, registrantFile: file, tokenFile: h.wrongTokenFile }))).code).to.equal('token-refused')
    expect(h.calls).to.deep.equal([])
    expect(h.transportBuilds).to.equal(0)
    expect(h.opens).to.equal(0)
  })

  it('register stops at registration-staged, returns the registrant id and the key tag, and stages no association', async () => {
    await provisionIdentity(flow)
    const r = await ok(runRegister(flow.deps, { network: NETWORK, registrantFile: writeRegistrantFile(flow), tokenFile: flow.tokenFile }))
    expect(Object.keys(r).sort()).to.deep.equal(['deviceKeyTag', 'electionId', 'milestone', 'ms', 'registrantId', 'steps'])
    expect(r.milestone).to.equal('registration-staged')
    expect(r.electionId).to.equal(ELECTION)
    expect(r.registrantId).to.match(/^[0-9a-f-]{36}$/)
    expect(r.deviceKeyTag).to.match(/^[0-9a-f]{16}$/)
    flowRegistrantId = String(r.registrantId)
    flowTag = String(r.deviceKeyTag)
    expect(flow.calls).to.include.members(['open', 'network.getDetails', 'elections.getElections', 'mint', 'registration.submit'])
    expect(flow.calls).to.not.include('association.submit')
    expect(flow.submitted.registration).to.have.length(1)
    expect(flow.submitted.registration[0]!.id).to.equal(flowRegistrantId)
    expect(flow.submitted.registrationCodes).to.have.length(1)
    expect(flow.submitted.registrationCodes[0]).to.include(SECRET_CODE)
    const stored = await flow.deps.attemptStore.read()
    expect(stored).to.not.equal(null)
    expect(stored!.registrationStaged).to.equal(true)
    expect(stored!.registrantId).to.equal(flowRegistrantId)
    expect(stored!.association).to.not.equal(null)
    flowAssociationId = stored!.association!.id
    expect(flow.secrets.hasWindow(SECRET_CODE.slice(0, 16))).to.equal(true)
    expect(flow.secrets.hasWindow(SECRET_PII.slice(0, 16))).to.equal(true)
    const last = await flow.deps.lastAttemptStore.read()
    expect(last).to.deep.include({ registrantId: flowRegistrantId, authorityId: AUTHORITY, electionId: ELECTION, deviceKeyTag: flowTag, milestone: 'registration-staged' })
  })

  it('a second register on a staged attempt returns alreadyStaged without a ceremony run', async () => {
    const before = flow.calls.length
    const r = await ok(runRegister(flow.deps, { network: NETWORK, registrantFile: writeRegistrantFile(flow), tokenFile: flow.tokenFile }))
    expect(r).to.have.keys(['alreadyStaged', 'registrantId', 'deviceKeyTag', 'ms'])
    expect(r.alreadyStaged).to.equal(true)
    expect(r.registrantId).to.equal(flowRegistrantId)
    expect(r.deviceKeyTag).to.equal(flowTag)
    expect(flow.calls.length).to.equal(before)
  })

  it('stage-association and answer-challenge refuse no-attempt when nothing is stored, before the token', async () => {
    const h = fresh()
    await provisionIdentity(h)
    for (const run of [runStageAssociation, runAnswerChallenge]) {
      const e = await rejection(run(h.deps, { network: NETWORK, tokenFile: h.wrongTokenFile }))
      expect(e.name).to.equal('VerbRefusal')
      expect(e.code).to.equal('no-attempt')
      expect((await rejection(run(h.deps, { network: NETWORK }))).code).to.equal('no-attempt')
    }
    expect((await rejection(runAnswerChallenge(h.deps, { network: NETWORK, waitMs: '1', tokenFile: h.tokenFile }))).code).to.equal('wait-invalid')
    expect(h.calls).to.deep.equal([])
  })

  it('stage-association resumes the stored attempt, submits no registration and stops at association-staged', async () => {
    const submitsBefore = flow.submitted.registration.length
    const r = await ok(runStageAssociation(flow.deps, { network: NETWORK, tokenFile: flow.tokenFile }))
    expect(Object.keys(r).sort()).to.deep.equal(['associationRequestId', 'deviceKeyTag', 'milestone', 'ms', 'registrantId', 'steps'])
    expect(r.milestone).to.equal('association-staged')
    expect(r.registrantId).to.equal(flowRegistrantId)
    expect(r.associationRequestId).to.equal(flowAssociationId)
    expect(r.deviceKeyTag).to.equal(flowTag)
    expect(flow.submitted.registration.length).to.equal(submitsBefore)
    expect(flow.submitted.association).to.have.length(1)
    expect(flow.submitted.association[0]!.registrantId).to.equal(flowRegistrantId)
    expect(flow.calls).to.not.include('attestation.submit')
    expect((await flow.deps.lastAttemptStore.read())!.milestone).to.equal('association-staged')
  })

  it('answer-challenge answers the challenge with the same K_vote and clears the attempt', async () => {
    flow.script.assocDecisions = [{ requestId: flowAssociationId, status: 'c', cursor: '1', challengeNonce: SECRET_NONCE }]
    const r = await ok(runAnswerChallenge(flow.deps, { network: NETWORK, tokenFile: flow.tokenFile, waitMs: '60000' }))
    expect(Object.keys(r).sort()).to.deep.equal(['associationRequestId', 'challengeStatus', 'deviceKeyTag', 'ms', 'outcome', 'registrantId', 'steps'])
    expect(r.outcome).to.equal('answered')
    expect(r.challengeStatus).to.equal('c')
    expect(r.deviceKeyTag).to.equal(flowTag)
    expect(r.associationRequestId).to.equal(flowAssociationId)
    expect(flow.submitted.attestation).to.have.length(1)
    const answer = flow.submitted.attestation[0]!
    expect(answer.requestId).to.equal(flowAssociationId)
    expect(answer.nonce).to.equal(SECRET_NONCE)
    expect(answer.attestation.publicKey).to.equal(flow.submitted.association[0]!.deviceKey)
    expect(answer.attestation.deviceId).to.equal(await flow.deviceId())
    expect(await flow.deps.attemptStore.read()).to.equal(null)
    expect((await flow.deps.lastAttemptStore.read())!.milestone).to.equal('answered')
    expect(flow.secrets.hasWindow(SECRET_NONCE.slice(0, 16))).to.equal(true)
    // the same association submit was re-sent idempotently on resume (same init), never a new request
    expect(flow.submitted.association.every((i) => i.id === flowAssociationId)).to.equal(true)
  })

  it('answer-challenge maps a rejected association, a closed registration and its own deadline to named codes', async () => {
    const seed = async (h: Harness): Promise<string> => {
      await provisionIdentity(h)
      const r = await ok(runRegister(h.deps, { network: NETWORK, registrantFile: writeRegistrantFile(h), tokenFile: h.tokenFile }))
      return (await h.deps.attemptStore.read())!.association!.id + ':' + String(r.registrantId)
    }
    const rejected = fresh()
    const [assocId] = (await seed(rejected)).split(':')
    rejected.script.assocDecisions = [{ requestId: assocId!, status: 'r', cursor: '1' }]
    const e1 = await rejection(runAnswerChallenge(rejected.deps, { network: NETWORK, tokenFile: rejected.tokenFile, waitMs: '60000' }))
    expect(e1.code).to.equal('association-rejected')
    expect((await rejected.deps.attemptStore.read())!.association).to.equal(null)

    const closed = fresh()
    const [, registrantId] = (await seed(closed)).split(':')
    closed.script.regDecisions = [{ requestId: registrantId!, status: 'r', cursor: '1' }]
    const e2 = await rejection(runStageAssociation(closed.deps, { network: NETWORK, tokenFile: closed.tokenFile }))
    expect(e2.code).to.equal('registration-closed')
    expect(await closed.deps.attemptStore.read()).to.equal(null)
    expect(closed.calls).to.not.include('association.submit')

    const slow = fresh()
    await seed(slow)
    const t0 = Date.now()
    const e3 = await rejection(runAnswerChallenge(slow.deps, { network: NETWORK, tokenFile: slow.tokenFile, waitMs: '1000' }))
    expect(e3.code).to.equal('wait-timeout')
    expect(Date.now() - t0).to.be.below(15_000)
    expect(slow.calls).to.not.include('attestation.submit')
    expect(await slow.deps.attemptStore.read()).to.not.equal(null)

    const unreachable = fresh({ knownNetwork: false })
    await provisionIdentity(unreachable)
    expect((await rejection(runRegister(unreachable.deps, { network: NETWORK, registrantFile: writeRegistrantFile(unreachable), tokenFile: unreachable.tokenFile }))).code).to.equal('network-not-open')

    const noElection = fresh()
    await provisionIdentity(noElection)
    noElection.script.elections = []
    expect((await rejection(runRegister(noElection.deps, { network: NETWORK, registrantFile: writeRegistrantFile(noElection), tokenFile: noElection.tokenFile }))).code).to.equal('no-election')
  })

  it('read-decision returns only ids, decisions, the status and the key tag, never registrant fields', async () => {
    flow.script.regDecisions = [{ requestId: flowRegistrantId, status: 'a', cursor: '1' }]
    flow.script.assocDecisions = [{ requestId: flowAssociationId, status: 'c', cursor: '1', challengeNonce: SECRET_NONCE }, { requestId: flowAssociationId, status: 'a', cursor: '2' }]
    flow.script.associations = [{ registrantId: flowRegistrantId }]
    flow.script.registrant = { id: flowRegistrantId, authorityId: AUTHORITY, status: 'a', firstName: SECRET_PII, lastName: SECRET_PII }
    const r = await ok(runReadDecision(flow.deps, { network: NETWORK, waitFor: 'registered', waitMs: '10000' }))
    expect(Object.keys(r).sort()).to.deep.equal(['associationDecision', 'associationRequestId', 'attempt', 'deviceKeyTag', 'ms', 'polls', 'registrantId', 'registrationDecision', 'status'])
    expect(r).to.deep.include({ attempt: 'stored', registrantId: flowRegistrantId, associationRequestId: flowAssociationId, registrationDecision: 'a', associationDecision: 'a', status: 'registered', deviceKeyTag: flowTag, polls: 1 })
    expect(JSON.stringify(r)).to.not.include('SECRET-MARKER')
    expect((await rejection(runReadDecision(flow.deps, { network: NETWORK, waitFor: 'approved' }))).code).to.equal('wait-invalid')
    expect((await rejection(runReadDecision(flow.deps, { network: NETWORK, waitMs: '-1' }))).code).to.equal('wait-invalid')
    // a condition that never holds within the wait is wait-timeout, polled more than once
    const t0 = Date.now()
    const e = await rejection(runReadDecision(flow.deps, { network: NETWORK, waitFor: 'closed', waitMs: '2500' }))
    expect(e.code).to.equal('wait-timeout')
    expect(Date.now() - t0).to.be.at.least(2000)
    // a voter with no attempt reads attempt none and its status
    const none = fresh()
    await provisionIdentity(none)
    const r2 = await ok(runReadDecision(none.deps, { network: NETWORK }))
    expect(r2).to.have.keys(['attempt', 'status', 'ms'])
    expect(r2.attempt).to.equal('none')
    expect(r2.status).to.equal('notRegistered')
  })

  it('a second voter verb on the same peer refuses voter-busy and the lock frees after a throw', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const h = fresh({ attemptRead: async () => { await gate; return null } })
    await provisionIdentity(h)
    const first = runStageAssociation(h.deps, { network: NETWORK, tokenFile: h.tokenFile })
    first.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 20))
    const busy = await rejection(runReadDecision(h.deps, { network: NETWORK }))
    expect(busy.name).to.equal('VerbRefusal')
    expect(busy.code).to.equal('voter-busy')
    release()
    expect((await rejection(first)).code).to.equal('no-attempt')
    const after = await rejection(runAnswerChallenge(h.deps, { network: NETWORK, tokenFile: h.tokenFile }))
    expect(after.code).to.equal('no-attempt')
    // two different peers never share a lock
    const other = fresh()
    await provisionIdentity(other)
    expect((await rejection(runStageAssociation(other.deps, { network: NETWORK, tokenFile: other.tokenFile }))).code).to.equal('no-attempt')
  })

  it('no result, refusal or error carries the token, the registration code, the nonce, the device id or registrant data', async () => {
    expect(captured.length).to.be.at.least(40)
    const secrets: Uint8Array[] = [Buffer.from(SECRET_CODE, 'utf8'), Buffer.from(SECRET_NONCE, 'utf8'), Buffer.from(SECRET_PII, 'utf8'), Buffer.from(await flow.deviceId(), 'utf8')]
    for (const h of harnesses) secrets.push(h.tokenBytes)
    assertNoLeak(captured.join('\n'), secrets)
    expect(captured.join('\n')).to.not.include('SECRET-MARKER')
    expect(VOTER_VERB_NAMES).to.deep.equal(['join', 'register', 'stage-association', 'answer-challenge', 'read-decision'])
    for (const name of VOTER_VERB_NAMES) {
      expect(VOTER_VERB_ENTRIES[name], name).to.equal(VOTER_VERBS[name])
      expect(VOTER_VERB_ENTRIES[name]).to.be.a('function')
    }
    expect(Object.keys(VOTER_VERB_ENTRIES).sort()).to.deep.equal(['answer-challenge', 'join', 'read-decision', 'readback', 'register', 'stage-association', 'stop'])
    expect(Object.isFrozen(VOTER_VERBS)).to.equal(true)
  })
})
