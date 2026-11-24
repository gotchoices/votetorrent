// `vt officer approve`: the registration accept ceremony over the shared 67-18 functions the Authority
// app's approval screen runs. The statement ORDER below is the security property (D-07, WR-02, WR-19):
// the arguments and the party gate; the D-07 checklist gate on the canonical `--checklist` BEFORE any
// token read, engine call or signature; the token (presence, then the preflight) BEFORE any engine
// read; the AttestationRequired rows guard; the shared load; the shared blockers (a non-empty list is a
// refusal, so the CLI can never approve what the screen would not let an officer approve); then the
// shared accept, which re-runs the gate and is the ONLY place a signature digest is read or completed.
//
// The reply carries the request id, the publish outcome and the read/decide/publish timings, the fields
// of the rig's `APPROVE registration N readMs=.. decideMs=.. publishMs=..` line.

import { performance } from 'node:perf_hooks'
import { isChecklistGateMet } from '@votetorrent/vote-core'
import {
  approveRegistrationRequest,
  closesRequestIdOf,
  loadRegistrationApproval,
  registrationApprovalErrorCode,
  registrationDecisionBlockers,
  type RegistrationApprovalView
} from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import { readAttestationRows } from '../../attestation/policy.js'
import {
  IntakeVerbRefusal,
  assertIntakeTestParty,
  bindIntakeVerb,
  parseChecklistArg,
  pickIntakeArgs,
  requireAuthorityArg,
  requireNetworkArg,
  requireRequestArg,
  withIntakeApproval,
  type IntakeDeps
} from './intake-deps.js'
import { guardAttestationRows } from './peer-sync.js'

const ALLOWED: readonly string[] = Object.freeze(['authority', 'network', 'request', 'checklist', ...CALL_APPROVAL_ARG_KEYS])

/**
 * A `not-found` failure or a missing read is `request-not-found`; any other failure of the load is
 * rethrown as the identical object (an engine error keeps its structural classifiers).
 */
export function requireLoadedRequest(view: RegistrationApprovalView): void {
  if (view.failure !== undefined) {
    if (registrationApprovalErrorCode(view.failure) === 'not-found') throw new IntakeVerbRefusal('request-not-found')
    throw view.failure
  }
  if (view.read === undefined) throw new IntakeVerbRefusal('request-not-found')
}

export async function runApprove(deps: IntakeDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const a = pickIntakeArgs(args, ALLOWED)
  assertIntakeTestParty(deps.partyId)
  const requestId = requireRequestArg(a)
  requireAuthorityArg(a)
  requireNetworkArg(a)
  const checklist = parseChecklistArg(a)
  if (!isChecklistGateMet(checklist)) throw new IntakeVerbRefusal('checklist-incomplete')
  return withIntakeApproval(deps, args, async ({ sign }) => {
    const { db, authorityId } = await deps.open()
    guardAttestationRows(deps, await readAttestationRows(db, authorityId))
    const getEngine = deps.getEngine
    const view = await loadRegistrationApproval({ getEngine, requestId })
    requireLoadedRequest(view)
    const blockers = registrationDecisionBlockers(view).approve
    if (blockers.length > 0) throw new IntakeVerbRefusal('blocked', { blockers })
    const result = await approveRegistrationRequest({
      getEngine,
      requestId,
      task: view.taskLookup?.task,
      checklist,
      resolveSign: async () => sign,
      review: {
        getEngine,
        createPeerStagingTransports: (t) => deps.createTransports(t),
        authorityId,
        sign,
        resolveVault: () => deps.intakeVault
      },
      closesRequestId: closesRequestIdOf(view)
    })
    const code = (result.published as { code?: unknown }).code
    return {
      requestId,
      published: result.published.kind,
      ...(typeof code === 'string' ? { publishCode: code } : {}),
      readMs: view.readMs,
      decideMs: result.timings.decideMs,
      publishMs: result.timings.publishMs,
      ms: Math.round(performance.now() - t0)
    }
  })
}

export const approveVerb = bindIntakeVerb(runApprove)
