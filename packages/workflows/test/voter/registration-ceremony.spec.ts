// registration-ceremony.spec.ts: plain-Node proof of the shared Voter registration + association
// ceremony (phase 67 plan 11). In-file fakes only (a recording producer, recording transports, a
// Map-backed attempt store, an instant virtual clock, an event collector); no network, no key material.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import type { AssociationRequestInit, DeviceAttestation, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs'
import {
  DECISION_POLL_INTERVAL_MS,
  DECISION_WAIT_MAX_MS,
  IGNORED_EXPIRATION_PLACEHOLDER,
  createRegistrationCeremonyMemory,
  pollForNotice,
  resolveAttemptDeviceKey,
  runRegistrationCeremony,
  type RegistrationCeremonyAttemptRecord,
  type RegistrationCeremonyAttemptStore,
  type RegistrationCeremonyDeps,
  type RegistrationCeremonyDraft,
  type RegistrationCeremonyEvent,
  type RegistrationCeremonyTransports,
} from '../../src/voter/ceremony.js'
import type { AttestationProducer, SignCallback } from '../../src/platform/index.js'

const AUTHORITY_ID = 'authority-A1'
const ELECTION_ID = 'election-E1'
const IDENTITY_KEY = 'identity-key-I1'
const NONCE = 'nonce-N1'
const CODE = 'code-C1'
const KEY_1 = 'p256-key-K1'
const KEY_2 = 'p256-key-K2'

const signatureOf = (signerKey: string): Signature => ({ signature: 'sig', signerKey, signerUserId: 'user' })
const deviceSign: SignCallback = async () => signatureOf(IDENTITY_KEY)

const draft: RegistrationCeremonyDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dob: '1815-12-10',
  email: 'ada@example.invalid',
  phone: '',
  addressLine1: '1 Analytical St',
  addressLine2: '',
  addressLine3: '',
  party: 'independent',
}

interface Notice { requestId: string; status: string; cursor: string; challengeNonce?: string }

interface RecordingProducer extends AttestationProducer {
  provisionCalls: number
  currentCalls: number
  produceCalls: Array<Record<string, unknown>>
  signCalls: number
}

function makeProducer (opts: { keys?: string[]; current?: () => Promise<{ publicKey: string }>; withSign?: boolean } = {}): RecordingProducer {
  const keys = [...(opts.keys ?? [KEY_1, KEY_2])]
  const producer: RecordingProducer = {
    provisionCalls: 0,
    currentCalls: 0,
    produceCalls: [],
    signCalls: 0,
    async provisionDeviceKey () {
      producer.provisionCalls += 1
      return { publicKey: keys.shift() as string }
    },
    async getCurrentDeviceKey () {
      producer.currentCalls += 1
      if (opts.current) return opts.current()
      return { publicKey: KEY_1 }
    },
    async produce (challenge) {
      producer.produceCalls.push({ ...challenge })
      return { kind: 'fake' } as unknown as DeviceAttestation
    },
  }
  if (opts.withSign !== false) {
    producer.signDeviceKeyDigest = async () => {
      producer.signCalls += 1
      return signatureOf(KEY_1)
    }
  }
  return producer
}

interface SubmitCall { init: unknown; requesterKey: string; sign: SignCallback; extras?: unknown; argCount: number }

interface RecordingTransports extends RegistrationCeremonyTransports {
  registrationSubmits: SubmitCall[]
  associationSubmits: SubmitCall[]
  attestationSubmits: SubmitCall[]
  registrationPolls: number
  associationPolls: number
}

