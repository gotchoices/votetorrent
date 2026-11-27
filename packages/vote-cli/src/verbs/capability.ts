// `capability` (authority roles): can this peer mint voter join codes? The answer is the shared
// `voterInviteCapability` of @votetorrent/workflows/authority, never a local reading of the owner keys.

import { voterInviteCapability, type VoterInviteNode } from '@votetorrent/workflows/authority'
import type { VerbHandler } from '../ctl/protocol.js'
import { assertNoArgs, type VerbContext } from '../daemon/verb-context.js'

const capability: VerbHandler<VerbContext> = async (ctx, args) => {
  assertNoArgs(args)
  return { capability: await voterInviteCapability(ctx.built.ownerNode as unknown as VoterInviteNode | null) }
}

export default capability
