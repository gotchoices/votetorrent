// `readback`: the peer's state as the rig's readback verb reported it, with the owner-set tag and
// owner-trust classification for an authority only. It never returns a full peer id, a multiaddr or
// an owner key: peer ids appear as their last 8 characters, the owner set as a hash prefix and count.

import { createHash } from 'node:crypto'
import { readOwnerTrustClassification, type OwnerTrustNode } from '@votetorrent/workflows/authority'
import type { VerbHandler } from '../ctl/protocol.js'
import { assertNoArgs, type VerbContext } from '../daemon/verb-context.js'

interface ControlDbLike {
  getOwnerKeys(): Promise<ReadonlySet<string>>
}

function addrs(ctx: VerbContext): string[] {
  try {
    return (ctx.node.getMultiaddrs() ?? []).map((a) => String(a))
  } catch {
    return []
  }
}

function controlConnections(ctx: VerbContext): number {
  try {
    return ctx.node.getControlNode()?.getConnections().length ?? 0
  } catch {
    return 0
  }
}

/** sha256 of the sorted owner keys, first 8 hex, then `:` and the count; `no-db` without a control db. */
async function ownerSetTag(ctx: VerbContext): Promise<string> {
  const db = (ctx.node as unknown as { getControlDatabase?: () => ControlDbLike | null }).getControlDatabase?.()
  if (!db) return 'no-db'
  const keys = [...(await db.getOwnerKeys())].map(String).sort()
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 8) + ':' + keys.length
}

const unreadable = (e: unknown): string => `unreadable:${String((e as { name?: unknown } | undefined)?.name ?? 'Error')}`

const readback: VerbHandler<VerbContext> = async (ctx, args) => {
  assertNoArgs(args)
  const all = addrs(ctx)
  const circuit = all.filter((a) => a.includes('/p2p-circuit'))
  const circuitViaRelay = circuit.some((a) => a.includes(`/p2p/${ctx.relay.peerId}/p2p-circuit`))
  const nonCircuitAddrs = all.length - circuit.length
  let ownerSet: string | null = null
  let ownerTrust: string | null = null
  if (ctx.built.kind === 'authority') {
    try {
      ownerSet = await ownerSetTag(ctx)
    } catch (e) {
      ownerSet = unreadable(e)
    }
    try {
      ownerTrust = String(await readOwnerTrustClassification(ctx.node as unknown as OwnerTrustNode, 'persistent'))
    } catch (e) {
      ownerTrust = unreadable(e)
    }
  }
  const recents = (await ctx.localStorage.getItem<Array<{ hash?: unknown }>>('recentNetworks')) ?? []
  const recent0 = typeof recents[0]?.hash === 'string' ? recents[0].hash.slice(0, 8) : null
  const mem = process.memoryUsage()
  return {
    role: ctx.role,
    label: ctx.label,
    peerId8: ctx.peerId8,
    bootN: ctx.bootN,
    recreated: ctx.built.recreated,
    circuitReady: circuitViaRelay && nonCircuitAddrs === 0,
    circuitViaRelay,
    circuitAddrs: circuit.length,
    nonCircuitAddrs,
    controlConnections: controlConnections(ctx),
    ownerSetTag: ownerSet,
    ownerTrust,
    recentCount: recents.length,
    recent0,
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    uptimeMs: Math.round(process.uptime() * 1000),
    authPrompts: ctx.authPrompts,
    acceptTokenAttestations: ctx.acceptTokenAttestations
  }
}

export default readback
