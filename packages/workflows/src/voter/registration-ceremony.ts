/**
 * registration-ceremony.ts: the Voter's registration + association ceremony as one Node-safe
 * function, `runRegistrationCeremony`. Origin: `apps/VoteTorrentVoter/src/screens/registration/ConfirmationScreen.tsx`
 * `onConfirm` (phase 67 plan 11); the screen now calls this function and keeps React state, its refs
 * and its presentation. The CLI voter daemon calls the same function with its own producer and store.
 *
 * The ceremony (order matters; the biometric-last property, D-06/D-15/D-16, is unchanged):
 *   1. Resolve the attempt's hardware-backed P-256 device key BEFORE any request is submitted. ONCE per
 *      attempt (spike 104): a retry, or a press that resumes a stored attempt, reads the key back with
 *      `getCurrentDeviceKey` and never re-provisions; only a key that is gone or changed starts a new
 *      association request for a newly provisioned key.
 *   2. Map the draft onto `RegisterInit` tiers (name public, contact/dob/address private, party
 *      selective; empty values are never furnished, WR-04).
 *   3. Submit the self-signed registration-request document, signed by the voter's OWN secp256k1
 *      identity signer (`deviceSign`), never an officer signer. On the P2P route the registration code is
 *      minted first and travels as `extras.registrationCode` (D-45); the REST bridge route carries none.
 *   4. Submit the self-signed association-request document bound to the P-256 device key, then wait for
 *      the authority's challenge-issued decision notice: an open-ended wait (64 D-27), ended only by the
 *      notice or by `shouldStop()`. The authority's challenge-issuing engine method is never called.
 *   5. `producer.produce(challenge)`: the D-11 second step, after the challenge and before the answer.
 *   6. Submit the self-signed attestation-answer document and clear the stored attempt.
 *
 * D-12: the voter proposes NO expiration for a record the authority signs; `IGNORED_EXPIRATION_PLACEHOLDER`
 * fills the three required fields and the authority's approval path overrides it.
 *
 * D-05/D-32: both inits (not just their ids) are minted once per attempt and reused byte-identical on
 * every retry out of the caller-owned `memory`, so an idempotent P2P re-submit never becomes a permanent
 * 'duplicate-request-id'. An attempt also outlives its process through the caller's `store`: the ids, the
 * association init, the device key and the registration's `submittedAt` (never the payload) are stored
 * before the first submit and resumed by a later run with empty memory for the same identity, authority
 * and election. The stored attempt ends when the answer is staged, when the authority closes the
 * registration request, or when it belongs to another identity, authority or election; a refused
 * association request is replaced by a new one for the same registrant.
 *
 * The caller supplies the identity signer, the producer and the attempt store. This module never holds
 * key material and never logs: progress is reported only as closed-token step and milestone events.
 */

import type {
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AttestationChallenge,
  DeviceAttestation,
  INetworkEngine,
  PrivateDetail,
  RegisterInit,
  RegistrationRequestInit,
  Signature,
} from '@votetorrent/vote-core'
import type { AttestationProducer, SignCallback } from '../platform/index.js'

/**
 * D-12: `RegisterInit`'s `registrant`/`private`/`selective` tiers still declare an expiration field as
 * required (the type itself is untouched), but the voter proposes NO validity window for a record the
 * authority signs. This value is a clearly-non-real placeholder, deliberately in the deep past, and is
 * IGNORED: the authority's approval path overrides all three occurrences with its own policy-derived
 * value before ever creating the Registrant record.
 */
export const IGNORED_EXPIRATION_PLACEHOLDER = new Date(0).toISOString()

/**
 * 64 D-27, revised 2026-11-17: the Confirm press waits for the officer's decision with NO deadline,
 * polling every 2 s until the officer answers or the voter presses Stop or leaves the screen. The old
 * 180 s deadline ran out before a busy officer challenged (about 9.5 min on the 2026-11-17 Redmi run),
 * and each Try Again cost the voter another fingerprint. `DECISION_WAIT_MAX_MS` caps only a caller that
 * passes a numeric deadline to `pollForNotice`.
 */
