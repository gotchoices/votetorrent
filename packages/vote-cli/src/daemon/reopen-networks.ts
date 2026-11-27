// Reopen every joined network when a daemon boots, before it reports ready. A peer that joined a network
// is a member of that network strand's write cohort, but a restarted daemon attaches the strand only
// when something opens the network. Without this step the other peers' writes fail until a verb happens
// to open it here (observed after a restart of three authority daemons: `Failed to get super-majority:
// 1/3 approvals`). The lean rig's reopen leg opened the network on every node for the same reason.
//
// A network that fails to open is recorded and left for the next verb to retry (openNetwork drops a
// rejected open from its cache). An open that outlasts the bound keeps running and a verb joins it.
// The report holds counts only.

import type { VerbContext } from './verb-context.js'

export const REOPEN_BOUND_MS = 60_000
const NETWORK_HASH_RE = /^[A-Za-z0-9_-]{8,128}$/

export type ReopenContext = Pick<VerbContext, 'user' | 'localStorage' | 'openNetwork' | 'record'>

export interface ReopenReport {
  known: number
  opened: number
  failed: number
  pending: number
}

export async function reopenJoinedNetworks (ctx: ReopenContext, boundMs: number = REOPEN_BOUND_MS): Promise<ReopenReport> {
  const report: ReopenReport = { known: 0, opened: 0, failed: 0, pending: 0 }
  let hashes: string[]
  try {
    const recents = (await ctx.localStorage.getItem<Array<{ hash?: unknown }>>('recentNetworks')) ?? []
    hashes = [...new Set(recents.map((r) => r?.hash).filter((h): h is string => typeof h === 'string' && NETWORK_HASH_RE.test(h)))]
  } catch (e) {
    ctx.record('boot.reopen-network', e)
    return report
  }
  report.known = hashes.length
  if (hashes.length === 0 || ctx.user === null) return report
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), boundMs)
  })
  for (const hash of hashes) {
    const open = ctx.openNetwork(hash).then(
      () => 'opened' as const,
      (e: unknown) => {
        ctx.record('boot.reopen-network', e)
        return 'failed' as const
      }
    )
    report[(await Promise.race([open, bound]).then((r) => (r === 'bound' ? 'pending' : r)))]++
  }
  clearTimeout(timer)
  return report
}
