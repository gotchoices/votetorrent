// `vt officer tally`: the officer's decrypt, validate and tally through the shipped ElectionResultsEngine
// (the same call the Authority ElectionResultsScreen makes), followed by the opened-set preimage check (the
// lean rig's X1: every block opens, the per-option counts equal the engine's tally, and with `--expected-files`
// the preimage hash equals the voters' choice files' hash). Replaces the retired lean rig's main driver legRelease
// 1295-1371. Approval-class without signing (discretion choice 3): the token is read per call and the officer
// key is preflighted (presence, zero signatures) before any engine read; `production-party` is refused. Option
// codes, shares, the secret key and the tally tree never appear in the reply. No console, no process.env,
// no instanceof.

import { ElectionResultsEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import { CALL_APPROVAL_ARG_KEYS, withCallApproval } from '../../approval/call-approval.js'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { checkOpenedSet, DEFAULT_OPENED_SET_SEAMS, readChoiceFiles, type OpenedEntry, type OpenedSetSeams, type TalliedResults } from '../../proof/opened-set-check.js'
import { countsMultiset } from '../../proof/results-agreement.js'
import { assertTestParty, elapsedMs, officerSignerFactory, pickArgs, refuse, serializeOfficerWrite, startedNow } from './election-deps.js'
import { readNeedleFile } from './release-window.js'
import { officerResultsDeps, requireElection, type OfficerResultsDeps } from './results.js'

const ALLOWED: readonly string[] = ['network', 'election', 'expectedFiles', 'needleFile', ...CALL_APPROVAL_ARG_KEYS]
export const TALLY_EXPECTED_FILES_MAX = 16

/** The results engine and the opened-set calls, injectable by the unit spec. */
export interface TallySeams {
  resultsEngine: (est: EngineContext) => { getElectionResults(electionId: string): Promise<unknown> }
  openedSet: OpenedSetSeams
}

export const DEFAULT_TALLY_SEAMS: TallySeams = Object.freeze({
  resultsEngine: (est: EngineContext) => new ElectionResultsEngine(est),
  openedSet: DEFAULT_OPENED_SET_SEAMS
})

/** `--expected-files`: a comma list of up to 16 absolute 0600 choice files (`expected-file-invalid`). */
export function readExpectedFilesArg(v: unknown, secrets: OfficerResultsDeps['secrets']): OpenedEntry[] | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) refuse('expected-file-invalid')
  const paths = v.split(',').map((p) => p.trim())
  if (paths.length > TALLY_EXPECTED_FILES_MAX) refuse('expected-file-invalid')
  try {
    return readChoiceFiles(paths, secrets)
  } catch (e) {
    return refuse(String((e as { code?: unknown } | null)?.code ?? 'expected-file-invalid'))
  }
}

/** The engine's results, or the `results-<status>` refusal (`results-unavailable:<reason>`, never the detail). */
export function requireTallied(results: unknown): TalliedResults & { tallyRoot: string, blockRoot: string, blockCount: number, tally: unknown } {
  const r = results as { status?: unknown, reason?: unknown } | null | undefined
  const status = typeof r?.status === 'string' ? r.status : 'unreadable'
  if (status !== 'tallied') refuse(status === 'unavailable' ? `results-unavailable:${String(r?.reason ?? 'unknown')}` : `results-${status}`)
  return results as TalliedResults & { tallyRoot: string, blockRoot: string, blockCount: number, tally: unknown }
}

export async function runTally(deps: OfficerResultsDeps, args: Record<string, unknown>, seams: TallySeams = DEFAULT_TALLY_SEAMS): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  assertTestParty(deps.partyId)
  if (a.network === undefined) refuse('network-required')
  const electionId = requireElection(a)
  const expected = readExpectedFilesArg(a.expectedFiles, deps.secrets)
  const needle = a.needleFile === undefined ? undefined : readNeedleFile(a.needleFile, deps.secrets)

  return withCallApproval(args, (approval) =>
    serializeOfficerWrite(deps.writeKey, async () => {
      const network = await deps.openNetwork(a.network)
      await network.openElection(electionId)
      const est = await deps.openEst(a.network)
      const signer = officerSignerFactory(deps, approval)
      await signer.preflight()
      const tTally = startedNow()
      const results = requireTallied(await seams.resultsEngine(est).getElectionResults(electionId))
      const tallyMs = elapsedMs(tTally)
      const opened = await checkOpenedSet(
        { est, electionId, results, ...(expected === undefined ? {} : { expected }), ...(needle === undefined ? {} : { needle }) },
        seams.openedSet
      )
      return {
        electionId,
        revision: results.revision,
        status: results.status,
        blockCount: results.blockCount,
        valid: results.totals.valid,
        invalid: results.totals.invalid,
        excluded: results.totals.excluded,
        counts: countsMultiset(results),
        tallyRoot8: results.tallyRoot.slice(0, 8),
        blockRoot8: results.blockRoot.slice(0, 8),
        openedCount: opened.openedCount,
        expectedMatch: opened.expectedMatch,
        needleInOpened: opened.needleInOpened,
        signatures: signer.signatures(),
        tallyMs,
        decryptMs: opened.decryptMs,
        ms: elapsedMs(t0)
      }
    })
  )
}

const tally: VerbHandler<VerbContext> = async (ctx, args) => runTally(officerResultsDeps(ctx), args)

export default tally
