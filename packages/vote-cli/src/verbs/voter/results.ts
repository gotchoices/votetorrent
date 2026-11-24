// `vt voter results`: the voter's read of the election results through the shared `readElectionResults` (67-19,
// the Voter Results screen's read) with the opened-set preimage check and the agreement hash every peer
// computes (src/proof). Replaces tools/lean-rig/lean/lean-part2.ts legRelease X5 (1407-1420) and
// tools/lean-rig/host-voter/host-voter.ts 1049+. Read-only: no token (a token key is `bad-arg`), no party
// gate. The reply holds ids, counts, booleans, 8-char root prefixes, hashes and timings; option codes never
// appear. No console, no process.env, no instanceof.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { parseResultsArgs, readAgreedResults, resultsReply } from '../../proof/results-agreement.js'
import { requireElectionArg } from './cast.js'
import {
  bindVoteVerb,
  elapsedMs,
  pickVoterArgs,
  requireVoterNetworkArg,
  startedNow,
  VoterVerbRefusal,
  type VoterRefusalCode,
  type VoterVoteDeps
} from './voter-deps.js'

export const VOTER_RESULTS_ARGS: readonly string[] = ['network', 'election', 'waitMs', 'requirePublished', 'expectedFiles', 'needleFile']

export async function runVoterResults(deps: VoterVoteDeps, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickVoterArgs(args, VOTER_RESULTS_ARGS)
  const network = requireVoterNetworkArg(a)
  const electionId = requireElectionArg(a)
  const parsed = parseResultsArgs(a, deps.secrets, (code) => { throw new VoterVerbRefusal(code as VoterRefusalCode) })
  const { est, getEngine } = await deps.openNetwork(network)
  const agreed = await readAgreedResults({
    getEngine,
    est,
    electionId,
    waitMs: parsed.waitMs,
    requirePublished: parsed.requirePublished,
    ...(parsed.expected === undefined ? {} : { expected: parsed.expected }),
    ...(parsed.needle === undefined ? {} : { needle: parsed.needle })
  })
  return resultsReply(agreed, electionId, elapsedMs(t0))
}

export const voterResultsVerb: VerbHandler<VerbContext> = bindVoteVerb(runVoterResults)

export default voterResultsVerb
