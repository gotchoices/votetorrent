// registration-approval.spec.ts: the officer's registration decision workflow moved into
// @votetorrent/workflows (phase 67 plan 18): the gate-before-signature order (WR-02 / WR-19 / D-07),
// sign and checklist identity (48-11 L-2), error identity, the refusal's no-sign discipline (D-12),
// the swallowed task close (WR-14), the load's partial-failure semantics, the requestId-scoped task
// (48-11 L-3), the decision blockers and the secrecy of every message and event. Every engine and
// signer here is a recording fake; the request id and the payload carry a marker that must never
// appear in anything the module emits. Nothing in this file prints a request, a payload or a signature.
import { expect } from 'chai'
import type {
  LikelyDuplicateRequest,
  RegistrantSignatureTask,
  RegistrationDuplicateClosure,
  RegistrationRequestRead,
  RegistrationVerificationChecklistItem,
  Signature,
  SigningStatus,
} from '@votetorrent/vote-core'
import {
  RegistrationApprovalError,
  approveRegistrationRequest,
  closeRegistrationRequestAsStale,
  closesRequestIdOf,
  findRegistrantTask,
  isRegistrationStaleCloseError,
  loadRegistrationApproval,
  recordRegistrationRejectVote,
  refuseRegistrationRequest,
  registrationApprovalErrorCode,
  registrationDecisionBlockers,
} from '../../src/authority/officer.js'
import type {
  PeerReviewDeps,
  PeerStagingTransports,
  RegistrationApprovalView,
  RegistrationDecisionStep,
} from '../../src/authority/officer.js'

const REQUEST_ID = 'req-SECRET-MARKER-req'
const OTHER_REQUEST_ID = 'req-other'
const MARKER = 'SECRET-MARKER'
const AUTHORITY_ID = 'authority-1'

/** Every error any case observed and every event any case received: E1 scans them all. */
const observedErrors: unknown[] = []
const observedEvents: RegistrationDecisionStep[] = []

function request(status: 'p' | 'a' | 'r' = 'p', extra: Partial<RegistrationRequestRead> = {}): RegistrationRequestRead {
  return {
    requestId: REQUEST_ID,
    authorityId: AUTHORITY_ID,
    requesterKey: 'requester-key',
    issuerType: 'registrant',
    payload: { public: { lastName: `${MARKER}-pii`, firstName: 'x', district: 'd' } } as unknown as RegistrationRequestRead['payload'],
    payloadCid: 'cid',
    status,
    submittedAt: '2026-11-24T00:00:00Z',
    receivedAt: '2026-11-24T00:00:01Z',
    verificationChecklist: ['id'],
    ...extra,
  } as RegistrationRequestRead
}

function registrantTask(requestId: string): RegistrantSignatureTask {
  return { signatureType: 'registrant', requestId, payload: {}, submittedAt: '', issuerType: 'registrant' } as unknown as RegistrantSignatureTask
}

interface RigOptions {
  request?: RegistrationRequestRead | undefined
  tasks?: RegistrantSignatureTask[]
  priorRejectionsError?: unknown
  closure?: RegistrationDuplicateClosure
  closureError?: unknown
  likely?: LikelyDuplicateRequest[]
  likelyError?: unknown
  requestedSignaturesError?: unknown
  signingStatus?: SigningStatus | null
  completeSignatureError?: unknown
  rejectError?: unknown
  resolveSignError?: unknown
  withFactory?: boolean
}

