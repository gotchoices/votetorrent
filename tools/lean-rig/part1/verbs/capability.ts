import { AUTH } from './_util.ts'
export default async function (ctx: any): Promise<any> {
  const vi: any = await import(AUTH('engines/voter-invite.ts'))
  return { capability: await vi.voterInviteCapability(ctx.node) }
}
