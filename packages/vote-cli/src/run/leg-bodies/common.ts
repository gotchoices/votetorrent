// Shared leg-body helpers. callVerb is the only path from a body to a daemon: it resolves every verb
// (and every argument name) through LEG_VERBS, adds the approval token path for approval-class entries,
// and records a failed reply in the instruments' thrown wall path. poll records hidden failures only.

import { BUILTIN_VERBS_VERB } from '../../ctl/protocol.js'
import { roleForLabel, type DaemonCallResult } from '../daemon-launcher.js'
import { LEG_VERBS, type LegVerbInput, type LegVerbKey } from '../leg-verbs.js'
import type { LegCtx } from '../legs.js'
import type { RunContext } from '../election-legs.js'

export const nowMs = (ctx: RunContext): number => ctx.nowMs()
export const sleep = (ctx: RunContext, ms: number): Promise<void> => ctx.sleep(ms)

export async function callVerb (
  ctx: RunContext,
  label: string,
  key: LegVerbKey,
  input: LegVerbInput,
  opts: { timeoutMs?: number } = {}
): Promise<DaemonCallResult> {
  const entry = LEG_VERBS[key]
  if (roleForLabel(label) !== entry.role) throw new TypeError('leg-bodies: wrong-role')
  const args: Record<string, string> = entry.args(input)
  if (entry.approval) args.tokenFile = ctx.tokenFile(label)
  const reply = await ctx.peer(label).call(entry.verb, args, opts)
  if (!reply.ok) ctx.instruments?.wall.record('thrown', reply.error)
  return reply
}

/** Calls the 67-12 built-in listing; it is a daemon built-in, never a registered workflow verb. */
export async function callVerbs (ctx: RunContext, label: string): Promise<DaemonCallResult> {
  return ctx.peer(label).call(BUILTIN_VERBS_VERB)
}

export interface PollResult<T> {
  ok: boolean
  value: T | undefined
  waitedMs: number
}

export async function poll<T> (
  ctx: RunContext,
  label: string,
  key: LegVerbKey,
  input: LegVerbInput,
  until: (value: Record<string, unknown>) => boolean,
  opts: { timeoutMs: number, intervalMs: number }
): Promise<PollResult<T>> {
  const t0 = nowMs(ctx)
  let last: T | undefined
  for (;;) {
    const reply = await callVerb(ctx, label, key, input)
    if (!reply.ok) ctx.instruments?.wall.record('hidden', reply.error)
    else {
      last = reply.result as T
      if (until(reply.result)) return { ok: true, value: last, waitedMs: nowMs(ctx) - t0 }
    }
    if (nowMs(ctx) - t0 >= opts.timeoutMs) return { ok: false, value: last, waitedMs: nowMs(ctx) - t0 }
    await sleep(ctx, opts.intervalMs)
  }
}

export function needOk (
  L: LegCtx,
  token: string,
  id: string,
  text: string,
  reply: DaemonCallResult
): void {
  const error = reply.ok ? undefined : reply.error?.name
  L.need(token, id, text, reply.ok, error === undefined ? { ms: reply.ms } : { ms: reply.ms, error })
}

export const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '')
export const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
export const bool = (value: unknown): boolean => value === true