function makeTransports (opts: {
  route?: 'peer' | 'rest-bridge'
  notices?: (poll: number) => Notice[]
  registrationNotices?: Array<{ requestId: string; status: string }>
  ownStaged?: string[] | (() => Promise<string[]>)
  attestationError?: unknown
  withRegistrationPoll?: boolean
} = {}): RecordingTransports {
  const t: RecordingTransports = {
    registrationSubmits: [],
    associationSubmits: [],
    attestationSubmits: [],
    registrationPolls: 0,
    associationPolls: 0,
    registrationRoute: opts.route ?? 'peer',
    registrationTransport: {
      async submitRequest (init: RegistrationRequestInit, requesterKey: string, sign: SignCallback, extras?: { registrationCode?: string }) {
        t.registrationSubmits.push({ init, requesterKey, sign, extras, argCount: arguments.length })
        return init.id
      },
    },
    associationTransport: {
      async submitRequest (init: AssociationRequestInit, requesterKey: string, sign: SignCallback) {
        t.associationSubmits.push({ init, requesterKey, sign, argCount: arguments.length })
        return init.id
      },
      async submitAttestation (answer, requesterKey, sign) {
        t.attestationSubmits.push({ init: answer, requesterKey, sign, argCount: arguments.length })
        if (opts.attestationError !== undefined) throw opts.attestationError
      },
      async pollDecisions () {
        t.associationPolls += 1
        if (opts.notices) return opts.notices(t.associationPolls)
        const id = (t.associationSubmits[0]?.init as AssociationRequestInit | undefined)?.id ?? ''
        return [{ requestId: id, status: 'c', cursor: `c${t.associationPolls}`, challengeNonce: NONCE }]
      },
    },
    async ownStagedRegistrationRequestIds () {
      if (typeof opts.ownStaged === 'function') return opts.ownStaged()
      return opts.ownStaged ?? []
    },
  }
  if (opts.withRegistrationPoll !== false) {
    t.registrationTransport.pollDecisions = async () => {
      t.registrationPolls += 1
      return opts.registrationNotices ?? []
    }
  }
  return t
}

class MapStore implements RegistrationCeremonyAttemptStore {
  raw: string | null = null
  writes: RegistrationCeremonyAttemptRecord[] = []
  clearCalls = 0
  readCalls = 0
  async read (): Promise<RegistrationCeremonyAttemptRecord | null> {
    this.readCalls += 1
    return this.raw === null ? null : (JSON.parse(this.raw) as RegistrationCeremonyAttemptRecord)
  }
  async write (record: RegistrationCeremonyAttemptRecord): Promise<void> {
    this.writes.push(JSON.parse(JSON.stringify(record)) as RegistrationCeremonyAttemptRecord)
    this.raw = JSON.stringify(record)
  }
  async clear (): Promise<void> {
    this.clearCalls += 1
    this.raw = null
  }
}

interface Rig {
  deps: RegistrationCeremonyDeps
  producer: RecordingProducer
  transports: RecordingTransports
  store: MapStore
  events: RegistrationCeremonyEvent[]
  mintCalls: string[]
  resolveTransportsCalls: string[]
  resolveElectionCalls: number
  clock: { t: number }
}

function makeRig (over: Partial<RegistrationCeremonyDeps> & {
  producer?: RecordingProducer
  transports?: RecordingTransports
  store?: MapStore
  electionId?: string | undefined
  transportsUndefined?: boolean
} = {}): Rig {
  const producer = over.producer ?? makeProducer()
  const transports = over.transports ?? makeTransports()
  const store = over.store ?? new MapStore()
  const events: RegistrationCeremonyEvent[] = []
  const clock = { t: 1_000_000 }
  const rig: Rig = {
    producer,
    transports,
    store,
    events,
    mintCalls: [],
    resolveTransportsCalls: [],
    resolveElectionCalls: 0,
    clock,
    deps: {
      getEngine: async <T>(name: string): Promise<T> => {
        if (name !== 'network') throw new Error(`unexpected engine ${name}`)
        return { getDetails: async () => ({ network: { primaryAuthorityId: AUTHORITY_ID } }) } as unknown as T
      },
      deviceUser: { activeKeys: [{ key: IDENTITY_KEY }] },
      deviceSign,
      producer,
      store,
      memory: createRegistrationCeremonyMemory(),
      draft,
      resolveElectionId: async () => {
        rig.resolveElectionCalls += 1
        return 'electionId' in over ? over.electionId : ELECTION_ID
      },
      resolveTransports: async (authorityId: string) => {
        rig.resolveTransportsCalls.push(authorityId)
        return over.transportsUndefined ? undefined : transports
      },
      mintRegistrationCode: async (registrantId: string) => {
        rig.mintCalls.push(registrantId)
        return CODE
      },
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.t += ms
      },
      shouldStop: () => false,
      onStep: event => {
        events.push(event)
      },
      ...stripRigKeys(over),
    },
  }
  return rig
}

