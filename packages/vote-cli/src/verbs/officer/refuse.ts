// `vt officer refuse`: the registration refusal over the shared 67-18 function the Authority app's
// approval screen runs. Same order as approve: arguments, the party gate, the D-07 checklist gate BEFORE
// the reason file is even read and before any token read; the reason from `--reason-file` ONLY (a
// rejection reason is written to a signed record and can carry personal data, so it never travels on
// argv or into a log or a reply); the token (presence, then the preflight) BEFORE any engine read; the
// rows guard; the shared load; the shared refuse blockers; then the shared refusal, which never reads
// a signature digest and hands the signer only to the engine for the rejection record.

import { performance } from 'node:perf_hooks'
import { isAbsolute, resolve } from 'node:path'
import { isChecklistGateMet } from '@votetorrent/vote-core'
import {
  closesRequestIdOf,
  loadRegistrationApproval,
  refuseRegistrationRequest,
  registrationDecisionBlockers
} from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import { readAttestationRows } from '../../attestation/policy.js'
import { readPrivateFile } from '../../vault/private-file.js'
import { requireLoadedRequest } from './approve.js'
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

const ALLOWED: readonly string[] = Object.freeze(['authority', 'network', 'request', 'checklist', 'reasonFile', ...CALL_APPROVAL_ARG_KEYS])

export const REASON_FILE_MAX_BYTES = 1024

/**
 * The reason: an absolute path to a 0600 file of this uid (67-13 `readPrivateFile`, which refuses a loose
 * mode, another owner or a symlink), at most 1024 bytes, utf8, trimmed. Missing, relative or empty is
 * `reason-required`; the buffer is zero-filled after the copy.
 */
export function readReasonFile(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new IntakeVerbRefusal('reason-required')
  const buf = readPrivateFile(resolve(path), { maxBytes: REASON_FILE_MAX_BYTES })
  if (buf === null) throw new IntakeVerbRefusal('reason-required')
  const reason = buf.toString('utf8').trim()
  buf.fill(0)
  if (reason.length === 0) throw new IntakeVerbRefusal('reason-required')
  return reason
}

export async function runRefuse(deps: IntakeDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const a = pickIntakeArgs(args, ALLOWED)
  assertIntakeTestParty(deps.partyId)
  const requestId = requireRequestArg(a)
  requireAuthorityArg(a)
  requireNetworkArg(a)
  const checklist = parseChecklistArg(a)
  if (!isChecklistGateMet(checklist)) throw new IntakeVerbRefusal('checklist-incomplete')
  const reason = readReasonFile(a.reasonFile)
  return withIntakeApproval(deps, args, async ({ sign }) => {
    const { db, authorityId } = await deps.open()
    guardAttestationRows(deps, await readAttestationRows(db, authorityId))
    const getEngine = deps.getEngine
    const view = await loadRegistrationApproval({ getEngine, requestId })
    requireLoadedRequest(view)
    const blockers = registrationDecisionBlockers(view).refuse
    if (blockers.length > 0) throw new IntakeVerbRefusal('blocked', { blockers })
    const result = await refuseRegistrationRequest({
      getEngine,
      requestId,
      task: view.taskLookup?.task,
      checklist,
      reason,
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
    return {
      requestId,
      published: result.published.kind,
      taskClose: result.taskClose,
      ms: Math.round(performance.now() - t0)
    }
  })
}

export const refuseVerb = bindIntakeVerb(runRefuse)
