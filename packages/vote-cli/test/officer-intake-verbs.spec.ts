// officer-intake-verbs.spec.ts (67-27 Task 2): every refusal path and the call order of the five officer
// intake verbs against FAKE engines and transports (the 67-18 spec's model), with a REAL device vault, a
// REAL provisioned officer key and REAL 0600 token files, so the token preflight and the signer are the
// shipped ones. PII, the rejection reason and a nonce are planted as markers and must never leak into a
// result or an error. The last cases pin the group record against the registry and round-trip each verb
// through a real ctl server over the injectable deps seam.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerStagingTransports } from '@votetorrent/workflows/authority'
import { createApprovalContext, generateApprovalToken, writeApprovalTokenFile } from '../src/approval/token.js'
import type { AttestationVerdictCounts, OfficerAttestationPosture } from '../src/attestation/policy.js'
import { callCtl } from '../src/ctl/ctl-client.js'
import { startCtlServer, type CtlServerHandle } from '../src/ctl/ctl-server.js'
import { defineVerbRegistry } from '../src/ctl/verb-registry.js'
import { ensureAuthorityUser } from '../src/network/authority-user.js'
import type { OfficerVerbContext } from '../src/network/network-verb-support.js'
import { runApprove } from '../src/verbs/officer/approve.js'
import { OFFICER_ELECTION_VERBS } from '../src/verbs/officer/election-verbs.js'
import { runEnableIntake } from '../src/verbs/officer/enable-intake.js'
import { bindIntakeVerb, type IntakeDeps } from '../src/verbs/officer/intake-deps.js'
import { OFFICER_INTAKE_VERBS } from '../src/verbs/officer/intake-verbs.js'
import { OFFICER_NETWORK_VERBS } from '../src/verbs/officer/network-verbs.js'
import { runPeerSync } from '../src/verbs/officer/peer-sync.js'
import { runRefuse } from '../src/verbs/officer/refuse.js'
import { OFFICER_VERB_ENTRIES } from '../src/verbs/officer/registry.js'
import { runRegistrations } from '../src/verbs/officer/registrations.js'
import { makeFakeOfficerCtx, type FakeOfficerCtx } from './support/fake-officer-ctx.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown, blockers?: unknown }
type Run = (deps: IntakeDeps, args: Record<string, unknown>) => Promise<Record<string, unknown>>
type Loose = Record<string, any>

const PARTY = 'vt-27-v'
const HASH = randomBytes(16).toString('hex')
const AID8 = randomBytes(4).toString('hex')
const AUTH = AID8 + randomBytes(12).toString('hex')
const PII = 'SECRET-MARKER-pii-' + randomBytes(6).toString('hex')
const REASON = 'SECRET-MARKER-reason-' + randomBytes(6).toString('hex')
const NONCE = 'SECRET-MARKER-nonce-' + randomBytes(12).toString('hex')

const outputs: string[] = []
const secrets: Uint8Array[] = []

const VERBS: Record<string, Run> = {
  'enable-intake': runEnableIntake,
  'peer-sync': runPeerSync,
  approve: runApprove,
  refuse: runRefuse,
  registrations: runRegistrations
}

interface World {
  calls: string[]
  requests: Map<string, Loose>
  tasks: Loose[]
  intakeEnabled: boolean
  skipping: number
  counts: { token: { accepted: number, refused: number }, platform: { accepted: number, refused: number } }
  rejected: Array<{ requestId: string, reason: string, checklist: string[] }>
  signCalls: number
  priorRejectionsFail: boolean
  likelyDuplicatesFail: boolean
  closureFail: boolean
  closure: Loose | undefined
  signingStatus: Loose | null
  syncHook?: () => void
  syncSigns: boolean
  associations: number
  challenges: number
  listPages: Loose[][]
}

function pendingRequest(requestId: string, over: Loose = {}): Loose {
  return {
    requestId,
    authorityId: AUTH,
    requesterKey: 'rk-' + requestId,
    issuerType: 'registrant',
    payload: { registrant: { id: 'reg-' + requestId, authorityId: AUTH, expiration: '2030-01-01T00:00:00Z' }, public: { lastName: PII, firstName: PII }, private: { expiration: '2030-01-01T00:00:00Z', details: [{ name: 'n', value: PII }] } },
    payloadCid: 'cid-' + requestId,
    status: 'p',
    submittedAt: '2026-11-24T00:00:00Z',
    receivedAt: '2026-11-24T00:00:01Z',
    hasPriorRejections: false,
    payloadAccess: 'opened',
    ...over
  }
}