export const DECISION_POLL_INTERVAL_MS = 2_000
export const DECISION_WAIT_MAX_MS = 300_000

/**
 * The wait ended without a decision. Matched by `name` (the duck typing `NoElectionConfiguredError`
 * already uses), which is safe under Babel and Hermes class transforms.
 */
function decisionWaitError (name: 'DecisionWaitTimeoutError' | 'DecisionWaitStoppedError'): Error {
  return Object.assign(
    new Error(name === 'DecisionWaitTimeoutError' ? 'The decision wait reached its deadline.' : 'The decision wait was stopped.'),
    { name },
  )
}

export interface DecisionNoticeLike {
  requestId: string
  status: string
  cursor: string
  challengeNonce?: string
}

/** The ceremony steps, as closed tokens. The identity read (step 0) stays with the caller. */
export type RegistrationCeremonyStep =
  | 'election'
  | 'network'
  | 'transports'
  | 'resume'
  | 'device-key'
  | 'registration-check'
  | 'registration-submit'
  | 'association-submit'
  | 'decision-wait'
  | 'produce'
  | 'attestation-submit'

/** The points a caller may stop at and resume from (through `store` and `memory`) on a later run. */
export type RegistrationCeremonyMilestone = 'registration-staged' | 'association-staged' | 'decision-received' | 'answered'

/**
 * A progress event. Only closed tokens and, on `decision-received`, the notice's one-letter status: no
 * other field exists, so no id, nonce, key, code or signature can ride on an event, by type.
 */
export type RegistrationCeremonyEvent =
  | { type: 'step'; step: RegistrationCeremonyStep }
  | { type: 'milestone'; milestone: Exclude<RegistrationCeremonyMilestone, 'decision-received'> }
  | { type: 'milestone'; milestone: 'decision-received'; status: string }

/**
 * The caller-owned per-attempt memory (the screen's former refs): minted once and reused byte-identical
 * on every retry within one mount or process. `deviceKey` and `electionId` survive a reset; the ids and
 * inits do not.
 */
export interface RegistrationCeremonyMemory {
  electionId: string | null
  registrantId: string | null
  associationRequestId: string | null
  registrationRequestInit: RegistrationRequestInit | null
  associationRequestInit: AssociationRequestInit | null
  registrationCode: string | null
  deviceKey: string | null
  registrationSubmittedAt: string | null
  registrationStaged: boolean
}

/** The stored attempt record: field for field the Voter app's `RegistrationAttemptRecord`. */
export interface RegistrationCeremonyAttemptRecord {
  version: 1
  /** The secp256k1 identity PUBLIC key the registration request is signed by. */
  identityKey: string
  authorityId: string
  electionId: string
  /** Also the registration request's own id. */
  registrantId: string
  registrationSubmittedAt: string
  /** True once a registration submit for this id has succeeded on this device. */
  registrationStaged: boolean
  /** The P-256 PUBLIC key this attempt's association request names. */
  deviceKey: string
  /** Null once the authority refused the association request (a new one is made on the next run). */
  association: AssociationRequestInit | null
}

/**
 * The attempt store. Implementations never throw (an unreadable store reads as "no attempt", a failed
 * write only loses the resume) and store only the record's public fields, never the payload.
 */
export interface RegistrationCeremonyAttemptStore {
  read(): Promise<RegistrationCeremonyAttemptRecord | null>
  write(record: RegistrationCeremonyAttemptRecord): Promise<void>
  clear(): Promise<void>
}

/** The nine draft fields the ceremony reads (the app's `RegistrationDraft` is assignable). */
export interface RegistrationCeremonyDraft {
  firstName: string
  lastName: string
  dob: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  addressLine3: string
  party: string
}

