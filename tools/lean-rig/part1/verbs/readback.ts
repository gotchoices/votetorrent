import { AUTH, addrs, ownerSetTag, controlConnections, recents } from './_util.ts'
export default async function (ctx: any): Promise<any> {
  const a = addrs(ctx)
  const circuit = a.filter((x) => x.includes('/p2p-circuit'))
  const r = await recents(ctx)
  const ot: any = await import(AUTH('engines/owner-trust.ts'))
  let ownerTrust: string
  try { ownerTrust = String(await ot.readOwnerTrustClassification(ctx.node, 'persistent')) } catch (e: any) { ownerTrust = 'unreadable:' + String(e?.name ?? 'Error') }
  return {
    peerId8: String(ctx.peerId).slice(-8),
    circuitViaRelay: circuit.some((x) => x.includes(ctx.relayPeer)),
    circuitAddrs: circuit.length,
    nonCircuitAddrs: a.length - circuit.length,
    controlConnections: controlConnections(ctx),
    ownerSetTag: await ownerSetTag(ctx),
    ownerTrust,
    recentCount: r.length,
    recent0: r[0]?.hash ? String(r[0].hash).slice(0, 8) : null
  }
}
