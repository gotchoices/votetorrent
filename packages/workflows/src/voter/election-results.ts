/**
 * election-results.ts — the Voter's results read, extracted from
 * `apps/VoteTorrentVoter/src/screens/timeline/ResultsScreen.tsx` (its effect body plus `readPublication`)
 * by phase 67 plan 19. The screen keeps its state, the strand-change subscription, its dev-only
 * fallback choice, the debug log call and all presentation; this is the one read both it and the CLI's
 * voter `results` verb run.
 *
 * Same engine calls in the same order as the screen made them: `elections` -> `getElections()` ->
 * `pickElectionId`; with no id the result is `no-election` and the results engine is never asked for.
 * Otherwise `electionResults` -> `getElectionResults(electionId)`, then the published tally through
 * `tallyPublication` for a tallied result only. The publication is returned by identity: this module
 * never inspects, sets or defaults the engine's verdicts. Judging a publication is the caller's
 * presentation decision, and vote-engine's verification is the only trust source. A failed publication
 * read is `'unknown'`, never a fabricated value; every other error propagates to the caller.
 */
import type { IElectionsEngine } from '@votetorrent/vote-core'
import type { ElectionResults, ElectionResultsEngine, PublishedTally, TallyPublicationEngine } from '@votetorrent/vote-engine/rn'
import { pickElectionId } from './election-read.js'

/** `'unknown'`: the published tally could not be read; nothing is shown for it. */
export type ElectionResultsPublication = PublishedTally | null | 'unknown'

/** The engine's reason code for an `unavailable` result (a closed token for logs; the caller shows plain copy). */
export type ElectionResultsUnavailableReason = Extract<ElectionResults, { status: 'unavailable' }>['reason']

export interface ElectionResultsReadDeps {
  getEngine: <T>(engineName: string) => Promise<T>
  /** The election to fall back to when the network lists none (the app passes its dev seed, the CLI `undefined`). */
  fallbackElectionId: string | undefined
  /** Called once with the engine's reason code when the result is `unavailable`. */
  onUnavailable?: (reason: ElectionResultsUnavailableReason) => void
}

export interface ElectionResultsRead {
  results: ElectionResults
  publication: ElectionResultsPublication
}

async function readPublication(getEngine: <T>(name: string) => Promise<T>, results: ElectionResults): Promise<ElectionResultsPublication> {
  if (results.status !== 'tallied') return 'unknown'
  try {
    const engine = await getEngine<TallyPublicationEngine>('tallyPublication')
    return await engine.readPublishedTally(results.electionId, results.revision, results.tally)
  } catch {
    return 'unknown'
  }
}

/** The results read: the counted result plus the published tally, as the Results screen reads them. */
export async function readElectionResults(deps: ElectionResultsReadDeps): Promise<ElectionResultsRead> {
  const electionsEngine = await deps.getEngine<IElectionsEngine>('elections')
  const summaries = await electionsEngine.getElections()
  const electionId = pickElectionId(summaries, deps.fallbackElectionId)
  if (!electionId) {
    return { results: { status: 'no-election', electionId: '' }, publication: 'unknown' }
  }
  const engine = await deps.getEngine<ElectionResultsEngine>('electionResults')
  const results = await engine.getElectionResults(electionId)
  const publication = await readPublication(deps.getEngine, results)
  if (results.status === 'unavailable') deps.onUnavailable?.(results.reason)
  return { results, publication }
}