/** The narrowest structural view of the Voter's request transports the ceremony uses. */
export interface RegistrationCeremonyTransports {
  registrationRoute: 'peer' | 'rest-bridge'
  registrationTransport: {
    submitRequest(
      init: RegistrationRequestInit,
      requesterKey: string,
      sign: SignCallback,
      extras?: { registrationCode?: string },
    ): Promise<unknown>
    pollDecisions?(sinceCursor?: string): Promise<Array<{ requestId: string; status: string }>>
  }
  associationTransport: {
    submitRequest(init: AssociationRequestInit, requesterKey: string, sign: SignCallback): Promise<unknown>
    submitAttestation(answer: AssociationAttestationAnswer, requesterKey: string, sign: SignCallback): Promise<unknown>
    pollDecisions(sinceCursor?: string): Promise<Array<{ requestId: string; status: string; cursor: string; challengeNonce?: string }>>
  }
  ownStagedRegistrationRequestIds(requesterKey: string): Promise<string[]>
}

export interface RegistrationCeremonyDeps {
  getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
  /** The voter's own identity; `activeKeys[0].key` is the requester key of the registration request. */
  deviceUser: { activeKeys: ReadonlyArray<{ key: string }> }
  /** The voter's OWN secp256k1 identity signer, never an officer signer. */
  deviceSign: SignCallback
  producer: AttestationProducer
  store: RegistrationCeremonyAttemptStore
  memory: RegistrationCeremonyMemory
  draft: RegistrationCeremonyDraft
  /** The joined network's current election, or undefined when none is configured. */
  resolveElectionId: () => Promise<string | undefined>
  /** The transports over the joined network, or undefined when the authority is unreachable. */
  resolveTransports: (authorityId: string) => Promise<RegistrationCeremonyTransports | undefined>
  /** D-45: the registration code, minted by the identity-key signer (P2P route only). */
  mintRegistrationCode: (registrantId: string, sign: SignCallback) => Promise<string>
  /** Attributes a submit to `registration:<registrantId>` (the app's commit tracker); optional. */
  trackSubmit?: <T>(actionKey: string, fn: () => Promise<T>) => Promise<T>
  now: () => number
  sleep: (ms: number) => Promise<void>
  shouldStop: () => boolean
  onStep?: (event: RegistrationCeremonyEvent) => void
}

/**
 * Waits until a notice for `requestId` reaches one of `terminalStatuses` (64 D-27), forwarding the
 * cursor between reads. The first read is immediate; each later read follows a sleep of at most
 * `DECISION_POLL_INTERVAL_MS`, clamped to the time left. A null `options.deadlineMs` means no
 * deadline: the wait ends only on the notice or on `shouldStop()` (the Confirmation screen's mode).
 * A numeric deadline bounds the wait by wall clock (capped at `DECISION_WAIT_MAX_MS`; a non-finite
 * or non-positive value falls to the cap) and rejects with `DecisionWaitTimeoutError`; a clock jump
 * past it ends the wait at the next tick with no further read. Either way the wait rejects with
 * `DecisionWaitStoppedError` as soon as `shouldStop()` holds (a notice read after that is discarded).
 *
 * Every tick is a fresh `pollDecisions` cursor read, never a cached list. A timeout therefore says
 * nothing about whether the requests were written: they were already staged, and Try Again
 * re-submits them idempotently.
 */
