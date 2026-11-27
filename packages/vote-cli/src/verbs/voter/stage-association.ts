// `vt voter stage-association`: resume the stored attempt and stage the association request bound to the
// token-gated K_vote, stopping at the `association-staged` milestone. With nothing stored it refuses
// `no-attempt` before any token read, so a step verb never silently performs an earlier step.
//
// Order: arguments, the party gate, the network, the lock, the stored attempt, the token and the identity
// preflight, the shared ceremony.

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

/** The association step's bound: one sealed submit over the strand. */
export const STAGE_ASSOCIATION_WAIT_MS = 600_000

const STAGE_ARGS: readonly string[] = ['network', ...CALL_APPROVAL_ARG_KEYS]

export async function runStageAssociation(deps: VoterDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, STAGE_ARGS)
  assertVoterTestParty(deps.partyId)
  const network = requireVoterNetworkArg(a)
  return withVoterVerbLock(deps.lockKey, 'stage-association', async () => {
    if ((await deps.attemptStore.read()) === null) throw new VoterVerbRefusal('no-attempt')
    return withVoterApproval(deps, args, async (approval) => {
      const r = await runCeremonyStep(deps, { approval, network, stopAt: 'association-staged', waitMs: STAGE_ASSOCIATION_WAIT_MS })
      return {
        registrantId: r.registrantId,
        associationRequestId: r.associationRequestId,
        milestone: r.milestone,
        deviceKeyTag: r.deviceKeyTag,
        steps: r.steps,
        ms: elapsedMs(t0)
      }
    })
  })
}

export const stageAssociationVerb: VerbHandler<VerbContext> = bindVoterVerb(runStageAssociation)

export default stageAssociationVerb