function registrantTask(requestId: string): Loose {
  return { id: 'task-' + requestId, type: 'signature', signatureType: 'registrant', requestId, networkName: 'n', title: 't' }
}

function makeWorld(): World {
  return {
    calls: [],
    requests: new Map([['req-1', pendingRequest('req-1')]]),
    tasks: [registrantTask('req-1')],
    intakeEnabled: false,
    skipping: 0,
    counts: { token: { accepted: 0, refused: 0 }, platform: { accepted: 0, refused: 0 } },
    rejected: [],
    signCalls: 0,
    priorRejectionsFail: false,
    likelyDuplicatesFail: false,
    closureFail: false,
    closure: undefined,
    signingStatus: null,
    syncSigns: false,
    associations: 0,
    challenges: 0,
    listPages: []
  }
}

function freezeCounts(c: World['counts']): AttestationVerdictCounts {
  return Object.freeze({ token: Object.freeze({ ...c.token }), platform: Object.freeze({ ...c.platform }) })
}

function fakeDb(w: World): Loose {
  return {
    prepare(sql: string) {
      return {
        all: () => (sql.includes('ElectionAttestationPolicy')
          ? [...Array(w.skipping)].map((_, i) => ({ electionId: `e${i}`, required: 0 })).concat([{ electionId: 'e-req', required: 1 }])
          : []),
        get: async () => (sql.includes("Status = 'c'") ? { n: w.challenges } : sql.includes('from Association') ? { n: w.associations } : undefined)
      }
    }
  }
}

function fakeTransports(w: World): PeerStagingTransports {
  const report = async (): Promise<Loose> => ({ delivered: [], unreadable: [] })
  const t: Loose = {
    strandId: HASH,
    registration: { readStagedRequestsReport: report, publishDecision: async () => 'pub', close: async () => undefined },
    association: { readStagedRequestsReport: report, readStagedAttestationsReport: report, close: async () => undefined }
  }
  w.calls.push('createTransports')
  return t as PeerStagingTransports
}