export async function pollForNotice<T extends DecisionNoticeLike> (
  poll: (sinceCursor?: string) => Promise<T[]>,
  requestId: string,
  terminalStatuses: ReadonlySet<string>,
  options: { now: () => number; sleep: (ms: number) => Promise<void>; deadlineMs: number | null; shouldStop: () => boolean },
): Promise<T> {
  const bound =
    options.deadlineMs === null
      ? Infinity
      : Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
        ? Math.min(options.deadlineMs, DECISION_WAIT_MAX_MS)
        : DECISION_WAIT_MAX_MS
  const deadlineAt = options.now() + bound
  let cursor: string | undefined
  for (;;) {
    if (options.shouldStop()) {
      throw decisionWaitError('DecisionWaitStoppedError')
    }
    const notices = await poll(cursor)
    if (options.shouldStop()) {
      throw decisionWaitError('DecisionWaitStoppedError')
    }
    for (const notice of notices) {
      cursor = notice.cursor
      if (notice.requestId === requestId && terminalStatuses.has(notice.status)) {
        return notice
      }
    }
    const left = deadlineAt - options.now()
    if (left <= 0) {
      throw decisionWaitError('DecisionWaitTimeoutError')
    }
    await options.sleep(Math.min(DECISION_POLL_INTERVAL_MS, left))
    if (options.shouldStop()) {
      throw decisionWaitError('DecisionWaitStoppedError')
    }
    if (options.now() >= deadlineAt) {
      throw decisionWaitError('DecisionWaitTimeoutError')
    }
  }
}

/** Throws `DecisionWaitStoppedError` when `shouldStop()` holds; the ceremony's stop check. */
export function throwIfCeremonyStopped (shouldStop: () => boolean): void {
  if (shouldStop()) {
    throw decisionWaitError('DecisionWaitStoppedError')
  }
}

/** A fresh attempt memory: nothing minted, nothing staged. */
export function createRegistrationCeremonyMemory (): RegistrationCeremonyMemory {
  return {
    electionId: null,
    registrantId: null,
    associationRequestId: null,
    registrationRequestInit: null,
    associationRequestInit: null,
    registrationCode: null,
    deviceKey: null,
    registrationSubmittedAt: null,
    registrationStaged: false,
  }
}

/**
 * The read-only `getCurrentDeviceKey` lookup's two "no usable key" reject codes (the producer contract
 * in `platform/attestation.ts`). They are not ceremony failures; any other rejection propagates.
 */
function isDeviceKeyGone (err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === 'DEVICE_KEY_ABSENT' || code === 'DEVICE_KEY_INVALIDATED'
}

/**
 * Spike 104: this attempt's voting key. A retry reads the key back (read-only) and keeps it when it
 * is still the one the association request names. Only a key that is absent or permanently
 * invalidated, or a different key, is replaced, and then the association request is made again for
 * the new key (the registration request is signed by the identity key and is kept). Any other lookup
 * failure propagates rather than silently minting a new key.
 */
export async function resolveAttemptDeviceKey (memory: RegistrationCeremonyMemory, producer: AttestationProducer): Promise<string> {
  const attemptKey = memory.deviceKey
  if (attemptKey !== null) {
    let current: string | null
    try {
      current = (await producer.getCurrentDeviceKey()).publicKey
    } catch (err) {
      if (!isDeviceKeyGone(err)) {
        throw err
      }
      current = null
    }
    if (current === attemptKey) {
      return attemptKey
    }
    memory.associationRequestId = null
    memory.associationRequestInit = null
  }
  const { publicKey } = await producer.provisionDeviceKey()
  memory.deviceKey = publicKey
  return publicKey
}

/**
 * True when the authority has closed this registration request ('r', which also carries D-44's
 * closed-as-duplicate). Best-effort: a read that fails, or a transport with no decision read, says
 * "not closed" and the ceremony carries on exactly as before.
 */
async function isRegistrationRequestClosed (
  transport: { pollDecisions?: (sinceCursor?: string) => Promise<Array<{ requestId: string; status: string }>> },
  requestId: string,
): Promise<boolean> {
  if (typeof transport.pollDecisions !== 'function') {
    return false
  }
  try {
    const notices = await transport.pollDecisions()
    return notices.some(notice => notice.requestId === requestId && notice.status === 'r')
  } catch {
    return false
  }
}

/** The P2P staging refusal for a request id that already holds a different staged row. */
function isDuplicateStagedRequest (err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null | undefined
  return e?.name === 'P2pStagingError' && e.code === 'duplicate-request-id'
}

