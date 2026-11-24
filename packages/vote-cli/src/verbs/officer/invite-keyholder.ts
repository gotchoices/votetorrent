// `vt officer invite-keyholder`: mint one keyholder SEAT invitation through the shared
// `inviteKeyholderSeat` (@votetorrent/workflows/authority, the KeyholderInvitationScreen send path)
// and hand the serialized share over as a NEW 0600 file under the peer's `secrets/`. Replaces
// tools/lean-rig/lean/lean-part2.ts 749-757 (the hand-rolled key, expiry and JSON.stringify share) and
// tools/vote-cli/src/workflows/authority.mjs 625-636. Approval-class.
//
// The reply carries the file path, an 8-character suffix of the public invite key, counts and timings:
// never the share, the seat private key or the whole invite key (a 16-char window of the share). The
// expiry is returned as epoch ms, not as the share's ISO text, so no window of the share text appears
// in any reply. An expiry outside the offered presets is refused before any token read and before the
// shared function mints a key. A lost race on the share file (`share-file-exists` after the slot was
// already invited) is an accepted residual: the slot exists, the file does not; re-run with another
// `--share-name` is not possible for the same slot.

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS,
  KEYHOLDER_INVITE_EXPIRY_HOURS,
  inviteKeyholderSeat,
  serializeInviteShare
} from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import { createPrivateFileOnce } from '../../vault/private-file.js'
import {
  assertTestParty,
  elapsedMs,
  officerElectionDeps,
  officerSignerFactory,
  pickArgs,
  refuse,
  serializeOfficerWrite,
  startedNow,
  type OfficerElectionDeps
} from './election-deps.js'

const ALLOWED = ['network', 'election', 'name', 'expiryHours', 'shareName', ...CALL_APPROVAL_ARG_KEYS]
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const SHARE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const HOURS_RE = /^\d{1,4}$/
const SHARE_EXT = '.share'
const PRESETS: readonly number[] = KEYHOLDER_INVITE_EXPIRY_HOURS

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export async function runInviteKeyholder(deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  if (a.election === undefined) refuse('election-required')
  if (a.name === undefined) refuse('name-required')
  const name = a.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) refuse('name-invalid')
  const hoursText = a.expiryHours === undefined ? String(DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS) : a.expiryHours
  if (typeof hoursText !== 'string' || !HOURS_RE.test(hoursText)) refuse('expiry-invalid')
  const expiryHours = Number(hoursText)
  if (!PRESETS.includes(expiryHours)) refuse('expiry-not-preset')
  const shareName = a.shareName === undefined ? 'seat-' + name.toLowerCase().replace(/[^a-z0-9-]/g, '-') : a.shareName
  if (typeof shareName !== 'string' || !SHARE_NAME_RE.test(shareName)) refuse('share-name-invalid')
  const sharePath = join(deps.secretsDir, shareName + SHARE_EXT)
  if (exists(sharePath)) refuse('share-file-exists')
  return withCallApproval(args, (approval) =>
    serializeOfficerWrite(deps.writeKey, async () => {
      const network = await deps.openNetwork(a.network)
      const electionEngine = await network.openElection(a.election)
      const signer = officerSignerFactory(deps, approval)
      await signer.preflight()
      const { electionId, share } = await inviteKeyholderSeat({ electionEngine, name, expiryHours, createSigner: () => signer.createSigner(), now: deps.now() })
      const text = serializeInviteShare(share)
      deps.secrets.add(share.invitePrivate, { windows: true })
      deps.secrets.add(text, { windows: true })
      if (!createPrivateFileOnce(sharePath, text + '\n')) refuse('share-file-exists')
      return {
        electionId,
        name,
        expiryHours,
        expiresAt: Date.parse(share.expiration),
        shareFile: sharePath,
        inviteKey8: share.inviteKey.slice(-8),
        invitedSeats: await network.countKeyholderInviteSlots(electionId),
        signatures: signer.signatures(),
        ms: elapsedMs(t0)
      }
    })
  )
}

export default async function inviteKeyholder(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runInviteKeyholder(officerElectionDeps(ctx), args)
}