function fakeEngines(w: World, sign: (d: Uint8Array) => Promise<unknown>): Record<string, Loose> {
  const log = (s: string): void => {
    w.calls.push(s)
  }
  const registration: Loose = {
    getRegistrationRequest: async (id: string) => {
      log('getRegistrationRequest')
      return w.requests.get(id)
    },
    getPriorRejections: async () => {
      log('getPriorRejections')
      if (w.priorRejectionsFail) throw new Error('prior rejections unavailable')
      return []
    },
    getDuplicateClosure: async () => {
      log('getDuplicateClosure')
      if (w.closureFail) throw new Error('closure unavailable')
      return w.closure
    },
    getLikelyDuplicateRequests: async () => {
      log('getLikelyDuplicateRequests')
      if (w.likelyDuplicatesFail) throw new Error('duplicates unavailable')
      return []
    },
    getStaleCloseAvailability: async () => undefined,
    listRegistrationRequests: async (_filter: Loose, page: Loose) => {
      log('listRegistrationRequests')
      const idx = page.cursor === undefined ? 0 : Number(page.cursor)
      const rows = w.listPages[idx] ?? []
      const next = idx + 1 < w.listPages.length ? String(idx + 1) : undefined
      return { rows, ...(next !== undefined ? { nextCursor: next } : {}) }
    },
    rejectRegistrationRequest: async (id: string, decision: Loose, s: (d: Uint8Array) => Promise<unknown>) => {
      log('rejectRegistrationRequest')
      await s(randomBytes(32))
      w.rejected.push({ requestId: id, reason: decision.rejectionReason, checklist: decision.checklist })
      const r = w.requests.get(id)
      if (r !== undefined) r.status = 'r'
    },
    listUnpublishedRegistrationDecisions: async () => [],
    publishRegistrationDecision: async () => {
      log('publishRegistrationDecision')
      return { published: true }
    },
    completeDuplicateClosures: async () => ({ failed: [] })
  }
  const signatureTasksEngine: Loose = {
    getRequestedSignatures: async () => {
      log('getRequestedSignatures')
      return w.tasks
    },
    getRegistrantSigningStatus: async () => w.signingStatus,
    getSignatureDigest: async () => {
      log('getSignatureDigest')
      return randomBytes(32)
    },
    completeSignature: async (task: Loose, completion: Loose) => {
      log(`completeSignature:${String(completion.isAccepted)}:${(completion.decision?.checklist ?? []).join('+')}`)
      if (completion.isAccepted === true) {
        const r = w.requests.get(task.requestId)
        if (r !== undefined) r.status = 'a'
      }
    }
  }
  const intake: Loose = {
    getOfficerEncryptionKeyStatus: async () => {
      log('getOfficerEncryptionKeyStatus')
      return { isIntakeRecipient: w.intakeEnabled }
    },
    registerOfficerEncryptionKey: async (_a: string, _v: unknown, s: (d: Uint8Array) => Promise<unknown>) => {
      log('registerOfficerEncryptionKey')
      await s(randomBytes(32))
      w.intakeEnabled = true
      return {}
    },
    createOpener: () => ({ userId: 'u', open: async () => ({ ok: false, reason: 'no-local-key' }) })
  }
  const association: Loose = {
    getAssociationRequest: async () => undefined,
    submitAssociationRequest: async () => undefined,
    submitAssociationAttestation: async () => undefined,
    processPendingAssociationRequests: async (_a: string, s: (d: Uint8Array) => Promise<unknown>) => {
      log('processPendingAssociationRequests')
      w.syncHook?.()
      if (w.syncSigns) {
        try {
          await s(randomBytes(32))
        } catch {
          // a per-request signing refusal is the engine's to record; the sync goes on
        }
      }
      return { challengesIssued: 0, associated: 0, rejected: 0 }
    },
    processPendingReassociations: async () => ({ reviewed: 0 })
  }
  void sign
  return { registration, signatureTasksEngine, intake, association }
}

