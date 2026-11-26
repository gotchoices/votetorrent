// The h10-release-decrypt leg: wait for the key-release window, let both keyholders release, then (in a
// full topology) tally, publish and read identical results on every peer. A reduced topology stops at
// key release and records results-skipped instead of failing a vote it can never cast.

import type { ElectionLegBody } from '../election-legs.js'
import type { Role } from '../../ctl/protocol.js'
import { identityKeyName, RESULTS_IDENTICAL_KEY, resultsTag } from '../results-identity.js'
import { callVerb, needOk, nowMs, number, poll, sleep, stringOf } from './common.js'

function roleOf (label: string): Role {
  if (label === 'officer') return 'officer'
  if (label.startsWith('kh-')) return 'keyholder'
  return 'voter'
}

const resultKey = (label: string): 'officer.results' | 'keyholder.results' | 'voter.results' =>
  roleOf(label) === 'officer' ? 'officer.results' : roleOf(label) === 'keyholder' ? 'keyholder.results' : 'voter.results'

const readbackKey = (label: string): 'officer.readback' | 'keyholder.readback' | 'voter.readback' =>
  roleOf(label) === 'officer' ? 'officer.readback' : roleOf(label) === 'keyholder' ? 'keyholder.readback' : 'voter.readback'

export const releaseBody: ElectionLegBody = async (L, ctx) => {
  const labels: string[] = ['officer', 'kh-a', 'kh-b']
  for (let i = 1; i <= ctx.opts.voters; i++) labels.push(`v${i}`)
  const network = ctx.shared.networkHash
  const election = ctx.shared.electionId

  const waitStart = nowMs(ctx)
  while (nowMs(ctx) < ctx.shared.releasingKeysAtMs && nowMs(ctx) - waitStart < 600000) await sleep(ctx, 1000)
  L.need('release-wait', 'Q0', 'the key-release window was reached by the real clock',
    nowMs(ctx) >= ctx.shared.releasingKeysAtMs && nowMs(ctx) - waitStart <= 600000,
    { waitedMs: nowMs(ctx) - waitStart })

  const window = await callVerb(ctx, 'officer', 'officer.release-window', { network, election })
  needOk(L, 'release-wait', 'Q1', 'the officer opened the release window', window)
  L.need('release-wait', 'Q2', 'the release window is open', window.ok && (stringOf(window.result.phase) === 'reconstructable' || number(window.result.releasedCount) >= 2))

  const releaseStart = nowMs(ctx)
  const released = await Promise.all(['kh-a', 'kh-b'].map((label) => callVerb(ctx, label, 'keyholder.release', {
    network,
    election,
    awaitCount: 2
  }, { timeoutMs: 900000 })))
  for (let i = 0; i < released.length; i++) needOk(L, 'release', `L-${i}`, `keyholder ${i + 1} released its share`, released[i]!)
  L.duration('releaseMs', nowMs(ctx) - releaseStart)
  L.window('release', releaseStart, nowMs(ctx))

  if (ctx.opts.reduced) {
    L.check('results-skipped', 'a reduced topology skips tally, publish and results', true, { voters: ctx.opts.voters })
  } else {
    const tallyStart = nowMs(ctx)
    const tally = await callVerb(ctx, 'officer', 'officer.tally', { network, election }, { timeoutMs: 900000 })
    needOk(L, 'decrypt', 'X1', 'the officer tallied the votes', tally)
    L.need('decrypt', 'X2', 'three valid votes, no failures', tally.ok && number(tally.result.valid) === 3 && number(tally.result.invalid) === 0 && number(tally.result.excluded) === 0)
    L.duration('decryptMs', nowMs(ctx) - tallyStart)
    L.window('tally', tallyStart, nowMs(ctx))

    const published = await callVerb(ctx, 'officer', 'officer.publish', { network, election })
    needOk(L, 'results', 'X3', 'the officer published the tally', published)

    const reads = await Promise.all(labels.map(async (label) => {
      if (roleOf(label) === 'voter') ctx.peer(label).stage('results-wait')
      const read = await poll<Record<string, unknown>>(ctx, label, resultKey(label), { network, election, waitMs: 0 },
        (v) => v.status === 'tallied', { timeoutMs: 600000, intervalMs: 5000 })
      if (roleOf(label) === 'voter' && read.ok) ctx.peer(label).stage('results-read')
      return { label, read }
    }))
    for (const r of reads) L.need('results', `X4-${r.label}`, `${r.label} read tallied results`, r.read.ok, { waitedMs: r.read.waitedMs })
    const voters = labels.filter((l) => roleOf(l) === 'voter')
    L.duration('voterResultsMs', Math.max(0, ...reads.filter((r) => voters.includes(r.label)).map((r) => r.read.waitedMs)))

    const tags: string[] = []
    let firstTag = ''
    let equal = true
    for (const r of reads) {
      const result = r.read.value ?? {}
      const tag = resultsTag(result)
      tags.push(tag)
      if (firstTag.length === 0) firstTag = tag
      if (tag !== firstTag) equal = false
      const counts = Array.isArray(result.counts) ? result.counts.map((c) => String(c)).join('/') : ''
      ctx.out.key(identityKeyName(r.label), `tag=${tag} status=${stringOf(result.status)} valid=${number(result.valid)} counts=${counts}`)
    }
    ctx.out.key(RESULTS_IDENTICAL_KEY, `peers=${reads.length} tag=${firstTag} equal=${equal}`)
    L.need('results-identity', 'X5', 'all peers read byte-identical canonical results', equal, { peers: tags.length })
    const officerResult: Record<string, unknown> = reads.find((r) => r.label === 'officer')?.read.value ?? {}
    const counts = Array.isArray(officerResult.counts) ? officerResult.counts.map((c) => number(c)) : []
    L.need('results', 'X6', 'the count multiset equals the three cast choices',
      [...counts].sort((a, b) => b - a).join('/') === '2/1', { counts: counts.join('/') })
  }

  const reads = await Promise.all(labels.map((label) => callVerb(ctx, label, readbackKey(label), {})))
  for (let i = 0; i < reads.length; i++) needOk(L, 'reopen-peers', `RB-${labels[i]}`, `${labels[i]} answered readback`, reads[i]!)
  ctx.out.key('PEER-RSS-MB', labels.map((label, i) => `${label}=${reads[i]!.ok ? number(reads[i]!.result.rssMb) : 0}`).join(' '))

  if (ctx.instruments !== null) {
    const pre = await ctx.instruments.forkPrecheck('exit', L.dir, labels)
    L.need(`fork-precheck-${pre.token || 'unreadable'}`, 'X2', 'fork precheck at exit', pre.pass)
  }
}
