// The h9-voters leg: mint one code per voter, drive the voter registration/association ceremony and
// the officer approval loop concurrently, then cast once voting has opened (eligibility refuses a cast
// before the window) and pool all votes together. With fewer than three voters the leg stops after
// association and records pool-skipped (a check, not a soft fail).

import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { ElectionLegBody } from '../election-legs.js'
import { callVerb, needOk, needServedVerbs, nowMs, number, poll, sleep, stringOf } from './common.js'

interface VoterMetric {
  joinMs: number
  associatedMs: number
}

const AUTHORITIES = ['officer', 'kh-a', 'kh-b'] as const

export const votersBody: ElectionLegBody = async (L, ctx) => {
  const reduced = ctx.opts.voters < 3
  const target = ctx.opts.voters
  const voters: string[] = []
  for (let i = 1; i <= ctx.opts.voters; i++) voters.push(`v${i}`)
  const network = ctx.shared.networkHash
  const election = ctx.shared.electionId
  const firstJoinStart = nowMs(ctx)

  for (const label of voters) {
    const codeFile = ctx.secretPath(`code-${label}.txt`)
    const fingerprintFile = ctx.secretPath(`fp-${label}.txt`)
    const mint = await callVerb(ctx, 'officer', 'officer.mint', { networkHash: network, codeFile, fingerprintFile })
    needOk(L, 'mint', `M-${label}`, `${label}'s join code was minted`, mint)
    ctx.registerSecretFile(codeFile, { windows: true })
    ctx.registerSecretFile(fingerprintFile, { windows: true })
    ctx.shared.codeFiles[label] = codeFile
    ctx.shared.fingerprintFiles[label] = fingerprintFile
  }
  await ctx.startPeers(voters)
  for (const label of voters) await needServedVerbs(ctx, L, label)

  const approvals = new Set<string>()
  let challenges = 0
  let associations = 0
  let refused = false
  const reasonFile = ctx.secretPath('refuse-reason.txt')
  writeFileSync(reasonFile, 'the D-07 checklist is intentionally incomplete\n', { flag: 'wx', mode: 0o600 })
  ctx.registerSecretFile(reasonFile)

  const loopStart = nowMs(ctx)
  const loopPromise = L.step('officer-loop', async () => {
    const ended = nowMs(ctx) + 900000
    for (;;) {
      const sync = await callVerb(ctx, 'officer', 'officer.peer-sync', { authority: ctx.shared.authorityId, network })
      needOk(L, 'officer-loop', 'S1', 'the officer synced the staged requests', sync)
      const rows = await callVerb(ctx, 'officer', 'officer.registrations', { authority: ctx.shared.authorityId, network, status: 'p' })
      needOk(L, 'officer-loop', 'S2', 'the officer read the pending registrations', rows)
      const pending = rows.ok && Array.isArray(rows.result.rows)
        ? (rows.result.rows as Array<Record<string, unknown>>).map((r) => stringOf(r.requestId)).filter((id) => id.length > 0 && !approvals.has(id))
        : []

      if (pending.length > 0 && !refused) {
        refused = true
        const refuse = await callVerb(ctx, 'officer', 'officer.refuse', {
          authority: ctx.shared.authorityId,
          network,
          request: pending[0]!,
          // `none` mixed with a substantive item is the incomplete checklist; `none` alone meets the
          // gate and would refuse the voter's request for good
          checklist: 'none,id',
          reasonFile
        })
        L.need('refuse-gate', 'D07', 'the incomplete D-07 checklist was refused before any token read',
          !refuse.ok && refuse.error?.code === 'checklist-incomplete',
          { ok: refuse.ok, code: refuse.ok ? undefined : refuse.error?.code })
      }

      for (const request of pending) {
        if (approvals.size >= target) break
        const callStart = nowMs(ctx)
        const approve = await callVerb(ctx, 'officer', 'officer.approve', {
          authority: ctx.shared.authorityId,
          network,
          request,
          checklist: 'id'
        })
        needOk(L, 'officer-loop', `A-${approvals.size + 1}`, 'the officer approved a pending registration', approve)
        const n = approvals.size + 1
        const readMs = Math.max(0, number(approve.ok ? approve.result.readMs : 0))
        const decideMs = Math.max(0, number(approve.ok ? approve.result.decideMs : 0))
        const publishMs = Math.max(0, number(approve.ok ? approve.result.publishMs : 0))
        ctx.out.approve({ n, readMs, decideMs, publishMs, publish: stringOf(approve.ok ? approve.result.published : 'failed') })
        L.window(`approve${n}-read`, callStart, callStart + readMs)
        L.window(`approve${n}-decide`, callStart + readMs, callStart + readMs + decideMs)
        L.window(`approve${n}-publish`, callStart + readMs + decideMs, callStart + readMs + decideMs + publishMs)
        if (approve.ok) approvals.add(request)
      }

      const after = await callVerb(ctx, 'officer', 'officer.peer-sync', { authority: ctx.shared.authorityId, network })
      needOk(L, 'officer-loop', 'S3', 'the officer synced after deciding', after)
      if (after.ok) {
        challenges = number(after.result.challenges)
        associations = number((after.result.associations as Record<string, unknown> | undefined)?.after)
      }
      if (approvals.size >= target && associations >= target) break
      if (nowMs(ctx) >= ended) break
      await sleep(ctx, 5000)
    }
    // one more sync after the last association, so every decision is published to its voter
    const last = await callVerb(ctx, 'officer', 'officer.peer-sync', { authority: ctx.shared.authorityId, network })
    needOk(L, 'officer-loop', 'S4', 'the officer ran the closing sync', last)
    L.need('officer-loop', 'G1', `${target} registrations were approved once each`, approvals.size >= target, { approvals: approvals.size })
    L.need('officer-loop', 'G2', `${target} challenges were issued`, challenges >= target, { challenges })
    L.need('officer-loop', 'G3', `${target} associations were published`, associations >= target, { associations })
    return true
  }).then((ok) => {
    L.duration('associatedWaitMs', nowMs(ctx) - loopStart)
    return ok
  })

  const prepare = async (label: string): Promise<VoterMetric> => {
    const peer = ctx.peer(label)
    peer.stage('started')
    const joinStart = nowMs(ctx)
    const joined = await callVerb(ctx, label, 'voter.join', {
      codeFile: ctx.shared.codeFiles[label]!,
      expectFingerprintFile: ctx.shared.fingerprintFiles[label]!,
      timeoutMs: 420000
    })
    needOk(L, 'join-outcome', `V-${label}`, `${label} joined the network`, joined)
    if (!joined.ok) return { joinMs: 0, associatedMs: 0 }
    const joinMs = Math.max(1, nowMs(ctx) - joinStart)
    peer.stage('joined')

    const registrantFile = ctx.secretPath(`registrant-${label}.json`)
    // the rig's registrant fields (synthetic, with a random address per voter)
    const number1 = label.slice(1)
    const email = `voter${number1}-${randomBytes(4).toString('hex')}@example.invalid`
    writeFileSync(registrantFile, JSON.stringify({ firstName: 'Vtcli', lastName: `Voter${number1}`, email, dob: '1990-01-01' }) + '\n', { flag: 'wx', mode: 0o600 })
    ctx.registerSecretFile(registrantFile, { windows: true })
    const registered = await callVerb(ctx, label, 'voter.register', { network, election, registrantFile })
    needOk(L, 'intake', `R-${label}`, `${label} staged its registration`, registered)
    peer.stage('intake-ready')
    peer.stage('registration-staged')

    const staged = await callVerb(ctx, label, 'voter.stage-association', { network })
    needOk(L, 'association-staged', `AS-${label}`, `${label} staged its association`, staged)
    peer.stage('association-staged')

    const challenge = await poll(ctx, label, 'voter.read-decision', { network, waitFor: 'challenge' },
      (v) => stringOf(v.associationDecision) === 'c', { timeoutMs: 900000, intervalMs: 5000 })
    L.need('hv-association-staged', `C-${label}`, `${label} received its challenge`, challenge.ok, { waitedMs: challenge.waitedMs })
    peer.stage('challenge-received')
    const answered = await callVerb(ctx, label, 'voter.answer-challenge', { network })
    needOk(L, 'challenge-answered', `CA-${label}`, `${label} answered its challenge`, answered)
    peer.stage('challenge-answered')

    const decision = await poll(ctx, label, 'voter.read-decision', { network, waitFor: 'registered' },
      (v) => v.status === 'registered' && v.associationDecision === 'a', { timeoutMs: 900000, intervalMs: 5000 })
    L.need('associated', `D-${label}`, `${label} is associated and eligible`, decision.ok, { waitedMs: decision.waitedMs })
    const associatedMs = Math.max(joinMs, nowMs(ctx) - joinStart)
    peer.stage('associated')
    peer.stage('eligible')
    if (reduced) return { joinMs, associatedMs }

    const untilOpen = ctx.shared.votingStartsAtMs + 1000
    while (nowMs(ctx) < untilOpen) await sleep(ctx, 1000)
    peer.stage('voting-open')
    const choice = ctx.shared.votersChoices[label] ?? 0
    const cast = await callVerb(ctx, label, 'voter.cast', { network, election, choiceIndex: choice })
    needOk(L, 'vote-built', `B-${label}`, `${label} built and signed its vote`, cast)
    // the choice file travels by the path in the reply; whole value only, its text embeds public ids
    if (cast.ok) ctx.registerSecretFile(stringOf(cast.result.choiceFile))
    peer.stage('vote-built')
    peer.stage('ready-to-send')
    return { joinMs, associatedMs }
  }

  const metrics = await Promise.all([loopPromise, ...voters.map(prepare)])
  const voterMetrics = metrics.slice(1).filter((m): m is VoterMetric => typeof m === 'object' && m !== null)
  L.duration('hvJoinMs', Math.max(0, ...voterMetrics.map((m) => m.joinMs)))
  L.duration('associatedMs', Math.max(0, ...voterMetrics.map((m) => m.associatedMs)))

  if (reduced) {
    L.check('pool-skipped', 'a reduced topology never pools', true, { voters: ctx.opts.voters })
    return
  }

  const atSend = nowMs(ctx)
  L.need('timeline-missed', 'W0', 'the send window is open and has not closed',
    atSend >= ctx.shared.votingStartsAtMs && atSend <= ctx.shared.closedAtMs - 180000,
    { at: atSend, opens: ctx.shared.votingStartsAtMs, closes: ctx.shared.closedAtMs })

  for (const label of voters) ctx.peer(label).stage('pooling')
  // The send reply carries no block id; one pool is proven by the tally's blockCount in the next leg.
  const sendMs = await Promise.all(voters.map(async (label) => {
    const sendStart = nowMs(ctx)
    const result = await callVerb(ctx, label, 'voter.send', { network, election }, { timeoutMs: 900000 })
    needOk(L, 'hv-commit', `P-${label}`, `${label}'s send finished`, result)
    const committed = result.ok ? number(result.result.committed) : 0
    L.need('hv-commit', `P2-${label}`, `${label} committed exactly one ballot`, committed === 1, { committed })
    ctx.peer(label).stage('committed')
    return nowMs(ctx) - sendStart
  }))
  L.duration('poolMs', Math.max(0, ...sendMs))
  L.window('h9-voters-active', firstJoinStart, nowMs(ctx))

  if (ctx.instruments !== null) {
    const pre = await ctx.instruments.forkPrecheck('block', L.dir, AUTHORITIES)
    L.need(`fork-precheck-${pre.token || 'unreadable'}`, 'P5', 'fork precheck after the block', pre.pass)
  }
}