describe('officer intake verbs', function () {
  this.timeout(60_000)
  let root: string
  let ctx: FakeOfficerCtx
  let rightPath: string
  let wrongPath: string
  let rightB64: string
  let reasonPath: string
  let userId = ''
  let signerKey = ''

  function makeDeps(w: World, posture: OfficerAttestationPosture = { kind: 'production', partyId: PARTY }, partyId = PARTY): IntakeDeps {
    const engines = fakeEngines(w, async () => undefined)
    return {
      partyId,
      posture,
      open: async () => ({ db: fakeDb(w) as never, authorityId: AUTH, strandId: HASH }),
      getEngine: async <T>(name: string): Promise<T> => {
        w.calls.push(`getEngine:${name}`)
        const e = engines[name]
        if (e === undefined) throw new Error('fake: unknown engine')
        return e as T
      },
      attestationCounts: () => freezeCounts(w.counts),
      intakeVault: ctx.device.vault,
      createTransports: () => fakeTransports(w),
      officer: async () => ({ userId, signerKey })
    }
  }

  async function refused(p: Promise<unknown>): Promise<Coded> {
    try {
      const out = await p
      outputs.push(JSON.stringify(out))
    } catch (err) {
      outputs.push(String((err as Coded).message))
      return err as Coded
    }
    throw new Error('expected a refusal')
  }

  async function ok(p: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const out = await p
    outputs.push(JSON.stringify(out))
    return out
  }

  const validFor = (verb: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
    const base: Record<string, unknown> = { authority: AID8, network: HASH }
    if (verb === 'approve' || verb === 'refuse') Object.assign(base, { request: 'req-1', checklist: 'id', tokenFile: rightPath })
    if (verb === 'refuse') base.reasonFile = reasonPath
    if (verb === 'enable-intake') base.tokenFile = rightPath
    return { ...base, ...over }
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'vt-27v-'))
    ctx = makeFakeOfficerCtx({ partyId: PARTY, home: join(root, 'officer') })
    rightPath = join(ctx.secretsDir, 'officer.token')
    wrongPath = join(ctx.secretsDir, 'wrong.token')
    const right = generateApprovalToken()
    const wrong = generateApprovalToken()
    secrets.push(Uint8Array.from(right), Uint8Array.from(wrong), Buffer.from(PII, 'utf8'), Buffer.from(REASON, 'utf8'), Buffer.from(NONCE, 'utf8'))
    rightB64 = Buffer.from(right).toString('base64url')
    writeApprovalTokenFile(rightPath, right)
    writeApprovalTokenFile(wrongPath, wrong)
    const user = await ensureAuthorityUser(ctx, createApprovalContext({ file: rightPath }), { name: 'vt officer' })
    userId = user.id
    signerKey = user.activeKeys[0]!.key
    const reasons = join(root, 'reasons')
    mkdirSync(reasons, { mode: 0o700 })
    reasonPath = join(reasons, 'reason.txt')
    writeFileSync(reasonPath, `  ${REASON}\n`, { mode: 0o600 })
  })

  after(() => {
    ctx.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('X1 every verb refuses an extra key (bad-arg), the production party and an empty party before any call or token read', async () => {
    const absentToken = join(root, 'absent.token')
    for (const [verb, run] of Object.entries(VERBS)) {
      const w = makeWorld()
      // an absent token path proves no token read happens before the refusal (registrations takes no token)
      const tokenOver = verb === 'registrations' ? {} : { tokenFile: absentToken }
      const bad = await refused(run(makeDeps(w), validFor(verb, { ...tokenOver, bogus: '1' })))
      expect(bad.name, verb).to.equal('VerbRefusal')
      expect(bad.code, verb).to.equal('bad-arg')
      expect(bad.message).to.equal('intake verb refused (bad-arg)')
      for (const party of ['votetorrent', ' VoteTorrent ']) {
        const prod = await refused(run(makeDeps(w, { kind: 'production', partyId: party }, party), validFor(verb, tokenOver)))
        expect(prod.code, `${verb} ${party}`).to.equal('production-party')
      }
      const missing = await refused(run(makeDeps(w, { kind: 'production', partyId: '' }, ''), validFor(verb, tokenOver)))
      expect(missing.code, verb).to.equal('party-missing')
      expect(w.calls, verb).to.deep.equal([])
    }
  })

  it('A1 approve runs the D-07 gate before any token read: none,id is checklist-incomplete with no token argument', async () => {
    const w = makeWorld()
    const err = await refused(runApprove(makeDeps(w), { authority: AID8, network: HASH, request: 'req-1', checklist: 'none,id' }))
    expect(err.code).to.equal('checklist-incomplete')
    expect(w.calls).to.deep.equal([])
  })

  it('A2 approve refuses an unknown checklist item, a missing checklist, a missing request and a missing authority, each with no call', async () => {
    const w = makeWorld()
    expect((await refused(runApprove(makeDeps(w), validFor('approve', { checklist: 'addr' })))).code).to.equal('checklist-invalid')
    expect((await refused(runApprove(makeDeps(w), validFor('approve', { checklist: ' , ' })))).code).to.equal('checklist-required')
    const noChecklist = validFor('approve')
    delete noChecklist.checklist
    expect((await refused(runApprove(makeDeps(w), noChecklist))).code).to.equal('checklist-required')
    const noRequest = validFor('approve')
    delete noRequest.request
    expect((await refused(runApprove(makeDeps(w), noRequest))).code).to.equal('request-required')
    const noAuthority = validFor('approve')
    delete noAuthority.authority
    expect((await refused(runApprove(makeDeps(w), noAuthority))).code).to.equal('authority-required')
    const noNetwork = validFor('approve')
    delete noNetwork.network
    expect((await refused(runApprove(makeDeps(w), noNetwork))).code).to.equal('network-required')
    expect(w.calls).to.deep.equal([])
  })

  it('A3 approve token presence and proof: token-absent, token-ambiguous, token-file-not-absolute, token-refused leave no call; a forwarded base64url token proceeds', async () => {
    const w = makeWorld()
    const base = validFor('approve')
    delete base.tokenFile
    const absent = await refused(runApprove(makeDeps(w), { ...base }))
    expect(absent.name).to.equal('ApprovalRefusal')
    expect(absent.code).to.equal('token-absent')
    expect((await refused(runApprove(makeDeps(w), { ...base, tokenFile: rightPath, approvalToken: rightB64 }))).code).to.equal('token-ambiguous')
    expect((await refused(runApprove(makeDeps(w), { ...base, tokenFile: 'secrets/officer.token' }))).code).to.equal('token-file-not-absolute')
    const wrong = await refused(runApprove(makeDeps(w), { ...base, tokenFile: wrongPath }))
    expect(wrong.name).to.equal('VerbRefusal')
    expect(wrong.code).to.equal('token-refused')
    expect(w.calls).to.deep.equal([])
    const args = { ...base, approvalToken: rightB64 }
    const out = await ok(runApprove(makeDeps(w), args))
    expect(out.published).to.equal('published')
    expect(Object.hasOwn(args, 'approvalToken')).to.equal(false)
    expect(w.calls).to.include('completeSignature:true:id')
  })

  it('A4 an unknown request is request-not-found with no digest read and no completion', async () => {
    const w = makeWorld()
    const err = await refused(runApprove(makeDeps(w), validFor('approve', { request: 'req-nope' })))
    expect(err.code).to.equal('request-not-found')
    expect(w.calls).to.include('getRegistrationRequest')
    expect(w.calls.some((c) => c.startsWith('getSignatureDigest') || c.startsWith('completeSignature'))).to.equal(false)
  })

  it('A5 one case per approve blocker gives blocked with the blocker code and no digest read', async () => {
    const cases: Array<[string, (w: World) => void]> = [
      ['not-pending', (w) => { w.requests.get('req-1')!.status = 'a' }],
      ['prior-rejections-unavailable', (w) => { w.priorRejectionsFail = true }],
      ['duplicate-check-unavailable', (w) => { w.likelyDuplicatesFail = true }],
      ['closure-check-unavailable', (w) => { w.closureFail = true }],
      ['closed-as-duplicate', (w) => { w.closure = { requestId: 'req-1', state: 'closed', closedByRequestId: 'req-0' } }],
      ['no-task', (w) => { w.tasks = [] }],
      ['content-unreadable', (w) => { w.requests.get('req-1')!.payloadAccess = 'no-opener' }]
    ]
    for (const [blocker, plant] of cases) {
      const w = makeWorld()
      plant(w)
      const err = await refused(runApprove(makeDeps(w), validFor('approve')))
      expect(err.code, blocker).to.equal('blocked')
      expect(err.blockers, blocker).to.include(blocker)
      expect(String(err.message)).to.match(/^intake verb refused \(blocked: [a-z,-]+\)$/)
      expect(w.calls.some((c) => c.startsWith('getSignatureDigest')), blocker).to.equal(false)
    }
  })

  it('A6 approve happy path: loads, then digest, then the completion with the canonical checklist, then the publish; timings are numbers', async () => {
    const w = makeWorld()
    const out = await ok(runApprove(makeDeps(w), validFor('approve', { checklist: ' roll , id ' })))
    const idx = (s: string): number => w.calls.findIndex((c) => c.startsWith(s))
    expect(idx('getRegistrationRequest')).to.be.at.least(0)
    expect(idx('getRequestedSignatures')).to.be.greaterThan(idx('getRegistrationRequest'))
    expect(idx('getSignatureDigest')).to.be.greaterThan(idx('getRequestedSignatures'))
    expect(idx('completeSignature:true:id+roll')).to.be.greaterThan(idx('getSignatureDigest'))
    expect(idx('publishRegistrationDecision')).to.be.greaterThan(idx('completeSignature:true:id+roll'))
    expect(out.requestId).to.equal('req-1')
    expect(out.published).to.equal('published')
    for (const k of ['readMs', 'decideMs', 'publishMs', 'ms']) expect(typeof out[k], k).to.equal('number')
    expect(Object.keys(out).sort()).to.deep.equal(['decideMs', 'ms', 'publishMs', 'published', 'readMs', 'requestId'])
    console.log(`      APPROVE-MS fakes readMs=${String(out.readMs)} decideMs=${String(out.decideMs)} publishMs=${String(out.publishMs)} ms=${String(out.ms)}`)
  })

  it('A7 token posture plus a skipping AttestationRequired row refuses policy-skips-verification before any engine call', async () => {
    const w = makeWorld()
    w.skipping = 1
    const err = await refused(runApprove(makeDeps(w, { kind: 'token', partyId: PARTY }), validFor('approve')))
    expect(err.code).to.equal('policy-skips-verification')
    expect(w.calls).to.deep.equal([])
    w.skipping = 0
    const out = await ok(runApprove(makeDeps(w, { kind: 'token', partyId: PARTY }), validFor('approve')))
    expect(out.published).to.equal('published')
  })

  it('R1 refuse: reason-required, the gate before the reason file, token-refused, each refuse blocker, and the happy path signs no digest', async () => {
    const w = makeWorld()
    const noReason = validFor('refuse')
    delete noReason.reasonFile
    expect((await refused(runRefuse(makeDeps(w), noReason))).code).to.equal('reason-required')
    expect((await refused(runRefuse(makeDeps(w), validFor('refuse', { reasonFile: 'reasons/reason.txt' })))).code).to.equal('reason-required')
    expect((await refused(runRefuse(makeDeps(w), validFor('refuse', { reasonFile: join(root, 'reasons', 'absent.txt') })))).code).to.equal('reason-required')
    const gate = await refused(runRefuse(makeDeps(w), validFor('refuse', { checklist: 'none,id', reasonFile: join(root, 'reasons', 'absent.txt') })))
    expect(gate.code).to.equal('checklist-incomplete')
    expect((await refused(runRefuse(makeDeps(w), validFor('refuse', { tokenFile: wrongPath })))).code).to.equal('token-refused')
    expect(w.calls).to.deep.equal([])
    const cases: Array<[string, (w: World) => void]> = [
      ['not-pending', (x) => { x.requests.get('req-1')!.status = 'a' }],
      ['closed-as-duplicate', (x) => { x.closure = { requestId: 'req-1', state: 'closing', closedByRequestId: 'req-0' } }],
      ['no-task-above-threshold', (x) => { x.tasks = []; x.signingStatus = { threshold: 2, reached: false, unreachable: false } }],
      ['content-unreadable', (x) => { x.requests.get('req-1')!.payloadAccess = 'unreadable' }]
    ]
    for (const [blocker, plant] of cases) {
      const x = makeWorld()
      plant(x)
      const err = await refused(runRefuse(makeDeps(x), validFor('refuse')))
      expect(err.code, blocker).to.equal('blocked')
      expect(err.blockers, blocker).to.include(blocker)
    }
    const happy = makeWorld()
    const out = await ok(runRefuse(makeDeps(happy), validFor('refuse', { checklist: 'none' })))
    expect(happy.rejected).to.deep.equal([{ requestId: 'req-1', reason: REASON, checklist: ['none'] }])
    expect(happy.calls.some((c) => c.startsWith('getSignatureDigest'))).to.equal(false)
    expect(happy.calls).to.include('completeSignature:false:')
    expect(out.requestId).to.equal('req-1')
    expect(out.published).to.equal('published')
    expect(out.taskClose).to.equal('closed')
    expect(typeof out.ms).to.equal('number')
    expect(Object.keys(out).sort()).to.deep.equal(['ms', 'published', 'requestId', 'taskClose'])
    console.log(`      REFUSE-MS fakes ms=${String(out.ms)}`)
  })

  it('E1 enable-intake: token-absent with no engine registration, token-refused leaves it not enabled, the right token enables once', async () => {
    const w = makeWorld()
    const noToken = validFor('enable-intake')
    delete noToken.tokenFile
    expect((await refused(runEnableIntake(makeDeps(w), noToken))).code).to.equal('token-absent')
    expect((await refused(runEnableIntake(makeDeps(w), validFor('enable-intake', { tokenFile: wrongPath })))).code).to.equal('token-refused')
    expect(w.calls.filter((c) => c === 'registerOfficerEncryptionKey')).to.have.length(0)
    expect(w.intakeEnabled).to.equal(false)
    const first = await ok(runEnableIntake(makeDeps(w), validFor('enable-intake')))
    expect(first.state).to.equal('enabled')
    expect(first.changed).to.equal(true)
    expect(typeof first.ms).to.equal('number')
    const second = await ok(runEnableIntake(makeDeps(w), validFor('enable-intake')))
    expect(second.state).to.equal('enabled')
    expect(second.changed).to.equal(false)
    expect(w.calls.filter((c) => c === 'registerOfficerEncryptionKey')).to.have.length(2)
  })

  it('S1 peer-sync: counts, the token-shaped refusal delta, the token-posture row guard, and the counted lazy signer refusal', async () => {
    const w = makeWorld()
    w.associations = 3
    w.challenges = 2
    w.syncHook = () => {
      w.counts.token.refused++
    }
    const out = await ok(runPeerSync(makeDeps(w), validFor('peer-sync', { tokenFile: rightPath })))
    expect(out.imported).to.equal(0)
    expect(out.errors).to.equal(0)
    expect(out.refusals).to.deep.equal(['token-attestation-refused'])
    expect(out.associations).to.deep.equal({ before: 3, after: 3 })
    expect(out.challenges).to.equal(2)
    expect((out.attestation as Loose).token).to.deep.equal({ accepted: 0, refused: 1 })
    expect((out.attestation as Loose).posture).to.equal('production')
    expect(out.signingRefused).to.equal(0)
    expect(Object.keys(out).sort()).to.deep.equal(['associations', 'attestation', 'challenges', 'errors', 'imported', 'ms', 'pending', 'refusals', 'signingRefused'])
    const guarded = makeWorld()
    guarded.skipping = 1
    const err = await refused(runPeerSync(makeDeps(guarded, { kind: 'token', partyId: PARTY }), validFor('peer-sync')))
    expect(err.code).to.equal('policy-skips-verification')
    expect(guarded.calls).to.deep.equal([])
    const unattended = makeWorld()
    unattended.syncSigns = true
    const out2 = await ok(runPeerSync(makeDeps(unattended), validFor('peer-sync')))
    expect(out2.signingRefused).to.equal(1)
    expect(out2.refusals).to.deep.equal([])
    console.log(`      PEER-SYNC-MS fakes ms=${String(out.ms)}`)
  })

  it('G1 registrations: exactly the seven row keys, blockers only on pending rows with detail, status-invalid', async () => {
    const w = makeWorld()
    const row = (id: string, status: string): Loose => ({ requestId: id, authorityId: AUTH, status, issuerType: 'registrant', submittedAt: 's', receivedAt: 'r', lastName: PII, firstName: PII, bridgeLabel: PII, hasPriorRejections: false, payloadAccess: 'opened' })
    w.listPages = [[row('req-1', 'p'), row('req-2', 'a')], [{ ...row('req-3', 'r'), duplicateClosure: 'closed' }]]
    w.requests.set('req-2', pendingRequest('req-2', { status: 'a' }))
    w.associations = 1
    const plain = await ok(runRegistrations(makeDeps(w), validFor('registrations')))
    const rows = plain.rows as Loose[]
    expect(rows).to.have.length(3)
    for (const r of rows) expect(Object.keys(r).sort()).to.deep.equal(['duplicateClosure', 'hasPriorRejections', 'issuerType', 'payloadAccess', 'receivedAt', 'requestId', 'status'])
    expect(rows[2]!.duplicateClosure).to.equal('closed')
    expect(plain.counts).to.deep.equal({ pending: 1, approved: 1, rejected: 1, other: 0, challenges: 0, associations: 1 })
    expect(plain.posture).to.equal('production')
    expect(plain.intake).to.equal('not-enabled')
    expect(plain.attestationRows).to.deep.equal({ elections: 1, skipping: 0 })
    expect(plain.truncated).to.equal(false)
    expect(Object.keys(plain).sort()).to.deep.equal(['attestationRows', 'counts', 'intake', 'ms', 'posture', 'rows', 'truncated'])
    const detailed = await ok(runRegistrations(makeDeps(w), validFor('registrations', { detail: true })))
    const drows = detailed.rows as Loose[]
    expect(drows[0]!.blockers).to.deep.equal([])
    expect(Object.hasOwn(drows[1]!, 'blockers')).to.equal(false)
    expect(typeof detailed.detailMs).to.equal('number')
    const capped = await ok(runRegistrations(makeDeps(w), validFor('registrations', { max: '2', pageSize: '2' })))
    expect((capped.rows as Loose[]).length).to.equal(2)
    expect(capped.truncated).to.equal(true)
    expect((await refused(runRegistrations(makeDeps(w), validFor('registrations', { status: 'x' })))).code).to.equal('status-invalid')
    expect((await refused(runRegistrations(makeDeps(w), validFor('registrations', { pageSize: '0' })))).code).to.equal('bad-arg')
    expect((await refused(runRegistrations(makeDeps(w), validFor('registrations', { detail: 'maybe' })))).code).to.equal('bad-arg')
  })

  it('D1 the group record is frozen with the five names, disjoint from the other officer groups, and served by the registry', () => {
    expect(Object.isFrozen(OFFICER_INTAKE_VERBS)).to.equal(true)
    expect(Object.keys(OFFICER_INTAKE_VERBS).sort()).to.deep.equal(['approve', 'enable-intake', 'peer-sync', 'refuse', 'registrations'])
    const names = Object.keys(OFFICER_INTAKE_VERBS)
    expect(names.sort()).to.deep.equal(Object.keys(VERBS).sort())
    for (const name of names) expect(typeof OFFICER_INTAKE_VERBS[name]).to.equal('function')
    for (const name of names) {
      expect(Object.hasOwn(OFFICER_ELECTION_VERBS, name), name).to.equal(false)
      expect(Object.hasOwn(OFFICER_NETWORK_VERBS, name), name).to.equal(false)
      expect(OFFICER_VERB_ENTRIES[name]).to.equal(OFFICER_INTAKE_VERBS[name])
    }
    const registry = defineVerbRegistry(OFFICER_VERB_ENTRIES)
    expect(registry.names()).to.include.members(names)
  })

  it('L1 no result or error message leaks the tokens, the planted PII, the reason or the nonce', () => {
    expect(outputs.length).to.be.at.least(40)
    assertNoLeak(outputs.join('\n'), secrets)
  })

  it('C1 ctl round trip: each verb through a real ctl server over fake deps; a refusal is a 500 with the code and a short message', async () => {
    const w = makeWorld()
    w.requests.set('req-2', pendingRequest('req-2'))
    w.tasks.push(registrantTask('req-2'))
    w.listPages = [[]]
    const depsFor = (): IntakeDeps => makeDeps(w)
    const entries = Object.fromEntries(Object.entries(VERBS).map(([name, run]) => [name, bindIntakeVerb(run, depsFor)]))
    const dir = join(root, 'ctl')
    let server: CtlServerHandle | undefined
    try {
      server = await startCtlServer<OfficerVerbContext>({ dir, role: 'officer', registry: defineVerbRegistry(entries), ctx: {} as OfficerVerbContext })
      const call = (verb: string, args: Record<string, unknown>) => callCtl({ dir, role: 'officer', verb, args })
      const expectOk = async (verb: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const reply = await call(verb, args)
        outputs.push(JSON.stringify(reply))
        expect(reply.status, `${verb}: ${JSON.stringify(reply.body.error ?? {})}`).to.equal(200)
        expect(typeof reply.body.ms).to.equal('number')
        return reply.body.result ?? {}
      }
      expect((await expectOk('registrations', validFor('registrations'))).posture).to.equal('production')
      expect((await expectOk('enable-intake', validFor('enable-intake'))).state).to.equal('enabled')
      expect((await expectOk('peer-sync', validFor('peer-sync'))).errors).to.equal(0)
      expect((await expectOk('approve', validFor('approve'))).published).to.equal('published')
      expect((await expectOk('refuse', validFor('refuse', { request: 'req-2' }))).taskClose).to.equal('closed')
      const bad = await call('approve', validFor('approve', { checklist: 'none,id' }))
      outputs.push(JSON.stringify(bad))
      expect(bad.status).to.equal(500)
      const err = bad.body.error as { name: string, code?: string, message?: string }
      expect(err.name).to.equal('VerbRefusal')
      expect(err.code).to.equal('checklist-incomplete')
      expect(String(err.message).length).to.be.at.most(200)
      const absent = await call('enable-intake', { authority: AID8, network: HASH })
      outputs.push(JSON.stringify(absent))
      expect(absent.status).to.equal(500)
      expect((absent.body.error as { name: string, code?: string }).code).to.equal('token-absent')
      assertNoLeak(outputs.join('\n'), secrets)
    } finally {
      await server?.close()
    }
  })
})
