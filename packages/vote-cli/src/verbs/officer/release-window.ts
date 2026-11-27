// `vt officer release-window`: the officer's view of the key-release window. Before the keyholders release it
// proves the ciphertext-only state (the lean rig's Q1: phase not reconstructable, every VoteBlock not
// decryptable, the ballot needle absent raw and as hex from every ciphertext); after their `release` it
// confirms `releasedCount >= --await-released` and `rejected === 0` (the officer-side confirmation 67-28 left
// to this plan). Replaces the retired lean rig's main driver legRelease 1245-1294. Read-only: no token (a token
// key is `bad-arg`), no party gate; it never calls a release or key-task method and never returns a share, a
// task or the timeline. No console, no process.env, no instanceof.

import { releasingKeysAt, KeyReleaseEngine } from '@votetorrent/vote-engine/rn'
import type { EngineContext } from '@votetorrent/vote-engine/rn'
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { readPrivateFile } from '../../vault/private-file.js'
import { elapsedMs, pickArgs, refuse, startedNow } from './election-deps.js'
import { officerResultsDeps, requireElection, type OfficerResultsDeps } from './results.js'

const ALLOWED: readonly string[] = ['network', 'election', 'waitMs', 'awaitReleased', 'needleFile']
export const RELEASE_WINDOW_WAIT_MAX_MS = 1_800_000
export const RELEASE_WINDOW_AWAIT_MAX = 16
export const RELEASE_WINDOW_POLL_MS = 1000
export const RELEASE_WINDOW_AWAIT_BOUND_MS = 180_000
const NEEDLE_FILE_MAX_BYTES = 4096
const TIMELINE_SQL = 'select Timeline as tl from ElectionRevision where ElectionId = :electionId order by Revision desc'
const BLOCKS_SQL = 'select Id, BallotId, Ciphertext, ElectionRevision from VoteBlock where ElectionId = :electionId'

/** The status and decrypt calls, injectable by the unit spec. */
export interface ReleaseWindowSeams {
  keyRelease: (est: EngineContext) => {
    getKeyReleaseStatus(electionId: string): Promise<{ phase: string, revision: number | null, releasedCount: number, rejectedReleases: readonly unknown[] }>
    decryptElectionBlocks(electionId: string, blocks: ReadonlyArray<{ blockId: string, ciphertext: unknown }>): Promise<ReadonlyArray<{ ok: boolean }>>
  }
  sleep: (ms: number) => Promise<void>
  now: () => number
  awaitBoundMs: number
}

export const DEFAULT_RELEASE_WINDOW_SEAMS: ReleaseWindowSeams = Object.freeze({
  keyRelease: (est: EngineContext) => new KeyReleaseEngine(est),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  awaitBoundMs: RELEASE_WINDOW_AWAIT_BOUND_MS
})

/** The latest revision's timeline, parsed, or null (bind name `:electionId` only). */
export async function readLatestTimeline(est: EngineContext, electionId: string): Promise<unknown> {
  for await (const row of est.db.eval(TIMELINE_SQL, { electionId })) {
    const tl = (row as { tl?: unknown }).tl
    if (typeof tl === 'string') {
      try {
        return JSON.parse(tl)
      } catch {
        return null
      }
    }
    return tl ?? null
  }
  return null
}

/** An absolute 0600 needle file: its trimmed text, registered windowed. */
export function readNeedleFile(path: unknown, secrets: OfficerResultsDeps['secrets']): string {
  if (typeof path !== 'string' || path.length === 0 || path[0] !== '/') refuse('needle-file-invalid')
  let data: Buffer | null = null
  try {
    data = readPrivateFile(path, { maxBytes: NEEDLE_FILE_MAX_BYTES })
  } catch {
    refuse('needle-file-invalid')
  }
  if (data === null) refuse('needle-file-invalid')
  const text = (data as Buffer).toString('utf8').trim()
  ;(data as Buffer).fill(0)
  if (text.length === 0) refuse('needle-file-invalid')
  secrets.add(text, { windows: true })
  return text
}

function ciphertextText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null)
}

