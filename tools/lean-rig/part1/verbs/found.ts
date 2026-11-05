import { updateParty, controlConnections, relayConnections, recents, lastAttach } from './_util.ts'
export default async function (ctx: any, args: { name: string, key: string }): Promise<any> {
  if (!args?.name || !/^n[0-9]+$/.test(args?.key ?? '')) throw new Error('found: args {name, key}')
  const init = ctx.fixtures.makeTestNetworkInit({ name: args.name, relays: [ctx.relayAddr] })
  const t0 = Date.now()
  let errorName: string | null = null
  let net: any = null
  try { net = await ctx.engine().create(init, ctx.user) } catch (e: any) { errorName = String(e?.name ?? 'Error'); throw e }
  const createMs = Date.now() - t0
  const r = await recents(ctx)
  const hash = String(r[0]?.hash ?? '')
  ;(ctx.__nets ??= {})[args.key] = { hash, net }
  updateParty(ctx, (p) => { p.networks = { ...(p.networks ?? {}), [args.key]: { hash, name: args.name } } })
  const attaches = ctx.attaches.filter((x: any) => x.kind === 'attach')
  return {
    settled: true, createMs, errorName, hash8: hash.slice(0, 8), hashFull: hash,
    attachCount: attaches.length, attach: lastAttach(ctx),
    relayConnections: relayConnections(ctx), recentHas: r.some((x: any) => x.hash === hash), controlConnectionsNow: controlConnections(ctx)
  }
}
