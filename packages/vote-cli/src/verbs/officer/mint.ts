// `vt officer mint`: mint a voter join code for a network this peer founded, through the shared
// `createVoterJoinCode` (the Authority app's voter-invite card). The code and the fingerprint are each
// written ONCE as a 0600 file inside an existing caller-owned 0700 `secrets` dir outside the repo, and
// the reply holds the two paths plus counts and booleans. No token: the app's mint card has no
// presence prompt either. Both paths are checked before any identity, engine or node work.

import { unlinkSync } from 'node:fs'
import { decodeCadreInvitation, encodeCadreInvitation } from '@serfab/cadre-core'
import { decodeNetworkJoinCode } from '@votetorrent/vote-engine/rn'
import { createVoterJoinCode, type VoterJoinCodeResult } from '@votetorrent/workflows/authority'
import { loadAuthorityUser } from '../../network/authority-user.js'
import {
  NetworkVerbError,
  assertSecretTarget,
  checkArgs,
  officerEngine,
  officerNode,
  openKnownNetwork,
  parseNetworkHash,
  writeSecretFile,
  type OfficerVerbContext
} from '../../network/network-verb-support.js'

const VOTER_INVITE_REASONS: ReadonlySet<string> = new Set(['not-founding-officer', 'not-reachable'])

export default async function mint(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = checkArgs(args, { required: ['networkHash', 'codeFile', 'fingerprintFile'] })
  const networkHash = parseNetworkHash(a.networkHash)
  const codeFile = assertSecretTarget(a.codeFile!)
  const fingerprintFile = assertSecretTarget(a.fingerprintFile!)
  if (codeFile === fingerprintFile) throw new NetworkVerbError('secret-path-same')
  const user = await loadAuthorityUser(ctx)
  if (user === null) throw new NetworkVerbError('identity-absent')
  await openKnownNetwork(ctx, networkHash, user)
  let minted: VoterJoinCodeResult
  try {
    minted = await createVoterJoinCode({
      node: officerNode(ctx),
      networksEngine: officerEngine(ctx),
      networkHash,
      founder: { userId: user.id, signerKey: user.activeKeys[0]!.key },
      encodeInvitation: encodeCadreInvitation as (invitation: unknown) => string
    })
  } catch (e) {
    const err = e as { name?: unknown, reason?: unknown } | null
    if (err?.name === 'VoterInviteError' && typeof err.reason === 'string' && VOTER_INVITE_REASONS.has(err.reason)) {
      throw new NetworkVerbError(err.reason as 'not-founding-officer' | 'not-reachable', { cause: e })
    }
    throw e
  }
  const { code, fingerprint } = minted
  ctx.secrets.add(code, { windows: true })
  ctx.secrets.add(fingerprint, { windows: true })
  const dec = decodeNetworkJoinCode(code)
  if (!dec.ok) throw new NetworkVerbError('own-code-undecodable')
  ctx.secrets.add(dec.code.invitation, { windows: true })
  const invitation = decodeCadreInvitation(dec.code.invitation) as { members?: unknown }
  const members = Array.isArray(invitation.members) ? invitation.members.map(String) : []
  writeSecretFile(codeFile, code)
  try {
    writeSecretFile(fingerprintFile, fingerprint)
  } catch (e) {
    try {
      unlinkSync(codeFile)
    } catch {
      // the first file is best-effort removed; the refusal below is what the caller sees
    }
    throw e
  }
  return {
    codeFile,
    fingerprintFile,
    v: dec.code.v,
    chars: code.length,
    members: members.length,
    memberAddrsCircuitOnly: members.length > 0 && members.every((m) => m.includes('/p2p-circuit')),
    expiresAtPresent: minted.expiresAt !== null,
    fingerprintEqual: dec.fingerprint === fingerprint,
    networkName8: minted.networkName.slice(0, 8)
  }
}
