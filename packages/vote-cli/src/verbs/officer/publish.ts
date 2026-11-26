// `vt officer publish`: the officer publishes the tally computed by the shipped ElectionResultsEngine through
// TallyPublicationEngine.publishElectionTally, the ONE call the Authority ElectionResultsScreen makes
// (discretion choice 2), signed once through the 67-26 token signer. Replaces the retired lean rig's main driver
// legRelease X4 (1372-1406). Approval-class: the token is read per call, the officer key is preflighted before
// any engine read, `production-party` is refused; `published` and `already-published` succeed, every other
// outcome refuses `publish-<outcome>` (the invalid-tally reason text is never carried). The readback counts
// the ElectionTally rows. No console, no process.env, no instanceof.

import { ElectionResultsEngine, TallyPublicationEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { assertTestParty, elapsedMs, officerSignerFactory, pickArgs, refuse, serializeOfficerWrite, startedNow } from './election-deps.js'
import { officerResultsDeps, requireElection, type OfficerResultsDeps } from './results.js'
import { requireTallied } from './tally.js'

const ALLOWED: readonly string[] = ['network', 'election', ...CALL_APPROVAL_ARG_KEYS]
const ROWS_SQL = 'select count(*) as n from ElectionTally where ElectionId = :e'

/** The one publication call this verb makes, as the engine declares it. */
type PublicationEngineLike = Pick<TallyPublicationEngine, 'publishElectionTally'>
type PublishCall = TallyPublicationEngine['publishElectionTally']
export type TallyPublisher = Parameters<PublishCall>[1]
export type PublishOutcome = Awaited<ReturnType<PublishCall>>

/** The results and publication engines, injectable by the unit spec. */
export interface PublishSeams {
  resultsEngine: (est: EngineContext) => { getElectionResults(electionId: string): Promise<unknown> }
  publication: (est: EngineContext) => PublicationEngineLike
}

export const DEFAULT_PUBLISH_SEAMS: PublishSeams = Object.freeze({
  resultsEngine: (est: EngineContext) => new ElectionResultsEngine(est),
  publication: (est: EngineContext) => new TallyPublicationEngine(est)
})

export async function runPublish(deps: OfficerResultsDeps, args: Record<string, unknown>, seams: PublishSeams = DEFAULT_PUBLISH_SEAMS): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  const electionId = requireElection(a)

  return withCallApproval(args, (approval) =>
    serializeOfficerWrite(deps.writeKey, async () => {
      const network = await deps.openNetwork(a.network)
      await network.openElection(electionId)
      const est = await deps.openEst(a.network)
      const signer = officerSignerFactory(deps, approval)
      await signer.preflight()
      const results = requireTallied(await seams.resultsEngine(est).getElectionResults(electionId))
      const officer = deps.officer
      const publisher: TallyPublisher = { userId: officer.userId, signingPublicKey: officer.signerKey, sign: await signer.createSigner() }
      const tPublish = startedNow()
      const outcome: PublishOutcome = await seams.publication(est).publishElectionTally(results.tally as Parameters<PublishCall>[0], publisher)
      const publishMs = elapsedMs(tPublish)
      if (outcome.outcome !== 'published' && outcome.outcome !== 'already-published') refuse(`publish-${outcome.outcome}`)
      let rows = 0
      for await (const row of est.db.eval(ROWS_SQL, { e: electionId })) rows = Number((row as { n?: unknown }).n)
      return {
        electionId,
        revision: outcome.revision,
        outcome: outcome.outcome,
        publishedAt: outcome.publishedAt,
        tallyRoot8: outcome.tallyRoot.slice(0, 8),
        rows,
        signatures: signer.signatures(),
        publishMs,
        ms: elapsedMs(t0)
      }
    })
  )
}

const publish: VerbHandler<VerbContext> = async (ctx, args) => runPublish(officerResultsDeps(ctx), args)

export default publish