/** Forgets every id and init of this attempt (the device key and election are kept). */
function resetAttempt (memory: RegistrationCeremonyMemory): void {
  memory.registrantId = null
  memory.associationRequestId = null
  memory.registrationRequestInit = null
  memory.associationRequestInit = null
  memory.registrationCode = null
  memory.registrationSubmittedAt = null
  memory.registrationStaged = false
}

/**
 * A run with no attempt in memory (a fresh mount or a new process) takes up the stored attempt when it
 * belongs to this identity, authority and election, so the second run waits on the SAME request with the
 * SAME device key instead of provisioning a new key and filing a second request. A stored attempt that
 * does not match is dropped. Returns whether an attempt was resumed.
 */
async function resumeStoredAttempt (
  memory: RegistrationCeremonyMemory,
  store: RegistrationCeremonyAttemptStore,
  identityKey: string,
  authorityId: string,
  electionId: string,
): Promise<boolean> {
  if (memory.registrantId !== null) {
    return false
  }
  const stored = await store.read()
  if (stored === null) {
    return false
  }
  if (stored.identityKey !== identityKey || stored.authorityId !== authorityId || stored.electionId !== electionId) {
    await store.clear()
    return false
  }
  memory.registrantId = stored.registrantId
  memory.registrationSubmittedAt = stored.registrationSubmittedAt
  memory.registrationStaged = stored.registrationStaged
  memory.deviceKey = stored.deviceKey
  if (stored.association !== null) {
    memory.associationRequestId = stored.association.id
    memory.associationRequestInit = stored.association
  }
  return true
}

/** Stores this attempt as it now stands (best-effort; the store never throws). */
async function storeAttempt (
  memory: RegistrationCeremonyMemory,
  store: RegistrationCeremonyAttemptStore,
  identityKey: string,
  authorityId: string,
  electionId: string,
  deviceKey: string,
): Promise<void> {
  const registrantId = memory.registrantId
  const submittedAt = memory.registrationSubmittedAt
  if (registrantId === null || submittedAt === null) {
    return
  }
  await store.write({
    version: 1,
    identityKey,
    authorityId,
    electionId,
    registrantId,
    registrationSubmittedAt: submittedAt,
    registrationStaged: memory.registrationStaged,
    deviceKey,
    association: memory.associationRequestInit,
  })
}

/** A v4 id from the platform's crypto; both apps and Node provide `globalThis.crypto`. */
function mintId (): string {
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID()
}

/**
 * Runs the ceremony (steps 1-6 above) once. Rejects with the same error names and messages the screen
 * raised: `NoElectionConfiguredError`, `RegistrationRequestClosedError`, `DecisionWaitStoppedError`, the
 * unreachable-authority, refused-association, no-nonce and signer-unavailable messages, and whatever the
 * transports or the producer reject with. `shouldStop()` is consulted after every await, so a caller that
 * flips it on a milestone stops before the next irreversible action and resumes on its next run from
 * `store` and `memory`.
 */
