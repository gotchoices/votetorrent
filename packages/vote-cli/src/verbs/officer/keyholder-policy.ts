// `vt officer keyholder-policy`: read, check or propose the election's keyholder policy (seat names
// and threshold) through the shared `checkElectionKeyholders` / `proposeElectionRevision`
// (@votetorrent/workflows/authority, the Authority's EditElectionScreen body). Replaces the rig's
// direct `ElectionRevision` read (the retired lean rig's main driver 758-761) and the retired JSON-RPC vote-cli's
// keyholder edits. NOT approval-class: `adjustElection` is non-signing, so the token keys are not
// allowed here and passing one is `bad-arg`.
//
// Modes: read (no policy args) -> the current policy and the invited-seat count; check (`--check` with
// `--keyholders` and `--threshold`) -> the policy rule alone, no network; propose (policy args, no
// `--check`) -> a proposed revision, read back from `getProposedElections`.

import { checkElectionKeyholders, proposeElectionRevision } from '@votetorrent/workflows/authority'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import { assertTestParty, elapsedMs, officerElectionDeps, pickArgs, refuse, startedNow, type OfficerElectionDeps } from './election-deps.js'

const ALLOWED = ['network', 'election', 'keyholders', 'threshold', 'check']
const THRESHOLD_RE = /^\d{1,3}$/

function names(value: unknown): string[] {
  if (typeof value !== 'string') refuse('keyholders-invalid')
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

function thresholdOf(value: unknown): number {
  if (typeof value !== 'string' || !THRESHOLD_RE.test(value)) refuse('threshold-invalid')
  return Number(value)
}

export async function runKeyholderPolicy(deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.check !== undefined && a.check !== true) refuse('bad-arg')
  const hasPolicy = a.keyholders !== undefined || a.threshold !== undefined
  if (a.check === true) {
    if (a.keyholders === undefined || a.threshold === undefined) refuse('check-needs-policy')
    const r = checkElectionKeyholders(names(a.keyholders), thresholdOf(a.threshold))
    if (!r.ok) refuse(r.refusal.code)
    return { mode: 'check', seats: r.keyholders.length, threshold: r.threshold, ms: elapsedMs(t0) }
  }
  if (a.network === undefined) refuse('network-required')
  if (a.election === undefined) refuse('election-required')
  const network = await deps.openNetwork(a.network)
  const electionEngine = await network.openElection(a.election)
  const details = await electionEngine.getElectionDetails()
  const electionId = details.election.id
  const current = details.current
  if (!hasPolicy) {
    return {
      mode: 'read',
      electionId,
      revision: current.revision,
      threshold: current.keyholderThreshold,
      seats: current.keyholders.length,
      invitedSeats: await network.countKeyholderInviteSlots(electionId),
      ms: elapsedMs(t0)
    }
  }
  const keyholders = a.keyholders === undefined ? current.keyholders.map((k) => k.invite.name) : names(a.keyholders)
  const threshold = a.threshold === undefined ? current.keyholderThreshold : thresholdOf(a.threshold)
  const res = await proposeElectionRevision({
    electionsEngine: network.electionsEngine,
    current: details,
    input: { type: details.election.type, keyholders, threshold, tags: current.tags, instructions: current.instructions, timeline: current.timeline },
    now: deps.now()
  })
  if (!res.ok) refuse(res.refusal.code)
  const proposedRevision = (current.revision ?? 0) + 1
  const proposals = await network.electionsEngine.getProposedElections()
  const hit = proposals.find(
    (p) => p.proposed.election.id === electionId && p.proposed.revision.revision === proposedRevision && p.proposed.revision.keyholderThreshold === threshold
  )
  if (hit === undefined) refuse('policy-readback-mismatch')
  return { mode: 'propose', electionId, proposedRevision, threshold, seats: keyholders.length, ms: elapsedMs(t0) }
}

export default async function keyholderPolicy(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runKeyholderPolicy(officerElectionDeps(ctx), args)
}
