import { readParty, updateParty } from './_util.ts'
export default async function (ctx: any, args: { networkKey: string }): Promise<any> {
  const entry = (ctx.__nets ?? {})[args.networkKey]
  if (!entry) throw new Error('authority-id: network not founded in this process')
  const details = await entry.net.getDetails()
  const id = String(details.network.primaryAuthorityId)
  const auth = await entry.net.openAuthority(id)
  const ad = await auth.getDetails()
  const count = ad?.authority?.id === id ? 1 : 0
  if (count === 1) updateParty(ctx, (p) => { p.authorityId = id })
  void readParty
  return { count, authorityId8: id.slice(0, 8) }
}
