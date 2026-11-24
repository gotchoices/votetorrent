// `vt officer owner-setup`: make this peer's identity the cadre owner through the shared
// `voterInviteCapability` + `ensureVoterInviteOwner` (the Authority app's owner-setup path). A
// `not-owner` or `unavailable` reading refuses before any write, so no message text is parsed. The
// reply holds two capability names, a count and a boolean: never a key string.

import { ensureVoterInviteOwner, voterInviteCapability } from '@votetorrent/workflows/authority'
import { NetworkVerbError, checkArgs, officerNode, type OfficerVerbContext } from '../../network/network-verb-support.js'

export default async function ownerSetup(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  checkArgs(args, { required: [] })
  const node = officerNode(ctx)
  const before = await voterInviteCapability(node)
  if (before === 'not-owner') throw new NetworkVerbError('not-owner')
  if (before === 'unavailable') throw new NetworkVerbError('owner-setup-unavailable')
  await ensureVoterInviteOwner(node)
  const after = await voterInviteCapability(node)
  const db = node.getControlDatabase()
  if (db === null) throw new NetworkVerbError('owner-setup-unavailable')
  const owners = await db.getOwnerKeys()
  return {
    capabilityBefore: before,
    capabilityAfter: after,
    ownerCount: owners.size,
    ownerIsIdentity: owners.has(node.getIdentityOwnerKey().publicKeyB64)
  }
}
