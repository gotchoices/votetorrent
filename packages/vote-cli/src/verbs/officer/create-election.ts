// `vt officer create-election`: a threshold-N election on the CLI short timeline, through the shared
// `createElection` workflow (@votetorrent/workflows/authority, the Authority's CreateElectionScreen
// body). Replaces tools/lean-rig/lean/lean-part2.ts 717-747 (the hand-built init, the two signing
// seams, the builder-less createElection) and tools/vote-cli/src/workflows/authority.mjs 227-291.
// Approval-class: the token is taken per call (`--token-file` / `--token-env` / `--token-stdin`).
//
// Check order: args allow-list, party gate, static argument and timeline validation (incl. the Voter's
// own rule over the shared deriveTimeline), token presence, network, token preflight, the shared
// workflow, readback. The result holds ids, counts, booleans, ISO instants and timings only.

import { ElectionType } from '@votetorrent/vote-core'
import { createElection as createElectionWorkflow } from '@votetorrent/workflows/authority'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import { buildCliTimeline, checkVoterTimelineRules, parseTimelineArgs } from '../../election/parse-timeline.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import {
  assertTestParty,
  elapsedMs,
  officerElectionDeps,
  officerSignerFactory,
  pickArgs,
  refuse,
  serializeOfficerWrite,
  startedNow,
  type OfficerElectionDeps
} from './election-deps.js'

const ALLOWED = ['network', 'title', 'keyholders', 'threshold', 'type', 'tags', 'instructions', 'leadMs', 'windowMs', ...CALL_APPROVAL_ARG_KEYS]
const DEFAULT_TITLE = 'vt-election'
const DEFAULT_KEYHOLDERS = ['kh-a', 'kh-b']
const TITLE_RE = /^[\x20-\x7e]{1,120}$/
const THRESHOLD_RE = /^\d{1,3}$/
const MAX_INSTRUCTIONS = 2000
const TYPES: Readonly<Record<string, ElectionType>> = Object.freeze({ official: ElectionType.official, adhoc: ElectionType.adhoc })

function csv(value: unknown, fallback: string[], code: string): string[] {
  if (value === undefined) return fallback
  if (typeof value !== 'string') refuse(code)
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

export async function runCreateElection(deps: OfficerElectionDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  const title = a.title === undefined ? DEFAULT_TITLE : a.title
  if (typeof title !== 'string' || !TITLE_RE.test(title)) refuse('title-invalid')
  const keyholders = csv(a.keyholders, DEFAULT_KEYHOLDERS, 'keyholders-invalid')
  const thresholdText = a.threshold === undefined ? '2' : a.threshold
  if (typeof thresholdText !== 'string' || !THRESHOLD_RE.test(thresholdText)) refuse('threshold-invalid')
  const threshold = Number(thresholdText)
  const typeKey = a.type === undefined ? 'official' : a.type
  if (typeof typeKey !== 'string' || !Object.hasOwn(TYPES, typeKey)) refuse('type-invalid')
  const type = TYPES[typeKey]!
  const tags = csv(a.tags, [], 'tags-invalid')
  const instructions = a.instructions === undefined ? `# ${title}` : a.instructions
  if (typeof instructions !== 'string' || instructions.length > MAX_INSTRUCTIONS) refuse('instructions-invalid')
  const parsed = parseTimelineArgs({ leadMs: a.leadMs, windowMs: a.windowMs })
  if (!parsed.ok) refuse(parsed.code)
  const built = (deps.buildTimeline ?? buildCliTimeline)({ now: deps.now(), leadMs: parsed.leadMs, windowMs: parsed.windowMs })
  const conflicts = checkVoterTimelineRules({ timeline: built.timeline, date: built.date, ballotDeadline: built.ballotDeadline, now: built.T })
  if (conflicts.length > 0) refuse('timeline-voter-rules')
  return withCallApproval(args, (approval) =>
    serializeOfficerWrite(deps.writeKey, async () => {
      const network = await deps.openNetwork(a.network)
      const signer = officerSignerFactory(deps, approval)
      await signer.preflight()
      const res = await createElectionWorkflow({
        electionsEngine: network.electionsEngine,
        input: {
          authorityId: network.authorityId,
          title,
          date: built.date,
          revisionDeadline: built.revisionDeadline,
          type,
          keyholders,
          threshold,
          tags,
          instructions,
          timeline: built.timeline,
          ballotDeadline: built.ballotDeadline
        },
        createSigner: () => signer.createSigner(),
        now: built.T
      })
      if (!res.ok) refuse(res.refusal.code)
      const electionCount = (await network.electionsEngine.getElections()).length
      return {
        electionId: res.electionId,
        authorityId8: network.authorityId.slice(-8),
        title,
        threshold,
        seats: keyholders.length,
        leadMs: parsed.leadMs,
        windowMs: parsed.windowMs,
        belowProvenDefaults: parsed.belowProvenDefaults,
        votingStartsAt: new Date(built.votingStarts).toISOString(),
        closedAt: new Date(built.date).toISOString(),
        electionCount,
        signatures: signer.signatures(),
        ms: elapsedMs(t0)
      }
    })
  )
}

export default async function createElection(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runCreateElection(officerElectionDeps(ctx), args)
}
