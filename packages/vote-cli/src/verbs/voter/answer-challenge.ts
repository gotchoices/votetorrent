// `vt voter answer-challenge`: resume the stored attempt, wait for the officer's challenge notice and answer
// it with a token attestation (67-20's producer), letting the shared ceremony run to `answered`. The wait is
// bounded by `--wait-ms` (`wait-timeout`); the shared decision wait itself is open-ended and is stopped
// through `shouldStop`. With nothing stored it refuses `no-attempt` before any token read.
//
// Order: arguments, the party gate, the network and the wait, the lock, the stored attempt, the token and
// the identity preflight, the shared ceremony.

import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { runCeremonyStep } from './ceremony-step.js'
import {
  assertVoterTestParty,
  bindVoterVerb,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  withVoterApproval,
  withVoterVerbLock,
  type VoterDeps
} from './voter-deps.js'

export const ANSWER_WAIT_MIN_MS = 1_000
export const ANSWER_WAIT_MAX_MS = 1_800_000
export const ANSWER_WAIT_DEFAULT_MS = 300_000

const ANSWER_ARGS: readonly string[] = ['network', 'waitMs', ...CALL_APPROVAL_ARG_KEYS]

/** `waitMs` as digits within the bound; anything else is `wait-invalid`. */
export function parseWaitMs(v: string | boolean | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  if (typeof v !== 'string' || !/^\d{1,7}$/.test(v)) throw new VoterVerbRefusal('wait-invalid')
  const n = Number(v)
  if (n < min || n > max) throw new VoterVerbRefusal('wait-invalid')
  return n
}

export async function runAnswerChallenge(deps: VoterDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, ANSWER_ARGS)
  assertVoterTestParty(deps.partyId)
  const network = requireVoterNetworkArg(a)
  const waitMs = parseWaitMs(a.waitMs, ANSWER_WAIT_MIN_MS, ANSWER_WAIT_MAX_MS, ANSWER_WAIT_DEFAULT_MS)
  return withVoterVerbLock(deps.lockKey, 'answer-challenge', async () => {
    if ((await deps.attemptStore.read()) === null) throw new VoterVerbRefusal('no-attempt')
    return withVoterApproval(deps, args, async (approval) => {
      const r = await runCeremonyStep(deps, { approval, network, stopAt: 'answered', waitMs })
      return {
        registrantId: r.registrantId,
        associationRequestId: r.associationRequestId,
        outcome: 'answered',
        challengeStatus: r.challengeStatus,
        deviceKeyTag: r.deviceKeyTag,
        steps: r.steps,
        ms: elapsedMs(t0)
      }
    })
  })
}

export const answerChallengeVerb: VerbHandler<VerbContext> = bindVoterVerb(runAnswerChallenge)

export default answerChallengeVerb
