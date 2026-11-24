// `vt voter read-decision`: the voter's own view of the outcome, read-only (no token, no party gate). From
// the last-attempt record it reads the registration decision letter, the association decision letter and
// the four-outcome registration status (the Voter's derivation, mirrored in registration-status.ts), polling
// every 2 s until `--wait-for` holds or `--wait-ms` passes. The reply holds ids, letters, the status token,
// the key tag and counts only; no registrant field, reason, nonce or key is read into it.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { parseWaitMs } from './answer-challenge.js'
import { openVoterTransports } from './ceremony-step.js'
import { readVoterRegistrationStatus, type VoterRegistrationStatus } from './registration-status.js'
import {
  bindVoterVerb,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  withVoterVerbLock,
  type VoterDeps
} from './voter-deps.js'

export const READ_DECISION_WAIT_MAX_MS = 1_800_000
export const READ_DECISION_POLL_MS = 2_000
export const READ_DECISION_WAIT_FOR = Object.freeze(['registered', 'challenge', 'closed', 'decided'] as const)

export type ReadDecisionWaitFor = (typeof READ_DECISION_WAIT_FOR)[number]

const READ_ARGS: readonly string[] = ['network', 'waitFor', 'waitMs']

interface Reading {
  registrationDecision: string
  associationDecision: string
  status: VoterRegistrationStatus
}

/** The last notice's status for `requestId` as a single lowercase letter, `none` when absent, `other` otherwise. */
function lastLetter(notices: ReadonlyArray<{ requestId: string, status: string }>, requestId: string | null): string {
  if (requestId === null) return 'none'
  let out = 'none'
  for (const n of notices) if (n.requestId === requestId) out = /^[a-z]$/.test(n.status) ? n.status : 'other'
  return out
}

function conditionMet(waitFor: ReadDecisionWaitFor, r: Reading): boolean {
  if (waitFor === 'registered') return r.status === 'registered'
  if (waitFor === 'challenge') return r.associationDecision === 'c'
  if (waitFor === 'closed') return r.registrationDecision === 'r'
  return r.associationDecision === 'a' || r.associationDecision === 'r' || r.registrationDecision === 'r'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runReadDecision(deps: VoterDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, READ_ARGS)
  const network = requireVoterNetworkArg(a)
  let waitFor: ReadDecisionWaitFor | undefined
  if (a.waitFor !== undefined) {
    if (typeof a.waitFor !== 'string' || !(READ_DECISION_WAIT_FOR as readonly string[]).includes(a.waitFor)) throw new VoterVerbRefusal('wait-invalid')
    waitFor = a.waitFor as ReadDecisionWaitFor
  }
  const waitMs = parseWaitMs(a.waitMs, 0, READ_DECISION_WAIT_MAX_MS, 0)
  return withVoterVerbLock(deps.lockKey, 'read-decision', async () => {
    const last = await deps.lastAttemptStore.read()
    const { opened, transports } = await openVoterTransports(deps, network)
    const producer = await deps.producerForRead()
    const readStatus = (): Promise<VoterRegistrationStatus> =>
      readVoterRegistrationStatus({
        getEngine: opened.getEngine,
        getCurrentDeviceKey: () => producer.getCurrentDeviceKey(),
        transports,
        ...(last === null ? {} : { electionId: last.electionId })
      })
    if (last === null) {
      return { attempt: 'none', status: await readStatus(), ms: elapsedMs(t0) }
    }
    const readOnce = async (): Promise<Reading> => {
      const registrationNotices = await transports.registrationTransport.pollDecisions()
      const associationNotices = await transports.associationTransport.pollDecisions()
      for (const n of associationNotices) if (typeof n.challengeNonce === 'string') deps.secrets.add(n.challengeNonce, { windows: true })
      return {
        registrationDecision: lastLetter(registrationNotices, last.registrantId),
        associationDecision: lastLetter(associationNotices, last.associationRequestId),
        status: await readStatus()
      }
    }
    const deadline = Date.now() + waitMs
    let polls = 0
    let reading: Reading
    for (;;) {
      polls++
      reading = await readOnce()
      if (waitFor === undefined || conditionMet(waitFor, reading)) break
      const left = deadline - Date.now()
      if (left <= 0) throw new VoterVerbRefusal('wait-timeout')
      await sleep(Math.min(READ_DECISION_POLL_MS, left))
    }
    return {
      attempt: 'stored',
      registrantId: last.registrantId,
      associationRequestId: last.associationRequestId,
      registrationDecision: reading.registrationDecision,
      associationDecision: reading.associationDecision,
      status: reading.status,
      deviceKeyTag: last.deviceKeyTag,
      polls,
      ms: elapsedMs(t0)
    }
  })
}

export const readDecisionVerb: VerbHandler<VerbContext> = bindVoterVerb(runReadDecision)

export default readDecisionVerb
