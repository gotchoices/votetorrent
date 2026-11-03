import { AUTH } from './_util.ts'
export default async function (ctx: any): Promise<any> {
  const vi: any = await import(AUTH('engines/voter-invite.ts'))
  const capabilityBefore = await vi.voterInviteCapability(ctx.node)
  await vi.ensureVoterInviteOwner(ctx.node)
  const capabilityAfter = await vi.voterInviteCapability(ctx.node)
  const owners = await ctx.node.getControlDatabase().getOwnerKeys()
  return { capabilityBefore, capabilityAfter, ownerCount: owners.size, ownerIsIdentity: owners.has(ctx.node.getIdentityOwnerKey().publicKeyB64) }
}