/** Recording fakes: one shared call log for engine methods, the sign resolver and the signer, plus the engine lookups. */
function rig(options: RigOptions = {}) {
  const calls: string[] = []
  const engineLookups: string[] = []
  const args: Record<string, unknown[][]> = {}
  const record = (name: string, a: unknown[]): void => {
    calls.push(name)
    ;(args[name] ??= []).push(a)
  }
  const state = { request: 'request' in options ? options.request : request('p') }
  const signatureValue: Signature = { signature: 'sig', signerKey: 'key', signerUserId: 'user' }
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    record('sign', [digest])
    return signatureValue
  }
  const resolveSign = async () => {
    record('resolveSign', [])
    if (options.resolveSignError !== undefined) throw options.resolveSignError
    return sign
  }
  const registration = {
    async getRegistrationRequest(id: string) {
      record('registration.getRegistrationRequest', [id])
      return state.request
    },
    async getPriorRejections(requesterKey: string, excludeRequestId?: string) {
      record('registration.getPriorRejections', [requesterKey, excludeRequestId])
      if (options.priorRejectionsError !== undefined) throw options.priorRejectionsError
      return []
    },
    async getDuplicateClosure(id: string) {
      record('registration.getDuplicateClosure', [id])
      if (options.closureError !== undefined) throw options.closureError
      return options.closure
    },
    async getLikelyDuplicateRequests(id: string) {
      record('registration.getLikelyDuplicateRequests', [id])
      if (options.likelyError !== undefined) throw options.likelyError
      return options.likely ?? []
    },
    async getStaleCloseAvailability(id: string) {
      record('registration.getStaleCloseAvailability', [id])
      return undefined
    },
    async rejectRegistrationRequest(id: string, decision: unknown, signer: unknown) {
      record('registration.rejectRegistrationRequest', [id, decision, signer])
      if (options.rejectError !== undefined) throw options.rejectError
      if (state.request) state.request = { ...state.request, status: 'r' }
    },
    async closeStaleRegistrationRequest(id: string, input: unknown, signer: unknown) {
      record('registration.closeStaleRegistrationRequest', [id, input, signer])
      if (state.request) state.request = { ...state.request, status: 'r' }
    },
    async publishRegistrationDecision(port: unknown, id: string, opts: unknown) {
      record('registration.publishRegistrationDecision', [port, id, opts])
      return { published: true }
    },
  }
  const tasks = {
    async getRequestedSignatures(pending: boolean) {
      record('tasks.getRequestedSignatures', [pending])
      if (options.requestedSignaturesError !== undefined) throw options.requestedSignaturesError
      return options.tasks ?? [registrantTask(REQUEST_ID)]
    },
    async getSignatureDigest(task: unknown) {
      record('tasks.getSignatureDigest', [task])
      return new Uint8Array([1, 2, 3])
    },
    async completeSignature(task: unknown, result: { isAccepted: boolean }) {
      record('tasks.completeSignature', [task, result])
      if (options.completeSignatureError !== undefined) throw options.completeSignatureError
      if (result.isAccepted && state.request) state.request = { ...state.request, status: 'a' }
    },
    async getRegistrantSigningStatus(id: string) {
      record('tasks.getRegistrantSigningStatus', [id])
      return options.signingStatus ?? null
    },
  }
  const intake = {
    createOpener(vault: unknown) {
      record('intake.createOpener', [vault])
      return { opener: true }
    },
  }
  const getEngine = async <T>(name: string): Promise<T> => {
    engineLookups.push(name)
    if (name === 'registration') return registration as unknown as T
    if (name === 'signatureTasksEngine') return tasks as unknown as T
    if (name === 'intake') return intake as unknown as T
    throw new Error('unknown engine')
  }
  const factory = (deps: unknown): PeerStagingTransports => {
    record('factory', [deps])
    return {
      strandId: 'strand',
      registration: { publishDecision: async () => 'cid', close: async () => undefined },
      association: { close: async () => undefined },
    } as unknown as PeerStagingTransports
  }
  const review: PeerReviewDeps = {
    getEngine,
    createPeerStagingTransports: options.withFactory ? factory : undefined,
    authorityId: AUTHORITY_ID,
    sign,
    resolveVault: () => ({ vault: true }) as unknown as ReturnType<PeerReviewDeps['resolveVault']>,
  }
  const events: RegistrationDecisionStep[] = []
  const onStep = (step: RegistrationDecisionStep): void => {
    events.push(step)
    observedEvents.push(step)
  }
  return { calls, engineLookups, args, getEngine, resolveSign, sign, signatureValue, review, events, onStep, state }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    observedErrors.push(err)
    return err
  }
  throw new Error('expected a rejection')
}

const CHECKLIST: RegistrationVerificationChecklistItem[] = ['id']
const task = registrantTask(REQUEST_ID)

