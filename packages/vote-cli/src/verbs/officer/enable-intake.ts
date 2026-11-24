// `vt officer enable-intake`: the officer's "enable encrypted intake" step over the shared 67-09
// `enableOfficerEncryptedIntake` (the Authority app's registration step). Approval class: the token is
// proven per call BEFORE any engine read, even when the key is already enabled, so the contract stays
// "token per call". The intake key itself is a non-approval secret in the at-rest device vault.
//
// Order: arguments, the party gate, the static arguments, the token (presence, then the preflight), the
// shared workflow, the readback. The reply carries the intake state, whether this call changed it, and ms.

import { performance } from 'node:perf_hooks'
import { enableOfficerEncryptedIntake, readOfficerIntakeKeyState } from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import {
  IntakeVerbRefusal,
  assertIntakeTestParty,
  bindIntakeVerb,
  pickIntakeArgs,
  requireAuthorityArg,
  requireNetworkArg,
  withIntakeApproval,
  type IntakeDeps
} from './intake-deps.js'

const ALLOWED: readonly string[] = Object.freeze(['authority', 'network', ...CALL_APPROVAL_ARG_KEYS])

/** `readOfficerIntakeKeyState` never calls the signer; this one refuses if it ever did. */
const readOnlySigner = async (): Promise<never> => {
  throw new Error('enable-intake: the state read never signs')
}

export async function runEnableIntake(deps: IntakeDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = performance.now()
  const a = pickIntakeArgs(args, ALLOWED)
  assertIntakeTestParty(deps.partyId)
  requireAuthorityArg(a)
  requireNetworkArg(a)
  return withIntakeApproval(deps, args, async ({ sign }) => {
    const { authorityId } = await deps.open()
    const getEngine = deps.getEngine
    const vault = deps.intakeVault
    const before = await readOfficerIntakeKeyState({ getEngine, vault, createSigner: readOnlySigner }, authorityId)
    const state = await enableOfficerEncryptedIntake({ getEngine, vault, createSigner: async () => sign }, authorityId)
    if (state !== 'enabled') throw new IntakeVerbRefusal('intake-not-enabled')
    return { state, changed: before !== 'enabled', ms: Math.round(performance.now() - t0) }
  })
}

export const enableIntakeVerb = bindIntakeVerb(runEnableIntake)
