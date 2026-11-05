// _util.ts - shared helpers for the rebuilt part-1 verbs (2026-10-30, after vt65-uat was deleted; notes 19 E99).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const REPO = new URL('../../../../', import.meta.url)
export const AUTH = (p: string): string => new URL('apps/VoteTorrentAuthority/src/' + p, REPO).href

export const partyFile = (ctx: any): string => join(ctx.state, 'party.json')
export function readParty (ctx: any): any { return JSON.parse(readFileSync(partyFile(ctx), 'utf8')) }
export function updateParty (ctx: any, fn: (p: any) => void): void {
  const p = readParty(ctx); fn(p)
  writeFileSync(partyFile(ctx), JSON.stringify(p, null, 2), { mode: 0o600 })
}
export function addrs (ctx: any): string[] {
  try { return (ctx.node.getMultiaddrs() ?? []).map((a: any) => String(a)) } catch { return [] }
}
export async function ownerSetTag (ctx: any): Promise<string> {
  const db = ctx.node.getControlDatabase?.()
  if (!db) return 'no-db'
  const keys = [...(await db.getOwnerKeys())].map(String).sort()
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 8) + ':' + keys.length
}
export function controlConnections (ctx: any): number {
  try { return ctx.node.getControlNode()?.getConnections().length ?? 0 } catch { return 0 }
}
export function relayConnections (ctx: any): number {
  try { return (ctx.node.getControlNode()?.getConnections() ?? []).filter((c: any) => String(c?.remotePeer) === ctx.relayPeer).length } catch { return 0 }
}
export async function recents (ctx: any): Promise<any[]> {
  const ls = (await import(new URL('../hr5-lib.ts', import.meta.url).href)).roleLocalStorage(ctx.state, ctx.role)
  return (await ls.getItem('recentNetworks')) ?? []
}
export function lastAttach (ctx: any): any {
  const a = ctx.attaches.filter((x: any) => x.kind === 'attach')
  const last = a[a.length - 1]
  return last ? { founder: last.founder, controlConnections: last.controlConnections, intent: last.intent } : null
}
