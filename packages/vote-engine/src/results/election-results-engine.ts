// election-results-engine.ts — decrypt, validate and tally one election on a device, after the key release.
//
// Role:
//   - Loads the committed VoteBlock / VoteBlockVoter rows of the election's current revision, the Registrant and
//     Association rows those voter rows name, the revision timeline, and the election's confirmed ballots.
//   - Reconstructs the election secret from the PUBLIC released shares (KeyReleaseEngine.reconstructElectionKey),
//     runs the R5-R8 pipeline (buildTallyTree: block tree, R7 validation, R8 tally tree) and zero-fills the secret.
//   - Returns a display summary (per ballot, per question, per option counts in template order) plus the tally
//     tree itself, so any device holding the replicated election data can compute and check the same result.
//
// Rules:
//   - Nothing is written. The secret exists only inside getElectionResults and is zero-filled in a finally block.
//   - Ballots are read exactly as the Voter reads them for casting (getBallots + getBallotConfirmationState +
//     getBallotDetails), so the template digests the tally checks are the ones the voters signed.
//   - Every outcome is a typed value. A thrown database or engine error is reported as 'unavailable', never thrown.

import type { IKeyReleaseEngine, KeyReleasePhase, ReconstructedElectionKey } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { KeyReleaseEngine, KeyReleaseError } from '../key-release/key-release-engine.js'
import { ElectionEngine } from '../election/election-engine.js'
import { buildTallyTree, type TallyTree } from '../blocks/tally-tree.js'
import type { ValidationTotals, ValidationBlockRow, ValidationVoterRow, ValidationRegistrantRow, ValidationAssociationRow } from '../blocks/validate-blocks.js'
import type { AnswerCheckBallot } from '../blocks/answer-checks.js'

export interface OptionResult {
  code: string
  title: string
  count: number
}

export interface QuestionResult {
  code: string
  title: string
  /** 'select' when unset */
  type: string
  /** false for question types the tally does not count yet (rank, score, text): only `answered` is known */
  counted: boolean
  /** valid votes that answered this question */
  answered: number
  /** valid votes that left it blank (counted questions only, else 0) */
  blank: number
  /** template order; empty when not counted */
  options: OptionResult[]
}

export interface BallotResult {
  ballotId: string
  description: string
  /** every vote in the ballot's blocks, including invalid ones and those of excluded blocks */
  votes: number
  /** votes - invalid - excluded */
  valid: number
  invalid: number
  excluded: number
  questions: QuestionResult[]
}

export type ElectionResults =
  | { status: 'no-election', electionId: string }
  | {
    status: 'awaiting-keys'
    electionId: string
    phase: KeyReleasePhase
    revision: number | null
    threshold: number | null
    participants: number | null
    releasedCount: number
    releasingKeysAt: number | null
  }
  | { status: 'unavailable', electionId: string, reason: string, detail: string }
  | {
    status: 'tallied'
    electionId: string
    revision: number
    threshold: number
    /** keyholders whose released shares rebuilt the key */
    keyholdersUsed: number
    blockCount: number
    totals: ValidationTotals
    ballots: BallotResult[]
    tallyRoot: string
    blockRoot: string
    /** the full R8 tally tree (plain JSON), for verifyTallyTree or publication */
    tally: TallyTree
  }

export interface ElectionResultsEngineDeps {
  keyRelease?: Pick<IKeyReleaseEngine, 'getKeyReleaseStatus' | 'reconstructElectionKey'>
  /** The election's confirmed ballots; defaults to the ElectionEngine read the Voter uses for casting. */
  loadBallots?: (election: { id: string, authorityId: string }) => Promise<AnswerCheckBallot[]>
}

