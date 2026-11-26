// `vt voter send`: pool the saved vote through the authority's rendezvous with the shared `runVoteSend` (67-22,
// the Voter's send flow) over `sendSavedVote` and vote-engine's PoolAgent. Replaces the retired lean rig/host-voter/
// host-voter.ts 976-1047 (the pool wiring). Approval-class because the consent signature uses K_vote, but the
// saved-vote marker is read with NO token and the shared flow runs the reachability probe BEFORE `openRecord`,
// so an unreachable or absent network costs zero token reads and zero vault prompts. The reply carries ids,
// status names, counts and timings only. No console (the sink's stderr line excepted), no process.env, no instanceof.

import { multiaddr } from '@multiformats/multiaddr'
import { PROBE_BUDGET_MS, runVoteSend, sendSavedVote, VOTE_SENDING_PORT_ENGINE, type VoteSendingPort } from '@votetorrent/workflows/voter'
import type { VoteSigningProducer } from '@votetorrent/workflows/platform'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { CLI_VOTE_PROMPT, createCliVoteRecordPorts, createRedactingVoteSendDebug } from '../../voter/vote-record-seams.js'
import { countingApproval, requireElectionArg } from './cast.js'
import {
  assertVoterTestParty,
  bindVoteVerb,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  type VoterVoteDeps
} from './voter-deps.js'

const SEND_ARGS: readonly string[] = ['network', 'election', 'probeBudgetMs', ...CALL_APPROVAL_ARG_KEYS]
export const PROBE_BUDGET_MIN_MS = 1000
export const PROBE_BUDGET_MAX_MS = 60000

export async function runSend(deps: VoterVoteDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, SEND_ARGS)
  assertVoterTestParty(deps.partyId)
  const network = requireVoterNetworkArg(a)
  const electionId = requireElectionArg(a)
  let probeBudgetMs = PROBE_BUDGET_MS
  if (a.probeBudgetMs !== undefined) {
    if (typeof a.probeBudgetMs !== 'string' || !/^\d{4,5}$/.test(a.probeBudgetMs)) throw new VoterVerbRefusal('probe-budget-invalid')
    probeBudgetMs = Number(a.probeBudgetMs)
    if (probeBudgetMs < PROBE_BUDGET_MIN_MS || probeBudgetMs > PROBE_BUDGET_MAX_MS) throw new VoterVerbRefusal('probe-budget-invalid')
  }

  return withCallApproval(args, async (rawApproval) => {
    const counted = countingApproval(rawApproval)
    const { getEngine, readRendezvousAddrs } = await deps.openNetwork(network)
    const sink = createRedactingVoteSendDebug(deps)
    const ports = createCliVoteRecordPorts({ kv: deps.kv, keys: deps.keys, approval: counted.approval, debug: sink })
    // the marker, with no token
    const load = await ports.receipt.loadVoteReceipt(electionId, null)
    if (load.kind === 'none') throw new VoterVerbRefusal('no-saved-vote')
    if (load.kind === 'unreadable') throw new VoterVerbRefusal('saved-vote-unreadable')
    const envelope = load.envelope
    const promptsBefore = deps.authPromptCount()
    // built before the flow (its construction reads no token); the flow asks for it only after the probe and the record open
    const producer: VoteSigningProducer = await deps.producer(counted.approval)
    const tSend = startedNow()
    const outcome = await runVoteSend(
      {
        node: deps.node,
        readRendezvousAddrs,
        toDialTarget: (addr) => multiaddr(addr),
        openRecord: () => ports.receipt.revealVoteReceipt(electionId, envelope, CLI_VOTE_PROMPT),
        getPort: () => getEngine<VoteSendingPort>(VOTE_SENDING_PORT_ENGINE),
        signingProducer: () => producer,
        consentPrompt: CLI_VOTE_PROMPT,
        sentStore: ports.sentStore,
        send: (d) => sendSavedVote(d, sink),
        cancelSign: async () => undefined,
        canPrompt: () => true,
        nowMs: () => deps.now(),
        probeBudgetMs
      },
      sink
    )
    const sendMs = elapsedMs(tSend)
    if (outcome.kind !== 'done') throw new VoterVerbRefusal(`send:${outcome.kind}`)
    const ballots = outcome.ballots.map((b) => ({
      ballotId: b.ballotId,
      phase: b.status.phase,
      ...(b.status.phase === 'not-sent' ? { reason: b.status.reason } : {})
    }))
    return {
      electionId,
      ballots,
      committed: ballots.filter((b) => b.phase === 'sent').length,
      tokenReads: counted.reads(),
      sendUnwraps: deps.authPromptCount() - promptsBefore,
      sendMs,
      ms: elapsedMs(t0)
    }
  })
}

export const sendVerb: VerbHandler<VerbContext> = bindVoteVerb(runSend)

export default sendVerb