describe('registration approval (@votetorrent/workflows/authority officer group)', () => {
  describe('approve', () => {
    it('A1 order: digest, resolver, signer, completion, in that order and nothing else without a transport factory', async () => {
      const r = rig()
      const result = await approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign,
        review: r.review, closesRequestId: null,
      })
      expect(r.calls).to.deep.equal(['tasks.getSignatureDigest', 'resolveSign', 'sign', 'tasks.completeSignature'])
      expect(r.engineLookups).to.deep.equal(['signatureTasksEngine'])
      expect(result.published).to.deep.equal({ kind: 'unavailable' })
      expect(result.timings.decideMs).to.be.a('number')
      expect(result.timings.publishMs).to.be.a('number')
    })

    it('A1b order: with a transport factory the publish reads follow the completion', async () => {
      const r = rig({ withFactory: true })
      const result = await approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign,
        review: r.review, closesRequestId: OTHER_REQUEST_ID,
      })
      const completed = r.calls.indexOf('tasks.completeSignature')
      expect(completed).to.equal(3)
      expect(r.calls.slice(completed + 1)).to.deep.equal([
        'registration.getRegistrationRequest', 'intake.createOpener', 'factory', 'registration.publishRegistrationDecision',
      ])
      expect(r.args['registration.publishRegistrationDecision']![0]![1]).to.equal(REQUEST_ID)
      expect(r.args['registration.publishRegistrationDecision']![0]![2]).to.deep.equal({ closesRequestId: OTHER_REQUEST_ID })
      expect(result.published.kind).to.equal('published')
    })

    it('A2 gate first: an unmet checklist refuses before any engine lookup, resolver or signer call', async () => {
      for (const checklist of [[], ['none', 'id']] as RegistrationVerificationChecklistItem[][]) {
        const r = rig()
        const err = await rejection(approveRegistrationRequest({
          getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
        }))
        expect(registrationApprovalErrorCode(err)).to.equal('checklist-incomplete')
        expect(r.calls).to.deep.equal([])
        expect(r.engineLookups).to.deep.equal([])
      }
    })

    it('A2b gate before task: gate unmet with no task still reports checklist-incomplete', async () => {
      const r = rig()
      const err = await rejection(approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task: undefined, checklist: [], resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(registrationApprovalErrorCode(err)).to.equal('checklist-incomplete')
      expect(r.calls).to.deep.equal([])
    })

    it('A3 no task: gate met and no own task refuses with no-task and an empty call log', async () => {
      const r = rig()
      const err = await rejection(approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task: undefined, checklist: CHECKLIST, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(registrationApprovalErrorCode(err)).to.equal('no-task')
      expect(r.calls).to.deep.equal([])
      expect(r.engineLookups).to.deep.equal([])
    })

    it('A4 identity: the completion carries the signer result, the resolved callback and the same checklist instance', async () => {
      const r = rig()
      const checklist: RegistrationVerificationChecklistItem[] = ['id', 'roll']
      await approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      })
      const [completedTask, result] = r.args['tasks.completeSignature']![0] as [unknown, Record<string, unknown>]
      expect(completedTask).to.equal(task)
      expect(result.isAccepted).to.equal(true)
      expect(result.signature).to.equal(r.signatureValue)
      expect(result.sign).to.equal(r.sign)
      expect((result.decision as { checklist: unknown }).checklist).to.equal(checklist)
      expect(Object.keys(result).sort()).to.deep.equal(['decision', 'isAccepted', 'sign', 'signature'])
    })

    it('A5 error identity: a completion refusal is rethrown as the identical object and nothing is published', async () => {
      const refusal = { name: 'RegistrationDuplicateError', code: 'closed-as-duplicate' }
      const r = rig({ completeSignatureError: refusal, withFactory: true })
      const err = await rejection(approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(err).to.equal(refusal)
      expect(r.calls).to.not.include('registration.publishRegistrationDecision')
      expect(r.calls).to.not.include('registration.getRegistrationRequest')
    })

    it('A5b error identity: a signer resolution failure is rethrown as the identical object with no completion', async () => {
      const refusal = { name: 'DeviceSigningError', code: 'key-invalidated' }
      const r = rig({ resolveSignError: refusal, withFactory: true })
      const err = await rejection(approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(err).to.equal(refusal)
      expect(r.calls).to.deep.equal(['tasks.getSignatureDigest', 'resolveSign'])
    })

    it('A6 track: approve tracks completion and publish, refuse tracks reject and publish, the vote tracks nothing', async () => {
      let count = 0
      const track = <T>(fn: () => Promise<T>): Promise<T> => {
        count++
        return fn()
      }
      const a = rig()
      await approveRegistrationRequest({
        getEngine: a.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: a.resolveSign, review: a.review, closesRequestId: null, track,
      })
      expect(count).to.equal(2)
      count = 0
      const f = rig()
      await refuseRegistrationRequest({
        getEngine: f.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, reason: 'r', resolveSign: f.resolveSign, review: f.review, closesRequestId: null, track,
      })
      expect(count).to.equal(2)
      count = 0
      const v = rig()
      const read: string[] = []
      const input = new Proxy({ getEngine: v.getEngine, task, track }, {
        get(target, prop) {
          read.push(String(prop))
          return (target as Record<string | symbol, unknown>)[prop]
        },
      })
      await recordRegistrationRejectVote(input as Parameters<typeof recordRegistrationRejectVote>[0])
      expect(count).to.equal(0)
      expect(read).to.not.include('track')
      expect(read).to.not.include('resolveSign')
    })

    it('A7 events: the five steps in order, each exactly { step, atMs }', async () => {
      const r = rig()
      let tick = 1000
      await approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
        onStep: r.onStep, now: () => tick++,
      })
      expect(r.events.map((e) => e.step)).to.deep.equal(['gate-checked', 'digest-read', 'signed', 'completed', 'published'])
      for (const e of r.events) {
        expect(Object.keys(e).sort()).to.deep.equal(['atMs', 'step'])
        expect(e.atMs).to.be.a('number')
      }
    })

    it('A7b events: an observer that throws leaves the outcome and the call log unchanged', async () => {
      const quiet = rig()
      const quietResult = await approveRegistrationRequest({
        getEngine: quiet.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: quiet.resolveSign, review: quiet.review, closesRequestId: null,
      })
      const loud = rig()
      const loudResult = await approveRegistrationRequest({
        getEngine: loud.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: loud.resolveSign, review: loud.review, closesRequestId: null,
        onStep: () => {
          throw new Error('observer failure')
        },
      })
      expect(loud.calls).to.deep.equal(quiet.calls)
      expect(loudResult.published).to.deep.equal(quietResult.published)
    })
  })

  describe('refuse', () => {
    it('R1 discipline: the signer goes to the rejection record, the task close is the blank triple, no digest and no own signing', async () => {
      const r = rig()
      const result = await refuseRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, reason: 'reason text', resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      })
      expect(r.calls).to.deep.equal(['resolveSign', 'registration.rejectRegistrationRequest', 'tasks.completeSignature'])
      expect(r.engineLookups).to.deep.equal(['registration', 'signatureTasksEngine'])
      const rejectArgs = r.args['registration.rejectRegistrationRequest']![0]!
      expect(rejectArgs[0]).to.equal(REQUEST_ID)
      expect(rejectArgs[1]).to.deep.equal({ checklist: CHECKLIST, rejectionReason: 'reason text' })
      expect((rejectArgs[1] as { checklist: unknown }).checklist).to.equal(CHECKLIST)
      expect(rejectArgs[2]).to.equal(r.sign)
      const [closedTask, completion] = r.args['tasks.completeSignature']![0] as [unknown, Record<string, unknown>]
      expect(closedTask).to.equal(task)
      expect(completion).to.deep.equal({ isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
      expect(Object.keys(completion).sort()).to.deep.equal(['isAccepted', 'signature'])
      expect(r.calls).to.not.include('tasks.getSignatureDigest')
      expect(r.calls).to.not.include('sign')
      expect(result.taskClose).to.equal('closed')
      expect(result.published).to.deep.equal({ kind: 'unavailable' })
    })

    it('R2 gate: an unmet checklist refuses with an empty call log', async () => {
      const r = rig()
      const err = await rejection(refuseRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: [], reason: 'x', resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(registrationApprovalErrorCode(err)).to.equal('checklist-incomplete')
      expect(r.calls).to.deep.equal([])
      expect(r.engineLookups).to.deep.equal([])
    })

    it('R3 WR-14: a failed task close is swallowed as taskClose failed and the publish still runs', async () => {
      const r = rig({ completeSignatureError: new Error('task close failed'), withFactory: true })
      const result = await refuseRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, reason: 'x', resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      })
      expect(result.taskClose).to.equal('failed')
      expect(r.calls).to.include('registration.publishRegistrationDecision')
      expect(result.published.kind).to.equal('published')
    })

    it('R3b WR-14: no task gives taskClose skipped with no task engine lookup', async () => {
      const r = rig()
      const result = await refuseRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task: undefined, checklist: CHECKLIST, reason: 'x', resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      })
      expect(result.taskClose).to.equal('skipped')
      expect(r.engineLookups).to.deep.equal(['registration'])
    })

    it('R4 reject failure: the identical object is rethrown with no task close and no publish', async () => {
      const refusal = { name: 'RequesterSignatureUnverifiableError', code: 'requester-signature-unverifiable' }
      const r = rig({ rejectError: refusal, withFactory: true })
      const err = await rejection(refuseRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, reason: 'x', resolveSign: r.resolveSign, review: r.review, closesRequestId: null,
      }))
      expect(err).to.equal(refusal)
      expect(r.calls).to.deep.equal(['resolveSign', 'registration.rejectRegistrationRequest'])
    })
  })

  describe('threshold vote and stale close', () => {
    it('V1 vote: no task refuses with no-task; with a task one blank completion and no signer involvement', async () => {
      const none = rig()
      const err = await rejection(recordRegistrationRejectVote({ getEngine: none.getEngine, task: undefined }))
      expect(registrationApprovalErrorCode(err)).to.equal('no-task')
      expect(none.calls).to.deep.equal([])
      const r = rig()
      await recordRegistrationRejectVote({ getEngine: r.getEngine, task })
      expect(r.calls).to.deep.equal(['tasks.completeSignature'])
      const completion = r.args['tasks.completeSignature']![0]![1] as Record<string, unknown>
      expect(completion).to.deep.equal({ isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
      expect(Object.keys(completion).sort()).to.deep.equal(['isAccepted', 'signature'])
    })

    it('S1 stale close: registration engine, resolver, the close with the reason, the blank task close, a publish closing nothing', async () => {
      const r = rig({ withFactory: true })
      const result = await closeRegistrationRequestAsStale({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, reason: 'late', resolveSign: r.resolveSign, review: r.review,
      })
      expect(r.engineLookups[0]).to.equal('registration')
      expect(r.calls.slice(0, 3)).to.deep.equal(['resolveSign', 'registration.closeStaleRegistrationRequest', 'tasks.completeSignature'])
      const closeArgs = r.args['registration.closeStaleRegistrationRequest']![0]!
      expect(closeArgs[0]).to.equal(REQUEST_ID)
      expect(closeArgs[1]).to.deep.equal({ rejectionReason: 'late' })
      expect(closeArgs[2]).to.equal(r.sign)
      expect(r.args['tasks.completeSignature']![0]![1]).to.deep.equal({ isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
      expect(r.args['registration.publishRegistrationDecision']![0]![2]).to.deep.equal({ closesRequestId: null })
      expect(result.taskClose).to.equal('closed')
      expect(result.published.kind).to.equal('published')
      expect(r.calls).to.not.include('tasks.getSignatureDigest')
      expect(r.calls).to.not.include('sign')
    })

    it('S1b stale-close classifier: name plus a string code, structurally', () => {
      expect(isRegistrationStaleCloseError({ name: 'RegistrationStaleCloseError', code: 'too-early' })).to.equal(true)
      expect(isRegistrationStaleCloseError({ name: 'RegistrationStaleCloseError' })).to.equal(false)
      expect(isRegistrationStaleCloseError({ code: 'too-early' })).to.equal(false)
      expect(isRegistrationStaleCloseError(null)).to.equal(false)
    })
  })

  describe('load', () => {
    const load = (r: ReturnType<typeof rig>, extra: { shouldStop?: () => boolean } = {}) =>
      loadRegistrationApproval({ getEngine: r.getEngine, requestId: REQUEST_ID, ...extra })

    it('L1 pending: the seven reads in the screen order and the task scoped by requestId, not by position', async () => {
      const r = rig({ tasks: [registrantTask(OTHER_REQUEST_ID), registrantTask(REQUEST_ID)] })
      const view = await load(r)
      expect(r.calls).to.deep.equal([
        'registration.getRegistrationRequest',
        'registration.getPriorRejections',
        'registration.getDuplicateClosure',
        'registration.getLikelyDuplicateRequests',
        'tasks.getRequestedSignatures',
        'tasks.getRegistrantSigningStatus',
        'registration.getStaleCloseAvailability',
      ])
      expect(view.taskLookup?.task?.requestId).to.equal(REQUEST_ID)
      expect(view.read?.requestId).to.equal(REQUEST_ID)
      expect(view.priorRejections).to.deep.equal([])
      expect(view.failure).to.equal(undefined)
      expect(view.readMs).to.be.a('number')
      expect(r.args['registration.getPriorRejections']![0]).to.deep.equal(['requester-key', REQUEST_ID])
    })

    it('L2 prior rejections failure: flagged with the identical failure, nothing stored, later reads still run', async () => {
      const failure = new Error('peer unavailable')
      const r = rig({ priorRejectionsError: failure })
      const view = await load(r)
      expect(view.priorRejectionsUnavailable).to.equal(true)
      expect(view.priorRejectionsFailure).to.equal(failure)
      expect(view.priorRejections).to.equal(undefined)
      expect(r.calls).to.include('tasks.getRequestedSignatures')
      expect(view.taskLookup?.task).to.not.equal(undefined)
    })

    it('L3 closure failure: closureUnavailable and the likely-duplicate read still runs', async () => {
      const r = rig({ closureError: new Error('closure read failed') })
      const view = await load(r)
      expect(view.closureUnavailable).to.equal(true)
      expect(r.calls).to.include('registration.getLikelyDuplicateRequests')
    })

    it('L4 a defined closure skips the likely-duplicate read', async () => {
      const closure = { requestId: REQUEST_ID, closedByRequestId: OTHER_REQUEST_ID } as unknown as RegistrationDuplicateClosure
      const r = rig({ closure })
      const view = await load(r)
      expect(view.closure).to.equal(closure)
      expect(r.calls).to.not.include('registration.getLikelyDuplicateRequests')
    })

    it('L5 not found: a coded failure, only the request read, no read in the view', async () => {
      const r = rig({ request: undefined })
      const view = await load(r)
      observedErrors.push(view.failure)
      expect(registrationApprovalErrorCode(view.failure)).to.equal('not-found')
      expect(r.calls).to.deep.equal(['registration.getRegistrationRequest'])
      expect(view.read).to.equal(undefined)
    })

    it('L6 decided request: no duplicates, no task lookup, no signing status, no stale-close read', async () => {
      const r = rig({ request: request('a') })
      const view = await load(r)
      expect(r.calls).to.deep.equal(['registration.getRegistrationRequest', 'registration.getPriorRejections', 'registration.getDuplicateClosure'])
      expect(view.taskLookup).to.equal(undefined)
      expect(view.signingStatus).to.equal(null)
      expect(view.staleClose).to.equal(undefined)
    })

    it('L7 late failure: the identical failure while the request and the prior rejections stay in the view', async () => {
      const failure = new Error('tasks unavailable')
      const r = rig({ requestedSignaturesError: failure })
      const view = await load(r)
      observedErrors.push(view.failure)
      expect(view.failure).to.equal(failure)
      expect(view.read).to.not.equal(undefined)
      expect(view.priorRejections).to.deep.equal([])
      expect(view.taskLookup).to.equal(undefined)
    })

    it('L8 shouldStop: only the request read, with the read set', async () => {
      const r = rig()
      const view = await load(r, { shouldStop: () => true })
      expect(r.calls).to.deep.equal(['registration.getRegistrationRequest'])
      expect(view.read?.requestId).to.equal(REQUEST_ID)
      expect(view.priorRejections).to.equal(undefined)
    })
  })

  describe('blockers', () => {
    function clearView(extra: Partial<RegistrationApprovalView> = {}): RegistrationApprovalView {
      return {
        read: request('p'),
        priorRejectionsUnavailable: false,
        closureUnavailable: false,
        duplicateUnavailable: false,
        taskLookup: { task },
        signingStatus: null,
        readMs: 0,
        ...extra,
      }
    }

    it('B1 all clear: a pending request with an own task has no blocker on either side', () => {
      const b = registrationDecisionBlockers(clearView())
      expect(b.approve).to.deep.equal([])
      expect(b.refuse).to.deep.equal([])
      expect(b.thresholdAboveOne).to.equal(false)
      expect(b.unreachable).to.equal(false)
      expect(b.closedAsDuplicate).to.equal(false)
      expect(b.contentReadable).to.equal(true)
      expect(b.rejectableUnread).to.equal(false)
    })

    it('B1b one case per blocker code, in the documented order', () => {
      expect(registrationDecisionBlockers(clearView({ read: request('a') })).approve).to.deep.equal(['not-pending'])
      expect(registrationDecisionBlockers(clearView({ read: request('a') })).refuse).to.deep.equal(['not-pending'])
      expect(registrationDecisionBlockers(clearView({ read: undefined })).approve[0]).to.equal('not-pending')
      expect(registrationDecisionBlockers(clearView({ priorRejectionsUnavailable: true })).approve).to.deep.equal(['prior-rejections-unavailable'])
      expect(registrationDecisionBlockers(clearView({ duplicateUnavailable: true })).approve).to.deep.equal(['duplicate-check-unavailable'])
      expect(registrationDecisionBlockers(clearView({ closureUnavailable: true })).approve).to.deep.equal(['closure-check-unavailable'])
      const closure = { requestId: REQUEST_ID } as unknown as RegistrationDuplicateClosure
      const closed = registrationDecisionBlockers(clearView({ closure }))
      expect(closed.approve).to.deep.equal(['closed-as-duplicate'])
      expect(closed.refuse).to.deep.equal(['closed-as-duplicate'])
      expect(closed.closedAsDuplicate).to.equal(true)
      expect(registrationDecisionBlockers(clearView({ taskLookup: { task: undefined } })).approve).to.deep.equal(['no-task'])
      expect(registrationDecisionBlockers(clearView({ taskLookup: undefined })).approve).to.deep.equal(['no-task'])
      expect(registrationDecisionBlockers(clearView({ taskLookup: undefined })).refuse).to.deep.equal([])
      const unread = registrationDecisionBlockers(clearView({ read: request('p', { payloadAccess: 'no-opener' }) }))
      expect(unread.approve).to.deep.equal(['content-unreadable'])
      expect(unread.refuse).to.deep.equal(['content-unreadable'])
      expect(unread.contentReadable).to.equal(false)
      const all = registrationDecisionBlockers(clearView({
        read: request('p', { payloadAccess: 'unreadable' }), priorRejectionsUnavailable: true, duplicateUnavailable: true,
        closureUnavailable: true, closure, taskLookup: undefined,
      }))
      expect(all.approve).to.deep.equal([
        'prior-rejections-unavailable', 'duplicate-check-unavailable', 'closure-check-unavailable', 'closed-as-duplicate', 'no-task', 'content-unreadable',
      ])
    })

    it('B1c tampered content blocks approve only; a threshold above one without a task blocks refuse', () => {
      const tampered = registrationDecisionBlockers(clearView({ read: request('p', { payloadAccess: 'tampered' }) }))
      expect(tampered.approve).to.deep.equal(['content-unreadable'])
      expect(tampered.refuse).to.deep.equal([])
      expect(tampered.rejectableUnread).to.equal(true)
      const status = { threshold: 2, reached: false, unreachable: false } as unknown as SigningStatus
      const above = registrationDecisionBlockers(clearView({ signingStatus: status, taskLookup: { task: undefined } }))
      expect(above.thresholdAboveOne).to.equal(true)
      expect(above.refuse).to.deep.equal(['no-task-above-threshold'])
      expect(above.approve).to.deep.equal(['no-task'])
      const withTask = registrationDecisionBlockers(clearView({ signingStatus: status }))
      expect(withTask.refuse).to.deep.equal([])
      const unreachable = registrationDecisionBlockers(clearView({ signingStatus: { ...status, unreachable: true } as SigningStatus }))
      expect(unreachable.unreachable).to.equal(true)
      const decidedUnreachable = registrationDecisionBlockers(clearView({ read: request('a'), signingStatus: { ...status, unreachable: true } as SigningStatus }))
      expect(decidedUnreachable.unreachable).to.equal(false)
    })
  })

  describe('helpers and secrecy', () => {
    it('C1 closesRequestIdOf: unavailable gives null, a candidate gives its id, none gives null', () => {
      const duplicate = { requestId: OTHER_REQUEST_ID } as unknown as LikelyDuplicateRequest
      expect(closesRequestIdOf({ duplicate, duplicateUnavailable: true })).to.equal(null)
      expect(closesRequestIdOf({ duplicate, duplicateUnavailable: false })).to.equal(OTHER_REQUEST_ID)
      expect(closesRequestIdOf({ duplicate: undefined, duplicateUnavailable: false })).to.equal(null)
    })

    it('C2 findRegistrantTask: requestId equality, never signature type alone', () => {
      const ballot = { signatureType: 'ballot' } as unknown as RegistrantSignatureTask
      const tasks = [ballot, registrantTask(OTHER_REQUEST_ID), registrantTask(REQUEST_ID)]
      expect(findRegistrantTask(tasks, REQUEST_ID)?.requestId).to.equal(REQUEST_ID)
      expect(findRegistrantTask([ballot, registrantTask(OTHER_REQUEST_ID)], REQUEST_ID)).to.equal(undefined)
    })

    it('C3 registrationApprovalErrorCode is structural and refuses foreign codes', () => {
      expect(registrationApprovalErrorCode(new RegistrationApprovalError('no-task'))).to.equal('no-task')
      expect(registrationApprovalErrorCode({ name: 'RegistrationApprovalError', code: 'checklist-incomplete' })).to.equal('checklist-incomplete')
      expect(registrationApprovalErrorCode({ name: 'RegistrationApprovalError', code: 'other' })).to.equal(undefined)
      expect(registrationApprovalErrorCode({ name: 'Other', code: 'no-task' })).to.equal(undefined)
      expect(registrationApprovalErrorCode(undefined)).to.equal(undefined)
    })

    it('E1 secrecy: no thrown message, serialized error or emitted event carries the request or payload marker', async () => {
      const r = rig({ withFactory: true })
      await approveRegistrationRequest({
        getEngine: r.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, resolveSign: r.resolveSign, review: r.review, closesRequestId: null, onStep: r.onStep,
      })
      const f = rig()
      await refuseRegistrationRequest({
        getEngine: f.getEngine, requestId: REQUEST_ID, task, checklist: CHECKLIST, reason: `${MARKER}-reason`, resolveSign: f.resolveSign, review: f.review, closesRequestId: null, onStep: f.onStep,
      })
      expect(new RegistrationApprovalError('no-task').message).to.equal('no-task')
      expect(new RegistrationApprovalError('checklist-incomplete').message).to.equal('checklist-incomplete')
      expect(new RegistrationApprovalError('not-found').message).to.equal('not-found')
      expect(observedErrors.length).to.be.greaterThan(5)
      expect(observedEvents.length).to.be.greaterThan(5)
      for (const err of observedErrors) {
        const message = (err as { message?: unknown }).message
        expect(String(message)).to.not.include(MARKER)
        expect(JSON.stringify(err) ?? '').to.not.include(MARKER)
        expect(JSON.stringify({ ...(err as object), message })).to.not.include(MARKER)
      }
      for (const event of observedEvents) {
        expect(JSON.stringify(event)).to.not.include(MARKER)
        expect(Object.keys(event).sort()).to.deep.equal(['atMs', 'step'])
      }
    })
  })
})
