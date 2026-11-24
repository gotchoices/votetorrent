// One step of the shared registration ceremony (67-11 `runRegistrationCeremony`) for the CLI voter: the
// WHOLE ceremony runs with a FRESH memory per call and resumes from the kv attempt store, exactly the
// app's "fresh mount takes up the stored attempt" path; the step verb flips `shouldStop` at its target
// milestone (`register`: registration-staged, `stage-association`: association-staged) or lets the run
// end at `answered` (`answer-challenge`). No `stopAfter` option exists in the shared code (67-11 choice).
//
// Secrets: the registration code (minted here), every challenge nonce seen by the decision poll and the
// nonce the producer answers are registered windowed the moment they appear. Errors are mapped to closed
// codes (`CEREMONY_ERROR_CODES`); no message, nonce, code or id from an error is ever copied.

import type { INetworkEngine } from '@votetorrent/vote-core'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import {
  createRegistrationCeremonyMemory,
  resolveCurrentElectionId,
  runRegistrationCeremony,
  type RegistrationCeremonyDraft,
  type RegistrationCeremonyEvent,
  type RegistrationCeremonyMilestone,
  type RegistrationCeremonyTransports
} from '@votetorrent/workflows/voter'
import {
  deviceKeyTag,
  mintVoterRegistrationCode,
  VoterVerbRefusal,
  type CeremonyRefusalCode,
  type OpenedVoterNetwork,
  type VoterApproval,
  type VoterDeps
} from './voter-deps.js'
import { createCliVoterRequestTransports, type CliVoterRequestTransports } from './voter-deps.js'

/** The ceremony's fixed error names and messages (67-11), and the vault codes, mapped to voter refusal codes. */
export const CEREMONY_ERROR_CODES = Object.freeze({
  byName: Object.freeze<Record<string, CeremonyRefusalCode | 'wait-timeout'>>({
    NoElectionConfiguredError: 'no-election',
    RegistrationRequestClosedError: 'registration-closed',
    DecisionWaitTimeoutError: 'wait-timeout'
  }),
  byMessage: Object.freeze<Record<string, CeremonyRefusalCode>>({
    'Cannot reach the authority right now — please try again later.': 'authority-unreachable',
    'The authority rejected the association request.': 'association-rejected',
    'The authority issued a challenge notice with no nonce.': 'challenge-without-nonce'
  }),
  byCode: Object.freeze<Record<string, 'token-refused'>>({
    'token-refused': 'token-refused',
    'auth-denied': 'token-refused'
  }),
  fallback: 'ceremony-failed' as const
})

const MILESTONE_ORDER: readonly RegistrationCeremonyMilestone[] = Object.freeze(['registration-staged', 'association-staged', 'decision-received', 'answered'])

/** Nine empty strings: a later step never builds a registration init on a staged resume. */
export const EMPTY_DRAFT: RegistrationCeremonyDraft = Object.freeze({
  firstName: '',
  lastName: '',
  dob: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  addressLine3: '',
  party: ''
})

function isPassThrough(e: unknown): boolean {
  const name = (e as { name?: unknown } | null | undefined)?.name
  return name === 'VerbRefusal' || name === 'ApprovalRefusal'
}

/** Maps a ceremony rejection to a closed voter code; the fallback keeps only a plain-word error name. */
export function mapCeremonyError(e: unknown): VoterVerbRefusal {
  const err = e as { name?: unknown, message?: unknown, code?: unknown } | null | undefined
  const name = typeof err?.name === 'string' ? err.name : ''
  const message = typeof err?.message === 'string' ? err.message : ''
  const code = typeof err?.code === 'string' ? err.code : ''
  const byName = CEREMONY_ERROR_CODES.byName[name]
  if (byName !== undefined) return new VoterVerbRefusal(byName, { cause: e })
  const byMessage = CEREMONY_ERROR_CODES.byMessage[message]
  if (byMessage !== undefined) return new VoterVerbRefusal(byMessage, { cause: e })
  const byCode = CEREMONY_ERROR_CODES.byCode[code]
  if (byCode !== undefined) return new VoterVerbRefusal(byCode, { cause: e })
  return new VoterVerbRefusal(CEREMONY_ERROR_CODES.fallback, { failedName: name, cause: e })
}

export interface OpenedVoterTransports {
  readonly opened: OpenedVoterNetwork
  /** The FULL primary authority id: internal to the daemon, never put in a reply. */
  readonly authorityId: string
  readonly transports: CliVoterRequestTransports
}

/** Opens the network, reads its primary authority and builds the transports once (the peer mirror by default). */
export async function openVoterTransports(deps: VoterDeps, network: string): Promise<OpenedVoterTransports> {
  const opened = await deps.openVoterNetwork(network)
  const networkEngine = await opened.getEngine<INetworkEngine>('network')
  const details = await networkEngine.getDetails()
  const authorityId = details.network.primaryAuthorityId
  const build = deps.createTransports ?? createCliVoterRequestTransports
  const transports = await build({ port: opened.port, strandId: opened.strandId, authorityId })
  return { opened, authorityId, transports }
}

/**
 * Every challenge nonce a decision poll returns is a secret before anything else can see it. Only
 * `pollDecisions` is intercepted; every other member of the association transport is the transport's own
 * (bound to it), so the submits stay the shared code's calls on the shared transport.
 */
