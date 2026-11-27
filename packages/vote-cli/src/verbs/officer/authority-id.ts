// `vt officer authority-id`: the 8-char primary authority id of the network named by the
// `networkHash` ARGUMENT, read from the network itself through this peer's recents. It works after
// a daemon restart because nothing is memoized in the process and no shared party.json exists.

import { checkArgs, openKnownNetwork, type OfficerVerbContext } from '../../network/network-verb-support.js'

export default async function authorityId(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = checkArgs(args, { required: ['networkHash'] })
  const { network } = await openKnownNetwork(ctx, a.networkHash)
  const id = String((await network.getDetails()).network.primaryAuthorityId)
  const details = await (await network.openAuthority(id)).getDetails()
  return {
    networkHash8: a.networkHash!.slice(0, 8),
    authorityId8: id.slice(0, 8),
    count: details?.authority?.id === id ? 1 : 0
  }
}
