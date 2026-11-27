// The h6-election leg: enable encrypted intake, create the short CLI timeline, read the keyholder
// policy, invite both seats, submit the ballot with its needle option and sign the confirmation task.

import { HANDOFF_KEYS } from '../results.js'
import type { ElectionLegBody } from '../election-legs.js'
import { callVerb, needOk, nowMs, number, stringOf } from './common.js'

/** releasingKeys = accruingVotes + 2 x 60 s (the CLI timeline); a spec pins it to buildCliTimeline. */
export const RELEASING_AFTER_ACCRUING_MS = 120000

export const electionBody: ElectionLegBody = async (L, ctx) => {
  const t0 = nowMs(ctx)
  const networkHash = ctx.shared.networkHash
  const authority = ctx.shared.authorityId

  const intake = await callVerb(ctx, 'officer', 'officer.enable-intake', { authority, network: networkHash })
  needOk(L, 'intake', 'E0', 'officer encrypted intake was enabled', intake)
  L.need('intake', 'E1', 'intake reads enabled', intake.ok && stringOf(intake.result.state) === 'enabled')
  L.duration('intakeMs', intake.ms)

  const created = await callVerb(ctx, 'officer', 'officer.create-election', {
    network: networkHash,
    title: 'vt-election',
    keyholders: 'kh-a,kh-b',
    threshold: '2',
    leadMs: ctx.opts.leadMs,
    windowMs: ctx.opts.windowMs
  })
  needOk(L, 'timeline-voter-rules', 'E2', 'the election timeline was accepted', created)
  needOk(L, 'election', 'E3', 'the election was created', created)
  const electionId = created.ok ? stringOf(created.result.electionId) : ''
  L.need('election', 'E4', 'create-election returned an election id', electionId.length > 0)
  ctx.shared.electionId = electionId
  const starts = created.ok ? stringOf(created.result.votingStartsAt) : ''
  const closed = created.ok ? stringOf(created.result.closedAt) : ''
  ctx.shared.votingStartsAtMs = Date.parse(starts)
  ctx.shared.closedAtMs = Date.parse(closed)
  // The create-election reply carries no releasingKeys instant: it is the timeline rule the verb builds
  // (election/parse-timeline.ts, as the rig), in a full and a reduced topology alike.
  ctx.shared.releasingKeysAtMs = ctx.shared.votingStartsAtMs + ctx.opts.windowMs + RELEASING_AFTER_ACCRUING_MS
  ctx.out.key(HANDOFF_KEYS.election, `electionId=${electionId}`)
  ctx.out.key('ELECTION', `id8=${electionId.slice(-8)} votingStartsAt=${starts} releasingKeysAt=${new Date(ctx.shared.releasingKeysAtMs).toISOString()}`)

  const policy = await callVerb(ctx, 'officer', 'officer.keyholder-policy', { network: networkHash, election: electionId })
  needOk(L, 'election', 'E5', 'the keyholder policy was read', policy)
  L.need('election', 'E6', 'the policy has threshold 2 and two seats', policy.ok && number(policy.result.threshold) === 2 && number(policy.result.seats) === 2)

  for (const label of ['kh-a', 'kh-b']) {
    const invited = await callVerb(ctx, 'officer', 'officer.invite-keyholder', {
      network: networkHash,
      election: electionId,
      name: label,
      shareName: `seat-${label}`
    })
    needOk(L, 'slots', `I-${label}`, `${label} was invited to a seat`, invited)
    const shareFile = invited.ok ? stringOf(invited.result.shareFile) : ''
    L.need('slots', `I2-${label}`, `${label}'s seat share was written`, shareFile.length > 0)
    if (shareFile.length > 0) ctx.registerSecretFile(shareFile, { windows: true })
    ctx.shared.seatFiles[label] = shareFile
  }
  const invitedSeats = await callVerb(ctx, 'officer', 'officer.keyholder-policy', { network: networkHash, election: electionId })
  needOk(L, 'election', 'E7', 'the policy was read after both invitations', invitedSeats)
  L.need('slots', 'E8', 'both keyholder seats are invited', invitedSeats.ok && number(invitedSeats.result.invitedSeats) === 2)

  const submitted = await callVerb(ctx, 'officer', 'officer.ballot-submit', { network: networkHash, election: electionId })
  needOk(L, 'ballot', 'B1', 'the ballot was submitted', submitted)
  ctx.shared.ballotId = submitted.ok ? stringOf(submitted.result.ballotId) : ''
  const needleFile = submitted.ok ? stringOf(submitted.result.needleFile) : ''
  L.need('ballot', 'B2', 'the needle option file was written', needleFile.length > 0)
  if (needleFile.length > 0) ctx.registerSecretFile(needleFile, { windows: true })
  ctx.shared.needleFile = needleFile

  const signed = await callVerb(ctx, 'officer', 'officer.task-sign', {
    network: networkHash,
    election: electionId,
    ballot: ctx.shared.ballotId,
    waitMs: 120000
  }, { timeoutMs: 180000 })
  needOk(L, 'ballot', 'B3', 'the ballot signature task was signed', signed)
  L.need('ballot', 'B4', 'the ballot is confirmed after signing', signed.ok && signed.result.confirmed === true)
  L.duration('ballotMs', submitted.ms + signed.ms)
  L.duration('electionMs', nowMs(ctx) - t0)
  L.window('h6-election', t0, nowMs(ctx))
}
