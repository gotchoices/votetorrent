// The two authority legs between the election and the voters: keyholders accept their seats, then drive
// the DKG in parallel against the same election. Both mirror the lean rig's accept and DKG legs.

import type { ElectionLegBody } from '../election-legs.js'
import { callVerb, needOk, nowMs, number, stringOf } from './common.js'

export const acceptBody: ElectionLegBody = async (L, ctx) => {
  const t0 = nowMs(ctx)
  for (const label of ['kh-a', 'kh-b']) {
    const accepted = await callVerb(ctx, label, 'keyholder.accept', {
      network: ctx.shared.networkHash,
      election: ctx.shared.electionId,
      shareFile: ctx.shared.seatFiles[label] ?? '',
      waitMs: 180000
    }, { timeoutMs: 300000 })
    needOk(L, 'accept', `A-${label}`, `${label} accepted its keyholder seat`, accepted)
    L.need('accept', `A2-${label}`, `${label}'s acceptance was recorded`, accepted.ok && accepted.result.accepted === true)
  }
  L.duration('acceptMs', nowMs(ctx) - t0)
  L.window('h7-accept', t0, nowMs(ctx))
}

export const dkgBody: ElectionLegBody = async (L, ctx) => {
  const t0 = nowMs(ctx)
  const input = { network: ctx.shared.networkHash, election: ctx.shared.electionId, boundMs: 900000 }
  const [a, b] = await Promise.all([
    callVerb(ctx, 'kh-a', 'keyholder.dkg', input, { timeoutMs: 1000000 }),
    callVerb(ctx, 'kh-b', 'keyholder.dkg', input, { timeoutMs: 1000000 })
  ])
  needOk(L, 'dkg-bound', 'D1', 'kh-a completed the DKG', a!)
  needOk(L, 'dkg-bound', 'D2', 'kh-b completed the DKG', b!)
  L.need('dkg-bound', 'D3', 'both keyholders reached the complete phase', a!.ok && b!.ok && stringOf(a!.result.phase) === 'complete' && stringOf(b!.result.phase) === 'complete')
  const ra = a!.ok ? a!.result : {}
  const rb = b!.ok ? b!.result : {}
  const tagA = stringOf(ra.jointKeyTag)
  const tagB = stringOf(rb.jointKeyTag)
  L.need('dkg-key', 'D4', 'both keyholders hold their share', a!.ok && b!.ok && ra.hasShare === true && rb.hasShare === true)
  L.need('dkg-key', 'D5', 'one joint key at threshold 2 with 2 participants', tagA.length > 0 && tagA === tagB && number(ra.threshold) === 2 && number(ra.participants) === 2)
  L.duration('dkgMs', nowMs(ctx) - t0)
  L.window('h8-dkg', t0, nowMs(ctx))
  if (ctx.instruments !== null) {
    const pre = await ctx.instruments.forkPrecheck('dkg', L.dir, ['kh-a', 'kh-b', 'officer'])
    L.need(`fork-precheck-${pre.token || 'unreadable'}`, 'D6', 'fork precheck after the DKG', pre.pass)
  }
}
