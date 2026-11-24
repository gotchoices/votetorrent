// `vt officer results` (and, through the keyholder group, `vt keyholder results`): the authority-side read of
// the election results through the shared `readElectionResults` (67-19, the Voter Results screen's read, the
// same two engine calls the Authority ElectionResultsScreen makes) with the opened-set preimage check and the
// agreement hash every peer computes (src/proof). Replaces tools/lean-rig/lean/lean-part2.ts legRelease X3
// (1330-1371). Read-only: no token (a token key is `bad-arg`), no party gate, no officer identity; it works on
// ANY authority VerbContext through `ctx.openNetwork(hash)` alone. The reply is the voter `results` reply.
// This module also holds the est opener and the officer results deps the other three results verbs share.
// No console, no process.env, no instanceof.

import type { EngineContext } from '@votetorrent/vote-engine/rn'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import type { OpenedSetSeams } from '../../proof/opened-set-check.js'
import { parseResultsArgs, readAgreedResults, resultsEngines, resultsReply } from '../../proof/results-agreement.js'
import type { SecretRegistry } from '../../secrecy/redact.js'
import { elapsedMs, officerElectionDeps, pickArgs, refuse, startedNow, type OfficerElectionDeps } from './election-deps.js'

const NETWORK_HASH_RE = /^[0-9a-f]{32}$/
const ELECTION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

export const RESULTS_ARGS: readonly string[] = ['network', 'election', 'waitMs', 'requirePublished', 'expectedFiles', 'needleFile']

/** What the results read needs of a daemon context: the established network context by hash, and the registry. */
export interface ResultsVerbDeps {
  readonly secrets: SecretRegistry
  openEst(hash: unknown): Promise<EngineContext>
}

/** The officer election deps plus the established context, for tally, publish and release-window. */
export interface OfficerResultsDeps extends OfficerElectionDeps {
  openEst(hash: unknown): Promise<EngineContext>
}

/** Spec seams for the results verbs; the daemon uses the defaults. */
export interface ResultsVerbSeams {
  engines?: (est: EngineContext) => <T>(engineName: string) => Promise<T>
  openedSet?: OpenedSetSeams
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function networkOpenCode(e: unknown): string | undefined {
  const err = e as { name?: unknown, code?: unknown } | null | undefined
  return err?.name === 'NetworkOpenError' && typeof err.code === 'string' ? err.code : undefined
}

/** The established network context by hash through the daemon's own opener (`bad-network-hash`, `identity-absent`, `network-not-open`). */
export async function openEstFor(ctx: Pick<VerbContext, 'openNetwork'>, hash: unknown): Promise<EngineContext> {
  if (typeof hash !== 'string' || !NETWORK_HASH_RE.test(hash)) refuse('bad-network-hash')
  try {
    return (await ctx.openNetwork(hash)).est
  } catch (e) {
    const code = networkOpenCode(e)
    if (code === 'user-missing') refuse('identity-absent')
    if (code !== undefined) refuse('network-not-open')
    throw e
  }
}

export function resultsDepsFor(ctx: Pick<VerbContext, 'openNetwork' | 'secrets'>): ResultsVerbDeps {
  return { secrets: ctx.secrets, openEst: (hash) => openEstFor(ctx, hash) }
}

/** The 67-26 officer deps with the established context added; the officer getter stays lazy. */
export function officerResultsDeps(ctx: VerbContext): OfficerResultsDeps {
  const base = officerElectionDeps(ctx)
  return {
    partyId: base.partyId,
    secretsDir: base.secretsDir,
    secrets: base.secrets,
    vault: base.vault,
    get officer() {
      return base.officer
    },
    now: () => base.now(),
    writeKey: base.writeKey,
    openNetwork: (hash) => base.openNetwork(hash),
    openEst: (hash) => openEstFor(ctx, hash)
  }
}

/** A non-empty election id argument; absent is `election-required`, any other shape `election-unknown`. */
export function requireElection(a: Record<string, unknown>): string {
  const v = a.election
  if (v === undefined || v === '') refuse('election-required')
  if (typeof v !== 'string' || !ELECTION_ID_RE.test(v)) refuse('election-unknown')
  return v
}

export async function runResults(deps: ResultsVerbDeps, args: Record<string, unknown>, seams: ResultsVerbSeams = {}): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, RESULTS_ARGS)
  if (a.network === undefined) refuse('network-required')
  const electionId = requireElection(a)
  const parsed = parseResultsArgs(a, deps.secrets, refuse)
  const est = await deps.openEst(a.network)
  const agreed = await readAgreedResults({
    getEngine: (seams.engines ?? resultsEngines)(est),
    est,
    electionId,
    waitMs: parsed.waitMs,
    requirePublished: parsed.requirePublished,
    ...(parsed.expected === undefined ? {} : { expected: parsed.expected }),
    ...(parsed.needle === undefined ? {} : { needle: parsed.needle }),
    ...(seams.openedSet === undefined ? {} : { seams: seams.openedSet }),
    ...(seams.sleep === undefined ? {} : { sleep: seams.sleep }),
    ...(seams.now === undefined ? {} : { now: seams.now })
  })
  return resultsReply(agreed, electionId, elapsedMs(t0))
}

const results: VerbHandler<VerbContext> = async (ctx, args) => runResults(resultsDepsFor(ctx), args)

export default results