export async function runRegistrationCeremony (deps: RegistrationCeremonyDeps): Promise<{ outcome: 'answered' }> {
  const { getEngine, deviceUser, deviceSign, producer, store, memory, resolveElectionId, resolveTransports, mintRegistrationCode, trackSubmit, now, sleep, shouldStop, onStep } = deps
  throwIfCeremonyStopped(shouldStop)
  const deviceUserKey = deviceUser.activeKeys[0]!.key
  const emit = (event: RegistrationCeremonyEvent): void => {
    onStep?.(event)
  }
  const tracked = <T>(actionKey: string, fn: () => Promise<T>): Promise<T> => (trackSubmit ? trackSubmit(actionKey, fn) : fn())

  emit({ type: 'step', step: 'election' })
  // WR-03: the registration request's payload only enforces field policy when init.electionId is
  // set. Fail closed rather than submit with policy unenforced. 64 D-28: the election is the joined
  // network's current one, resolved once per attempt (both inits and the challenge embed it); a
  // rejected read propagates.
  let electionId = memory.electionId
  if (electionId === null) {
    const resolved = await resolveElectionId()
    throwIfCeremonyStopped(shouldStop)
    if (!resolved) {
      throw Object.assign(
        new Error('No election configured — cannot register (field policy would be unenforced).'),
        { name: 'NoElectionConfiguredError' },
      )
    }
    electionId = resolved
    memory.electionId = resolved
  }

  // The joined network's authority, resolved from the already-established network context, never
  // hand-rolled.
  emit({ type: 'step', step: 'network' })
  const networkEngine = await getEngine<INetworkEngine>('network')
  const details = await networkEngine.getDetails()
  throwIfCeremonyStopped(shouldStop)
  const authorityId = details.network.primaryAuthorityId

  // D-28/D-29/D-32: reach the authority through the joined network's own strand, P2P by default, or
  // the authority-configured REST bridge for registration only. Unreachable (no delivery path at all)
  // is a user-visible condition, never a crash.
  emit({ type: 'step', step: 'transports' })
  const transports = await resolveTransports(authorityId)
  throwIfCeremonyStopped(shouldStop)
  if (!transports) {
    throw new Error('Cannot reach the authority right now — please try again later.')
  }

  // A run with empty memory takes up this device's stored attempt instead of starting a second one:
  // same registrant, same requests, same device key.
  emit({ type: 'step', step: 'resume' })
  const resumed = await resumeStoredAttempt(memory, store, deviceUserKey, authorityId, electionId)
  throwIfCeremonyStopped(shouldStop)
  const isRetry = memory.registrantId !== null

  // Spike 104: this attempt's P-256 voting key, read back (never re-provisioned) when the attempt
  // already has one, provisioned only for a new attempt or a key that is gone.
  emit({ type: 'step', step: 'device-key' })
  const p256DeviceKey = await resolveAttemptDeviceKey(memory, producer)
  throwIfCeremonyStopped(shouldStop)

  // A request the authority has closed can never be approved, so waiting on it again would time out
  // forever: the attempt is dropped and the next run starts a new one.
  if (isRetry && memory.registrantId !== null) {
    emit({ type: 'step', step: 'registration-check' })
    const closed = await isRegistrationRequestClosed(transports.registrationTransport, memory.registrantId)
    throwIfCeremonyStopped(shouldStop)
    if (closed) {
      resetAttempt(memory)
      await store.clear()
      throw Object.assign(new Error('The authority closed the registration request.'), { name: 'RegistrationRequestClosedError' })
    }
  }
  // A resumed attempt whose registration request is already on the strand needs no rebuilt init (and
  // no draft): the staging row is immutable and already the officer's.
  if (resumed && !memory.registrationStaged && memory.registrantId !== null) {
    try {
      const own = await transports.ownStagedRegistrationRequestIds(deviceUserKey)
      memory.registrationStaged = own.includes(memory.registrantId)
    } catch {
      // Unknown: the init is rebuilt and re-submitted (idempotent when byte-identical).
    }
    throwIfCeremonyStopped(shouldStop)
  }

  // WR-02: mint each id once per attempt and reuse it on retry.
  let registrantId = memory.registrantId
  if (registrantId === null) {
    registrantId = mintId()
    memory.registrantId = registrantId
  }
  let associationRequestId = memory.associationRequestId
  if (associationRequestId === null) {
    associationRequestId = mintId()
    memory.associationRequestId = associationRequestId
  }

  // (1) The self-signed registration request document, never a direct write and never the officer
  // signer. Reuses the registrantId as the request document's own id. D-05/D-32: the whole init
  // (including submittedAt) is minted ONCE and reused byte-identical on every retry, so a P2P re-submit
  // after a stop is idempotent instead of a permanent 'duplicate-request-id'. A resumed attempt rebuilds
  // it from the draft with the stored submittedAt, unless the request is already staged.
  let registrationRequestInit = memory.registrationRequestInit
  if (registrationRequestInit === null && !memory.registrationStaged) {
    // Tier mapping: name -> public, contact/dob/address -> private, party -> selective. WR-04: only
    // furnish details that actually have a value. Furnishing an empty {name, value: ''} entry would
    // satisfy the engine's name-presence check for a policy-required private field, letting a blank
    // required field slip past field-policy enforcement.
    const privateDetails: PrivateDetail[] = [
      { name: 'dob', value: deps.draft.dob },
      { name: 'email', value: deps.draft.email },
      { name: 'phone', value: deps.draft.phone },
      { name: 'addressLine1', value: deps.draft.addressLine1 },
      { name: 'addressLine2', value: deps.draft.addressLine2 },
      { name: 'addressLine3', value: deps.draft.addressLine3 },
    ].filter(detail => detail.value !== '')

    const init: RegisterInit = {
      electionId,
      registrant: { id: registrantId, authorityId, expiration: IGNORED_EXPIRATION_PLACEHOLDER },
      public: { firstName: deps.draft.firstName, lastName: deps.draft.lastName },
      private: { expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: privateDetails },
      // D-13: an absent/empty selective payload means no RegistrantSelective row at all; only enter
      // this branch when the voter actually picked a party.
      selective: deps.draft.party
        ? { expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: [{ name: 'party', value: deps.draft.party }] }
        : undefined,
    }
    const submittedAt = memory.registrationSubmittedAt ?? new Date().toISOString()
    memory.registrationSubmittedAt = submittedAt
    registrationRequestInit = {
      id: registrantId,
      authorityId,
      payload: init,
      submittedAt,
    }
    memory.registrationRequestInit = registrationRequestInit
  }

  // (2) The self-signed association-request init, bound to the P-256 device key. The requester key
  // MUST equal the device key (the authority's engine enforces this with a pre-flight guard); both are
  // p256DeviceKey. Reused byte-identical on retry, same idempotency rationale as the registration init.
  let associationRequestInit = memory.associationRequestInit
  if (associationRequestInit === null) {
    associationRequestInit = {
      id: associationRequestId,
      authorityId,
      registrantId,
      deviceKey: p256DeviceKey,
      electionId,
      submittedAt: new Date().toISOString(),
    }
    memory.associationRequestInit = associationRequestInit
  }

  // Stored BEFORE the first submit, so a process killed mid-submit resumes this attempt.
  await storeAttempt(memory, store, deviceUserKey, authorityId, electionId, p256DeviceKey)
  throwIfCeremonyStopped(shouldStop)

  if (registrationRequestInit !== null) {
    // D-45: mint the registration code on the P2P route ONLY; the REST bridge cannot carry `extras` at
    // all, so a registration submitted over it never gets a code. Minted once per attempt, from the SAME
    // identity-key signer that signs the request itself, never a raw key.
    emit({ type: 'step', step: 'registration-submit' })
    if (transports.registrationRoute === 'peer' && memory.registrationCode === null) {
      memory.registrationCode = await mintRegistrationCode(registrantId, deviceSign)
      throwIfCeremonyStopped(shouldStop)
    }
    const registrationInit = registrationRequestInit
    if (transports.registrationRoute === 'peer') {
      await tracked(`registration:${registrantId}`, () =>
        transports.registrationTransport.submitRequest(registrationInit, deviceUserKey, deviceSign, {
          registrationCode: memory.registrationCode as string,
        }),
      )
    } else {
      await tracked(`registration:${registrantId}`, () =>
        transports.registrationTransport.submitRequest(registrationInit, deviceUserKey, deviceSign),
      )
    }
    throwIfCeremonyStopped(shouldStop)
    if (!memory.registrationStaged) {
      memory.registrationStaged = true
      await storeAttempt(memory, store, deviceUserKey, authorityId, electionId, p256DeviceKey)
    }
    emit({ type: 'milestone', milestone: 'registration-staged' })
    throwIfCeremonyStopped(shouldStop)
  }

  // The association-request self-signature must verify directly against the P-256 device key (the
  // schema checks the signature against that exact public key, not against any registered identity);
  // `signDeviceKeyDigest` is the producer seam for that.
  const associationSign = async (digest: Uint8Array): Promise<Signature> => {
    if (typeof producer.signDeviceKeyDigest !== 'function') {
      throw new Error('Device attestation signer is not available yet — please try again later.')
    }
    return producer.signDeviceKeyDigest(digest)
  }
  emit({ type: 'step', step: 'association-submit' })
  const associationInit = associationRequestInit
  await tracked(`registration:${registrantId}`, () =>
    transports.associationTransport.submitRequest(associationInit, p256DeviceKey, associationSign),
  )
  throwIfCeremonyStopped(shouldStop)
  emit({ type: 'milestone', milestone: 'association-staged' })

  // (3) Obtain the challenge nonce from a challenge-issued decision notice; the authority's
  // challenge-issuing engine method is never called. 64 D-27: wait for the officer's decision with no
  // deadline, ended only by `shouldStop()`.
  emit({ type: 'step', step: 'decision-wait' })
  const decisionNotice = await pollForNotice(
    transports.associationTransport.pollDecisions.bind(transports.associationTransport),
    associationRequestId,
    new Set(['c', 'r']),
    {
      now,
      sleep,
      deadlineMs: null,
      shouldStop,
    },
  )
  throwIfCeremonyStopped(shouldStop)
  emit({ type: 'milestone', milestone: 'decision-received', status: decisionNotice.status })
  if (decisionNotice.status === 'r') {
    // This association request is closed for good: the next run makes a new one for the same
    // registrant instead of waiting on a refused request forever.
    memory.associationRequestId = null
    memory.associationRequestInit = null
    await storeAttempt(memory, store, deviceUserKey, authorityId, electionId, p256DeviceKey)
    throw new Error('The authority rejected the association request.')
  }
  if (!decisionNotice.challengeNonce) {
    throw new Error('The authority issued a challenge notice with no nonce.')
  }

  // (4) The D-11 second producer step answers the challenge, after the challenge is obtained and
  // before the attestation answer is submitted. iOS prompts here; Android does not (spike 104, R1d):
  // its voting key stays under the alias, so the answer below is signed by p256DeviceKey, the key the
  // request named and the authority checks it against.
  const challenge: AttestationChallenge = {
    nonce: decisionNotice.challengeNonce,
    authorityId,
    registrantId,
    deviceKey: p256DeviceKey,
    electionId,
  }
  // On iOS `produce` raises Face ID: it never runs for a stopped attempt.
  throwIfCeremonyStopped(shouldStop)
  emit({ type: 'step', step: 'produce' })
  const attestation: DeviceAttestation = await producer.produce(challenge)
  throwIfCeremonyStopped(shouldStop)

  // (5) Submit the self-signed attestation-answer document, never a direct associate write.
  const answer: AssociationAttestationAnswer = {
    requestId: associationRequestId,
    nonce: decisionNotice.challengeNonce,
    attestation,
  }
  emit({ type: 'step', step: 'attestation-submit' })
  try {
    await transports.associationTransport.submitAttestation(answer, p256DeviceKey, associationSign)
  } catch (err) {
    // An answer for this request is already staged: an earlier run whose write landed after it
    // reported a failure. A fresh attestation never re-digests identically, so the re-submit is
    // refused; the request is answered all the same, and is pending.
    if (!isDuplicateStagedRequest(err)) {
      throw err
    }
  }
  throwIfCeremonyStopped(shouldStop)
  // The attempt is answered: nothing is left to resume; the caller's outcome read takes over.
  await store.clear()
  emit({ type: 'milestone', milestone: 'answered' })
  return { outcome: 'answered' }
}
