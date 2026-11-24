// `vt voter register`: stage the sealed registration request over the shared ceremony (67-11), stopping at
// the `registration-staged` milestone. The registrant draft is read from an absolute 0600 JSON file (the
// nine ceremony draft fields, a subset; `firstName` and `lastName` required); every non-empty value is a
// secret before any ceremony work. A stored attempt already staged for this identity returns
// `alreadyStaged` with no ceremony run.
//
// Order: arguments, the party gate, the network, the registrant file, the lock, the token and the
// identity preflight, the stored-attempt check, the shared ceremony.

import { isAbsolute } from 'node:path'
import type { RegistrationCeremonyDraft } from '@votetorrent/workflows/voter'
import { CALL_APPROVAL_ARG_KEYS } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { readPrivateFile } from '../../vault/private-file.js'
import { runCeremonyStep } from './ceremony-step.js'
import {
  assertVoterTestParty,
  bindVoterVerb,
  deviceKeyTag,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  withVoterApproval,
  withVoterVerbLock,
  type VoterDeps
} from './voter-deps.js'

export const REGISTRANT_FILE_MAX_BYTES = 8_192
export const REGISTRANT_FIELD_MAX_CHARS = 256
/** The registration step's bound: the sealed submit over the strand, well under it on the loopback relay. */
export const REGISTER_WAIT_MS = 600_000

const REGISTER_ARGS: readonly string[] = ['network', 'registrantFile', 'election', ...CALL_APPROVAL_ARG_KEYS]
const DRAFT_FIELDS: readonly (keyof RegistrationCeremonyDraft)[] = ['firstName', 'lastName', 'dob', 'email', 'phone', 'addressLine1', 'addressLine2', 'addressLine3', 'party']

/** The registrant file: a JSON object whose keys are a subset of the nine draft fields, each a short string. */
export function readRegistrantFile(path: string | boolean | undefined): RegistrationCeremonyDraft {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) throw new VoterVerbRefusal('registrant-file-required')
  let data: Buffer | null
  try {
    data = readPrivateFile(path, { maxBytes: REGISTRANT_FILE_MAX_BYTES })
  } catch (e) {
    if ((e as { name?: unknown } | null | undefined)?.name === 'PrivateFileError') throw new VoterVerbRefusal('registrant-file-mode', { cause: e })
    throw e
  }
  if (data === null) throw new VoterVerbRefusal('registrant-file-missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new VoterVerbRefusal('registrant-invalid')
  } finally {
    data.fill(0)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new VoterVerbRefusal('registrant-invalid')
  const obj = parsed as Record<string, unknown>
  const allowed = new Set<string>(DRAFT_FIELDS)
  const draft: Record<string, string> = {}
  for (const field of DRAFT_FIELDS) draft[field] = ''
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new VoterVerbRefusal('registrant-invalid')
    const v = obj[key]
    if (typeof v !== 'string' || v.length > REGISTRANT_FIELD_MAX_CHARS) throw new VoterVerbRefusal('registrant-invalid')
    draft[key] = v
  }
  if (draft.firstName!.length === 0 || draft.lastName!.length === 0) throw new VoterVerbRefusal('registrant-invalid')
  return draft as unknown as RegistrationCeremonyDraft
}

export async function runRegister(deps: VoterDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, REGISTER_ARGS)
  assertVoterTestParty(deps.partyId)
  const network = requireVoterNetworkArg(a)
  const election = typeof a.election === 'string' && a.election.length > 0 ? a.election : undefined
  const draft = readRegistrantFile(a.registrantFile)
  for (const field of DRAFT_FIELDS) if (draft[field] !== '') deps.secrets.add(draft[field], { windows: true })
  return withVoterVerbLock(deps.lockKey, 'register', () =>
    withVoterApproval(deps, args, async (approval) => {
      const stored = await deps.attemptStore.read()
      if (stored !== null && stored.identityKey === approval.identity.key && stored.registrationStaged) {
        return { alreadyStaged: true, registrantId: stored.registrantId, deviceKeyTag: deviceKeyTag(stored.deviceKey), ms: elapsedMs(t0) }
      }
      const r = await runCeremonyStep(deps, { approval, network, draft, stopAt: 'registration-staged', waitMs: REGISTER_WAIT_MS, ...(election === undefined ? {} : { election }) })
      return {
        registrantId: r.registrantId,
        electionId: r.electionId,
        milestone: r.milestone,
        deviceKeyTag: r.deviceKeyTag,
        steps: r.steps,
        ms: elapsedMs(t0)
      }
    })
  )
}

export const registerVerb: VerbHandler<VerbContext> = bindVoterVerb(runRegister)

export default registerVerb