export async function runReleaseWindow(deps: OfficerResultsDeps, args: Record<string, unknown>, seams: ReleaseWindowSeams = DEFAULT_RELEASE_WINDOW_SEAMS): Promise<Record<string, unknown>> {
  const t0 = startedNow()
  const a = pickArgs(args, ALLOWED)
  if (a.network === undefined) refuse('network-required')
  const electionId = requireElection(a)
  const waitText = a.waitMs === undefined ? '0' : a.waitMs
  if (typeof waitText !== 'string' || !/^\d{1,7}$/.test(waitText) || Number(waitText) > RELEASE_WINDOW_WAIT_MAX_MS) refuse('wait-invalid')
  const waitMs = Number(waitText)
  const awaitText = a.awaitReleased === undefined ? '0' : a.awaitReleased
  if (typeof awaitText !== 'string' || !/^\d{1,2}$/.test(awaitText) || Number(awaitText) > RELEASE_WINDOW_AWAIT_MAX) refuse('await-invalid')
  const awaitReleased = Number(awaitText)
  const needle = a.needleFile === undefined ? undefined : readNeedleFile(a.needleFile, deps.secrets)

  const network = await deps.openNetwork(a.network)
  await network.openElection(electionId)
  const est = await deps.openEst(a.network)
  const releaseAt = releasingKeysAt(await readLatestTimeline(est, electionId))
  if (releaseAt === null) refuse('no-release-time')
  let statusReads = 0
  const started = seams.now()
  if (releaseAt - started > waitMs) refuse('window-not-open')
  while (seams.now() < releaseAt) await seams.sleep(Math.min(RELEASE_WINDOW_POLL_MS, releaseAt - seams.now()))
  const waitedMs = Math.max(0, seams.now() - started)

  const kr = seams.keyRelease(est)
  let status = await kr.getKeyReleaseStatus(electionId)
  statusReads++
  let preRelease: Record<string, unknown> | null = null
  if (status.phase !== 'reconstructable') {
    const rows: Array<{ Id: unknown, Ciphertext: unknown, ElectionRevision: unknown }> = []
    for await (const row of est.db.eval(BLOCKS_SQL, { electionId })) {
      const r = row as { Id: unknown, Ciphertext: unknown, ElectionRevision: unknown }
      if (status.revision === null || Number(r.ElectionRevision) === status.revision) rows.push(r)
    }
    const opened = await kr.decryptElectionBlocks(electionId, rows.map((r) => ({ blockId: String(r.Id), ciphertext: r.Ciphertext })))
    if (opened.some((o) => o.ok)) refuse('pre-release-open')
    let needlesChecked = 0
    if (needle !== undefined) {
      const hex = Buffer.from(needle, 'utf8').toString('hex')
      for (const r of rows) {
        needlesChecked++
        const text = ciphertextText(r.Ciphertext)
        if (text.includes(needle) || text.includes(hex)) refuse('needle-in-ciphertext')
      }
    }
    preRelease = { checked: true, phase: status.phase, blocks: rows.length, notReconstructable: opened.filter((o) => !o.ok).length, needlesChecked, needleFound: false }
  }

  if (awaitReleased > 0) {
    const deadline = seams.now() + seams.awaitBoundMs
    for (;;) {
      if (status.rejectedReleases.length > 0) refuse('release-rejected')
      if (status.releasedCount >= awaitReleased) break
      if (seams.now() >= deadline) refuse('release-incomplete')
      await seams.sleep(Math.min(RELEASE_WINDOW_POLL_MS, deadline - seams.now()))
      status = await kr.getKeyReleaseStatus(electionId)
      statusReads++
    }
  }

  return {
    electionId,
    releasingKeysAt: new Date(releaseAt).toISOString(),
    waitedMs,
    phase: status.phase,
    releasedCount: status.releasedCount,
    rejected: status.rejectedReleases.length,
    preRelease,
    statusReads,
    ms: elapsedMs(t0)
  }
}

const releaseWindow: VerbHandler<VerbContext> = async (ctx, args) => runReleaseWindow(officerResultsDeps(ctx), args)

export default releaseWindow