function stripRigKeys (over: Record<string, unknown>): Partial<RegistrationCeremonyDeps> {
  const { producer: _p, transports: _t, store: _s, electionId: _e, transportsUndefined: _u, ...rest } = over
  return rest as Partial<RegistrationCeremonyDeps>
}

async function rejection (p: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await p
  } catch (e) {
    return e as Error & { code?: unknown }
  }
  throw new Error('expected a rejection')
}

const step = (s: string): RegistrationCeremonyEvent => ({ type: 'step', step: s as never })
const milestone = (m: string): RegistrationCeremonyEvent => ({ type: 'milestone', milestone: m as never })

describe('registration ceremony (@votetorrent/workflows/voter)', () => {
  it('R1: peer route, fresh memory: the step and milestone events in order, the submits, the produce and the store calls', async () => {
    const rig = makeRig()
    const result = await runRegistrationCeremony(rig.deps)
    expect(result).to.deep.equal({ outcome: 'answered' })
    expect(rig.events).to.deep.equal([
      step('election'), step('network'), step('transports'), step('resume'), step('device-key'),
      step('registration-submit'), milestone('registration-staged'),
      step('association-submit'), milestone('association-staged'),
      step('decision-wait'), { type: 'milestone', milestone: 'decision-received', status: 'c' },
      step('produce'), step('attestation-submit'), milestone('answered'),
    ])
    expect(rig.transports.registrationSubmits).to.have.length(1)
    const reg = rig.transports.registrationSubmits[0]!
    expect(reg.sign).to.equal(deviceSign)
    expect(reg.requesterKey).to.equal(IDENTITY_KEY)
    expect(reg.extras).to.deep.equal({ registrationCode: CODE })
    expect(rig.mintCalls).to.deep.equal([rig.deps.memory.registrantId])
    expect(rig.transports.associationSubmits).to.have.length(1)
    const assoc = rig.transports.associationSubmits[0]!
    expect(assoc.requesterKey).to.equal(KEY_1)
    expect(rig.producer.signCalls).to.equal(0)
    await assoc.sign(new Uint8Array([1]))
    expect(rig.producer.signCalls).to.equal(1)
    expect(rig.producer.produceCalls).to.deep.equal([{
      nonce: NONCE,
      authorityId: AUTHORITY_ID,
      registrantId: rig.deps.memory.registrantId,
      deviceKey: KEY_1,
      electionId: ELECTION_ID,
    }])
    expect(rig.store.writes).to.have.length(2)
    expect(rig.store.writes[0]!.registrationStaged).to.equal(false)
    expect(rig.store.writes[1]!.registrationStaged).to.equal(true)
    expect(rig.store.clearCalls).to.equal(1)
    expect(rig.store.raw).to.equal(null)
    expect(rig.transports.attestationSubmits[0]!.init).to.deep.equal({
      requestId: rig.deps.memory.associationRequestId,
      nonce: NONCE,
      attestation: { kind: 'fake' },
    })
  })

  it('R2: the rest-bridge route never mints a code and submits the registration with exactly 3 arguments', async () => {
    const rig = makeRig({ transports: makeTransports({ route: 'rest-bridge' }) })
    await runRegistrationCeremony(rig.deps)
    expect(rig.mintCalls).to.deep.equal([])
    expect(rig.transports.registrationSubmits).to.have.length(1)
    expect(rig.transports.registrationSubmits[0]!.argCount).to.equal(3)
    expect(rig.transports.registrationSubmits[0]!.extras).to.equal(undefined)
  })

  it('R3: a retry with the same memory after a stop in the wait re-submits the SAME init objects; one provision, the retry reads the key back', async () => {
    let stop = false
    const transports = makeTransports({
      notices: () => {
        stop = true
        return []
      },
    })
    const rig = makeRig({ transports, shouldStop: () => stop })
    const first = await rejection(runRegistrationCeremony(rig.deps))
    expect(first.name).to.equal('DecisionWaitStoppedError')
    expect(rig.producer.produceCalls).to.have.length(0)

    stop = false
    const retryTransports = makeTransports()
    const retry = makeRig({ transports: retryTransports, producer: rig.producer, store: rig.store, memory: rig.deps.memory })
    await runRegistrationCeremony(retry.deps)
    expect(retryTransports.registrationSubmits[0]!.init).to.equal(transports.registrationSubmits[0]!.init)
    expect(retryTransports.associationSubmits[0]!.init).to.equal(transports.associationSubmits[0]!.init)
    expect(rig.producer.provisionCalls).to.equal(1)
    expect(rig.producer.currentCalls).to.equal(1)
    expect(retry.mintCalls).to.deep.equal([])
    expect(retry.events[5]).to.deep.equal(step('registration-check'))
  })

  it('R4: fresh memory + a matching stored record resumes ids, key and association init without provisioning; a staged registration is not re-submitted', async () => {
    const stored: RegistrationCeremonyAttemptRecord = {
      version: 1,
      identityKey: IDENTITY_KEY,
      authorityId: AUTHORITY_ID,
      electionId: ELECTION_ID,
      registrantId: 'reg-stored',
      registrationSubmittedAt: '2026-11-24T00:00:00.000Z',
      registrationStaged: false,
      deviceKey: 'p256-key-stored',
      association: {
        id: 'assoc-stored',
        authorityId: AUTHORITY_ID,
        registrantId: 'reg-stored',
        deviceKey: 'p256-key-stored',
        electionId: ELECTION_ID,
        submittedAt: '2026-11-24T00:00:01.000Z',
      },
    }
    const store = new MapStore()
    store.raw = JSON.stringify(stored)
    const producer = makeProducer({ current: async () => ({ publicKey: 'p256-key-stored' }) })
    const transports = makeTransports({ ownStaged: ['reg-stored'] })
    const rig = makeRig({ store, producer, transports })
    await runRegistrationCeremony(rig.deps)
    expect(producer.provisionCalls).to.equal(0)
    expect(producer.currentCalls).to.equal(1)
    expect(rig.deps.memory.registrantId).to.equal('reg-stored')
    expect(rig.deps.memory.deviceKey).to.equal('p256-key-stored')
    expect(rig.deps.memory.registrationStaged).to.equal(true)
    expect(transports.registrationSubmits).to.have.length(0)
    expect(transports.associationSubmits).to.have.length(1)
    expect(transports.associationSubmits[0]!.init).to.deep.equal(stored.association)
    expect(rig.events.filter(e => e.type === 'milestone').map(e => (e as { milestone: string }).milestone)).to.deep.equal([
      'association-staged', 'decision-received', 'answered',
    ])
    expect(rig.mintCalls).to.deep.equal([])
  })

  it('R5: a stored record for another authority is cleared and a new attempt starts', async () => {
    const store = new MapStore()
    store.raw = JSON.stringify({
      version: 1,
      identityKey: IDENTITY_KEY,
      authorityId: 'authority-OTHER',
      electionId: ELECTION_ID,
      registrantId: 'reg-other',
      registrationSubmittedAt: '2026-11-24T00:00:00.000Z',
      registrationStaged: true,
      deviceKey: 'p256-key-other',
      association: null,
    })
    const rig = makeRig({ store })
    await runRegistrationCeremony(rig.deps)
    expect(rig.store.clearCalls).to.equal(2)
    expect(rig.producer.provisionCalls).to.equal(1)
    expect(rig.deps.memory.registrantId).to.not.equal('reg-other')
    expect(rig.transports.registrationSubmits).to.have.length(1)
  })

  describe('R6: resolveAttemptDeviceKey', () => {
    const seeded = () => {
      const memory = createRegistrationCeremonyMemory()
      memory.deviceKey = KEY_1
      memory.associationRequestId = 'assoc-1'
      memory.associationRequestInit = { id: 'assoc-1', authorityId: AUTHORITY_ID, registrantId: 'reg-1', deviceKey: KEY_1, submittedAt: 'now' }
      return memory
    }
    for (const code of ['DEVICE_KEY_ABSENT', 'DEVICE_KEY_INVALIDATED']) {
      it(`${code} re-provisions and nulls the association id and init`, async () => {
        const memory = seeded()
        const producer = makeProducer({ keys: [KEY_2], current: async () => { throw Object.assign(new Error('gone'), { code }) } })
        expect(await resolveAttemptDeviceKey(memory, producer)).to.equal(KEY_2)
        expect(memory.deviceKey).to.equal(KEY_2)
        expect(memory.associationRequestId).to.equal(null)
        expect(memory.associationRequestInit).to.equal(null)
        expect(producer.provisionCalls).to.equal(1)
      })
    }
    it('a different current key re-provisions', async () => {
      const memory = seeded()
      const producer = makeProducer({ keys: [KEY_2], current: async () => ({ publicKey: 'p256-key-elsewhere' }) })
      expect(await resolveAttemptDeviceKey(memory, producer)).to.equal(KEY_2)
      expect(memory.associationRequestInit).to.equal(null)
    })
    it('the same current key is kept, with no provision', async () => {
      const memory = seeded()
      const producer = makeProducer({ keys: [KEY_2] })
      expect(await resolveAttemptDeviceKey(memory, producer)).to.equal(KEY_1)
      expect(producer.provisionCalls).to.equal(0)
      expect(memory.associationRequestId).to.equal('assoc-1')
    })
    it('code LOCKOUT rejects with that same error object and provisions nothing', async () => {
      const memory = seeded()
      const lockout = Object.assign(new Error('locked'), { code: 'LOCKOUT' })
      const producer = makeProducer({ current: async () => { throw lockout } })
      expect(await rejection(resolveAttemptDeviceKey(memory, producer))).to.equal(lockout)
      expect(producer.provisionCalls).to.equal(0)
      expect(memory.deviceKey).to.equal(KEY_1)
    })
  })

  it('R7: a retry against a closed registration rejects RegistrationRequestClosedError, forgets the ids and inits, keeps the key and election, clears the store', async () => {
    let stop = false
    const first = makeRig({ transports: makeTransports({ notices: () => { stop = true; return [] } }), shouldStop: () => stop })
    await rejection(runRegistrationCeremony(first.deps))
    const registrantId = first.deps.memory.registrantId as string
    stop = false
    const retry = makeRig({
      transports: makeTransports({ registrationNotices: [{ requestId: registrantId, status: 'r' }] }),
      producer: first.producer,
      store: first.store,
      memory: first.deps.memory,
    })
    const err = await rejection(runRegistrationCeremony(retry.deps))
    expect(err.name).to.equal('RegistrationRequestClosedError')
    expect(retry.deps.memory.registrantId).to.equal(null)
    expect(retry.deps.memory.associationRequestId).to.equal(null)
    expect(retry.deps.memory.registrationRequestInit).to.equal(null)
    expect(retry.deps.memory.associationRequestInit).to.equal(null)
    expect(retry.deps.memory.registrationCode).to.equal(null)
    expect(retry.deps.memory.registrationStaged).to.equal(false)
    expect(retry.deps.memory.deviceKey).to.equal(KEY_1)
    expect(retry.deps.memory.electionId).to.equal(ELECTION_ID)
    expect(first.store.clearCalls).to.equal(1)
    expect(retry.transports.registrationSubmits).to.have.length(0)
  })

  it('R8: a refused association decision rejects, nulls the association, stores association: null and never produces', async () => {
    const rig = makeRig({ transports: makeTransports({ notices: () => [{ requestId: 'x', status: 'r', cursor: '1' }] }) })
    rig.transports.associationTransport.pollDecisions = async () => [{
      requestId: rig.deps.memory.associationRequestId as string, status: 'r', cursor: '1',
    }]
    const err = await rejection(runRegistrationCeremony(rig.deps))
    expect(err.message).to.equal('The authority rejected the association request.')
    expect(rig.deps.memory.associationRequestId).to.equal(null)
    expect(rig.deps.memory.associationRequestInit).to.equal(null)
    expect(rig.store.writes).to.have.length(3)
    expect(rig.store.writes[2]!.association).to.equal(null)
    expect(rig.producer.produceCalls).to.have.length(0)
    expect(rig.events[rig.events.length - 1]).to.deep.equal({ type: 'milestone', milestone: 'decision-received', status: 'r' })
  })

  it('R9: a challenge notice with no nonce rejects and never produces', async () => {
    const rig = makeRig()
    rig.transports.associationTransport.pollDecisions = async () => [{
      requestId: rig.deps.memory.associationRequestId as string, status: 'c', cursor: '1',
    }]
    const err = await rejection(runRegistrationCeremony(rig.deps))
    expect(err.message).to.equal('The authority issued a challenge notice with no nonce.')
    expect(rig.producer.produceCalls).to.have.length(0)
  })

  it('R10: a stop during the wait rejects DecisionWaitStoppedError before produce; a stop at entry rejects before the election read', async () => {
    let stop = false
    const rig = makeRig({ transports: makeTransports({ notices: () => [] }), shouldStop: () => stop })
    const original = rig.deps.sleep
    rig.deps.sleep = async ms => {
      stop = true
      await original(ms)
    }
    const err = await rejection(runRegistrationCeremony(rig.deps))
    expect(err.name).to.equal('DecisionWaitStoppedError')
    expect(rig.producer.produceCalls).to.have.length(0)
    expect(rig.events[rig.events.length - 1]).to.deep.equal(step('decision-wait'))

    const atEntry = makeRig({ shouldStop: () => true })
    const entryErr = await rejection(runRegistrationCeremony(atEntry.deps))
    expect(entryErr.name).to.equal('DecisionWaitStoppedError')
    expect(atEntry.resolveElectionCalls).to.equal(0)
    expect(atEntry.events).to.deep.equal([])
  })

  it('R11: a duplicate-request-id refusal of the answer still resolves answered; any other rejection propagates and keeps the store', async () => {
    const dup = Object.assign(new Error('dup'), { name: 'P2pStagingError', code: 'duplicate-request-id' })
    const okRig = makeRig({ transports: makeTransports({ attestationError: dup }) })
    expect(await runRegistrationCeremony(okRig.deps)).to.deep.equal({ outcome: 'answered' })
    expect(okRig.store.clearCalls).to.equal(1)

    const other = Object.assign(new Error('refused'), { name: 'P2pStagingError', code: 'something-else' })
    const badRig = makeRig({ transports: makeTransports({ attestationError: other }) })
    expect(await rejection(runRegistrationCeremony(badRig.deps))).to.equal(other)
    expect(badRig.store.clearCalls).to.equal(0)
    expect(badRig.store.raw).to.not.equal(null)
  })

  it('R12: no election rejects NoElectionConfiguredError before transports; no transports rejects the unreachable message', async () => {
    const noElection = makeRig({ electionId: undefined })
    const err = await rejection(runRegistrationCeremony(noElection.deps))
    expect(err.name).to.equal('NoElectionConfiguredError')
    expect(noElection.resolveTransportsCalls).to.deep.equal([])
    expect(noElection.events).to.deep.equal([step('election')])

    const unreachable = makeRig({ transportsUndefined: true })
    const err2 = await rejection(runRegistrationCeremony(unreachable.deps))
    expect(err2.message).to.equal('Cannot reach the authority right now — please try again later.')
    expect(unreachable.resolveTransportsCalls).to.deep.equal([AUTHORITY_ID])
    expect(unreachable.producer.provisionCalls).to.equal(0)
  })

  it('R13: with a producer lacking signDeviceKeyDigest, the association sign callback rejects with the signer-unavailable message', async () => {
    const rig = makeRig({ producer: makeProducer({ withSign: false }) })
    await runRegistrationCeremony(rig.deps)
    const sign = rig.transports.associationSubmits[0]!.sign
    const err = await rejection(sign(new Uint8Array([1])))
    expect(err.message).to.equal('Device attestation signer is not available yet — please try again later.')
  })

  describe('R14: secrecy', () => {
    it('the event stream carries no id, nonce, key, code or authority', async () => {
      const rig = makeRig()
      await runRegistrationCeremony(rig.deps)
      const text = JSON.stringify(rig.events)
      for (const secret of [rig.deps.memory.registrantId as string, rig.deps.memory.associationRequestId as string, NONCE, KEY_1, CODE, AUTHORITY_ID]) {
        expect(text).to.not.include(secret)
      }
      for (const event of rig.events) {
        expect(Object.keys(event).sort()).to.deep.equal(event.type === 'step' ? ['step', 'type'] : (event.milestone === 'decision-received' ? ['milestone', 'status', 'type'] : ['milestone', 'type']))
      }
    })
    it('the shared source has no logging, no debug switch and no debug logger', () => {
      const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
      const code = stripComments(readFileSync(`${packageRoot}src/voter/registration-ceremony.ts`, 'utf8'))
      const needles = ['con' + 'sole.', '__DE' + 'V__', 'vt' + 'Debug']
      for (const needle of needles) {
        expect(code.split(needle).length - 1, needle).to.equal(0)
      }
      expect(code).to.include('runRegistrationCeremony')
    })
  })

  describe('R15: pollForNotice', () => {
    const notice = (status: string, cursor: string): Notice => ({ requestId: 'req', status, cursor })
    const clockOf = () => {
      const c = { t: 0, sleeps: [] as number[] }
      return { c, now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms } }
    }
    it('an open-ended wait returns the matching notice and forwards the cursor', async () => {
      const { now, sleep, c } = clockOf()
      const cursors: Array<string | undefined> = []
      const reads = [[notice('p', 'c1')], [{ ...notice('c', 'c2'), challengeNonce: NONCE }, notice('x', 'c3')]]
      const poll = async (since?: string) => { cursors.push(since); return reads.shift() ?? [] }
      const got = await pollForNotice(poll, 'req', new Set(['c', 'r']), { now, sleep, deadlineMs: null, shouldStop: () => false })
      expect(got.status).to.equal('c')
      expect(got.cursor).to.equal('c2')
      expect(cursors).to.deep.equal([undefined, 'c1'])
      expect(c.sleeps).to.deep.equal([DECISION_POLL_INTERVAL_MS])
    })
    it('a numeric deadline rejects DecisionWaitTimeoutError', async () => {
      const { now, sleep } = clockOf()
      const err = await rejection(pollForNotice(async () => [], 'req', new Set(['c']), { now, sleep, deadlineMs: 5_000, shouldStop: () => false }))
      expect(err.name).to.equal('DecisionWaitTimeoutError')
    })
    it('a stop rejects DecisionWaitStoppedError', async () => {
      const { now, sleep } = clockOf()
      let polls = 0
      const err = await rejection(pollForNotice(async () => { polls += 1; return [] }, 'req', new Set(['c']), { now, sleep, deadlineMs: null, shouldStop: () => polls >= 2 }))
      expect(err.name).to.equal('DecisionWaitStoppedError')
      expect(polls).to.equal(2)
    })
    it('the constants are 2000 and 300000', () => {
      expect(DECISION_POLL_INTERVAL_MS).to.equal(2000)
      expect(DECISION_WAIT_MAX_MS).to.equal(300000)
    })
  })

  it('R16: the draft mapping omits empty details, has no selective tier without a party, and uses the ignored placeholder expiration', async () => {
    const rig = makeRig({ draft: { ...draft, phone: '', addressLine2: '', addressLine3: '', party: '' } })
    await runRegistrationCeremony(rig.deps)
    const init = (rig.transports.registrationSubmits[0]!.init as RegistrationRequestInit).payload
    expect(init.private.details).to.deep.equal([
      { name: 'dob', value: draft.dob },
      { name: 'email', value: draft.email },
      { name: 'addressLine1', value: draft.addressLine1 },
    ])
    expect(init.selective).to.equal(undefined)
    expect(init.public).to.deep.equal({ firstName: 'Ada', lastName: 'Lovelace' })
    expect(IGNORED_EXPIRATION_PLACEHOLDER).to.equal('1970-01-01T00:00:00.000Z')
    expect(init.registrant.expiration).to.equal('1970-01-01T00:00:00.000Z')
    expect(init.private.expiration).to.equal('1970-01-01T00:00:00.000Z')

    const withParty = makeRig()
    await runRegistrationCeremony(withParty.deps)
    const init2 = (withParty.transports.registrationSubmits[0]!.init as RegistrationRequestInit).payload
    expect(init2.selective).to.deep.equal({ expiration: '1970-01-01T00:00:00.000Z', details: [{ name: 'party', value: 'independent' }] })
  })
})