function nonceRegisteringTransports(deps: VoterDeps, t: CliVoterRequestTransports): RegistrationCeremonyTransports {
  const assoc = t.associationTransport
  const pollDecisions = async (sinceCursor?: string): Promise<Array<{ requestId: string, status: string, cursor: string, challengeNonce?: string }>> => {
    const notices = await assoc.pollDecisions(sinceCursor)
    for (const n of notices) if (typeof n.challengeNonce === 'string') deps.secrets.add(n.challengeNonce, { windows: true })
    return notices
  }
  const associationTransport = new Proxy(assoc, {
    get(target, prop, _receiver) {
      if (prop === 'pollDecisions') return pollDecisions
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return {
    registrationRoute: t.registrationRoute,
    registrationTransport: t.registrationTransport,
    ownStagedRegistrationRequestIds: (key) => t.ownStagedRegistrationRequestIds(key),
    associationTransport
  }
}

/** The producer under the call's token, with the challenge nonce registered before `produce` runs. */
function nonceRegisteringProducer(deps: VoterDeps, producer: VoteSigningProducer): VoteSigningProducer {
  return {
    provisionDeviceKey: () => producer.provisionDeviceKey(),
    getCurrentDeviceKey: () => producer.getCurrentDeviceKey(),
    produce: (challenge) => {
      deps.secrets.add(challenge.nonce, { windows: true })
      return producer.produce(challenge)
    },
    signDeviceKeyDigest: (digest, options) => producer.signDeviceKeyDigest(digest, options)
  }
}

export interface CeremonyStepInput {
  readonly approval: VoterApproval
  readonly network: string
  /** The registrant file for `register`; later steps pass nothing (EMPTY_DRAFT). */
  readonly draft?: RegistrationCeremonyDraft
  /** The milestone at which `shouldStop` flips; `answered` means the natural end. */
  readonly stopAt: RegistrationCeremonyMilestone
  /** The whole step's wall-clock bound; `wait-timeout` when it passes first. */
  readonly waitMs: number
  /** An explicit election id, used only when the network lists none. */
  readonly election?: string
}

export interface CeremonyStepResult {
  readonly outcome: 'stopped' | 'answered'
  readonly registrantId: string
  readonly associationRequestId: string | null
  readonly electionId: string
  /** The last milestone reached. */
  readonly milestone: string
  readonly milestones: string[]
  readonly steps: number
  readonly deviceKeyTag: string | null
  /** The `decision-received` letter when that milestone was reached. */
  readonly challengeStatus: string | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Runs the shared ceremony once with a fresh memory, stopping at `stopAt` (or ending at `answered`), bounded
 * by `waitMs`. Whatever ends the run, the last-attempt record (ids, the key tag, the last milestone) is
 * written for `read-decision`.
 */
export async function runCeremonyStep(deps: VoterDeps, input: CeremonyStepInput): Promise<CeremonyStepResult> {
  const { approval, stopAt } = input
  const { opened, authorityId, transports } = await openVoterTransports(deps, input.network)
  const getEngine = opened.getEngine
  const ceremonyTransports = nonceRegisteringTransports(deps, transports)
  const memory = createRegistrationCeremonyMemory()
  const stopIndex = MILESTONE_ORDER.indexOf(stopAt)
  const deadline = Date.now() + input.waitMs
  let reached = false
  let steps = 0
  const milestones: string[] = []
  let challengeStatus: string | null = null
  const onStep = (event: RegistrationCeremonyEvent): void => {
    if (event.type === 'step') {
      steps++
      return
    }
    milestones.push(event.milestone)
    if (event.milestone === 'decision-received') challengeStatus = /^[a-z]$/.test(event.status) ? event.status : 'other'
    if (stopAt !== 'answered' && MILESTONE_ORDER.indexOf(event.milestone) >= stopIndex) reached = true
  }
  const finish = (outcome: 'stopped' | 'answered'): CeremonyStepResult => ({
    outcome,
    registrantId: memory.registrantId ?? '',
    associationRequestId: memory.associationRequestId,
    electionId: memory.electionId ?? '',
    milestone: milestones[milestones.length - 1] ?? 'none',
    milestones,
    steps,
    deviceKeyTag: memory.deviceKey === null ? null : deviceKeyTag(memory.deviceKey),
    challengeStatus
  })
  try {
    await runRegistrationCeremony({
      getEngine,
      deviceUser: { activeKeys: [{ key: approval.identity.key }] },
      deviceSign: approval.deviceSign,
      producer: nonceRegisteringProducer(deps, approval.producer),
      store: deps.attemptStore,
      memory,
      draft: input.draft ?? EMPTY_DRAFT,
      resolveElectionId: () => resolveCurrentElectionId({ getEngine, fallbackElectionId: input.election }),
      resolveTransports: async () => ceremonyTransports,
      mintRegistrationCode: async (registrantId, sign) => {
        const code = await mintVoterRegistrationCode(getEngine, registrantId, sign)
        deps.secrets.add(code, { windows: true })
        return code
      },
      now: Date.now,
      sleep,
      shouldStop: () => reached || Date.now() > deadline,
      onStep
    })
    return finish('answered')
  } catch (e) {
    if (isPassThrough(e)) throw e
    const name = (e as { name?: unknown } | null | undefined)?.name
    if (name === 'DecisionWaitStoppedError') {
      if (reached) return finish('stopped')
      throw new VoterVerbRefusal('wait-timeout', { cause: e })
    }
    throw mapCeremonyError(e)
  } finally {
    if (memory.registrantId !== null && memory.electionId !== null) {
      await deps.lastAttemptStore.write({
        registrantId: memory.registrantId,
        associationRequestId: memory.associationRequestId,
        authorityId,
        electionId: memory.electionId,
        deviceKeyTag: memory.deviceKey === null ? null : deviceKeyTag(memory.deviceKey),
        milestone: milestones[milestones.length - 1] ?? 'none'
      })
    }
  }
}