type Row = Record<string, unknown>

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** A stored datetime as ISO text ending in Z (the form the R5/R7 checks read), or the raw text when unreadable. */
export function toIsoZ (value: unknown): string {
  if (typeof value === 'string') {
    if (ISO_Z.test(value)) return value
    // a zone-less ISO datetime is UTC in this schema; never let Date.parse read it as local time
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value
    const ms = Date.parse(zoned)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  return String(value)
}

/** Timeline.votingStarts as epoch ms (number or ISO-Z text), else null. */
export function votingStartsAt (timelineText: unknown): number | null {
  let timeline: unknown = timelineText
  if (typeof timelineText === 'string') {
    try { timeline = JSON.parse(timelineText) } catch { return null }
  }
  if (timeline === null || typeof timeline !== 'object' || Array.isArray(timeline)) return null
  const raw = (timeline as Row).votingStarts
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  if (typeof raw === 'string' && ISO_Z.test(raw)) {
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

const toNumber = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number))

async function rows (ctx: EngineContext, sql: string, params: Record<string, string | number>): Promise<Row[]> {
  const out: Row[] = []
  for await (const row of ctx.db.eval(sql, params)) out.push(row as Row)
  return out
}

/** The display summary of one ballot, in template order. */
export function summarizeBallot (ballot: AnswerCheckBallot, tally: TallyTree): BallotResult {
  const counts = tally.histogram.ballots[ballot.id]
  const votes = counts?.votes ?? 0
  const invalid = counts?.invalid ?? 0
  const excluded = counts?.excluded ?? 0
  const valid = Math.max(0, votes - invalid - excluded)
  const questions: QuestionResult[] = ballot.questions.map(q => {
    const type = typeof q.type === 'string' ? q.type : 'select'
    const selected = counts?.questions[q.code]
    if (selected !== undefined) {
      return {
        code: q.code,
        title: q.title,
        type,
        counted: true,
        answered: selected.answered,
        blank: Math.max(0, valid - selected.answered),
        options: q.options.map(o => ({ code: o.code, title: o.title, count: selected.options[o.code] ?? 0 }))
      }
    }
    return { code: q.code, title: q.title, type, counted: false, answered: counts?.unsupported[q.code] ?? 0, blank: 0, options: [] }
  })
  return { ballotId: ballot.id, description: ballot.description, votes, valid, invalid, excluded, questions }
}

export class ElectionResultsEngine {
  constructor (private readonly ctx: EngineContext, private readonly deps: ElectionResultsEngineDeps = {}) {}

  private keyRelease (): Pick<IKeyReleaseEngine, 'getKeyReleaseStatus' | 'reconstructElectionKey'> {
    return this.deps.keyRelease ?? new KeyReleaseEngine(this.ctx)
  }

  private async loadBallots (election: { id: string, authorityId: string }): Promise<AnswerCheckBallot[]> {
    if (this.deps.loadBallots !== undefined) return await this.deps.loadBallots(election)
    const engine = new ElectionEngine(election, this.ctx)
    const summaries = await engine.getBallots()
    const states = await Promise.all(summaries.map(async s => await engine.getBallotConfirmationState(s.id)))
    const confirmed = summaries.filter((_, i) => states[i]?.confirmed === true)
    const ballots = await Promise.all(confirmed.map(async s => (await engine.getBallotDetails(s.id)).ballot as unknown as AnswerCheckBallot))
    return ballots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** Decrypt, validate and tally the election's current revision. Read-only; never throws. */
  async getElectionResults (electionId: string): Promise<ElectionResults> {
    let reconstructed: ReconstructedElectionKey | null = null
    try {
      const election = await this.ctx.db.prepare('select Id, AuthorityId from Election where Id = :electionId').get({ electionId })
      if (!election) return { status: 'no-election', electionId }

      const keyRelease = this.keyRelease()
      const status = await keyRelease.getKeyReleaseStatus(electionId)
      if (status.phase === 'election-key-inconsistent') {
        return { status: 'unavailable', electionId, reason: 'election-key-inconsistent', detail: 'the published election key does not match the revision or its keyholders' }
      }
      if (status.phase !== 'reconstructable') {
        return {
          status: 'awaiting-keys',
          electionId,
          phase: status.phase,
          revision: status.revision,
          threshold: status.threshold,
          participants: status.participants,
          releasedCount: status.releasedCount,
          releasingKeysAt: status.releasingKeysAt
        }
      }

      try {
        reconstructed = await keyRelease.reconstructElectionKey(electionId)
      } catch (err) {
        const code = err instanceof KeyReleaseError ? err.code : 'reconstruction-failed'
        return { status: 'unavailable', electionId, reason: code, detail: err instanceof Error ? err.message : String(err) }
      }
      const revision = reconstructed.revision

      const revRow = await this.ctx.db
        .prepare('select Timeline from ElectionRevision where ElectionId = :electionId and Revision = :revision')
        .get({ electionId, revision })
      const votingStarts = votingStartsAt(revRow?.Timeline)
      if (votingStarts === null) {
        return { status: 'unavailable', electionId, reason: 'no-timeline', detail: 'the election revision has no readable votingStarts' }
      }

      const blockRows = (await rows(this.ctx,
        'select Cid, Id, ElectionId, ElectionRevision, BallotId, TemplateDigest, EntryCount, VoterRegistrantIds, Ciphertext from VoteBlock where ElectionId = :electionId and ElectionRevision = :revision',
        { electionId, revision }
      )) as unknown as ValidationBlockRow[]
      const voterRows = (await rows(this.ctx,
        'select ElectionId, BallotId, RegistrantId, BlockCid, BlockId, ElectionRevision, DeviceKey, Signature from VoteBlockVoter where ElectionId = :electionId',
        { electionId }
      )).filter(r => toNumber(r.ElectionRevision) === revision) as unknown as ValidationVoterRow[]

      const registrantIds = [...new Set(voterRows.map(r => r.RegistrantId))].sort()
      const registrants: ValidationRegistrantRow[] = []
      const associations: ValidationAssociationRow[] = []
      // point lookups per registrant (no IN list: see the quereus AND+IN predicate trap)
      for (const id of registrantIds) {
        const reg = await this.ctx.db.prepare('select Id, Status, Expiration from Registrant where Id = :id').get({ id })
        if (reg) registrants.push({ Id: reg.Id as string, Status: reg.Status as string, Expiration: toIsoZ(reg.Expiration) })
        for (const a of await rows(this.ctx, 'select RegistrantId, DeviceKey, Expiration from Association where RegistrantId = :id', { id })) {
          associations.push({ RegistrantId: a.RegistrantId as string, DeviceKey: a.DeviceKey as string, Expiration: toIsoZ(a.Expiration) })
        }
      }

      const ballots = await this.loadBallots({ id: electionId, authorityId: election.AuthorityId as string })

      const built = buildTallyTree({
        scope: { electionId, electionRevision: revision },
        rows: blockRows,
        voterRows,
        ballots,
        registrants,
        associations,
        timeline: { votingStarts },
        release: { secretKey: reconstructed.secretKey, jointPublicKey: reconstructed.jointPublicKey }
      })
      if (!built.ok) return { status: 'unavailable', electionId, reason: built.reason, detail: built.detail }

      return {
        status: 'tallied',
        electionId,
        revision,
        threshold: reconstructed.threshold,
        keyholdersUsed: reconstructed.usedUserIds.length,
        blockCount: built.tally.size,
        totals: built.validation.totals,
        ballots: ballots.map(b => summarizeBallot(b, built.tally)),
        tallyRoot: built.tally.root,
        blockRoot: built.tally.blockRoot,
        tally: built.tally
      }
    } catch (err) {
      return { status: 'unavailable', electionId, reason: 'read-failed', detail: err instanceof Error ? err.message : String(err) }
    } finally {
      reconstructed?.secretKey.fill(0)
    }
  }
}
